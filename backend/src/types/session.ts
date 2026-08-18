import type { BotSession } from '../provider/types.js'

export interface MeetingSession {
  meetingInstanceId: string
  platform: string
  nativeMeetingId: string
  difyDatasetId: string | null
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
