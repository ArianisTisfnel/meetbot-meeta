import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { activeSessions } from './session-store.js'
import { resolveAnswer, sendChatBestEffort, speakProactive } from './wake-word-detector.js'
import { warmEouModel, isEndOfTurn } from '../lib/eou.js'
import { completeText } from '../lib/llm.js'
import { DIFY_NO_RESULT_SENTINEL } from '../lib/dify.js'
import {
  formatConversation,
  ICEBREAKER_OPENING_NO_KB,
  ICEBREAKER_OPENING_WITH_KB,
  ICEBREAKER_SUMMARY_SYSTEM,
  INTERJECTION_DECISION_SYSTEM,
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
  // 安靜模式：不排評估計時（省下 EOU 推論與決策 LLM）；對話窗照記，解除後脈絡不斷
  if (session.quietMode) return

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

async function fireIcebreaker(meetingInstanceId: string): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  const s = states.get(meetingInstanceId)
  if (!session || !session.botSession || !s) return

  const now = Date.now()
  // 跳過時必留 log：這些防護原本靜默 return，實測「破冰沒出來」時完全無從診斷是哪條擋的
  const skipReason = session.quietMode
    ? 'quiet-mode'
    : session.isSpeaking
      ? 'bot-speaking'
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
  if (humanEntries.length < 2) {
    // 開場沉默：罐頭引導
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
  await speakProactive(session, text)
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

/** ② 決策層＋③ 執行層。 */
async function evaluateTurn(meetingInstanceId: string): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  const s = states.get(meetingInstanceId)
  if (!session || !session.botSession || !s || s.evaluating) return

  const now = Date.now()
  // 硬性防護：呼叫模型前先擋（省 token、避免搶話）。
  // 跳過時必留 log：原本靜默 return，實測「都不插話」時無從診斷是哪條擋的。
  const last = s.window[s.window.length - 1]
  const skipReason = session.quietMode
    ? 'quiet-mode' // 旗標可能在計時器排定後才切換，這裡要再擋一次
    : session.isSpeaking
    ? 'bot-speaking'
    : now - session.lastWakeAt < WAKE_GRACE_MS
      ? 'wake-grace'
      : session.wakePendingUntil > now
        ? 'wake-pending'
        : now - s.lastInterjectionAt < env.INTERJECTION_COOLDOWN_MS
          ? 'cooldown'
          : !last || last.fromBot
            ? 'last-entry-from-bot'
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
    const context = formatConversation(recent, { chatMarker: true })

    const raw = await completeText({
      maxTokens: 200,
      temperature: 0, // 決策要穩定（實測 temp 預設 1.0 時同情境會忽插忽不插）
      system: INTERJECTION_DECISION_SYSTEM,
      prompt: `最近的對話：\n\n${context}`,
      purpose: 'interjection',
    })

    let decision: { interject?: boolean; question?: string } = {}
    try {
      decision = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim())
    } catch {
      logger.warn({ meetingInstanceId, raw: raw.slice(0, 100) }, 'interjection: decision JSON parse failed')
      return
    }

    if (!decision.interject || !decision.question?.trim()) {
      logger.info({ meetingInstanceId }, 'interjection: decision = stay quiet')
      return
    }

    logger.info(
      { meetingInstanceId, question: decision.question.slice(0, 60) },
      'interjection: decision = interject, resolving answer',
    )

    const lastAtBeforeAnswer = s.window[s.window.length - 1]?.at
    const answer = await resolveAnswer(session, decision.question, 'chat')

    s.lastInterjectionAt = Date.now()

    // 檢索沒中（Dify 哨兵句）或空答案 → 沒東西可補充，安靜放棄本次插話。
    // 冷卻照計：同一個答不出的問題若反覆觸發決策＋檢索，只是浪費 quota。
    // （喚醒詞問答不在此列——使用者點名問就必須回應，哨兵句照常唸出。）
    if (!answer.trim() || answer === DIFY_NO_RESULT_SENTINEL) {
      logger.info(
        { meetingInstanceId, question: decision.question.slice(0, 40) },
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
      await sendChatBestEffort(session, `💡 ${answer}`)
    } else {
      logger.info({ meetingInstanceId }, 'interjection: room still silent, delivering via voice')
      await speakProactive(session, `我補充一下：${answer}`)
    }

    s.window.push({ speaker: '蜜塔', text: answer, source: 'chat', fromBot: true, at: Date.now() })
    logger.info({ meetingInstanceId, answerPreview: answer.slice(0, 60) }, 'interjection: answer sent to chat')
  } finally {
    s.evaluating = false
  }
}
