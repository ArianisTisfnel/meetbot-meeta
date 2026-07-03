import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { botProvider } from '../provider/index.js'
import type { BotSession } from '../provider/types.js'
import * as dify from '../lib/dify.js'
import { toTraditional } from '../lib/zh.js'
import { completeText } from '../lib/llm.js'
import { recordConversation } from './interjection.js'
import type { MeetingSession, VexaChatMessage } from '../types/session.js'

/** 取得已 admitted 的 bot session（喚醒詞只會在 admitted 後觸發，故必為非 null）。 */
function requireBotSession(session: MeetingSession): BotSession {
  if (!session.botSession) {
    throw new Error(`session ${session.meetingInstanceId} has no active bot session`)
  }
  return session.botSession
}

// 固定台詞（匯出供 session-manager 在 join 後 primeSpeech 預熱 TTS）。
export const PENDING_VOICE_KB = '好的，我收到了，正在查詢資料，請稍候。'
export const PENDING_VOICE_TRANSCRIPT = '好的，我收到了，正在查閱會議記錄，請稍候。'
export const ERROR_VOICE = '抱歉，查詢時發生錯誤，請稍後再試。'

/** 在聊天室發訊息（best-effort：provider 不支援聊天室時記 warn 不中斷）。 */
export async function sendChatBestEffort(session: MeetingSession, text: string): Promise<void> {
  try {
    await botProvider.sendChat?.(requireBotSession(session), text)
    // 蜜塔自己的聊天回覆也記進 chatLog（webhook 會過濾 bot 訊息，只能在送出端記錄）
    session.chatLog?.push({ speaker: '蜜塔', text, at: Date.now() })
    // 也記進插話引擎的對話窗：決策層才知道「這個問題已經有人（蜜塔）回答過了」
    recordConversation(session, { speaker: '蜜塔', text, source: 'chat', fromBot: true, at: Date.now() })
  } catch (err) {
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'sendChat failed (best-effort)')
  }
}

// 字元集涵蓋 STT 常見誤轉：實測 recallai_streaming 會把「蜜塔」轉成「米塔」等。
const WAKE_WORD_REGEX = /[蜜密祕秘迷米咪][塔搭達]|小幫手|[Mm]e{1,2}ta|[Mm]ita/
const DEBOUNCE_MS = 2000
/** 喚醒待命窗長度：只叫名字沒問題後，等後續段落接問題的時間。 */
const WAKE_PENDING_MS = 8000
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
/** 明確停止指令：再短也觸發讓路，且不再轉貼被打斷的內容（使用者就是不想聽）。 */
const STOP_COMMAND_REGEX = /^(閉嘴|安靜|住嘴|停|停止|別說了|不用了|不用說了|夠了)[。！!～~]*$/

export async function handleBargeIn(
  session: MeetingSession,
  speech: { text: string; speaker: string },
): Promise<void> {
  if (!session.isSpeaking) return
  const trimmed = speech.text.trim()
  const isStopCommand = STOP_COMMAND_REGEX.test(trimmed)
  if (!isStopCommand && trimmed.length < BARGE_IN_MIN_CHARS) return

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
    await sendChatBestEffort(session, `（先讓大家討論～完整回覆放這裡）${interrupted}`)
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
  if (!partial.text || !WAKE_WORD_REGEX.test(partial.text)) return

  const now = Date.now()
  if (session.isSpeaking) return
  // 剛派發過問題（final 已處理）→ 不重複 ack
  if (now - session.lastWakeAt < DEBOUNCE_MS) return
  // 同一句的 partial 會重複推送 → 抑制期內只 ack 一次
  if (now - session.partialAckAt < PARTIAL_ACK_WINDOW_MS) return
  session.partialAckAt = now

  const pendingVoice = session.difyDatasetId ? PENDING_VOICE_KB : PENDING_VOICE_TRANSCRIPT
  logger.info(
    { meetingInstanceId: session.meetingInstanceId, speaker: partial.speaker, text: partial.text.slice(0, 40) },
    'partial wake detected, speaking pending prompt early',
  )
  try {
    await botProvider.speak(requireBotSession(session), pendingVoice)
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
  const match = WAKE_WORD_REGEX.exec(segment.text)

  if (!match) {
    // 喚醒待命窗：前一段只叫了名字，這段（同說話者）直接視為問題。
    if (
      session.wakePendingUntil > 0 &&
      now <= session.wakePendingUntil &&
      (!session.wakePendingSpeaker || session.wakePendingSpeaker === segment.speaker)
    ) {
      const question = segment.text.trim()
      if (!question) return
      session.wakePendingUntil = 0
      session.wakePendingSpeaker = null
      session.lastWakeAt = now
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 60), speaker: segment.speaker },
        'wake pending window: follow-up segment taken as question',
      )
      await dispatchQuestion(session, question, 'voice', { skipPendingPrompt: consumePartialAck(session, now) })
    }
    return
  }

  if (now - session.lastWakeAt < DEBOUNCE_MS) return

  const question = segment.text
    .slice(match.index + match[0].length)
    .replace(/^[\s，。！？、…]+/, '')
    .trim()

  // 只叫名字沒接問題：開待命窗等下一段，**不消耗 debounce**
  //（STT 常把「蜜塔，」finalize 成獨立 utterance，問題在下一段）。
  if (!question) {
    session.wakePendingUntil = now + WAKE_PENDING_MS
    session.wakePendingSpeaker = segment.speaker || null
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, wakeWord: match[0], speaker: segment.speaker },
      'wake word matched without question, opening pending window',
    )
    return
  }

  session.lastWakeAt = now
  session.wakePendingUntil = 0
  session.wakePendingSpeaker = null
  logger.info(
    { meetingInstanceId: session.meetingInstanceId, wakeWord: match[0], question: question.slice(0, 60), speaker: segment.speaker },
    'wake word matched (voice), dispatching question',
  )
  await dispatchQuestion(session, question, 'voice', { skipPendingPrompt: consumePartialAck(session, now) })
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
  chatMsg: VexaChatMessage,
): Promise<void> {
  if (chatMsg.is_from_bot) return

  const match = WAKE_WORD_REGEX.exec(chatMsg.text)
  if (!match) return

  const now = Date.now()
  if (now - session.lastWakeAt < DEBOUNCE_MS) return

  const question = chatMsg.text
    .slice(match.index + match[0].length)
    .replace(/^[\s，。！？、…]+/, '')
    .trim()
  if (!question) return

  // debounce 在確認有問題內容後才消耗，避免空喚醒吃掉緊接著的真問題。
  session.lastWakeAt = now
  await dispatchQuestion(session, question, 'chat')
}

// ── 主動語音（插話/破冰用）────────────────────────────────────────────────────
//
// 與喚醒回答共用 isSpeaking/currentSpeech/barge-in 機制；超過 100 字自動截斷
// （語音唸太長很煩），語音失敗退回聊天室。

export async function speakProactive(session: MeetingSession, text: string): Promise<boolean> {
  if (session.isSpeaking) return false

  let speech = text
  if (speech.length > 100) {
    const truncated = speech.slice(0, 100)
    const lastPunct = truncated.search(/[。！？…][^。！？…]*$/)
    speech = (lastPunct > 0 ? truncated.slice(0, lastPunct + 1) : truncated) + '……詳細內容我放在聊天室。'
  }

  const estimatedMs = Math.max(3000, (speech.length / 4) * 1000 + 1500)
  session.isSpeaking = true
  session.currentSpeech = speech
  setTimeout(() => {
    session.isSpeaking = false
    session.currentSpeech = null
  }, estimatedMs)

  try {
    await botProvider.speak(requireBotSession(session), speech)
    // 截斷過的長內容補完整版到聊天室
    if (speech !== text) await sendChatBestEffort(session, text)
    return true
  } catch (err) {
    session.isSpeaking = false
    session.currentSpeech = null
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'speakProactive failed, falling back to chat')
    await sendChatBestEffort(session, text)
    return true
  }
}

// ── 意圖分流（Dify RAG 前）────────────────────────────────────────────────────
//
// 「你覺得這方案如何」直接丟 Dify RAG 會答「資料沒提到」→ 先用便宜的 LLM 三分類：
//   factual：查文件就能答（報名日期）→ Dify RAG（原路）
//   context：意見/脈絡型（你覺得如何）→ LLM＋近期逐字稿
//   hybrid ：兩者都要（依簡章看我們時程合理嗎）→ 先 Dify 檢索、再與脈絡合成
// 分類失敗一律回退 factual（保持原行為）。

export type QuestionIntent = 'factual' | 'context' | 'hybrid'

/** 把分類器輸出解析成意圖（寬鬆比對；未知回 factual）。純函式，可測。 */
export function parseIntent(raw: string): QuestionIntent {
  const t = raw.toLowerCase()
  if (t.includes('hybrid') || t.includes('混合')) return 'hybrid'
  if (t.includes('context') || t.includes('意見') || t.includes('脈絡')) return 'context'
  return 'factual'
}

async function classifyIntent(question: string): Promise<QuestionIntent> {
  try {
    const raw = await completeText({
      system: [
        '你是會議助理的問題分類器。把問題分成三類，只回傳一個詞：',
        'factual = 查專案文件/資料就能回答的事實型問題（日期、金額、規則、名額）',
        'context = 需要對話脈絡或主觀判斷的問題（你覺得如何、有什麼建議、剛才誰說了什麼）',
        'hybrid = 同時需要文件資料與對話脈絡（依照文件看我們的討論/規劃合理嗎）',
      ].join('\n'),
      prompt: `問題：${question}`,
      maxTokens: 10,
    })
    return parseIntent(raw)
  } catch (err) {
    logger.warn({ err }, 'classifyIntent failed, falling back to factual')
    return 'factual'
  }
}

// ── 問答路由 ───────────────────────────────────────────────────────────────────

export async function resolveAnswer(
  session: MeetingSession,
  question: string,
  mode: 'voice' | 'chat',
): Promise<string> {
  if (!session.difyDatasetId) {
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, route: 'transcript' },
      'resolveAnswer: no difyDatasetId, answering from transcript',
    )
    const { answer } = await answerFromTranscript(session, question)
    return answer
  }

  // 意圖分流：意見/脈絡型不走 RAG（會答「資料沒提到」）
  const intent = await classifyIntent(question)
  logger.info(
    { meetingInstanceId: session.meetingInstanceId, intent, mode, question: question.slice(0, 40) },
    'resolveAnswer: intent classified',
  )

  if (intent === 'context') {
    const { answer } = await answerFromTranscript(session, question)
    return answer
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

  if (intent !== 'hybrid') return factAnswer

  // hybrid：把檢索到的事實與近期對話脈絡合成（合成失敗退回純檢索答案）
  try {
    const segments = await botProvider.getTranscript(requireBotSession(session))
    const context = segments
      .slice(-30)
      .map((seg) => `[${seg.speaker || '參與者'}]: ${seg.text}`)
      .join('\n')
    const composed = await completeText({
      system:
        '你是在線的 AI 會議助理蜜塔（Meeta）。根據「資料查詢結果」與「會議近期對話」綜合回答問題，口語、簡潔（100 字內）、繁體中文。',
      prompt: `資料查詢結果：\n${factAnswer}\n\n會議近期對話：\n${context}\n\n請回答：${question}`,
      maxTokens: 512,
    })
    return toTraditional(composed || factAnswer)
  } catch (err) {
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'hybrid compose failed, using fact answer')
    return factAnswer
  }
}

async function dispatchQuestion(
  session: MeetingSession,
  question: string,
  source: 'voice' | 'chat',
  opts?: { skipPendingPrompt?: boolean },
): Promise<void> {
  const pendingVoice = session.difyDatasetId ? PENDING_VOICE_KB : PENDING_VOICE_TRANSCRIPT
  const pendingChat = session.difyDatasetId
    ? '收到你的問題，正在查詢資料中……'
    : '收到你的問題，正在查閱會議記錄……'

  if (source === 'voice') {
    if (session.isSpeaking) return
    // partial 快速喚醒已先說過開場白 → 跳過，直接查詢
    const speakPending = !opts?.skipPendingPrompt
    const promptEstimatedMs = speakPending ? Math.max(3000, (pendingVoice.length / 4) * 1000 + 1500) : 0
    const epochAtStart = session.bargeEpoch // 查詢期間被 barge-in 打斷 → 答案改走聊天室
    session.isSpeaking = true
    const lockTimer = setTimeout(() => { session.isSpeaking = false }, promptEstimatedMs + 10_000)

    try {
      const botSession = requireBotSession(session)
      if (speakPending) {
        session.currentSpeech = pendingVoice
        await botProvider.speak(botSession, pendingVoice)
      }

      const rawAnswer = await resolveAnswer(session, question, 'voice')

      // 開場白／查詢期間有人開口（barge-in）→ 不再出聲，完整答案貼聊天室
      if (session.bargeEpoch !== epochAtStart) {
        clearTimeout(lockTimer)
        session.isSpeaking = false
        session.currentSpeech = null
        await sendChatBestEffort(session, rawAnswer)
        logger.info(
          { meetingInstanceId: session.meetingInstanceId },
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

      clearTimeout(lockTimer)
      const answerEstimatedMs = Math.max(3000, (answer.length / 4) * 1000 + 1500)
      session.currentSpeech = answer
      setTimeout(() => {
        session.isSpeaking = false
        session.currentSpeech = null
      }, promptEstimatedMs + answerEstimatedMs)

      await botProvider.speak(botSession, answer)
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, answerPreview: answer.slice(0, 60) },
        'dispatchQuestion voice: answer spoken',
      )
    } catch (err) {
      clearTimeout(lockTimer)
      session.isSpeaking = false
      session.currentSpeech = null
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion voice failed')
      // 靜默失敗會讓使用者以為蜜塔沒反應 → 盡力口頭回報（失敗則退回聊天室）。
      try {
        await botProvider.speak(requireBotSession(session), ERROR_VOICE)
      } catch {
        await sendChatBestEffort(session, ERROR_VOICE)
      }
    }
  } else {
    await sendChatBestEffort(session, pendingChat)

    try {
      const answer = await resolveAnswer(session, question, 'chat')
      await sendChatBestEffort(session, answer)
    } catch (err) {
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion chat failed')
      await sendChatBestEffort(session, '抱歉，查詢時發生錯誤，請稍後再試。')
    }
  }
}

// ── 逐字稿 Q&A（無知識庫路徑）─────────────────────────────────────────────────

async function answerFromTranscript(
  session: MeetingSession,
  question: string,
): Promise<{ answer: string }> {
  const allSegments = await botProvider.getTranscript(requireBotSession(session))
  const recentSegments = allSegments.slice(-30)
  if (!recentSegments.length) {
    return { answer: '目前還沒有足夠的逐字稿內容可以回答，請稍後再試。' }
  }
  const context = recentSegments
    .map((seg) => `[${seg.speaker || '參與者'}]: ${seg.text}`)
    .join('\n')

  const text = await completeText({
    system: [
      '你是在線的 AI 會議助理蜜塔（Meeta），正在會議中即時回答。回答會以語音唸出，請口語、簡潔（100 字內）、繁體中文。',
      '兩類問題都要能答：',
      '1. 事實型（剛才提到什麼、時程是什麼）：根據逐字稿內容回答；逐字稿沒有就直說找不到。',
      '2. 意見型（你覺得這個提議如何、有什麼建議）：根據討論脈絡給出具體、可執行的看法或建議，不要推託說無法回答。',
    ].join('\n'),
    prompt: `以下是近期的會議逐字稿片段：\n\n${context}\n\n請回答：${question}`,
    maxTokens: 512,
  })
  return { answer: toTraditional(text || '抱歉，無法取得回答。') }
}
