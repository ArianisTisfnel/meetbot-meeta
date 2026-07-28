import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { botProvider } from '../provider/index.js'
import type { BotSession } from '../provider/types.js'
import * as dify from '../lib/dify.js'
import { toTraditional } from '../lib/zh.js'
import { completeText } from '../lib/llm.js'
import { recordConversation, getConversationWindow } from './interjection.js'
import { arbitrateAddress } from './response-policy.js'
import { withReplyTag, type AnswerRoute, type ReplyTag } from './reply-tags.js'
import {
  decideAddressing,
  decideChatAddressing,
  isVocativeWake,
  DEBOUNCE_MS,
  WAKE_PENDING_MS,
} from './addressing.js'
import type { MeetingSession, VexaChatMessage } from '../types/session.js'

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
/** 明確停止指令：再短也觸發讓路，且不再轉貼被打斷的內容（使用者就是不想聽）。 */
const STOP_COMMAND_REGEX = /^(閉嘴|安靜|住嘴|停|停止|別說了|不用了|不用說了|夠了)[。！!～~]*$/

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

    // 句中提及蜜塔：規則分不出「對她說」還是「談論她」→ 花一次便宜的 LLM 呼叫裁決。
    // 只有這一小撮案例付這個成本，句首呼喚仍是零成本零延遲。
    case 'ambiguous': {
      const verdict = await arbitrateAddress({
        text: segment.text,
        speaker: segment.speaker,
        recent: getConversationWindow(session.meetingInstanceId),
      })
      logger.info(
        {
          meetingInstanceId: session.meetingInstanceId,
          verdict,
          wakeWord: decision.wakeWord,
          text: segment.text.slice(0, 60),
          speaker: segment.speaker,
        },
        'addressing: mid-utterance mention arbitrated',
      )
      // mention = 模型判定在談論蜜塔 → 安靜（這正是回報 A.1 的病灶）。
      // unknown = 呼叫失敗（Gemini 免費層 429 是常態，見 docs/15）→ **退回舊行為照常回答**。
      // 「判不出來」絕不能等同「沒在叫我」：那會讓額度一枯竭蜜塔就對所有非逗號句型全聾，
      // 比偶爾多嘴嚴重得多。
      if (verdict === 'mention') return
      if (!decision.candidate) {
        session.wakePendingUntil = now + WAKE_PENDING_MS
        session.wakePendingSpeaker = segment.speaker || null
        return
      }
      session.wakePendingUntil = 0
      session.wakePendingSpeaker = null
      session.lastWakeAt = now
      await dispatchQuestion(session, decision.candidate, 'voice', {
        skipPendingPrompt: consumePartialAck(session, now),
        speaker: segment.speaker,
      })
      return
    }

    // 只叫名字沒接問題：開待命窗等下一段，**不消耗 debounce**
    //（STT 常把「蜜塔，」finalize 成獨立 utterance，問題在下一段）。
    case 'wake-pending':
      session.wakePendingUntil = now + WAKE_PENDING_MS
      session.wakePendingSpeaker = segment.speaker || null
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, wakeWord: decision.wakeWord, speaker: segment.speaker },
        'wake word matched without question, opening pending window',
      )
      return

    case 'question':
      session.wakePendingUntil = 0
      session.wakePendingSpeaker = null
      session.lastWakeAt = now
      logger.info(
        {
          meetingInstanceId: session.meetingInstanceId,
          reason: decision.reason,
          viaPendingWindow: decision.viaPendingWindow,
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

  const now = Date.now()
  const decision = decideChatAddressing(session, { text: chatMsg.text, speaker: chatMsg.sender, now })

  let question: string
  if (decision.kind === 'question') {
    question = decision.question
  } else if (decision.kind === 'ambiguous') {
    // 句中提及（「我覺得蜜塔這功能…」打在聊天室）→ 與語音同一套語意裁決
    const verdict = await arbitrateAddress({
      text: chatMsg.text,
      speaker: chatMsg.sender,
      recent: getConversationWindow(session.meetingInstanceId),
    })
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, verdict, text: chatMsg.text.slice(0, 60) },
      'addressing: mid-message mention arbitrated (chat)',
    )
    if (verdict === 'mention') return // unknown（呼叫失敗）→ 退回舊行為照常回答，見語音路徑註解
    question = decision.candidate
  } else {
    return
  }

  // debounce 在確認有問題內容後才消耗，避免空喚醒吃掉緊接著的真問題。
  session.lastWakeAt = now
  await dispatchQuestion(session, question, 'chat')
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
// 「你覺得這方案如何」直接丟 Dify RAG 會答「資料沒提到」→ 先用便宜的 LLM 四分類：
//   chitchat：寒暄/閒聊（你好嗎、謝謝）→ LLM 直答，完全不碰 Dify 與逐字稿
//   factual ：查文件就能答（報名日期）→ Dify RAG（原路）
//   context ：意見/脈絡型（你覺得如何）→ LLM＋近期逐字稿
//   hybrid  ：兩者都要（依簡章看我們時程合理嗎）→ 先 Dify 檢索、再與脈絡合成
// 分類失敗一律回退 factual（保持原行為）。

export type QuestionIntent = 'chitchat' | 'factual' | 'context' | 'hybrid'

/** 把分類器輸出解析成意圖（寬鬆比對；未知回 factual）。純函式，可測。 */
export function parseIntent(raw: string): QuestionIntent {
  const t = raw.toLowerCase()
  if (t.includes('chitchat') || t.includes('閒聊') || t.includes('寒暄')) return 'chitchat'
  if (t.includes('hybrid') || t.includes('混合')) return 'hybrid'
  if (t.includes('context') || t.includes('意見') || t.includes('脈絡')) return 'context'
  return 'factual'
}

/**
 * 意圖 → 實際走的資料來源。**路由的唯一真相**：resolveAnswerRouted 與
 * scripts/eval-meeting.ts 都用這一份，避免評測跟線上判不一樣。
 */
export function routeForIntent(intent: QuestionIntent, hasKb: boolean): AnswerRoute {
  if (!hasKb) return 'transcript'
  if (intent === 'chitchat') return 'chitchat'
  if (intent === 'context') return 'transcript'
  return 'rag' // factual / hybrid 都要先做 Dify 檢索
}

/** 匯出供 scripts/eval-meeting.ts 離線評測（線上與評測共用同一份 prompt）。 */
export async function classifyIntent(question: string, kbContentCard: string | null): Promise<QuestionIntent> {
  try {
    const raw = await completeText({
      system: [
        '你是會議助理的問題分類器。把問題分成四類，只回傳一個詞：',
        'chitchat = 與專案資料和會議討論都無關的寒暄、打招呼、道謝、玩笑（你好嗎、在嗎、how are you、謝謝你、你是誰）',
        'factual = 查專案文件/資料就能回答的事實型問題（日期、金額、規則、名額）',
        'context = 需要對話脈絡或主觀判斷的問題（你覺得如何、有什麼建議、剛才誰說了什麼）',
        'hybrid = 同時需要文件資料與對話脈絡（依照文件看我們的討論/規劃合理嗎）',
        '接續型追問（「那X呢」「X呢」）若追問焦點 X 是日期、金額、名額、規則等查資料可答的事實 → factual。',
        '多輪脈絡由檢索端的對話記憶處理，不要只因句子省略主詞就分成 context（實測：「那 Beta 呢」誤分 context 會答不出來）。',
        '意見/評估型問題若評估對象是專案資料的內容（時程、規則、預算合不合理）→ hybrid：要先查文件才有評估依據。',
        'context 保留給純會議脈絡問題（剛才誰說了什麼、我們剛剛的結論是什麼）。',
        '最高優先規則：問「誰說了／誰問了／剛才是誰」，或指涉「這場會、我們剛剛、現在開的會」的問題 → 一律 context，就算句中出現文件相關名詞也一樣（實測：「剛才是誰在問簡報格式」被誤送去查文件，只會回無法回答）。',
        '對蜜塔自身狀態或行為的話（你還在嗎、你不X了嗎、你怎麼不說話）→ chitchat。',
        // 內容卡：讓分類器知道知識庫實際有什麼，別把查不到的事實題硬分成 factual
        ...(kbContentCard
          ? [
              `知識庫目前的文件與內容摘要：\n${kbContentCard}`,
              'factual/hybrid 只給「上述文件能涵蓋」的問題；與文件內容無關的事實題，分 context（讓助理靠對話脈絡回答）。',
            ]
          : []),
        '範例：「今年銷售多少」→ factual；「那 Beta 呢」「那決賽呢」→ factual；「hello 蜜塔」→ chitchat；「你覺得剛剛的提案如何」→ context；「你覺得我們時程安排合理嗎」→ hybrid；「剛才是誰在問簡報格式」「我們這場會確認了哪些日期」→ context；「你不破冰了嗎」→ chitchat',
      ].join('\n'),
      prompt: `問題：${question}`,
      maxTokens: 10,
      temperature: 0, // 分類要穩定：同一題必須永遠同一路（實測 temp 預設 1.0 會同題不同命）
    })
    return parseIntent(raw)
  } catch (err) {
    logger.warn({ err }, 'classifyIntent failed, falling back to factual')
    return 'factual'
  }
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
): Promise<{ answer: string; route: AnswerRoute }> {
  if (!session.difyDatasetId) {
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, route: 'transcript' },
      'resolveAnswer: no difyDatasetId, answering from transcript',
    )
    const { answer } = await answerFromTranscript(session, question)
    return { answer, route: 'transcript' }
  }

  // 意圖分流：意見/脈絡型不走 RAG（會答「資料沒提到」）
  const classifyStart = Date.now()
  const intent = await classifyIntent(question, session.kbContentCard)
  const route = routeForIntent(intent, true)
  logger.info(
    {
      meetingInstanceId: session.meetingInstanceId,
      intent,
      route,
      mode,
      question: question.slice(0, 40),
      classifyMs: Date.now() - classifyStart,
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
): Promise<string> {
  const { answer } = await resolveAnswerRouted(session, question, mode)
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
  opts?: { skipPendingPrompt?: boolean; speaker?: string },
): Promise<void> {
  const pendingVoice = PENDING_VOICE
  // ack 在意圖分類**之前**送出，此時還不知道會走 RAG／逐字稿／閒聊哪條路
  // → 措辭必須中性。舊版一律寫「正在查詢資料中……」，跟蜜塔打聲招呼也被宣告要去查
  // 資料庫（回報 2026-07-28 A.2）；實際結果由答案自己的功能標籤說明。
  const pendingChat = '收到你的問題，稍等一下～'
  const ackChat = `👂 收到${opts?.speaker ? ` ${opts.speaker} ` : ''}的問題：「${question.slice(0, 40)}」，稍等一下～`

  if (source === 'voice') {
    // 嘴巴被佔用（正在回答上一題）→ 這題不丟棄，改走聊天室
    if (session.isSpeaking) {
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 40) },
        'dispatchQuestion voice: bot is speaking, routing this question to chat',
      )
      await sendChatBestEffort(session, ackChat, 'chat', 'ack')
      try {
        const { answer, route } = await resolveAnswerRouted(session, question, 'chat')
        await sendChatBestEffort(session, answer, 'chat', route)
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
      const answerPromise = resolveAnswerRouted(session, question, 'voice')
      answerPromise.catch(() => {}) // 先掛 handler：開場白 throw 時查詢的 rejection 才不會變 unhandled
      if (speakPending) {
        session.currentSpeech = pendingVoice
        await botProvider.speak(botSession, pendingVoice)
        session.speechEndsAt = Date.now() + promptEstimatedMs
      }

      const { answer: rawAnswer, route } = await answerPromise
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
      const { answer, route } = await resolveAnswerRouted(session, question, 'chat')
      await sendChatBestEffort(session, answer, 'chat', route)
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
