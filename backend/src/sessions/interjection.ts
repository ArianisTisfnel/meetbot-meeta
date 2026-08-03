import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { activeSessions } from './session-store.js'
import { isSpeakingNow } from '../agent/speaker-timeline.js'
import { answerFollowUp, resolveAnswer, sendChatBestEffort, speakProactive } from './wake-word-detector.js'
import { warmEouModel, isEndOfTurn } from '../lib/eou.js'
import { completeText } from '../lib/llm.js'
import { DIFY_NO_RESULT_SENTINEL } from '../lib/dify.js'
import { decideTurn } from './response-policy.js'
import { isEngaged } from './addressing.js'
import {
  formatConversation,
  ICEBREAKER_OPENING_NO_KB,
  ICEBREAKER_OPENING_WITH_KB,
  ICEBREAKER_SUMMARY_SYSTEM,
} from './interjection-prompts.js'
import type { MeetingSession } from '../types/session.js'

// livekit 時機層啟用時，啟動階段就下載/載入模型（首場會議不用付冷啟成本）。
if (env.INTERJECTION_ENABLED && env.INTERJECTION_TURN_DETECTOR === 'livekit') {
  warmEouModel()
}

/**
 * 主動插話引擎（interjection）— 讓蜜塔在沒被叫名字時也能「參與聊天」。
 *
 * 三層架構（各層可獨立替換）：
 *   ① 時機層：判斷「這一輪話講完了」。由 INTERJECTION_TURN_DETECTOR 選擇——
 *      - 'silence'：最後一段內容後 INTERJECTION_TURN_SILENCE_MS 無新內容即評估
 *      - 'livekit'：兩段式。先等 INTERJECTION_EOU_CHECK_MS（短），用 LiveKit
 *        turn-detector 模型（lib/eou.ts）判斷語意上「講完了嗎」：講完 → 立即評估
 *        （比死等快）；沒講完/模型不可用 → 退回在 SILENCE_MS 時無條件評估
 *        （長停頓覆蓋語意判斷，模型永遠只是增強不是依賴）。
 *   ② 決策層：Claude Haiku 以 rolling window 判斷「該不該插話、要回答什麼問題」。
 *      硬性防護（cooldown / 喚醒流程進行中 / bot 剛說過話）在呼叫模型前先擋掉。
 *   ③ 執行層：走既有 resolveAnswer（Dify RAG / 逐字稿 QA）取得答案，
 *      以**聊天室訊息**送出（主動插話用文字，比語音干擾低；語音留給喚醒詞問答）。
 *
 * 狀態存模組層 Map（keyed by meetingInstanceId），session 結束時由
 * session-manager 呼叫 {@link clearInterjection} 清理。
 */

export interface ConversationEntry {
  speaker: string
  text: string
  source: 'voice' | 'chat'
  fromBot: boolean
  at: number
}

const WINDOW_MAX_ENTRIES = 60
/** 決策模型一次看的對話則數。 */
const DECISION_CONTEXT_ENTRIES = 12
/** 喚醒詞問答進行中／剛結束時不插話的靜默期。 */
const WAKE_GRACE_MS = 15_000
/**
 * 破冰的喚醒寬限：Dify 查詢鏈最長 45s（DIFY_CHATFLOW_TIMEOUT_MS 預設值），
 * 答案落地前破冰會自打臉（實測 2026-07-08：破冰說「我查不到預算」，2 秒後自己的答案就到了）。
 */
const ICEBREAKER_WAKE_QUERY_GRACE_MS = 45_000
/**
 * 「同一題不要答兩次」的有效期。取 60s：涵蓋整條查詢鏈（Dify 上限 45s）加上答案唸完，
 * 也就是「答案還沒落地／剛落地」的那段時間。超過就不擋——使用者過了一分鐘還在問
 * 同一句話，多半是真的沒聽到，這時候安靜才是壞掉。
 */
const REPEAT_QUESTION_MS = 60_000

interface InterjectionState {
  window: ConversationEntry[]
  lastInterjectionAt: number
  timer: ReturnType<typeof setTimeout> | null
  evaluating: boolean
  /** 沉默破冰計時器：全場靜默超過 ICEBREAKER_SILENCE_MS 觸發。 */
  idleTimer: ReturnType<typeof setTimeout> | null
  lastIcebreakerAt: number
}

const states = new Map<string, InterjectionState>()

function getOrCreateState(meetingInstanceId: string): InterjectionState {
  let s = states.get(meetingInstanceId)
  if (!s) {
    s = { window: [], lastInterjectionAt: 0, timer: null, evaluating: false, idleTimer: null, lastIcebreakerAt: 0 }
    states.set(meetingInstanceId, s)
  }
  return s
}

/**
 * 取近期對話窗（唯讀複本）。語意定址裁決層要靠它判斷受話者——
 * 同一段討論串裡的第二句提及，多半延續前一句的性質。
 */
export function getConversationWindow(meetingInstanceId: string, limit = DECISION_CONTEXT_ENTRIES): ConversationEntry[] {
  return (states.get(meetingInstanceId)?.window ?? []).slice(-limit)
}

/** session 結束時清理（session-manager 的 closeSession / handleSessionClose 呼叫）。 */
export function clearInterjection(meetingInstanceId: string): void {
  const s = states.get(meetingInstanceId)
  if (s?.timer) clearTimeout(s.timer)
  if (s?.idleTimer) clearTimeout(s.idleTimer)
  states.delete(meetingInstanceId)
}

/**
 * 每一段語音/聊天內容進來時呼叫（session-manager 的 onSegment / onChat）。
 * 累積 rolling window 並重排「turn 結束」計時器。
 */
export function recordConversation(session: MeetingSession, entry: ConversationEntry): void {
  if (!env.INTERJECTION_ENABLED && !env.ICEBREAKER_ENABLED) return

  const s = getOrCreateState(session.meetingInstanceId)
  s.window.push(entry)
  if (s.window.length > WINDOW_MAX_ENTRIES) s.window.splice(0, s.window.length - WINDOW_MAX_ENTRIES)

  // 任何活動（含蜜塔自己）都重置沉默計時
  armIcebreaker(session.meetingInstanceId)

  if (!env.INTERJECTION_ENABLED) return
  if (s.timer) clearTimeout(s.timer)
  // bot 自己的訊息不該觸發「有人講完話」的評估
  if (entry.fromBot) return

  if (env.INTERJECTION_TURN_DETECTOR === 'livekit') {
    // 兩段式：短暫靜默後先問 EOU 模型，講完就提早評估
    s.timer = setTimeout(() => {
      s.timer = null
      checkEndOfTurn(session.meetingInstanceId).catch((err) =>
        logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'interjection: checkEndOfTurn error'),
      )
    }, env.INTERJECTION_EOU_CHECK_MS)
  } else {
    s.timer = setTimeout(() => {
      s.timer = null
      evaluateTurn(session.meetingInstanceId).catch((err) =>
        logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'interjection: evaluateTurn error'),
      )
    }, env.INTERJECTION_TURN_SILENCE_MS)
  }
}

// ── 沉默破冰 ──────────────────────────────────────────────────────────────────
//
// 全場沉默超過 ICEBREAKER_SILENCE_MS → 蜜塔主動開口（語音，失敗退聊天室）：
//   開場沉默（幾乎沒人講過話）→ 罐頭引導（免 LLM、快又穩）
//   會議中沉默 → LLM 依對話窗總結進度＋拋出推進討論的問題

/** bot admitted 後啟動沉默計時（session-manager 呼叫）；之後每筆活動自動重置。 */
export function startIcebreaker(session: MeetingSession): void {
  if (!env.ICEBREAKER_ENABLED) return
  getOrCreateState(session.meetingInstanceId)
  armIcebreaker(session.meetingInstanceId)
}

/**
 * 有人**正在**講話（未定稿的 partial 逐字稿）→ 只重置破冰計時，不進對話窗。
 *
 * 破冰原本只靠定稿逐字稿重置計時，而定稿要等 VAD 判定靜音、再落後 1.5–3 秒才到，
 * 於是「她開口了但那句還沒定稿」的空檔會被算成沉默 —— 實測 2026-08-03 19:20:15
 * 就是這樣講到使用者身上。Recall 的 speech_on 本來該擋住，但那次它整段沒送
 *（19:19:36 之後就沒有事件了），單靠它不夠。partial 來自我們自己的串流 STT，
 * 不經過 Recall 的 webhook，是最可靠的「此刻有人在出聲」訊號。
 *
 * **不呼叫 recordConversation**：partial 內容會變動且同一句重複推送，
 * 進對話窗會污染決策層的輸入，也會讓插話的 turn 計時器永遠重排。
 */
export function noteHumanSpeaking(meetingInstanceId: string): void {
  if (!env.ICEBREAKER_ENABLED) return
  if (!states.has(meetingInstanceId)) return
  armIcebreaker(meetingInstanceId)
}

function armIcebreaker(meetingInstanceId: string): void {
  if (!env.ICEBREAKER_ENABLED) return
  const s = states.get(meetingInstanceId)
  if (!s) return
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = setTimeout(() => {
    s.idleTimer = null
    fireIcebreaker(meetingInstanceId).catch((err) =>
      logger.error({ err, meetingInstanceId }, 'icebreaker error'),
    )
  }, env.ICEBREAKER_SILENCE_MS)
}

/**
 * 現在有沒有人正在講話？靠 Recall 的 speech_on/off 時間軸（即時），
 * 不靠「多久沒有新逐字稿」——後者是落後且成批到達的指標，會在別人換氣、
 * 下一段定稿還沒到的空檔誤判成冷場，於是蜜塔在人家講到一半時插話。
 *
 * botId 取自 BotSession 的公開欄位（Recall 是字串 bot id；Vexa 是數字 → 無時間軸，
 * 回 false 維持原行為）。不讀 provider 私有的 state。
 */
function someoneIsSpeaking(session: MeetingSession): boolean {
  const botId = session.botSession?.providerMeetingId
  return typeof botId === 'string' && isSpeakingNow(botId)
}

async function fireIcebreaker(meetingInstanceId: string): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  const s = states.get(meetingInstanceId)
  if (!session || !session.botSession || !s) return

  const now = Date.now()
  // 跳過時必留 log：這些防護原本靜默 return，實測「破冰沒出來」時完全無從診斷是哪條擋的
  const skipReason = session.isSpeaking
    ? 'bot-speaking'
    : someoneIsSpeaking(session)
      ? 'human-speaking' // 現場根本不是沉默，只是逐字稿還沒到
      : now - s.lastIcebreakerAt < env.ICEBREAKER_COOLDOWN_MS
      ? 'cooldown'
      : // 喚醒問答剛發生（查詢/回答可能還在進行）→ 不是真沉默；
        // 寬限取 max(沉默門檻, 45s 查詢鏈上限)，避免破冰搶在遲到的答案前面
        now - session.lastWakeAt < Math.max(env.ICEBREAKER_SILENCE_MS, ICEBREAKER_WAKE_QUERY_GRACE_MS)
        ? 'wake-grace'
        : null
  if (skipReason) {
    logger.info(
      { meetingInstanceId, skipReason, sinceWakeMs: now - session.lastWakeAt, sinceLastIcebreakerMs: now - s.lastIcebreakerAt },
      'icebreaker: skipped, re-arming',
    )
    armIcebreaker(meetingInstanceId) // 繼續監看下一段沉默
    return
  }

  // 上次破冰後若沒有任何人類新發言 → 大家就是暫時不想說話，重複破冰只是騷擾
  //（實測 2026-07-07：同一段沉默把一模一樣的總結連發兩次）。
  if (s.lastIcebreakerAt > 0 && !s.window.some((e) => !e.fromBot && e.at > s.lastIcebreakerAt)) {
    logger.info({ meetingInstanceId }, 'icebreaker: skipped (no human speech since last icebreaker), re-arming')
    armIcebreaker(meetingInstanceId)
    return
  }

  const humanEntries = s.window.filter((e) => !e.fromBot)
  let text: string
  if (s.lastIcebreakerAt === 0 && humanEntries.length < 2) {
    // 開場沉默：罐頭引導。**只有第一次**能走這條——罐頭句是「大家好像還沒開始討論」，
    // 破過一次冰之後再說一模一樣的話，一來事實上已經開始討論了（能走到這裡代表
    // 上次破冰後有人講過話，見上面的防護），二來使用者聽到的是同一句話重播
    //（實測 2026-08-03 19:19:03 與 19:20:15 一字不差）。之後一律走總結路線。
    text = session.difyDatasetId ? ICEBREAKER_OPENING_WITH_KB : ICEBREAKER_OPENING_NO_KB
  } else {
    // 會議中沉默：總結＋拋問題
    try {
      // 記住進 LLM 前的最後一則：生成期間（1-2 秒）若有人開口，代表已不是冷場
      const lastEntryAt = s.window.length ? s.window[s.window.length - 1].at : 0
      const context = formatConversation(s.window.slice(-DECISION_CONTEXT_ENTRIES), { chatMarker: false })
      text = await completeText({
        system: ICEBREAKER_SUMMARY_SYSTEM,
        prompt: `最近的對話：\n\n${context}`,
        maxTokens: 200,
        purpose: 'interjection',
      })
      if (!text.trim()) {
        // 空文案：本輪不出聲，但監看不能斷——否則要等到下一筆活動才會復活
        armIcebreaker(meetingInstanceId)
        return
      }
      // 撞車防護：LLM 生成期間有人類新發言 → 放棄本輪破冰
      //（實測 2026-07-07：有人 3:05 提問、破冰 3:06 照發，變成打斷提問者）
      const nowLast = s.window[s.window.length - 1]
      if (nowLast && nowLast.at !== lastEntryAt && !nowLast.fromBot) {
        logger.info({ meetingInstanceId }, 'icebreaker: someone spoke during generation, aborting this round')
        armIcebreaker(meetingInstanceId)
        return
      }
    } catch (err) {
      logger.warn({ err, meetingInstanceId }, 'icebreaker: LLM failed, skipping')
      armIcebreaker(meetingInstanceId)
      return
    }
  }

  s.lastIcebreakerAt = Date.now()
  logger.info({ meetingInstanceId, text: text.slice(0, 60) }, 'icebreaker: breaking silence via voice')
  await speakProactive(session, text, 'icebreaker')
  armIcebreaker(meetingInstanceId)
}

/** livekit 時機層第一段：EOU 模型判斷「講完了嗎」；沒講完/不可用 → 排 fallback 評估。 */
async function checkEndOfTurn(meetingInstanceId: string): Promise<void> {
  const s = states.get(meetingInstanceId)
  if (!s || !s.window.length) return

  // 記住進入推論時的最後一則；推論期間有新內容 → 本次作廢（新內容自己的計時鏈會接手）
  const lastAt = s.window[s.window.length - 1].at

  const turns = s.window.slice(-DECISION_CONTEXT_ENTRIES).map((e) => ({
    role: (e.fromBot ? 'assistant' : 'user') as 'assistant' | 'user',
    content: e.text,
  }))
  const ended = await isEndOfTurn(turns, env.INTERJECTION_EOU_LANGUAGE, env.INTERJECTION_EOU_THRESHOLD)

  const s2 = states.get(meetingInstanceId)
  if (!s2 || !s2.window.length) return
  if (s2.window[s2.window.length - 1].at !== lastAt) return // 期間有新內容

  if (ended === true) {
    logger.info({ meetingInstanceId }, 'interjection: EOU model says turn ended, evaluating early')
    await evaluateTurn(meetingInstanceId)
    return
  }

  // 沒講完（或模型不可用）→ fallback：補滿剩餘靜默時間後無條件評估
  const remaining = Math.max(500, env.INTERJECTION_TURN_SILENCE_MS - env.INTERJECTION_EOU_CHECK_MS)
  if (s2.timer) clearTimeout(s2.timer)
  s2.timer = setTimeout(() => {
    s2.timer = null
    evaluateTurn(meetingInstanceId).catch((err) =>
      logger.error({ err, meetingInstanceId }, 'interjection: fallback evaluateTurn error'),
    )
  }, remaining)
}

/**
 * ② 決策層＋③ 執行層。
 *
 * 這一輪的**唯一一次** LLM 呼叫（decideTurn）同時回答兩個問題：
 *   「剛才那句是在對蜜塔說話嗎」→ 是 → 走喚醒問答的路（沒喊名字的連續追問，回報 A.3）
 *   「沒人叫她的話，她該不該主動補充」→ 該 → 走插話的路（原本的行為）
 * 兩者互斥且共用同一份判斷，所以連續追問**沒有增加**任何呼叫。
 */
async function evaluateTurn(meetingInstanceId: string): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  const s = states.get(meetingInstanceId)
  if (!session || !session.botSession || !s || s.evaluating) return

  const now = Date.now()
  // 冷卻／喚醒寬限只擋「主動插話」，不再擋整個評估——連續追問正好落在喚醒寬限裡
  //（上一題才剛答完），照舊擋掉的話 A.3 永遠接不上。
  // 對話串沒開著時兩者等價（不可能有追問），維持舊行為直接跳過、省一次呼叫。
  const engaged = isEngaged(session, now)
  const inWakeGrace = now - session.lastWakeAt < WAKE_GRACE_MS
  const inCooldown = now - s.lastInterjectionAt < env.INTERJECTION_COOLDOWN_MS

  // 硬性防護：呼叫模型前先擋（省 token、避免搶話）。
  // 跳過時必留 log：原本靜默 return，實測「都不插話」時無從診斷是哪條擋的。
  const last = s.window[s.window.length - 1]
  const skipReason = session.isSpeaking
    ? 'bot-speaking'
    : // 有人正在講話就不能插嘴——但**只擋主動插話**。對話串開著時這裡是「回答被問到的
      // 問題」的唯一出口（出口一），拿現場有人在講話擋掉等於她被叫到也不回答
      //（實測 2026-08-03：追問連續三次全部 skipReason=human-speaking，使用者最後說「閉嘴」）。
      // 與下面 wake-grace / cooldown 同一個原則：!engaged 才擋。
      !engaged && someoneIsSpeaking(session)
      ? 'human-speaking'
      : !last || last.fromBot
      ? 'last-entry-from-bot'
      : !engaged && inWakeGrace
        ? 'wake-grace'
        : !engaged && inCooldown
          ? 'cooldown'
          : null
  if (skipReason) {
    logger.info(
      { meetingInstanceId, skipReason, sinceWakeMs: now - session.lastWakeAt },
      'interjection: evaluation skipped',
    )
    return
  }

  s.evaluating = true
  try {
    const recent = s.window.slice(-DECISION_CONTEXT_ENTRIES)
    const turn = await decideTurn({ window: recent, kbContentCard: session.kbContentCard })

    // ── 出口一：這是在對蜜塔說話（沒喊名字的連續追問）→ 當成喚醒問答回答
    // unknown（呼叫失敗／JSON 壞掉）在這裡**退回安靜**，與句中提及的方向相反：
    // 那邊有喊名字，判不出來時多嘴一次而已；這裡沒喊名字，退回「照常回答」等於
    // 額度一枯竭就把會議裡每一句話都當成在問她。
    if (turn.addressed === 'address' && engaged && turn.question) {
      // 跳針防護：語意層是從**整個對話窗**挑問題的，窗裡就躺著剛才已經答過的那一則
      //（實測 2026-08-03 19:35：聊天室打的那題，答案還在查時她又出了一次聲，
      //  同一句原文被當成新追問，聊天室答一次、語音又答一次）。
      const prev = session.lastDispatchedQuestion
      if (prev && prev.text.trim() === turn.question.trim() && now - prev.at < REPEAT_QUESTION_MS) {
        logger.info(
          { meetingInstanceId, question: turn.question.slice(0, 60), sinceDispatchMs: now - prev.at },
          'interjection: same question was just dispatched, not answering twice',
        )
        return
      }
      logger.info(
        { meetingInstanceId, question: turn.question.slice(0, 60), intent: turn.intent },
        'interjection: decision = addressed follow-up, answering as a question',
      )
      const source = last.source === 'chat' ? 'chat' : 'voice'
      await answerFollowUp(session, turn.question, source, {
        speaker: last.speaker || undefined,
        intent: turn.intent,
      })
      return
    }

    // ── 出口二：沒人叫她，但值得主動補充 → 原本的插話行為
    // human-speaking 在這裡補檢查：上面為了讓出口一走得通而放行了 engaged 的情況，
    // 但「主動插嘴」在別人講話時仍然不可以。
    if (inWakeGrace || inCooldown || someoneIsSpeaking(session)) {
      logger.info(
        {
          meetingInstanceId,
          skipReason: inWakeGrace ? 'wake-grace' : inCooldown ? 'cooldown' : 'human-speaking',
        },
        'interjection: not a follow-up and still within grace/cooldown, staying quiet',
      )
      return
    }
    if (!turn.interject || !turn.question) {
      logger.info({ meetingInstanceId }, 'interjection: decision = stay quiet')
      return
    }

    logger.info(
      { meetingInstanceId, question: turn.question.slice(0, 60) },
      'interjection: decision = interject, resolving answer',
    )

    const lastAtBeforeAnswer = s.window[s.window.length - 1]?.at
    const answer = await resolveAnswer(session, turn.question, 'chat', turn.intent)

    s.lastInterjectionAt = Date.now()

    // 檢索沒中（Dify 哨兵句）或空答案 → 沒東西可補充，安靜放棄本次插話。
    // 冷卻照計：同一個答不出的問題若反覆觸發決策＋檢索，只是浪費 quota。
    // （喚醒詞問答不在此列——使用者點名問就必須回應，哨兵句照常唸出。）
    if (!answer.trim() || answer === DIFY_NO_RESULT_SENTINEL) {
      logger.info(
        { meetingInstanceId, question: turn.question.slice(0, 40) },
        'interjection: no retrievable answer (sentinel/empty), skipping delivery',
      )
      return
    }

    // 投遞方式看現場：查詢期間有人開口/蜜塔正在說話 → 聊天室（不打擾）；
    // 仍然沉默 → 語音說出來（沉默中丟訊息沒人會看）。
    const nowLast = s.window[s.window.length - 1]
    const someoneSpoke = Boolean(nowLast && nowLast.at !== lastAtBeforeAnswer && !nowLast.fromBot)
    if (someoneSpoke || session.isSpeaking) {
      logger.info({ meetingInstanceId }, 'interjection: delivering via chat (people talking)')
      await sendChatBestEffort(session, `💡 ${answer}`, 'chat', 'interjection')
    } else {
      logger.info({ meetingInstanceId }, 'interjection: room still silent, delivering via voice')
      await speakProactive(session, `我補充一下：${answer}`, 'interjection')
    }

    s.window.push({ speaker: '蜜塔', text: answer, source: 'chat', fromBot: true, at: Date.now() })
    logger.info({ meetingInstanceId, answerPreview: answer.slice(0, 60) }, 'interjection: answer sent to chat')
  } finally {
    s.evaluating = false
  }
}
