import type { BotSession } from '../provider/types.js'

/**
 * Vexa REST API GET /transcripts/{platform}/{native_id} 回傳的 segment 格式。
 * 欄位名為 start/end（Pydantic alias），非 start_time/end_time。
 * （保留給 transcription.service 的 Vexa REST fallback 與型別參考；
 *   provider 層對外一律使用正規化後的 TranscriptSegment。）
 */
export interface VexaRestSegment {
  segment_id: string | null
  text: string
  speaker: string | null
  start: number
  end: number
  language: string | null
  completed?: boolean
}

/**
 * va:meeting:{id}:chat channel 的 chat.new_message payload。
 */
export interface VexaChatMessage {
  sender: string
  text: string
  timestamp: number
  is_from_bot: boolean
}

export interface MeetingSession {
  meetingInstanceId: string
  vexaMeetingId: number | null
  platform: string
  nativeMeetingId: string
  difyDatasetId: string | null
  /** 邀請者 Vexa token：供 transcription.service / 重啟復原的 Vexa REST fallback 使用。 */
  creatorVexaToken: string
  isSpeaking: boolean
  lastWakeAt: number
  /**
   * 喚醒待命窗（epoch ms）：說話者只叫了名字（「蜜塔」）沒接問題時開窗，
   * 窗內同說話者的下一段語音直接視為問題。0 = 無待命。
   * 解決 STT 把「叫名字 →（停頓）→ 問問題」切成兩個 utterance 的情境。
   */
  wakePendingUntil: number
  /** 開喚醒待命窗的說話者（null = 未知，任何人皆可接問題）。 */
  wakePendingSpeaker: string | null
  /**
   * partial 快速喚醒的確認時間戳（epoch ms）：partial 片段偵測到喚醒詞時
   * 先說開場確認（「我收到了」），final 段落到達派發問題時據此跳過開場白。
   * 0 = 無待銜接的確認。
   */
  partialAckAt: number
  /** 正在用語音唸的內容（barge-in 被打斷時改貼聊天室用）。null = 沒在唸。 */
  currentSpeech: string | null
  /**
   * 這一輪語音開始的時間（epoch ms，isSpeaking=true 時設定）。
   * barge-in 用「說話者開口的時間」比對：STT 事件晚到 1.5-3 秒，
   * 開口時間早於此值的話不算打斷（實測誤判案例 2026-07-04）。
   */
  speechStartedAt: number
  /** 聊天室訊息紀錄（含蜜塔自己的回覆），會後併入逐字稿。at = epoch ms。 */
  chatLog: Array<{ speaker: string; text: string; at: number }>
  /** bot admitted 時間（epoch ms）：聊天訊息換算會議相對秒數的錨點。0 = 未 admitted。 */
  sessionStartedAt: number
  /** barge-in 世代計數：每次被打斷 +1。語音派發流程據此偵測「查詢期間被打斷 → 答案改走聊天室」。 */
  bargeEpoch: number
  processedSegmentIds: Set<string>
  /** 由 provider 抽象層建立的 bot session（admitted 後才有值）。取代舊的 wsConnection。 */
  botSession: BotSession | null
  difyConversationId: string | null
  lastQuestionAt: number
  /**
   * 知識庫內容卡（v0 = 已索引完成文件的名稱清單）：讓意圖分類器知道知識庫裡有什麼，
   * 才能判斷問題是否真的查得到（session 啟動時載入一次；null = 無知識庫或載入失敗）。
   */
  kbContentCard: string | null
}
