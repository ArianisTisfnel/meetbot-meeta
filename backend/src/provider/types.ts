/**
 * Meeting Bot Provider 抽象層 — 統一型別與介面。
 *
 * 上層（meeting.service / session-manager / summary.service / transcription.service /
 * wake-word-detector）只認 {@link MeetingBotProvider}，不得出現任何
 * `if (provider === 'vexa')` 之類的 provider 名稱條件分支。
 *
 * 兩家底層 API（Vexa / Recall.ai）的 dispatch endpoint、session 結構、transcript 交付方式
 * 都不相容，因此這是 application-level 的 adapter pattern，於程式邏輯層做翻譯，
 * 而非 network proxy。
 */

/**
 * 統一逐字稿 segment schema。
 *
 * ⚠️ 這個 schema **對齊現有的內部表示**（Vexa REST 的 start/end → camelCase startTime/endTime，
 * 見 transcription.service.ts 與 summary.service.ts），**不是新發明的格式**。
 * 下游 Dify 實際吃進去的是由這些 segment 經 `formatTranscriptAsMarkdown` 產生的 Markdown，
 * 因此 adapter 的正規化目標就是這個 segment 型別，Markdown 那層維持不動。
 */
export interface TranscriptSegment {
  segmentId: string | null
  text: string
  speaker: string | null
  /** 會議起算秒數。 */
  startTime: number
  endTime: number
  language: string | null
}

/** Bot 在會議中的狀態事件（由各 provider 的 live stream 推送）。 */
export type BotStatusEvent =
  /** Bot 真的被 admitted 進會議（存活訊號）。 */
  | { type: 'admitted' }
  /** Bot 被擋在門外 / 被拒絕（lobby 卡住）。 */
  | { type: 'blocked'; reason?: string }
  /** 會議結束 / Bot 離開。 */
  | { type: 'ended'; reason: 'completed' | 'failed' }

/** 會議聊天室訊息（用於聊天室喚醒詞）。 */
export interface ChatMessageEvent {
  sender: string
  text: string
  timestamp: number
  isFromBot: boolean
}

/** 派 bot 進會議所需的選項與憑證。各 adapter 自行挑選需要的欄位。 */
export interface BotOptions {
  platform: string
  nativeMeetingId: string
  botName?: string
  /** Vexa 邀請者 token（per-session 授權用）。 */
  vexaToken?: string
  /** 關聯專案的 Dify dataset，僅用於下游路由判斷。 */
  difyDatasetId?: string | null
}

/** Live stream 推送事件的回呼。全部 optional，呼叫端只訂閱需要的。 */
export interface LiveHandlers {
  onSegment?: (seg: TranscriptSegment) => void
  /**
   * 未定稿的即時片段（Recall transcript.partial_data；utterance 講到一半就會到，
   * 同一句會重複推送、內容持續變動）。**只可用於喚醒詞快速偵測**，
   * 不可當逐字稿內容累積或取問題文本（不穩定）。
   */
  onPartialSegment?: (seg: TranscriptSegment) => void
  onStatus?: (ev: BotStatusEvent) => void
  onChat?: (msg: ChatMessageEvent) => void
  /**
   * 「某人開始／停止說話」的低延遲事件（Recall participant_events.speech_on/off）。
   *
   * 與逐字稿無關，也**不受靜音窗影響** —— 這是唯一能即時回答
   * 「現在有沒有人在講話」的訊號。插話引擎需要它：逐字稿是「講完一段之後
   * 才到、而且成批到」的落後指標，光靠它判斷「這輪講完了」會在別人換氣時搶話。
   */
  onSpeechState?: (ev: { speaker: string; speaking: boolean }) => void
}

/** 開啟中的 live stream 控制把手。 */
export interface LiveStream {
  /** 主動關閉 stream（不再重連）。 */
  close(): void
}

/**
 * 一個已派出的 bot session。
 *
 * `adapter` 指向「建立此 session 的具體 provider」，讓 {@link FailoverProvider}
 * 能以 `session.adapter.xxx()` 委派，**完全不需要比對 provider 名稱字串**。
 */
export interface BotSession {
  /** Provider 名稱，僅供 log / debug，**不可**用於條件分支。 */
  readonly provider: string
  readonly platform: string
  readonly nativeMeetingId: string
  /** Provider 端的會議識別碼（Vexa: 數字 meeting id；Recall: bot id 字串）。 */
  providerMeetingId: string | number | null
  /** 建立此 session 的 adapter，後續操作一律委派給它。 */
  readonly adapter: MeetingBotProvider
  /** Provider 私有狀態（WS handle、token、bot id 等），其他層不應讀取。 */
  readonly state: Record<string, unknown>
}

/** 派 bot 失敗（在 timeout 內未被 admitted，或被擋在門外）。 */
export class BotAdmissionError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly reason: 'timeout' | 'blocked',
    message?: string,
  ) {
    super(message ?? `${providerName}: bot not admitted (${reason})`)
    this.name = 'BotAdmissionError'
  }
}

/** 所有 meeting bot provider 都要實作的統一介面。 */
export interface MeetingBotProvider {
  readonly name: string

  /**
   * 派 bot 進會議、開啟 live stream、並等待 bot 真的被 admitted。
   *
   * 關鍵：存活判定**不是 API health check**。Vexa 的 dispatch API 可能回 200 給了 bot id，
   * 但 bot 被 Google Meet 擋在門外。因此 join 必須等「admitted 訊號」：
   *   - 成功（admitted）→ resolve，回傳 live 的 {@link BotSession}（stream 持續開著供喚醒詞用）。
   *   - 被擋 / timeout → 撤除已派出的 bot，throw {@link BotAdmissionError}。
   *
   * @param handlers 進會議後持續推送的 segment/status/chat 回呼。
   */
  join(url: string, opts: BotOptions, handlers: LiveHandlers): Promise<BotSession>

  /** 拉取整場逐字稿，正規化成統一 {@link TranscriptSegment} schema。 */
  getTranscript(session: BotSession): Promise<TranscriptSegment[]>

  /** 讓 bot 說出指定文字（TTS 細節由各 provider 內部處理）。 */
  speak(session: BotSession, text: string): Promise<void>

  /** 在聊天室發訊息。Provider 不支援時可不實作（呼叫端需容錯）。 */
  sendChat?(session: BotSession, text: string): Promise<void>

  /**
   * 預熱固定台詞的語音合成（不播放）。Provider 內部 TTS 有冷啟成本時實作
   * （Recall：join 後先合成並快取「我收到了」等常用句，縮短首次喚醒的回應延遲）。
   */
  primeSpeech?(session: BotSession, texts: string[]): Promise<void>

  /** 立即停止正在播放的語音（barge-in 讓路用）。Provider 不支援時可不實作。 */
  stopSpeaking?(session: BotSession): Promise<void>

  /** Bot 離開會議、釋放資源。 */
  leave(session: BotSession): Promise<void>
}
