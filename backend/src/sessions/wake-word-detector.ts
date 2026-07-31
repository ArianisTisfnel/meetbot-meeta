import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { botProvider } from '../provider/index.js'
import type { BotSession } from '../provider/types.js'
import * as dify from '../lib/dify.js'
import { toTraditional } from '../lib/zh.js'
import { completeText, CLASSIFY_LLM_TIMEOUT_MS } from '../lib/llm.js'
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
/**
 * 進度句：說完「我收到了」後查詢還沒回來時的墊檔（不然使用者會以為沒收到而重問）。
 * 輪替使用——同一場會議問幾題就聽到幾次同一句話會很像壞掉的錄音機。
 * 全部都會在 join 後預熱進 TTS 快取，所以輪替不會增加延遲。
 */
export const PROGRESS_VOICES = [
  '等等喔，我正在頭腦風暴！',
  '再給我一點時間，快找到了。',
  '資料有點多，我整理一下。',
  '嗯……讓我再確認一下。',
  '快好了，再等我一下下。',
]
/** 相容舊有引用；也是輪替的第一句。 */
export const PROGRESS_VOICE = PROGRESS_VOICES[0]

/** 取下一句進度句（每個 session 各自輪替）。 */
function nextProgressVoice(session: MeetingSession): string {
  const idx = session.progressVoiceIdx ?? 0
  session.progressVoiceIdx = (idx + 1) % PROGRESS_VOICES.length
  return PROGRESS_VOICES[idx]
}

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
 * 佔用「嘴巴」（isSpeaking = true），回傳這次佔用專屬的釋放函式。
 *
 * 為什麼要世代比對：speak() 送出即返回，播放結束沒有事件可等，所以每段語音都靠
 * setTimeout 估時解鎖。沒有世代的話，**前一段語音的計時器會在新的一段播到一半時
 * 把 isSpeaking 關掉** —— 症狀是蜜塔講話講到一半就「聽不見了」：barge-in 直接
 * return（它第一行檢查 isSpeaking）、新問題誤走語音分支疊在舊答案上、插話引擎
 * 以為現場是安靜的。
 *
 * 釋放函式一律用這個，不要直接寫 `session.isSpeaking = false`。
 */
function holdSpeaking(session: MeetingSession): () => void {
  const gen = ++session.speechGen
  session.isSpeaking = true
  return () => {
    if (session.speechGen !== gen) return // 已被更新的語音接手 → 這次釋放作廢
    session.isSpeaking = false
    session.currentSpeech = null
  }
}

/**
 * 在聊天室發訊息（best-effort：provider 不支援聊天室時記 warn 不中斷）。
 * channel='voice'：這則是語音發言的文字鏡像 → 逐字稿標「（語音）」而非「（聊天室）」。
 */
export async function sendChatBestEffort(
  session: MeetingSession,
  text: string,
  channel: 'chat' | 'voice' = 'chat',
): Promise<void> {
  try {
    await botProvider.sendChat?.(requireBotSession(session), text)
    // 蜜塔自己的聊天回覆也記進 chatLog（webhook 會過濾 bot 訊息，只能在送出端記錄）
    session.chatLog?.push({ speaker: '蜜塔', text, at: Date.now(), channel })
    // 也記進插話引擎的對話窗：決策層才知道「這個問題已經有人（蜜塔）回答過了」
    recordConversation(session, { speaker: '蜜塔', text, source: 'chat', fromBot: true, at: Date.now() })
  } catch (err) {
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'sendChat failed (best-effort)')
  }
}

// 字元集涵蓋 STT 常見誤轉：實測 recallai_streaming 會把「蜜塔」轉成「米塔」「蜜桃」等。
const WAKE_WORD_PATTERN = '[蜜密祕秘迷米咪][塔搭達桃]|小幫手|[Mm]e{1,2}ta|[Mm]ita'
// A wake word is an address, not a keyword search. Matching it in the middle
// of a sentence lets quoted instructions (including Meeta's own output) become
// fake questions.
const DIRECTED_WAKE_WORD_REGEX = new RegExp(
  `^\\s*(?:@\\s*)?((?:[蜜密祕秘迷米咪][塔搭達桃]|小幫手)(?=$|[\\s，。！？、,…!?]|[\\u4e00-\\u9fff])|(?:[Mm]e{1,2}ta|[Mm]ita)(?=$|[\\s，。！？、,…!?]))`,
)
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
/**
 * 問題至少要有幾個「有意義的字」（中日韓字/字母/數字）才送去查詢。
 * STT 常把停頓 finalize 成單一標點（實測 2026-07-22：「,」被當成問題送去查 Dify，
 * 蜜塔就回一段完全不相干的答案）。
 */
const MIN_QUESTION_CHARS = 2
/**
 * partial 快速確認的門檻：喚醒詞後面至少要聽到這麼多字才開口說「我收到了」。
 * 開口就會靜音收音，太早開口會吃掉問題後半段。
 */
const PARTIAL_ACK_MIN_QUESTION_CHARS = 4
/** 同一句問題在此時間內重複進來 → 視為同一題，不重複回答（回灌/重送/重複觸發的最後一道閘）。 */
const DUPLICATE_QUESTION_MS = 30_000

/** 有意義的字數（中日韓字/字母/數字）：標點不算。 */
function countMeaningfulChars(text: string): number {
  return text.replace(/[^\p{L}\p{N}]/gu, '').length
}

/**
 * 清理喚醒詞後面的問題內容：去掉開頭殘留的標點（STT 的「」（）等）、壓平換行，
 * 內容不足（純標點、單字元）回傳空字串 = 不是問題。純函式，可測。
 */
export function cleanQuestion(raw: string): string {
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+/u, '')
    .trim()
  return countMeaningfulChars(text) >= MIN_QUESTION_CHARS ? text : ''
}

/** 問題的比對鍵（去標點、轉小寫）：判斷「是不是剛剛才答過的同一題」。 */
function questionKey(question: string): string {
  return question.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

/** 清掉「剛剛問過」的紀錄：這題其實沒答成，使用者重問時要能再走一次。 */
function forgetLastQuestion(session: MeetingSession): void {
  session.lastQuestionKey = undefined
  session.lastQuestionKeyAt = 0
}

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

  // 先翻旗標再做 I/O：重複 partial 不會重入。
  // speechGen++ 讓這段語音待執行的解鎖計時器一併作廢（它已經被取消，不該再影響後續語音）。
  session.speechGen++
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
  // 與定稿段落同一套「有指名才算叫我」規則：句中提到蜜塔（「蜜塔剛剛說的…」、
  // 蜜塔自己的話被轉錄回來）以前會先喊一句「我收到了」，然後定稿判定不是問題就沒下文
  //（使用者看到的就是蜜塔莫名其妙一直應聲）。
  if (!partial.text) return
  const wake = DIRECTED_WAKE_WORD_REGEX.exec(partial.text)
  if (!wake) return

  // 等問題講出一小段才開口確認。開口＝收音靜音（agent 網頁的「麥克風」是會議混音，
  // 不靜音會錄到自己），在「蜜塔」兩個字就搶答會把問題後半段吃掉，
  // 使用者只會聽到「我收到了」然後沒有下文（實測 2026-07-25）。
  // 定稿還要 1.5–3 秒才到，這裡晚一點點開口仍然比等定稿快。
  const spokenSoFar = cleanQuestion(partial.text.slice(wake.index + wake[0].length))
  if (countMeaningfulChars(spokenSoFar) < PARTIAL_ACK_MIN_QUESTION_CHARS) return

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
  const match = DIRECTED_WAKE_WORD_REGEX.exec(segment.text)

  if (!match) {
    // 喚醒待命窗：前一段只叫了名字，這段（同說話者）直接視為問題。
    if (
      session.wakePendingUntil > 0 &&
      now <= session.wakePendingUntil &&
      (!session.wakePendingSpeaker || session.wakePendingSpeaker === segment.speaker)
    ) {
      const question = cleanQuestion(segment.text)
      if (!question) return
      session.wakePendingUntil = 0
      session.wakePendingSpeaker = null
      session.lastWakeAt = now
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 60), speaker: segment.speaker },
        'wake pending window: follow-up segment taken as question',
      )
      await dispatchQuestion(session, question, 'voice', {
        skipPendingPrompt: consumePartialAck(session, now),
        speaker: segment.speaker,
      })
    }
    return
  }

  if (now - session.lastWakeAt < DEBOUNCE_MS) return

  const question = cleanQuestion(segment.text.slice(match.index + match[0].length))

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
  await dispatchQuestion(session, question, 'voice', {
    skipPendingPrompt: consumePartialAck(session, now),
    speaker: segment.speaker,
  })
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

  const match = DIRECTED_WAKE_WORD_REGEX.exec(chatMsg.text)
  if (!match) return

  const now = Date.now()
  if (now - session.lastWakeAt < DEBOUNCE_MS) return

  const question = cleanQuestion(chatMsg.text.slice(match.index + match[0].length))
  if (!question) return

  // debounce 在確認有問題內容後才消耗，避免空喚醒吃掉緊接著的真問題。
  session.lastWakeAt = now
  await dispatchQuestion(session, question, 'chat', { speaker: chatMsg.sender })
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

  const estimatedMs = estimateSpeechMs(speech)
  const release = holdSpeaking(session)
  session.speechStartedAt = Date.now()
  session.currentSpeech = speech
  session.speechEndsAt = Date.now() + estimatedMs
  setTimeout(release, estimatedMs)

  try {
    await botProvider.speak(requireBotSession(session), speech)
    // 蜜塔的語音也算「有人在說話」：記進對話窗（重置破冰計時、讓決策層知道已回答）
    recordConversation(session, { speaker: '蜜塔', text: speech, source: 'voice', fromBot: true, at: Date.now() })
    if (speech !== text) {
      // 截斷過的長內容補完整版到聊天室（同時留逐字稿紀錄，標「（語音）」）
      await sendChatBestEffort(session, text, 'voice')
    } else {
      // 沒發聊天室訊息也要留逐字稿紀錄（bot 聲音不進 STT，這裡是唯一留痕點）
      session.chatLog?.push({ speaker: '蜜塔', text: speech, at: Date.now(), channel: 'voice' })
    }
    return true
  } catch (err) {
    release()
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'speakProactive failed, falling back to chat')
    await sendChatBestEffort(session, text)
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

// 分流的正確性靠三層，越前面越可靠：
//   ① 規則（本節）：字面就能判定的類別，零成本、零變異，**LLM 掛掉時也還在**
//   ② 接續追問沿用上一題的類別（「那 Beta 呢」本身沒有足夠語意可判）
//   ③ LLM 分類器：其餘情況
// 為什麼規則層要做好：LLM 失敗時 classifyIntent 一律退回 factual（全部丟進 RAG），
// 那時只有規則擋得住「閒聊被拿專案文件回答」（實測 2026-07-22「你到底有什麼問題」
// 被知識庫的「主要問題」清單回答；2026-07-25 Gemini 額度用完後整場都是這種答案）。

/** 打招呼／道謝／道別：整句就只有寒暄才算（「謝謝，那報名日期呢」不是）。 */
const GREETING_REGEX =
  /^(嗨+|哈囉|哈嚕|你好|妳好|大家好|早安|午安|晚安|掰掰|再見|謝謝|感謝|辛苦了|hi|hello|hey|thanks|thank you|good morning|good afternoon)[你妳大家啊喔唷～~!！。.、,，]*$/i

/** 對蜜塔本人的問話（狀態、身分、能力）。 */
const SELF_TALK_REGEX =
  /^(你|妳|蜜塔|meeta)\s*[，,]?\s*(是誰|叫什麼|幾歲|是不是|是什麼|會做什麼|能做什麼|可以做什麼|有什麼功能|有什麼用|在嗎|在不在|還在|還好嗎|還好吧|好嗎|怎麼了|怎麼不|怎麼沒|沒聲音|不說話|不講話|睡著|發呆|聽得到|聽不到|有沒有在聽|到底|有什麼問題|還不|不破冰|不回答|辛苦)/i

/**
 * 與工作無關的個人狀態／語助詞：查文件與查逐字稿都答不出來，卻很容易被分成 factual
 *（實測 2026-07-25：「我肚子餓了。」被送去查專案資料）。
 * 句尾錨定是關鍵——「我們累積了多少報名」開頭也是「我」，但不會以狀態詞結尾。
 */
const SMALL_TALK_REGEXES: RegExp[] = [
  /^(我|我們)[^？?]{0,6}(餓|累|睏|渴|冷|熱|無聊|想睡|想吃|不舒服)[了啊呀喔耶欸～~。.!！]*$/,
  /^(哈+|呵+|嘿+|哇+|喔+|沒事|沒有啦|開玩笑的|不好意思|抱歉)[了啊呀喔～~。.!！]*$/,
  /^(good\s*)?(morning|afternoon|night)[!.！。]*$/i,
]

/** 純會議脈絡：問的是「這場會議裡發生過什麼」，不是專案文件。 */
const MEETING_CONTEXT_REGEXES: RegExp[] = [
  /(剛才|剛剛|方才|前面|上一句|上一段).{0,8}(誰|說|講|提到|問|回答|結論|決定|討論)/,
  /誰\s*(說|講|提到|問|負責|報告|做|要)/,
  /(我們|這場|這次|本次|今天).{0,6}(會議|會)(裡|中|上)?.{0,8}(結論|決定|決議|討論|說|提到|確認)/,
  /^(總結|整理|摘要|回顧)一下/,
  /(我們|大家)(剛剛|剛才).{0,8}(說|講|討論|決定|結論)/,
  /(目前|現在).{0,4}(討論|進度)到(哪|哪裡|什麼)/,
]

/**
 * 省略主詞的接續追問：「那 Beta 呢」「決賽呢」。
 * 這種句子本身沒有足夠語意可分類——分類器看單句常誤判成 context，
 * 結果拿逐字稿回答查得到的事實題。沿用上一題的路徑最準（也不必再問一次 LLM）。
 */
const FOLLOW_UP_REGEX = /^(那|那麼|然後|接下來)?\s*[^，。？?！!]{0,12}呢[？?]?$/

export function isFollowUpQuestion(question: string): boolean {
  return FOLLOW_UP_REGEX.test(question.trim())
}

/** Dify 沒檢索到（哨兵句或空答案）→ 這個答案沒有資訊量。 */
export function isNoRetrievalAnswer(answer: string): boolean {
  const t = answer.trim()
  return !t || t === dify.DIFY_NO_RESULT_SENTINEL
}

/**
 * 規則先行的意圖判定（純函式，可測）。回傳 null = 交給 LLM 分類器。
 */
export function preClassifyIntent(question: string): QuestionIntent | null {
  const q = question.trim()
  if (!q) return null
  if (GREETING_REGEX.test(q) || SELF_TALK_REGEX.test(q)) return 'chitchat'
  if (SMALL_TALK_REGEXES.some((re) => re.test(q))) return 'chitchat'
  if (MEETING_CONTEXT_REGEXES.some((re) => re.test(q))) return 'context'
  return null
}

/** 類別詞與它的中文同義說法（分類器偶爾會用中文回答）。 */
const INTENT_ALIASES: Array<[QuestionIntent, RegExp]> = [
  ['chitchat', /chitchat|small\s*talk|閒聊|寒暄/gi],
  ['hybrid', /hybrid|混合/gi],
  ['context', /context|脈絡|意見|會議內容/gi],
  ['factual', /factual|事實|查資料/gi],
]

/**
 * 把分類器輸出解析成意圖（純函式，可測）。未知回 factual。
 *
 * 取「最後出現」的類別詞而非第一個：模型偶爾會多講一句話，
 * 而否定句的第一個詞正好是錯的答案（「不是 chitchat，是 factual」）。
 */
export function parseIntent(raw: string): QuestionIntent {
  const t = raw.toLowerCase().replace(/[`*_"'「」【】[\]()（）:：,，.。\n]/g, ' ').trim()
  if (!t) return 'factual'

  // 正常情況分類器只回一個詞 → 完全相符最可靠
  for (const [intent] of INTENT_ALIASES) {
    if (t === intent) return intent
  }

  let best: QuestionIntent | null = null
  let bestAt = -1
  for (const [intent, re] of INTENT_ALIASES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    let last = -1
    while ((m = re.exec(t)) !== null) last = m.index
    if (last > bestAt) {
      bestAt = last
      best = intent
    }
  }
  return best ?? 'factual'
}

async function classifyIntent(question: string, kbContentCard: string | null): Promise<QuestionIntent> {
  try {
    const raw = await completeText({
      system: [
        '你是會議助理「蜜塔」的問題路由器。判斷這句話該用哪種方式回答，只輸出一個英文單字。',
        '',
        '四條路徑：',
        'chitchat = 不必查任何資料：寒暄、道謝、玩笑、對蜜塔本人說的話（你是誰、你還在嗎），以及與專案和會議都無關的個人狀態（我肚子餓了、好累喔）',
        'context  = 只需要這場會議講過的內容：誰說了什麼、剛才的結論、幫我總結、對剛剛的討論給看法',
        'factual  = 查專案文件就能回答：日期、金額、名額、規則、流程、數字',
        'hybrid   = 要先查文件、再對照這場會議的討論才答得出來（依照文件看我們的時程合理嗎）',
        '',
        '依序判斷，命中就停（前面的規則優先）：',
        '1. 對蜜塔本人說話，或與專案、會議都無關 → chitchat',
        '2. 指涉這場會議本身（剛才、剛剛、我們這場會、誰說的、誰問的、總結一下）→ context；即使句中出現文件相關名詞也一樣（實測：「剛才是誰在問簡報格式」被送去查文件，只會回答不出來）',
        '3. 要用文件內容評估會議裡的規劃或討論（時程、預算合不合理）→ hybrid',
        '4. 其他查得到答案的事實問題 → factual',
        '',
        '省略主詞的接續追問（「那 Beta 呢」「那決賽呢」）沿用同一條路徑，通常是 factual；不要因為句子不完整就分成 context。',
        // 內容卡：讓分類器知道知識庫實際有什麼，別把查不到的事實題硬分成 factual
        ...(kbContentCard
          ? [
              '',
              `知識庫現有文件與摘要：\n${kbContentCard}`,
              '內容卡只用來判斷「這題文件答不答得出來」：與文件內容完全無關的事實題改分 context。上面的判斷順序優先於內容卡。',
            ]
          : []),
        '',
        '範例：「今年銷售多少」→ factual；「那 Beta 呢」→ factual；「hello 蜜塔」「你不破冰了嗎」「我肚子餓了」→ chitchat；「你覺得剛剛的提案如何」「剛才是誰在問簡報格式」→ context；「你覺得我們時程安排合理嗎」→ hybrid',
        '只輸出 chitchat、context、factual、hybrid 其中一個單字，不要標點也不要解釋。',
      ].join('\n'),
      prompt: `問題：${question}`,
      // 16 而非 10：模型偶爾會多輸出一個前綴或換行，太緊會被截成空字串 → 解析不出來變 factual
      maxTokens: 16,
      temperature: 0, // 分類要穩定：同一題必須永遠同一路（實測 temp 預設 1.0 會同題不同命）
      // 分類跑在 Dify 查詢**之前**，卡住等於整題白等（實測 log 出現過 10.8 秒的離群值，
      // p90 只有 1 秒）。逾時就走下面的 catch 退回 factual，代價遠小於乾等。
      timeoutMs: CLASSIFY_LLM_TIMEOUT_MS,
    })
    const intent = parseIntent(raw)
    logger.info({ question: question.slice(0, 40), raw: raw.slice(0, 30), intent }, 'classifyIntent: LLM decided')
    return intent
  } catch (err) {
    // LLM 掛掉時 RAG 是唯一還能產生答案的路徑（Dify 有自己的模型），故退回 factual。
    // 閒聊/會議脈絡不該走到這裡——那兩類由上面的規則層先擋掉。
    logger.warn({ err, question: question.slice(0, 40) }, 'classifyIntent failed, falling back to factual')
    return 'factual'
  }
}

/**
 * 決定這一題走哪條路：規則 → 接續追問沿用 → LLM 分類器。
 * 沒有知識庫時不必問 LLM——規則沒中就一律走會議脈絡（省一次呼叫與 1-2 秒延遲）。
 */
async function decideIntent(session: MeetingSession, question: string): Promise<QuestionIntent> {
  const rule = preClassifyIntent(question)
  if (rule) {
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, intent: rule, route: 'rule', question: question.slice(0, 40) },
      'decideIntent: decided by rule',
    )
    return rule
  }

  if (!session.difyDatasetId) return 'context'

  if (isFollowUpQuestion(question) && session.lastIntent) {
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, intent: session.lastIntent, route: 'follow-up' },
      'decideIntent: elliptical follow-up, inheriting previous intent',
    )
    return session.lastIntent
  }

  return classifyIntent(question, session.kbContentCard)
}

// ── 問答路由 ───────────────────────────────────────────────────────────────────

export async function resolveAnswer(
  session: MeetingSession,
  question: string,
  mode: 'voice' | 'chat',
  opts?: { onKbMiss?: 'sentinel' | 'context' },
): Promise<string> {
  // 意圖分流：規則 → 接續追問沿用 → LLM（詳見 decideIntent）
  const classifyStart = Date.now()
  const intent = await decideIntent(session, question)
  session.lastIntent = intent
  logger.info(
    {
      meetingInstanceId: session.meetingInstanceId,
      intent,
      mode,
      question: question.slice(0, 40),
      classifyMs: Date.now() - classifyStart,
    },
    'resolveAnswer: intent classified',
  )

  if (intent === 'chitchat') {
    return answerChitchat(question)
  }

  // 會議脈絡題，以及沒有知識庫可查時的事實題 → 都由逐字稿回答
  if (intent === 'context' || !session.difyDatasetId) {
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

  // 知識庫沒檢索到 → 別把哨兵句唸給使用者聽（「抱歉 沒有檢索到相關資訊」既生硬又常常是
  // 分類誤判造成的）。喚醒詞問答改用會議脈絡再答一次；插話則維持沉默（呼叫端要自己判斷哨兵句）。
  if (isNoRetrievalAnswer(factAnswer) && opts?.onKbMiss === 'context') {
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 40) },
      'resolveAnswer: KB miss, falling back to meeting context',
    )
    const { answer } = await answerFromTranscript(session, question)
    return answer
  }

  if (intent !== 'hybrid') return factAnswer
  if (isNoRetrievalAnswer(factAnswer)) return factAnswer // 沒檢索到就沒東西可合成

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
    return toTraditional(composed || factAnswer)
  } catch (err) {
    logger.warn({ err, meetingInstanceId: session.meetingInstanceId }, 'hybrid compose failed, using fact answer')
    return factAnswer
  }
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
  const now = Date.now()
  // 同一題在 30 秒內重複派發 → 只答第一次。
  // 語音鏈路有很多重複來源（回灌、STT 重送、使用者以為沒收到而重問），
  // 每一次都查一次 Dify 就是使用者看到的「一直重複回答」。
  const key = questionKey(question)
  if (key && session.lastQuestionKey === key && now - (session.lastQuestionKeyAt ?? 0) < DUPLICATE_QUESTION_MS) {
    logger.info(
      { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 40), source },
      'dispatchQuestion: duplicate question within window, skipping',
    )
    return
  }
  session.lastQuestionKey = key
  session.lastQuestionKeyAt = now

  const pendingVoice = session.difyDatasetId ? PENDING_VOICE_KB : PENDING_VOICE_TRANSCRIPT
  // 提問者不明時（agent 串流轉錄是會議混音，沒有講者標記）要說「你的問題」——
  // 舊寫法會產生「收到的問題」這種缺字句子。問題預覽也要去掉引號與換行，免得破壞括號配對。
  const asker = opts?.speaker?.trim()
  const preview = question.replace(/[「」『』\r\n]/g, ' ').trim()
  // 圖示分辨來源：👂 = 聽到的（語音提問）、💬 = 讀到的（聊天室打字提問）。
  const icon = source === 'voice' ? '👂' : '💬'
  const channelLabel = source === 'voice' ? '語音提問' : '文字提問'
  const ackChat = `${icon} 收到${asker ? ` ${asker} ` : '你'}的${channelLabel}：「${preview.slice(0, 40)}${
    preview.length > 40 ? '…' : ''
  }」，${session.difyDatasetId ? '正在查詢資料中……' : '正在查閱會議記錄……'}`

  if (source === 'voice') {
    // 嘴巴被佔用（正在回答上一題）→ 這題不丟棄，改走聊天室
    if (session.isSpeaking) {
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, question: question.slice(0, 40) },
        'dispatchQuestion voice: bot is speaking, routing this question to chat',
      )
      await sendChatBestEffort(session, ackChat)
      try {
        const answer = await resolveAnswer(session, question, 'chat', { onKbMiss: 'context' })
        await sendChatBestEffort(session, answer)
      } catch (err) {
        logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'voice→chat fallback failed')
        forgetLastQuestion(session) // 這題沒答成 → 使用者重問時不該被「同一題」擋掉
        await sendChatBestEffort(session, ERROR_VOICE)
      }
      return
    }
    // 聊天室即時確認（標明是誰的哪一題）：唯一 <1 秒的回饋通道
    void sendChatBestEffort(session, ackChat)
    // partial 快速喚醒已先說過開場白 → 跳過，直接查詢
    const speakPending = !opts?.skipPendingPrompt
    const promptEstimatedMs = speakPending ? estimateSpeechMs(pendingVoice) : 0
    const epochAtStart = session.bargeEpoch // 查詢期間被 barge-in 打斷 → 答案改走聊天室
    let release = holdSpeaking(session)
    session.speechStartedAt = Date.now()
    // 安全網：查詢丟錯/卡住時強制釋放，否則嘴巴永久被佔（蜜塔從此不再回答語音）。
    // 長度必須涵蓋**整個查詢鏈**——舊值 promptEstimatedMs + 10s 在 partial ack 路徑上
    // 等於 10 秒（skipPendingPrompt → promptEstimatedMs = 0），而 Dify 實測 15-20 秒，
    // 於是每次都在答案回來前就解鎖。它是解死鎖用的上限，不是播放長度的估計值。
    const lockTimer = setTimeout(release, env.DIFY_CHATFLOW_TIMEOUT_MS + promptEstimatedMs + 10_000)

    // 查詢太久（Dify 常要 15-20 秒）→ 口頭回報進度，避免使用者以為沒收到而重問
    const progressTimer = setTimeout(() => {
      // 在 callback 裡才取：計時器沒觸發時不消耗輪替索引
      const progressVoice = nextProgressVoice(session)
      botProvider
        .speak(requireBotSession(session), progressVoice)
        .then(() => { session.speechEndsAt = Date.now() + estimateSpeechMs(progressVoice) })
        .catch(() => sendChatBestEffort(session, progressVoice))
    }, PROGRESS_NOTICE_MS)

    try {
      const botSession = requireBotSession(session)
      // 查詢與開場白並行：不等開場白唸完才開始查（省下開場白的 3-5 秒）
      const answerPromise = resolveAnswer(session, question, 'voice', { onKbMiss: 'context' })
      answerPromise.catch(() => {}) // 先掛 handler：開場白 throw 時查詢的 rejection 才不會變 unhandled
      if (speakPending) {
        session.currentSpeech = pendingVoice
        await botProvider.speak(botSession, pendingVoice)
        session.speechEndsAt = Date.now() + promptEstimatedMs
      }

      const rawAnswer = await answerPromise
      clearTimeout(progressTimer)

      // 開場白／查詢期間有人開口（barge-in）→ 不再出聲，完整答案貼聊天室
      if (session.bargeEpoch !== epochAtStart) {
        clearTimeout(lockTimer)
        release()
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
        release()
        await sendChatBestEffort(session, rawAnswer)
        logger.info(
          { meetingInstanceId: session.meetingInstanceId },
          'dispatchQuestion voice: interrupted while waiting for prompt to finish, answer via chat',
        )
        return
      }

      clearTimeout(lockTimer)
      const answerEstimatedMs = estimateSpeechMs(answer)
      // 重新佔用：安全網可能已在查詢期間到期（clearTimeout 對已觸發的計時器無效），
      // 不重新佔用的話整段答案都會在「嘴巴是空的」狀態下播出。
      release = holdSpeaking(session)
      session.currentSpeech = answer
      session.speechEndsAt = Date.now() + answerEstimatedMs
      setTimeout(release, answerEstimatedMs)

      await botProvider.speak(botSession, answer)
      // 蜜塔的語音回答記進對話窗（重置破冰計時、決策層可見已回答）
      recordConversation(session, { speaker: '蜜塔', text: answer, source: 'voice', fromBot: true, at: Date.now() })
      // 語音回答同步貼聊天室：留下文字紀錄（會後隨 chatLog 併入逐字稿，標「（語音）」），
      // 長答案被截短唸出時，完整版也在這裡補上
      await sendChatBestEffort(session, rawAnswer, 'voice')
      logger.info(
        { meetingInstanceId: session.meetingInstanceId, answerPreview: answer.slice(0, 60) },
        'dispatchQuestion voice: answer spoken',
      )
    } catch (err) {
      clearTimeout(lockTimer)
      clearTimeout(progressTimer)
      release()
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion voice failed')
      forgetLastQuestion(session) // 這題沒答成 → 使用者重問時不該被「同一題」擋掉
      // 靜默失敗會讓使用者以為蜜塔沒反應 → 盡力口頭回報（失敗則退回聊天室）。
      try {
        await botProvider.speak(requireBotSession(session), ERROR_VOICE)
      } catch {
        await sendChatBestEffort(session, ERROR_VOICE)
      }
    }
  } else {
    await sendChatBestEffort(session, ackChat)

    try {
      const answer = await resolveAnswer(session, question, 'chat', { onKbMiss: 'context' })
      await sendChatBestEffort(session, answer)
    } catch (err) {
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion chat failed')
      forgetLastQuestion(session) // 這題沒答成 → 使用者重問時不該被「同一題」擋掉
      await sendChatBestEffort(session, '抱歉，查詢時發生錯誤，請稍後再試。')
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
