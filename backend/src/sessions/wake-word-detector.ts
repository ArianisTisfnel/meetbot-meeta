import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { botProvider } from '../provider/index.js'
import type { BotSession } from '../provider/types.js'
import * as dify from '../lib/dify.js'
import { toTraditional } from '../lib/zh.js'
import { completeText } from '../lib/llm.js'
import { recordConversation, getConversationWindow } from './interjection.js'
import { decideTurn, parseIntent, routeForIntent, type QuestionIntent } from './response-policy.js'
import type { ConversationEntryLike } from './interjection-prompts.js'
import { withReplyTag, type AnswerRoute, type ReplyTag } from './reply-tags.js'
import {
  decideAddressing,
  decideChatAddressing,
  isVocativeWake,
  DEBOUNCE_MS,
  STOP_COMMAND_REGEX,
} from './addressing.js'
import type { MeetingSession } from '../types/session.js'
import type { ChatMessageEvent } from '../provider/types.js'

// 意圖四分類的定義已移到 response-policy.ts（它現在是每輪語意決策的產出之一）。
// 這裡 re-export 保持既有 import 路徑不變（scripts/eval-meeting.ts、單元測試）。
export { parseIntent, routeForIntent, type QuestionIntent }

/** 取得已 admitted 的 bot session（喚醒詞只會在 admitted 後觸發，故必為非 null）。 */
function requireBotSession(session: MeetingSession): BotSession {
  if (!session.botSession) {
    throw new Error(`session ${session.meetingInstanceId} has no active bot session`)
  }
  return session.botSession
}

// 固定台詞（匯出供 session-manager 在 join 後 primeSpeech 預熱 TTS）。
/**
 * 收到提問的口頭確認。**措辭必須中性**：這句在意圖分類前就唸出去，
 * 此時還不知道會走 RAG／逐字稿／閒聊。舊版分成「正在查詢資料」「正在查閱會議記錄」
 * 兩句，結果跟蜜塔打招呼也被宣告要去查資料庫（回報 2026-07-28 A.2）。
 */
export const PENDING_VOICE = '好的，我收到了，請稍候。'
export const ERROR_VOICE = '抱歉，查詢時發生錯誤，請稍後再試。'
export const PROGRESS_VOICE = '等等喔，我正在頭腦風暴！'
/** 說完「我收到了」後自己計時：查詢還沒回來就說進度句（不然使用者會以為沒收到而重問）。 */
const PROGRESS_NOTICE_MS = 10_000

/**
 * 檢索沒中時給人看/聽的說法。
 *
 * Dify 那側回的是哨兵字串 `抱歉 沒有檢索到相關資訊`——**沒有標點是刻意的**，
 * 它是拿來做精確字串比對的內部訊號（interjection 靠 `answer === SENTINEL` 判斷
 * 「沒東西可補充就閉嘴」）。但直接唸出來或貼進聊天室，使用者只會覺得蜜塔壞了
 * （回報 2026-07-29）。所以哨兵句只在送出的最後一刻換成正常句子，
 * **內部流通的仍是原字串**，不動 interjection 的判斷。
 */
export const NO_RESULT_REPLY = '抱歉，我在專案資料裡找不到相關內容。'

/** 送出前把內部哨兵句換成人話。只用於喚醒詞問答（主動插話遇到哨兵是直接放棄不送）。 */
function presentAnswer(answer: string): string {
  return answer === dify.DIFY_NO_RESULT_SENTINEL ? NO_RESULT_REPLY : answer
}

/**
 * 語音播放速度估算參數（speak() 送出即返回，播放進度只能用估的）。
 * 匯出供測試歸零（單元測試不能真等 3-6 秒）。
 */
export const speechTiming = { msPerChar: 250, extraMs: 1500, floorMs: 3000 }

/**
 * 以字數估算一段語音的播放毫秒。speak() 是「送出就返回」（不等播放完），
 * 再 POST 新音檔會蓋掉播放中的 → 開口前必須等上一段唸完。
 */
function estimateSpeechMs(text: string): number {
  return Math.max(speechTiming.floorMs, text.length * speechTiming.msPerChar + speechTiming.extraMs)
}

/**
 * 在聊天室發訊息（best-effort：provider 不支援聊天室時記 warn 不中斷）。
 * channel='voice'：這則是語音發言的文字鏡像 → 逐字稿標「（語音）」而非「（聊天室）」。
 * tag：功能標籤（【資料檢索】等），**只前綴在送進會議聊天室的那一份**——
 * chatLog 與插話對話窗一律存原文，否則標籤會污染 LLM 輸入與會後逐字稿/摘要。
 */
export async function sendChatBestEffort(
  session: MeetingSession,
  text: string,
  channel: 'chat' | 'voice' = 'chat',
  tag?: ReplyTag,
): Promise<void> {
  try {
    await botProvider.sendChat?.(requireBotSession(session), withReplyTag(text, tag))
    // 蜜塔自己的聊天回覆也記進 chatLog（webhook 會過濾 bot 訊息，只能在送出端記錄）
    session.chatLog?.push({ speaker: '蜜塔', text, at: Date.now(), channel })
    // 也記進插話引擎的對話窗：決策層才知道「這個問題已經有人（蜜塔）回答過了」
    recordConversation(session, { speaker: '蜜塔', text, source: 'chat', fromBot: true, at: Date.now() })
  } catch (err) {
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'sendChat failed (best-effort)')
  }
}

// 定址判斷（「這句是不是在對蜜塔說話」）已抽到 addressing.ts——它是語意層的接縫，
// 也是 scripts/eval-meeting.ts 離線評測的對象。本檔只負責依 decision 施加狀態與 I/O。

/**
 * partial 快速喚醒的銜接窗：partial ack 後多久內到達的 final 段落
 * 視為同一次喚醒（跳過開場白）。同時也是 partial 重複 ack 的抑制期。
 */
const PARTIAL_ACK_WINDOW_MS = 12_000
const MAX_PROCESSED_SEGMENT_IDS = 5000
const CONVERSATION_IDLE_RESET_MS = 5 * 60 * 1000

// ── Barge-in 讓路（參考 joinly 的互動模式）────────────────────────────────────
//
// 蜜塔說話到一半有人開口 → 立刻停止語音讓路；被打斷的回答改貼聊天室（內容不遺失）。
// 由 session-manager 的 onSegment / onPartialSegment 呼叫（partial 先到 → 讓路最快）。

/** 短於此長度的內容視為附和（嗯、好的），不觸發讓路。 */
const BARGE_IN_MIN_CHARS = 4
// 明確停止指令（再短也觸發讓路，且不再轉貼被打斷的內容）的詞表定義在 addressing.ts，
// 與定址判斷共用同一份——這兩處對「什麼算叫停」的認定分岔的話，
// 會出現「打斷得了、卻同時被當成新問題送去查資料」這種自相矛盾的行為。

export async function handleBargeIn(
  session: MeetingSession,
  speech: { text: string; speaker: string; startTime?: number },
): Promise<void> {
  if (!session.isSpeaking) return
  const trimmed = speech.text.trim()
  const isStopCommand = STOP_COMMAND_REGEX.test(trimmed)
  if (!isStopCommand && trimmed.length < BARGE_IN_MIN_CHARS) return

  // STT 事件晚到防護：用「說話者實際開口的時間」判斷，不是事件到達時間。
  // 開口時間早於蜜塔開始說話 → 對方是在安靜期講的（例如等答案等太久重問一次），
  // 不是打斷。明確停止指令不受此限。
  if (!isStopCommand && speech.startTime !== undefined && session.sessionStartedAt > 0 && session.speechStartedAt > 0) {
    const spokeAt = session.sessionStartedAt + speech.startTime * 1000
    if (spokeAt < session.speechStartedAt) {
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, text: trimmed.slice(0, 30) },
        'barge-in skipped: utterance started before bot speech (late STT event)',
      )
      return
    }
  }

  // 先翻旗標再做 I/O：重複 partial 不會重入
  session.isSpeaking = false
  session.bargeEpoch++
  // 讓路後進入喚醒靜默期：打斷者的話多半是「剛問過的問題」的延續，
  // 沒有這行插話引擎會把它當新問題再答一次（實測 2026-07-04 發生過重複回答）
  session.lastWakeAt = Date.now()
  const interrupted = session.currentSpeech
  session.currentSpeech = null

  logger.info(
    { meetingInstanceId: session.meetingInstanceId, speaker: speech.speaker, text: speech.text.slice(0, 40) },
    'barge-in: human speech while bot speaking, yielding',
  )

  try {
    await botProvider.stopSpeaking?.(requireBotSession(session))
  } catch (err) {
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'barge-in: stopSpeaking failed (best-effort)')
  }

  // 被打斷的回答改走聊天室，內容不遺失；明確叫停（閉嘴/安靜）則不轉貼
  if (interrupted && !isStopCommand) {
    await sendChatBestEffort(session, `（先讓大家討論～完整回覆放這裡）${interrupted}`, 'chat', 'deferred')
  }
}

// ── 語音輸入（partial：快速喚醒確認）──────────────────────────────────────────
//
// partial 片段在講到一半就會到（比定稿早 1.5–3 秒），但內容不穩定，
// 只拿來做一件事：偵測到喚醒詞就先說開場確認（TTS 已預熱 → 體感觸發 ~1 秒）。
// 問題內容一律等定稿段落（handleTranscriptSegment），據 partialAckAt 跳過開場白。

export async function handlePartialSegment(
  session: MeetingSession,
  partial: { text: string; speaker: string },
): Promise<void> {
  // 只有句首呼喚才提早 ack：句中提及要等語意裁決，
  // 不然「我覺得蜜塔這個功能…」講到一半蜜塔就插嘴說「我收到了」。
  if (!partial.text || !isVocativeWake(partial.text)) return

  const now = Date.now()
  if (session.isSpeaking) return
  // 剛派發過問題（final 已處理）→ 不重複 ack
  if (now - session.lastWakeAt < DEBOUNCE_MS) return
  // 同一句的 partial 會重複推送 → 抑制期內只 ack 一次
  if (now - session.partialAckAt < PARTIAL_ACK_WINDOW_MS) return
  session.partialAckAt = now

  const pendingVoice = PENDING_VOICE
  logger.info(
    { meetingInstanceId: session.meetingInstanceId, speaker: partial.speaker, text: partial.text.slice(0, 40) },
    'partial wake detected, speaking pending prompt early',
  )
  try {
    await botProvider.speak(requireBotSession(session), pendingVoice)
    session.speechEndsAt = Date.now() + estimateSpeechMs(pendingVoice)
  } catch (err) {
    // ack 失敗不致命：清掉時間戳，讓 final 派發時照常說開場白
    session.partialAckAt = 0
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'partial wake ack speak failed')
  }
}

// ── 語音輸入 ───────────────────────────────────────────────────────────────────

export async function handleTranscriptSegment(
  session: MeetingSession,
  segment: { segment_id: string; text: string; speaker: string; start_time: number; end_time: number },
): Promise<void> {
  if (!segment.segment_id || session.processedSegmentIds.has(segment.segment_id)) return

  if (session.processedSegmentIds.size >= MAX_PROCESSED_SEGMENT_IDS) {
    const ids = [...session.processedSegmentIds]
    session.processedSegmentIds = new Set(ids.slice(Math.floor(ids.length / 2)))
  }
  session.processedSegmentIds.add(segment.segment_id)

  const now = Date.now()
  const decision = decideAddressing(session, { text: segment.text, speaker: segment.speaker, now })

  switch (decision.kind) {
    case 'ignore':
    case 'debounced':
      return

    // 沒喊名字但對話串還開著（可能是連續追問）→ **本層不處理**。
    // 交給 turn 結束時的 decideTurn：那一層等講完整輪才判，才不會每收到一個 STT 片段
    // 就打一次 LLM（一輪話常被切成好幾段）。這也是「每輪一次呼叫」的落點。
    case 'followup-candidate':
      return

    // 句中提及蜜塔：規則分不出「對她說」還是「談論她」→ 花一次便宜的 LLM 呼叫裁決。
    // 這裡**不等 turn 結束**：使用者剛喊了她的名字，等 2.5 秒才反應太慢。
    case 'ambiguous': {
      const turn = await decideTurn({
        window: windowEndingWith(session, {
          speaker: segment.speaker,
          text: segment.text,
          source: 'voice',
          fromBot: false,
        }),
        kbContentCard: session.kbContentCard,
      })
      logger.info(
        {
          meetingInstanceId: session.meetingInstanceId,
          verdict: turn.addressed,
          intent: turn.intent,
          wakeWord: decision.wakeWord,
          text: segment.text.slice(0, 60),
          speaker: segment.speaker,
        },
        'addressing: mid-utterance mention arbitrated',
      )
      // mention / none = 模型判定不是在對她說話 → 安靜（這正是回報 A.1 的病灶）。
      // unknown = 呼叫失敗（Gemini 免費層 429 是常態，見 docs/15）→ **退回舊行為照常回答**。
      // 「判不出來」絕不能等同「沒在叫我」：那會讓額度一枯竭蜜塔就對所有非逗號句型全聾，
      // 比偶爾多嘴嚴重得多。
      if (turn.addressed === 'mention' || turn.addressed === 'none') return
      // 問題內容以規則層擷取的為準：語意層可能把它濃縮或改寫，
      // 而送進 Dify 的字串走樣會直接影響檢索命中（規則層擷的是使用者的原話）。
      const question = decision.candidate
      if (!question) {
        // 只喊了名字、沒有問題內容 → 對話串照開，等下一段
        session.lastEngagedAt = now
        return
      }
      session.lastEngagedAt = now
      session.lastWakeAt = now
      await dispatchQuestion(session, question, 'voice', {
        skipPendingPrompt: consumePartialAck(session, now),
        speaker: segment.speaker,
        // 呼叫失敗（unknown）時 intent 是預設值，讓 dispatch 自己再判一次
        intent: turn.addressed === 'address' ? turn.intent : undefined,
      })
      return
    }

    // 明確叫停：關掉對話串，並吃掉喚醒寬限讓插話引擎安靜一陣子。
    // 真正的「閉嘴」動作不在這裡做——handleBargeIn 對同一段語音先跑，
    // 蜜塔正在說話時它已經停了語音；這裡負責的是「不要把叫停當成新問題去查資料」。
    // 關掉對話串同時也讓後續發言不再被當成追問候選（叫停就是叫停，不是換個方式繼續問）。
    case 'stop':
      session.lastEngagedAt = 0
      session.lastWakeAt = now
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, reason: decision.reason, speaker: segment.speaker },
        'addressing: stop command, staying quiet',
      )
      return

    // 只叫名字沒接問題：對話串照開、**不消耗 debounce**
    //（STT 常把「蜜塔，」finalize 成獨立 utterance，問題在下一段，
    //  下一段會是 followup-candidate，由 turn 結束時的語意層接上）。
    case 'wake-only':
      session.lastEngagedAt = now
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, wakeWord: decision.wakeWord, speaker: segment.speaker },
        'wake word matched without question, opening follow-up thread',
      )
      return

    case 'question':
      session.lastEngagedAt = now
      session.lastWakeAt = now
      logger.info(
        {
          meetingInstanceId: session.meetingInstanceId,
          reason: decision.reason,
          question: decision.question.slice(0, 60),
          speaker: segment.speaker,
        },
        'addressing: taking segment as a question, dispatching',
      )
      await dispatchQuestion(session, decision.question, 'voice', {
        skipPendingPrompt: consumePartialAck(session, now),
        speaker: segment.speaker,
      })
  }
}

/**
 * 組出「最後一則就是要判斷的那一句」的對話窗——decideTurn 的 prompt 以此為前提。
 *
 * 為什麼要自己補：`recordConversation` 由 session-manager 在 handler 之後才呼叫，
 * 而 handler 走到語意層時已經 await 過幾次，兩者的先後順序會隨呼叫路徑改變
 *（喚醒問答走到 resolveAnswerRouted 時已經記進去了，句中提及則還沒）。
 * 這裡補上並去重，兩條路都拿到同一種形狀的窗，不必去猜時序。
 */
function windowEndingWith(session: MeetingSession, entry: ConversationEntryLike): ConversationEntryLike[] {
  const recent: ConversationEntryLike[] = getConversationWindow(session.meetingInstanceId)
  const last = recent[recent.length - 1]
  if (last && last.text === entry.text && last.speaker === entry.speaker) return recent
  return [...recent, entry]
}

/** partial 快速喚醒已說過開場白？（一次性消耗，窗內的 final 派發跳過開場白） */
function consumePartialAck(session: MeetingSession, now: number): boolean {
  const acked = session.partialAckAt > 0 && now - session.partialAckAt < PARTIAL_ACK_WINDOW_MS
  session.partialAckAt = 0
  return acked
}

// ── 聊天室輸入 ─────────────────────────────────────────────────────────────────

export async function handleChatMessage(
  session: MeetingSession,
  chatMsg: ChatMessageEvent,
): Promise<void> {
  if (chatMsg.isFromBot) return

  const now = Date.now()
  const decision = decideChatAddressing(session, { text: chatMsg.text, speaker: chatMsg.sender, now })

  let question: string
  let intent: QuestionIntent | undefined
  if (decision.kind === 'question') {
    question = decision.question
  } else if (decision.kind === 'stop') {
    // 聊天室打「蜜塔 不用了」：同樣吃掉喚醒寬限，讓插話引擎別接著補一句
    session.lastWakeAt = now
    session.lastEngagedAt = 0
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, reason: decision.reason },
      'addressing: stop command in chat, staying quiet',
    )
    return
  } else if (decision.kind === 'ambiguous') {
    // 句中提及（「我覺得蜜塔這功能…」打在聊天室）→ 與語音同一套語意裁決
    const turn = await decideTurn({
      window: windowEndingWith(session, {
        speaker: chatMsg.sender,
        text: chatMsg.text,
        source: 'chat',
        fromBot: false,
      }),
      kbContentCard: session.kbContentCard,
    })
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, verdict: turn.addressed, intent: turn.intent, text: chatMsg.text.slice(0, 60) },
      'addressing: mid-message mention arbitrated (chat)',
    )
    // unknown（呼叫失敗）→ 退回舊行為照常回答，見語音路徑註解
    if (turn.addressed === 'mention' || turn.addressed === 'none') return
    question = decision.candidate
    if (turn.addressed === 'address') intent = turn.intent
  } else {
    return
  }

  // debounce 在確認有問題內容後才消耗，避免空喚醒吃掉緊接著的真問題。
  session.lastWakeAt = now
  session.lastEngagedAt = now
  await dispatchQuestion(session, question, 'chat', { intent })
}

/**
 * 沒喊名字的連續追問（回報 A.3）：由插話引擎在 turn 結束時判定為「在對蜜塔說話」後呼叫。
 *
 * 為什麼由那一層呼叫而不是 handleTranscriptSegment：判準要看整輪講完的內容，
 * 而且它與插話決策**是同一次 LLM 呼叫**的兩個出口，不該重複問一次。
 */
export async function answerFollowUp(
  session: MeetingSession,
  question: string,
  source: 'voice' | 'chat',
  opts?: { speaker?: string; intent?: QuestionIntent },
): Promise<void> {
  const now = Date.now()
  session.lastWakeAt = now
  session.lastEngagedAt = now
  logger.info(
    { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 60), source, intent: opts?.intent },
    'addressing: follow-up in open thread, dispatching',
  )
  await dispatchQuestion(session, question, source, { speaker: opts?.speaker, intent: opts?.intent })
}

// ── 主動語音（插話/破冰用）────────────────────────────────────────────────────
//
// 與喚醒回答共用 isSpeaking/currentSpeech/barge-in 機制；超過 100 字自動截斷
// （語音唸太長很煩），語音失敗退回聊天室。

export async function speakProactive(
  session: MeetingSession,
  text: string,
  tag?: ReplyTag,
): Promise<boolean> {
  if (session.isSpeaking) return false

  let speech = text
  if (speech.length > 100) {
    const truncated = speech.slice(0, 100)
    const lastPunct = truncated.search(/[。！？…][^。！？…]*$/)
    speech = (lastPunct > 0 ? truncated.slice(0, lastPunct + 1) : truncated) + '……詳細內容我放在聊天室。'
  }

  const estimatedMs = estimateSpeechMs(speech)
  session.isSpeaking = true
  session.speechStartedAt = Date.now()
  session.currentSpeech = speech
  session.speechEndsAt = Date.now() + estimatedMs
  setTimeout(() => {
    session.isSpeaking = false
    session.currentSpeech = null
  }, estimatedMs)

  try {
    await botProvider.speak(requireBotSession(session), speech)
    // 蜜塔的語音也算「有人在說話」：記進對話窗（重置破冰計時、讓決策層知道已回答）
    recordConversation(session, { speaker: '蜜塔', text: speech, source: 'voice', fromBot: true, at: Date.now() })
    if (speech !== text) {
      // 截斷過的長內容補完整版到聊天室（同時留逐字稿紀錄，標「（語音）」）
      await sendChatBestEffort(session, text, 'voice', tag)
    } else {
      // 沒發聊天室訊息也要留逐字稿紀錄（bot 聲音不進 STT，這裡是唯一留痕點）
      session.chatLog?.push({ speaker: '蜜塔', text: speech, at: Date.now(), channel: 'voice' })
    }
    return true
  } catch (err) {
    session.isSpeaking = false
    session.currentSpeech = null
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'speakProactive failed, falling back to chat')
    await sendChatBestEffort(session, text, 'chat', tag)
    return true
  }
}

// ── 意圖分流（Dify RAG 前）────────────────────────────────────────────────────
//
// 「你覺得這方案如何」直接丟 Dify RAG 會答「資料沒提到」→ 先判意圖再選資料來源。
// 判斷本身在 response-policy.ts 的 decideTurn（與定址／插話同一次呼叫），
// 本檔只負責「拿到 intent 之後要怎麼取答案」。分類失敗一律回退 factual（保持原行為）。

/**
 * 單一問題的意圖分類。**線上不再用它**——線上的 intent 一律來自 decideTurn 的同一次
 * 呼叫（見 resolveAnswerRouted）。留著是給 `scripts/eval-meeting.ts --intent` 用的：
 * 那個評測要的正是「單看這個問題該走哪條路」，退化成只有一則的對話窗即可。
 */
export async function classifyIntent(question: string, kbContentCard: string | null): Promise<QuestionIntent> {
  const { intent } = await decideTurn({
    window: [{ speaker: '參與者', text: question, source: 'voice', fromBot: false }],
    kbContentCard,
  })
  return intent
}

// ── 問答路由 ───────────────────────────────────────────────────────────────────

/**
 * 回答一題，並回報實際走到的資料來源。
 * route 供呼叫端標記功能標籤（【資料檢索】／【會議記錄】／【閒聊】）——
 * 沒有它就無法從聊天室分辨這句答案是查了知識庫還是只看逐字稿掰的。
 */
export async function resolveAnswerRouted(
  session: MeetingSession,
  question: string,
  mode: 'voice' | 'chat',
  /** 已經從 decideTurn 拿到的意圖（同一輪的呼叫產出）。沒給才自己判一次。 */
  knownIntent?: QuestionIntent,
): Promise<{ answer: string; route: AnswerRoute }> {
  if (!session.difyDatasetId) {
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, route: 'transcript' },
      'resolveAnswer: no difyDatasetId, answering from transcript',
    )
    const { answer } = await answerFromTranscript(session, question)
    return { answer, route: 'transcript' }
  }

  // 意圖分流：意見/脈絡型不走 RAG（會答「資料沒提到」）。
  // 句中提及／連續追問／插話這三條路的 intent 是跟定址一起判出來的（knownIntent），
  // 只有純規則定案的句首呼喚才需要在這裡補一次呼叫——總量與舊制的 classifyIntent 相同。
  const classifyStart = Date.now()
  const intent =
    knownIntent ??
    (
      await decideTurn({
        window: windowEndingWith(session, {
          speaker: '參與者',
          text: question,
          source: mode,
          fromBot: false,
        }),
        kbContentCard: session.kbContentCard,
      })
    ).intent
  const route = routeForIntent(intent, true)
  logger.info(
    {
      meetingInstanceId: session.meetingInstanceId,
      intent,
      route,
      mode,
      question: question.slice(0, 40),
      classifyMs: Date.now() - classifyStart,
      fromTurnDecision: knownIntent !== undefined,
    },
    'resolveAnswer: intent classified',
  )

  if (intent === 'chitchat') {
    return { answer: await answerChitchat(question), route }
  }

  if (intent === 'context') {
    const { answer } = await answerFromTranscript(session, question)
    return { answer, route }
  }

  // factual / hybrid 都先做 Dify 檢索
  if (session.lastQuestionAt > 0 && Date.now() - session.lastQuestionAt > CONVERSATION_IDLE_RESET_MS) {
    logger.info({ meetingInstanceId: session.meetingInstanceId }, 'Dify conversation reset: idle timeout')
    session.difyConversationId = null
  }

  const callDify = (conversationId: string | null) =>
    dify.askQuestion({
      datasetId: session.difyDatasetId!,
      question,
      mode,
      userId: session.meetingInstanceId,
      conversationId,
    })

  let factAnswer: string
  try {
    const { answer, conversationId } = await callDify(session.difyConversationId)
    session.difyConversationId = conversationId || session.difyConversationId
    session.lastQuestionAt = Date.now()
    factAnswer = answer
  } catch (err) {
    if (!session.difyConversationId) throw err
    logger.warn({ meetingInstanceId: session.meetingInstanceId }, 'Dify error, resetting conversation and retrying')
    session.difyConversationId = null
    const { answer, conversationId } = await callDify(null)
    session.difyConversationId = conversationId
    session.lastQuestionAt = Date.now()
    factAnswer = answer
  }

  if (intent !== 'hybrid') return { answer: factAnswer, route }

  // hybrid：把檢索到的事實與近期對話脈絡合成（合成失敗退回純檢索答案）
  try {
    const segments = await botProvider.getTranscript(requireBotSession(session))
    const context = segments
      .slice(-30)
      .map((seg) => `[${seg.speaker || '參與者'}]: ${seg.text}`)
      .join('\n')
    const composed = await completeText({
      system: [
        '開頭規則：第一個字就直接講內容——不打招呼（哈囉、嗨、你好）、不自我介紹（我是蜜塔）、不稱呼對方（老闆、大家）。',
        '你是在線的 AI 會議助理蜜塔（Meeta）。根據「資料查詢結果」與「會議近期對話」綜合回答問題。語氣口語、自然、親切，像同事聊天；簡潔（100 字內）、繁體中文。',
      ].join('\n'),
      prompt: `資料查詢結果：\n${factAnswer}\n\n會議近期對話：\n${context}\n\n請回答：${question}`,
      maxTokens: 512,
    })
    return { answer: toTraditional(composed || factAnswer), route }
  } catch (err) {
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'hybrid compose failed, using fact answer')
    return { answer: factAnswer, route }
  }
}

/**
 * 只要答案的薄包裝（主動插話用——插話的標籤固定是【冷場插話】，不需要資料來源）。
 */
export async function resolveAnswer(
  session: MeetingSession,
  question: string,
  mode: 'voice' | 'chat',
  knownIntent?: QuestionIntent,
): Promise<string> {
  const { answer } = await resolveAnswerRouted(session, question, mode, knownIntent)
  return answer
}

// ── 回答通道與優先權 ──────────────────────────────────────────────────────────
// 1. 語音問 → 語音答（嘴巴說「我收到了」→ 答案；長答案唸重點+完整版補聊天室）
//    ＋聊天室同步貼「👂 收到 XXX 的問題」（<1 秒的視覺確認；語音要 3-5 秒才聽得到）
// 2. 聊天室問 → 聊天室答，全程不出聲（打字提問通常是不想打斷討論）
// 3. 兩通道並行互不阻塞；「嘴巴」是獨占資源——語音回答進行中又有語音問題
//    → 該題改走聊天室（不丟棄）
// 4. 同一人同時用兩邊問同一題（2 秒內）→ debounce 視為同一題，先到的通道回答
//    （聊天室沒有 STT 延遲通常先到）

async function dispatchQuestion(
  session: MeetingSession,
  question: string,
  source: 'voice' | 'chat',
  opts?: { skipPendingPrompt?: boolean; speaker?: string; intent?: QuestionIntent },
): Promise<void> {
  const pendingVoice = PENDING_VOICE
  // ack 在意圖分類**之前**送出，此時還不知道會走 RAG／逐字稿／閒聊哪條路，
  // 也還不知道對方到底是不是在提問 → 措辭必須中性。踩過兩次：
  //   舊版寫「正在查詢資料中……」→ 跟蜜塔打招呼也被宣告要去查資料庫（回報 07-28 A.2）
  //   接著寫「收到…的問題」→ 對「哈囉」硬把打招呼講成提問（回報 07-29）
  // 實際走哪條路由答案自己的功能標籤說明，ack 只負責「我聽到了，等我一下」。
  const pendingChat = '收到，稍等一下～'
  // 講者未知時不可留著「的」：舊版模板無條件插「的」，混音轉錄拿不到人名時
  // 就印出「👂 收到的問題」這種破碎中文（回報 2026-07-28 A.4 的表面症狀）。
  const ackChat = opts?.speaker
    ? `👂 收到 ${opts.speaker}：「${question.slice(0, 40)}」，稍等一下～`
    : `👂 收到：「${question.slice(0, 40)}」，稍等一下～`

  if (source === 'voice') {
    // 嘴巴被佔用（正在回答上一題）→ 這題不丟棄，改走聊天室
    if (session.isSpeaking) {
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 40) },
        'dispatchQuestion voice: bot is speaking, routing this question to chat',
      )
      await sendChatBestEffort(session, ackChat, 'chat', 'ack')
      try {
        const { answer, route } = await resolveAnswerRouted(session, question, 'chat', opts?.intent)
        await sendChatBestEffort(session, presentAnswer(answer), 'chat', route)
      } catch (err) {
        logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'voice→chat fallback failed')
        await sendChatBestEffort(session, ERROR_VOICE, 'chat', 'error')
      }
      return
    }
    // 聊天室即時確認（標明是誰的哪一題）：唯一 <1 秒的回饋通道
    void sendChatBestEffort(session, ackChat, 'chat', 'ack')
    // partial 快速喚醒已先說過開場白 → 跳過，直接查詢
    const speakPending = !opts?.skipPendingPrompt
    const promptEstimatedMs = speakPending ? estimateSpeechMs(pendingVoice) : 0
    const epochAtStart = session.bargeEpoch // 查詢期間被 barge-in 打斷 → 答案改走聊天室
    session.isSpeaking = true
    session.speechStartedAt = Date.now()
    const lockTimer = setTimeout(() => { session.isSpeaking = false }, promptEstimatedMs + 10_000)

    // 查詢太久（Dify 常要 15-20 秒）→ 口頭回報進度，避免使用者以為沒收到而重問
    const progressTimer = setTimeout(() => {
      botProvider
        .speak(requireBotSession(session), PROGRESS_VOICE)
        .then(() => { session.speechEndsAt = Date.now() + estimateSpeechMs(PROGRESS_VOICE) })
        .catch(() => sendChatBestEffort(session, PROGRESS_VOICE))
    }, PROGRESS_NOTICE_MS)

    try {
      const botSession = requireBotSession(session)
      // 查詢與開場白並行：不等開場白唸完才開始查（省下開場白的 3-5 秒）
      const answerPromise = resolveAnswerRouted(session, question, 'voice', opts?.intent)
      answerPromise.catch(() => {}) // 先掛 handler：開場白 throw 時查詢的 rejection 才不會變 unhandled
      if (speakPending) {
        session.currentSpeech = pendingVoice
        await botProvider.speak(botSession, pendingVoice)
        session.speechEndsAt = Date.now() + promptEstimatedMs
      }

      const { answer: resolved, route } = await answerPromise
      // 哨兵句在這裡就換成人話：後面的截斷、朗讀、聊天室鏡像全部沿用同一份文字
      const rawAnswer = presentAnswer(resolved)
      clearTimeout(progressTimer)

      // 開場白／查詢期間有人開口（barge-in）→ 不再出聲，完整答案貼聊天室
      if (session.bargeEpoch !== epochAtStart) {
        clearTimeout(lockTimer)
        session.isSpeaking = false
        session.currentSpeech = null
        await sendChatBestEffort(session, rawAnswer, 'chat', route)
        logger.info(
          { meetingInstanceId: session.meetingInstanceId, route },
          'dispatchQuestion voice: interrupted during query, answer delivered via chat',
        )
        return
      }

      let answer = rawAnswer
      if (rawAnswer.length > 100) {
        const truncated = rawAnswer.slice(0, 100)
        const lastPunct = truncated.search(/[。！？…][^。！？…]*$/)
        answer = (lastPunct > 0 ? truncated.slice(0, lastPunct + 1) : truncated) + '……如果想了解更多，可以繼續問我。'
      }

      // 答案再快也要等上一段語音（開場白/partial ack/進度句）唸完才開口——
      // speak() 送出即返回，疊著 POST 會把播放中的音檔蓋掉（聽起來像語音壞掉）。
      // 等待的空檔先把答案的 TTS 合成進快取，等完即播不再多耗時。
      const warmPromise = botProvider.primeSpeech?.(botSession, [answer])?.catch(() => {})
      const speechWaitMs = session.speechEndsAt - Date.now()
      if (speechWaitMs > 0) await new Promise((r) => setTimeout(r, speechWaitMs))
      await warmPromise

      // 等待期間被打斷 → 同樣改走聊天室，不搶話
      if (session.bargeEpoch !== epochAtStart) {
        clearTimeout(lockTimer)
        session.isSpeaking = false
        session.currentSpeech = null
        await sendChatBestEffort(session, rawAnswer, 'chat', route)
        logger.info(
          { meetingInstanceId: session.meetingInstanceId, route },
          'dispatchQuestion voice: interrupted while waiting for prompt to finish, answer via chat',
        )
        return
      }

      clearTimeout(lockTimer)
      const answerEstimatedMs = estimateSpeechMs(answer)
      session.currentSpeech = answer
      session.speechEndsAt = Date.now() + answerEstimatedMs
      setTimeout(() => {
        session.isSpeaking = false
        session.currentSpeech = null
      }, answerEstimatedMs)

      await botProvider.speak(botSession, answer)
      // 蜜塔的語音回答記進對話窗（重置破冰計時、決策層可見已回答）
      recordConversation(session, { speaker: '蜜塔', text: answer, source: 'voice', fromBot: true, at: Date.now() })
      // 語音回答同步貼聊天室：留下文字紀錄（會後隨 chatLog 併入逐字稿，標「（語音）」），
      // 長答案被截短唸出時，完整版也在這裡補上
      await sendChatBestEffort(session, rawAnswer, 'voice', route)
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, route, answerPreview: answer.slice(0, 60) },
        'dispatchQuestion voice: answer spoken',
      )
    } catch (err) {
      clearTimeout(lockTimer)
      clearTimeout(progressTimer)
      session.isSpeaking = false
      session.currentSpeech = null
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion voice failed')
      // 靜默失敗會讓使用者以為蜜塔沒反應 → 盡力口頭回報（失敗則退回聊天室）。
      try {
        await botProvider.speak(requireBotSession(session), ERROR_VOICE)
      } catch {
        await sendChatBestEffort(session, ERROR_VOICE, 'chat', 'error')
      }
    }
  } else {
    await sendChatBestEffort(session, pendingChat, 'chat', 'ack')

    try {
      const { answer, route } = await resolveAnswerRouted(session, question, 'chat', opts?.intent)
      await sendChatBestEffort(session, presentAnswer(answer), 'chat', route)
    } catch (err) {
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion chat failed')
      await sendChatBestEffort(session, '抱歉，查詢時發生錯誤，請稍後再試。', 'chat', 'error')
    }
  }
}

// ── 閒聊直答（不碰 Dify、不碰逐字稿）──────────────────────────────────────────

const CHITCHAT_FALLBACK = '我在喔！有什麼需要幫忙的，隨時叫我～'

async function answerChitchat(question: string): Promise<string> {
  try {
    const text = await completeText({
      system:
        '你是在線的 AI 會議助理蜜塔（Meeta）。有人跟你寒暄或閒聊，請用一到兩句話友善回應，口語、繁體中文、40 字內。不要查資料、不要反問。',
      prompt: question,
      maxTokens: 100,
    })
    return toTraditional(text.trim() || CHITCHAT_FALLBACK)
  } catch (err) {
    logger.warn({ err }, 'answerChitchat failed, using canned reply')
    return CHITCHAT_FALLBACK
  }
}

// ── 逐字稿 Q&A（無知識庫路徑）─────────────────────────────────────────────────

async function answerFromTranscript(
  session: MeetingSession,
  question: string,
): Promise<{ answer: string }> {
  const allSegments = await botProvider.getTranscript(requireBotSession(session))
  // 語音逐字稿＋聊天室訊息（chatLog 含使用者與蜜塔）依時間合併：
  // 純打字會議沒有 STT 段落，只靠 getTranscript 會回「逐字稿不足」
  //（實測 2026-07-07：意見題四連敗全是這個原因）。
  const merged = [
    ...allSegments.map((seg) => ({
      at: session.sessionStartedAt > 0 ? session.sessionStartedAt + seg.startTime * 1000 : 0,
      speaker: seg.speaker || '參與者',
      text: seg.text,
    })),
    ...(session.chatLog ?? []).map((m) => ({ at: m.at, speaker: m.speaker, text: m.text })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-30)
  if (!merged.length) {
    return { answer: '目前還沒有足夠的會議內容可以回答，請稍後再試。' }
  }
  const context = merged.map((l) => `[${l.speaker}]: ${l.text}`).join('\n')

  const text = await completeText({
    system: [
      '開頭規則：第一個字就直接講內容——不打招呼（哈囉、嗨、你好）、不自我介紹（我是蜜塔）、不稱呼對方。',
      '你是在線的 AI 會議助理蜜塔（Meeta），正在會議中即時回答。回答會以語音唸出。語氣口語、自然、親切；簡潔（100 字內）、繁體中文。',
      '兩類問題都要能答：',
      '1. 事實型（剛才提到什麼、時程是什麼）：根據逐字稿內容回答；逐字稿沒有就直說找不到。',
      '2. 意見型（你覺得這個提議如何、有什麼建議）：根據討論脈絡給出具體、可執行的看法或建議，不要推託說無法回答。',
      '不要反問使用者。資訊不足時，直接說出你手上最相關的資訊，並用一句話註明還缺什麼。',
    ].join('\n'),
    prompt: `以下是近期的會議逐字稿片段：\n\n${context}\n\n請回答：${question}`,
    maxTokens: 512,
  })
  return { answer: toTraditional(text || '抱歉，無法取得回答。') }
}
