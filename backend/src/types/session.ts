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
   * 蜜塔最近一次被叫到的時刻（epoch ms）：派發問題、只叫名字都算，叫停歸零。
   * 0 = 目前沒有和蜜塔進行中的對話串。
   *
   * 用途只有一個：決定「沒喊名字的發言」值不值得送語意層問「這是不是在追問我」
   *（`FOLLOWUP_WINDOW_MS`）。取代舊的 wakePendingUntil/wakePendingSpeaker 待命窗——
   * 那組欄位是用 8 秒時間窗去**近似**語意，只接得住「叫名字 →（停頓）→ 問題」，
   * 接不住第二、三輪追問（回報 A.3）。現在判準由語意層負責，這裡只管成本閘門。
   */
  lastEngagedAt: number
  /**
   * partial 快速喚醒的確認時間戳（epoch ms）：partial 片段偵測到喚醒詞時
   * 先說開場確認（「我收到了」），final 段落到達派發問題時據此跳過開場白。
   * 0 = 無待銜接的確認。
   */
  partialAckAt: number
  /**
   * 最近一次被叫停的時刻（epoch ms）。0 = 從未被叫停。
   *
   * 用途只有一個：叫停後的短時間內壓住 partial 快速 ack。實測 2026-08-16 連喊兩次
   * 「蜜塔閉嘴」，第二次的 partial 先只到「蜜塔」——這一層看不出是叫停，
   * 就先說了「好的，我收到了」；你叫她閉嘴，她回你一句話。叫停後緊接著的
   * 句首喊名字，十之八九是再叫停或抱怨，不是新問題；就算真是新問題，
   * 損失的也只是提前 ack，final 派發照常（會補說開場白）。
   */
  lastStopAt: number
  /** 正在用語音唸的內容（barge-in 被打斷時改貼聊天室用）。null = 沒在唸。 */
  currentSpeech: string | null
  /**
   * 這一輪語音開始的時間（epoch ms，isSpeaking=true 時設定）。
   * barge-in 用「說話者開口的時間」比對：STT 事件晚到 1.5-3 秒，
   * 開口時間早於此值的話不算打斷（實測誤判案例 2026-07-04）。
   */
  speechStartedAt: number
  /**
   * 目前這段語音「預估唸完」的時刻（epoch ms）。speak() 送出即返回、再 POST 會蓋台，
   * 下一段語音（答案）開口前要等到此刻之後。0 = 沒有在播的語音。
   */
  speechEndsAt: number
  /**
   * 聊天室訊息紀錄（含蜜塔自己的回覆），會後併入逐字稿。at = epoch ms。
   * channel：'voice' = 這則其實是蜜塔的語音發言（逐字稿標「（語音）」；
   * bot 聲音被 provider 過濾不進 STT，靠這裡留痕）；預設 'chat'。
   */
  chatLog: Array<{ speaker: string; text: string; at: number; channel?: 'chat' | 'voice' }>
  /** bot admitted 時間（epoch ms）：聊天訊息換算會議相對秒數的錨點。0 = 未 admitted。 */
  sessionStartedAt: number
  /** barge-in 世代計數：每次被打斷 +1。語音派發流程據此偵測「查詢期間被打斷 → 答案改走聊天室」。 */
  bargeEpoch: number
  /**
   * 語音世代計數：每次佔用「嘴巴」+1（見 wake-word-detector 的 holdSpeaking）。
   * 解鎖計時器據此判斷自己是否已被更新的一段語音接手——speak() 送出即返回、
   * 播放結束沒有事件可等，解鎖全靠 setTimeout 估時，沒有世代比對的話舊計時器
   * 會把新的語音解鎖（barge-in 失效、新問題疊在舊答案上）。
   */
  speechGen: number
  /** 進度句輪替索引：同一場會議不要每次都聽到同一句墊檔。 */
  progressVoiceIdx?: number
  /** ack 輪替索引：同進度句，避免每題都是同一句「好的我收到了」。 */
  pendingVoiceIdx?: number
  /**
   * 最後一次派發出去的問題原文與時刻——給「同一題不要答兩次」用。
   *
   * 追問出口（interjection 的 evaluateTurn）是讓語意層**從整個對話窗裡**挑出使用者在問
   * 什麼，而窗裡就躺著幾秒前才剛答過的那一則。實測 2026-08-03 19:35：使用者在聊天室打了
   * 「我們這個月有甚麼目標嗎」，答案還在查的時候她又出了一次聲，語意層就把同一句原文
   * （連錯字「甚麼」都一字不差）當成新的追問，於是同一題聊天室答一次、語音又答一次。
   */
  lastDispatchedQuestion?: { text: string; at: number }
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
