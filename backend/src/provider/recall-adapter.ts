import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { normalizeRecallTranscript, normalizeRecallRealtimeUtterance } from './normalize.js'
import {
  BotAdmissionError,
  type BotOptions,
  type BotSession,
  type LiveHandlers,
  type MeetingBotProvider,
  type TranscriptSegment,
} from './types.js'

/**
 * RecallAdapter — Recall.ai 的 MeetingBotProvider 實作。
 *
 * 與 Vexa 的差異（為什麼必須在程式邏輯層翻譯，而非流量重導）：
 *   - dispatch：POST /api/v1/bot/（回傳 bot id 字串，非數字 meeting id）
 *   - 存活訊號：bot status_changes 進入 `in_call_recording`（≈ admitted）；
 *     卡在 `in_waiting_room` 或進入 `call_ended`/`fatal` 而未錄製 ≈ 被擋在門外
 *   - transcript：GET /api/v1/bot/{id}/transcript/，結構是 speaker + words[]（含相對時間戳），
 *     與 Vexa 的 start/end segment 完全不同 → 由本 adapter 正規化成統一 TranscriptSegment
 *   - 說話：Recall 吃 **mp3（base64）**（Output Audio API），不像 Vexa 吃文字做 server-side TTS，
 *     因此 speak() 內部需自行 TTS（text → mp3）再丟給 Recall
 *
 * 即時逐字稿/聊天（驅動喚醒詞）：走 Recall realtime webhook。Recall 主動把 transcript.data /
 * participant_events.chat_message POST 到我們的 /webhooks/recall，由 {@link dispatchRecallEvent}
 * 依 bot.id 分派到該 session 的 handlers（與 Vexa 的 onSegment/onChat 同一條路）。
 * 需設定 RECALL_WEBHOOK_URL（公開可達）+ RECALL_WEBHOOK_TOKEN；未設定則退回 meeting_captions
 * （只有會後逐字稿、無即時喚醒詞問答）。
 *
 * 逐字稿雙軌策略：Recall 的最終逐字稿（download_url）要等會議結束「後處理完成」（status=done，
 * 通常需數分鐘）才拿得到，遠超摘要服務的等待視窗。因此 realtime webhook 進來的 segment
 * 會同步累積在 session state；getTranscript 優先用最終逐字稿，未就緒時回退用累積結果——
 * 會議進行中（喚醒詞問答）與剛結束（摘要）都因此拿得到內容。
 *
 * ⚠️ 已知限制：
 *   - speak() 需要 OPENAI_API_KEY 做 TTS；未設定時會丟出明確錯誤（不會 silently 跳過）。
 *     未設金鑰時 realtime 仍可用「聊天文字」回答（sendChat）。
 *   - sendChat 為 best-effort，部分會議平台可能不支援。
 *   - 未設定 webhook（無 realtime）時沒有累積可回退，摘要仍受最終逐字稿處理時間限制。
 */

const ADMISSION_TIMEOUT_MS = 30_000
/** admission 等待期輪詢間隔（短：失敗要快，failover 才不會拖太久）。 */
const ADMISSION_POLL_INTERVAL_MS = 2_000
/** admitted 後偵測會議結束的輪詢間隔（寬：Recall rate limit 為 workspace 級，省請求）。 */
const ENDED_POLL_INTERVAL_MS = 10_000
/** realtime segment 累積上限（防禦性；一場會議遠達不到）。 */
const MAX_REALTIME_SEGMENTS = 50_000
const DEFAULT_BOT_NAME = '蜜塔'

// ── Realtime webhook registry ────────────────────────────────────────────────
// Recall realtime 事件由公開 webhook POST 進來，依 bot.id 找回該 session 的 handlers。
// RecallAdapter 為單例，故用模組層 Map。

interface RealtimeRegistration {
  handlers: LiveHandlers
  botName: string
  /** 與 session.state.segments 同一個 array reference：webhook 累積、getTranscript 回退讀取。 */
  segments: TranscriptSegment[]
}

const realtimeRegistry = new Map<string, RealtimeRegistration>()

/** 註冊 bot.id → handlers（join 時呼叫；webhook 進來時依此找回）。 */
export function registerRealtimeHandlers(
  botId: string,
  handlers: LiveHandlers,
  botName: string,
  segments: TranscriptSegment[] = [],
): void {
  realtimeRegistry.set(botId, { handlers, botName, segments })
}

/** 移除註冊（leave 時呼叫）。 */
export function unregisterRealtimeHandlers(botId: string): void {
  realtimeRegistry.delete(botId)
}

/** 判斷某 participant 是否為 bot 自己（避免自迴圈：歡迎訊息/自身語音含「蜜塔」會誤觸發）。 */
function isBotParticipant(reg: RealtimeRegistration, participant: any): boolean {
  if (!participant) return false
  return Boolean(participant.name && participant.name === reg.botName)
}

/**
 * 由 /webhooks/recall route 呼叫：依事件的 bot.id 分派到對應 session 的 handlers。
 * 未知 / 已結束的 bot 一律安全略過。
 */
export function dispatchRecallEvent(event: any): void {
  const type: string | undefined = event?.event
  const data = event?.data
  const botId: string | undefined = data?.bot?.id
  if (!type || !botId) {
    logger.info({ type, botId }, 'recall webhook: event without type/botId, ignored')
    return
  }
  const reg = realtimeRegistry.get(botId)
  if (!reg) {
    logger.warn({ type, botId }, 'recall webhook: no registered handlers for botId (orphaned bot?)')
    return
  }

  if (type === 'transcript.data') {
    const utter = data?.data
    const seg = normalizeRecallRealtimeUtterance(utter, data?.transcript?.id)
    const isBot = isBotParticipant(reg, utter?.participant)
    logger.info(
      { botId, speaker: utter?.participant?.name, isBot, text: seg?.text?.slice(0, 60) ?? null },
      'recall webhook: transcript.data',
    )
    if (seg) {
      // bot 自己的語音也要進逐字稿（會後要看得到蜜塔的回覆），
      // 但不轉給 handlers（避免喚醒詞/插話自迴圈）。
      if (reg.segments.length < MAX_REALTIME_SEGMENTS) reg.segments.push(seg)
      if (!isBot) reg.handlers.onSegment?.(seg)
    }
    return
  }

  if (type === 'transcript.partial_data') {
    // 未定稿片段：只轉給 onPartialSegment（喚醒快速偵測），不累積進 segments。
    // 同一句會重複推送且內容變動，量大 → 不逐則記 info log。
    const utter = data?.data
    if (isBotParticipant(reg, utter?.participant)) return
    const seg = normalizeRecallRealtimeUtterance(utter, data?.transcript?.id)
    if (seg) reg.handlers.onPartialSegment?.(seg)
    return
  }

  if (type === 'participant_events.chat_message') {
    const d = data?.data
    const participant = d?.participant
    const text: string = d?.text ?? d?.message ?? d?.data?.text ?? ''
    logger.info(
      { botId, sender: participant?.name, isBot: isBotParticipant(reg, participant), text: text.slice(0, 60) },
      'recall webhook: chat_message',
    )
    if (isBotParticipant(reg, participant)) return
    if (!text.trim()) return
    reg.handlers.onChat?.({
      sender: participant?.name ?? 'unknown',
      text,
      timestamp: Date.now(),
      isFromBot: false,
    })
    return
  }

  logger.info({ type, botId }, 'recall webhook: other event')
}

/** bot 已在會議中並錄製 ≈ admitted。 */
const RECALL_IN_CALL_STATUSES = ['in_call_recording', 'in_call_not_recording']
/** 進入這些狀態而尚未 admitted ≈ 被擋 / 失敗。 */
const RECALL_TERMINAL_STATUSES = ['call_ended', 'fatal', 'done']

interface RecallSessionState extends Record<string, unknown> {
  botId: string
  statusTimer: ReturnType<typeof setInterval> | null
  closed: boolean
  /** realtime webhook 累積的 segment（最終逐字稿未就緒時的回退來源）。 */
  segments: TranscriptSegment[]
}

function getState(session: BotSession): RecallSessionState {
  return session.state as RecallSessionState
}

async function recallFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.RECALL_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Token ${env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Recall ${method} ${path} failed ${res.status}: ${text}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** 從 Recall bot 物件取出最新狀態 code（status_changes 取最後一筆）。 */
function latestStatus(bot: any): string | undefined {
  const changes = bot?.status_changes
  if (Array.isArray(changes) && changes.length) {
    return changes[changes.length - 1]?.code
  }
  return bot?.status?.code ?? bot?.status
}

export class RecallAdapter implements MeetingBotProvider {
  readonly name = 'recall'

  constructor(private readonly admissionTimeoutMs: number = ADMISSION_TIMEOUT_MS) {}

  async join(url: string, opts: BotOptions, handlers: LiveHandlers): Promise<BotSession> {
    if (!env.RECALL_API_KEY || !env.RECALL_API_URL) {
      throw new BotAdmissionError(this.name, 'blocked', 'RecallAdapter.join: RECALL_API_KEY / RECALL_API_URL not configured')
    }

    const botName = opts.botName ?? DEFAULT_BOT_NAME

    // ① 派 bot。逐字稿設定走 recording_config.transcript.provider（新版 API）。
    //   - 有設 webhook → recallai_streaming（streaming STT，支援 realtime）+ realtime_endpoints，
    //     讓 Recall 即時把 transcript.data / chat_message POST 進來驅動喚醒詞。
    //   - 未設 webhook → 退回 meeting_captions（免費，但只有會後逐字稿、無即時喚醒詞）。
    const realtimeEnabled = Boolean(env.RECALL_WEBHOOK_URL && env.RECALL_WEBHOOK_TOKEN)
    const recordingConfig = realtimeEnabled
      ? {
          transcript: {
            provider: {
              recallai_streaming: {
                // prioritize_low_latency 只支援 en；中文（「蜜塔」）需 prioritize_accuracy。
                // accuracy 模式支援 'auto'（自動偵測、可中英夾雜）與 'zh' 等。
                mode: 'prioritize_accuracy',
                language_code: env.RECALL_TRANSCRIBE_LANGUAGE,
              },
            },
          },
          realtime_endpoints: [
            {
              type: 'webhook',
              url: `${env.RECALL_WEBHOOK_URL}/webhooks/recall?token=${env.RECALL_WEBHOOK_TOKEN}`,
              // partial_data：未定稿片段，講到一半就推送 → 喚醒詞快速偵測用
              //（定稿的 data 要等句子講完＋endpointing，慢 1.5–3 秒）。
              events: ['transcript.data', 'transcript.partial_data', 'participant_events.chat_message'],
            },
          ],
        }
      : { transcript: { provider: { meeting_captions: {} } } }

    const bot = await recallFetch<{ id: string }>('POST', '/api/v1/bot/', {
      meeting_url: url,
      bot_name: botName,
      recording_config: recordingConfig,
    })

    // 註冊 realtime handlers（webhook 進來時依 bot.id 找回）。
    // segments 與 session.state 共用同一個 array：webhook 累積、getTranscript 回退讀取。
    const segments: TranscriptSegment[] = []
    if (realtimeEnabled) {
      registerRealtimeHandlers(bot.id, handlers, botName, segments)
    } else {
      logger.warn(
        { botId: bot.id },
        'RecallAdapter: RECALL_WEBHOOK_URL/TOKEN 未設定 → realtime 喚醒詞停用（僅會後逐字稿）',
      )
    }

    const session: BotSession = {
      provider: this.name,
      platform: opts.platform,
      nativeMeetingId: opts.nativeMeetingId,
      providerMeetingId: bot.id,
      adapter: this,
      state: {
        botId: bot.id,
        statusTimer: null,
        closed: false,
        segments,
      } satisfies RecallSessionState,
    }

    // ② 等 admitted（輪詢 status）。被擋 / timeout → 撤 bot 並 throw。
    try {
      await this.awaitAdmission(session, handlers)
    } catch (err) {
      await this.leave(session).catch((e) =>
        logger.warn({ e, botId: bot.id }, 'RecallAdapter: cleanup after admission failure failed'),
      )
      throw err
    }

    // admitted 後即時逐字稿/聊天由 webhook → dispatchRecallEvent → handlers 驅動（不需在此輪詢）。
    return session
  }

  private awaitAdmission(session: BotSession, handlers: LiveHandlers): Promise<void> {
    const state = getState(session)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const deadline = Date.now() + this.admissionTimeoutMs

      const tick = async () => {
        if (settled || state.closed) return
        try {
          const bot = await recallFetch<any>('GET', `/api/v1/bot/${state.botId}/`)
          const status = latestStatus(bot)

          if (status && RECALL_IN_CALL_STATUSES.includes(status)) {
            settled = true
            if (state.statusTimer) clearInterval(state.statusTimer)
            handlers.onStatus?.({ type: 'admitted' })
            this.startStatusPolling(session, handlers)
            resolve()
            return
          }

          if (status && RECALL_TERMINAL_STATUSES.includes(status)) {
            settled = true
            if (state.statusTimer) clearInterval(state.statusTimer)
            reject(new BotAdmissionError(this.name, 'blocked', status))
            return
          }

          if (Date.now() >= deadline) {
            settled = true
            if (state.statusTimer) clearInterval(state.statusTimer)
            reject(new BotAdmissionError(this.name, 'timeout'))
          }
        } catch (err) {
          logger.warn({ err, botId: state.botId }, 'RecallAdapter: status poll error')
          if (Date.now() >= deadline) {
            settled = true
            if (state.statusTimer) clearInterval(state.statusTimer)
            reject(new BotAdmissionError(this.name, 'timeout'))
          }
        }
      }

      state.statusTimer = setInterval(tick, ADMISSION_POLL_INTERVAL_MS)
      void tick()
    })
  }

  /** admitted 後持續監看 status，偵測會議結束。 */
  private startStatusPolling(session: BotSession, handlers: LiveHandlers): void {
    const state = getState(session)
    state.statusTimer = setInterval(async () => {
      if (state.closed) return
      try {
        const bot = await recallFetch<any>('GET', `/api/v1/bot/${state.botId}/`)
        const status = latestStatus(bot)
        if (status && RECALL_TERMINAL_STATUSES.includes(status)) {
          handlers.onStatus?.({ type: 'ended', reason: status === 'fatal' ? 'failed' : 'completed' })
          if (state.statusTimer) clearInterval(state.statusTimer)
          state.statusTimer = null
        }
      } catch (err) {
        logger.warn({ err, botId: state.botId }, 'RecallAdapter: post-admission status poll error')
      }
    }, ENDED_POLL_INTERVAL_MS)
  }

  async getTranscript(session: BotSession): Promise<TranscriptSegment[]> {
    const state = getState(session)
    // 優先用最終逐字稿（完整、含後處理修正）；未就緒（會議進行中 / 會後處理中，常需數分鐘）
    // 則回退用 realtime webhook 累積的 segment，讓喚醒詞問答與摘要都拿得到內容。
    const finalSegments = await this.fetchFinalTranscript(state.botId).catch((err) => {
      logger.warn({ err, botId: state.botId }, 'RecallAdapter.getTranscript: final transcript fetch failed, falling back to realtime buffer')
      return null
    })
    if (finalSegments && finalSegments.length) return finalSegments
    return [...state.segments]
  }

  /** 取最終逐字稿；尚未就緒回傳 null。 */
  private async fetchFinalTranscript(botId: string): Promise<TranscriptSegment[] | null> {
    // 新版 API：bot → recordings[0].media_shortcuts.transcript.id → GET /transcript/{id}/ → data.download_url
    // 逐字稿內容放在一個預簽 URL 的 JSON 檔（會議進行中為 processing，結束處理完才 done）。
    const bot = await recallFetch<any>('GET', `/api/v1/bot/${botId}/`)
    const transcriptId = bot?.recordings?.[0]?.media_shortcuts?.transcript?.id
    if (!transcriptId) return null

    const transcript = await recallFetch<any>('GET', `/api/v1/transcript/${transcriptId}/`)
    if (transcript?.status?.code !== 'done') return null // 尚在處理
    const downloadUrl: string | null = transcript?.data?.download_url ?? null
    if (!downloadUrl) return null

    // download_url 為預簽 URL，不可帶 Recall token。
    const res = await fetch(downloadUrl)
    if (!res.ok) return null
    const raw = (await res.json()) as any[]
    return normalizeRecallTranscript(raw)
  }

  async speak(session: BotSession, text: string): Promise<void> {
    const state = getState(session)
    // Recall 吃 mp3（base64），需自行 TTS（text → mp3）。
    const mp3Base64 = await this.synthesizeMp3(text)
    await recallFetch<void>('POST', `/api/v1/bot/${state.botId}/output_audio/`, {
      kind: 'mp3',
      b64_data: mp3Base64,
    })
  }

  async primeSpeech(_session: BotSession, texts: string[]): Promise<void> {
    // 只合成進快取、不播放：把「我收到了」等固定台詞的 TTS 成本移到 join 後的閒置期，
    // 首次喚醒的回應延遲可省 1–3 秒。
    for (const text of texts) {
      if (this.ttsCache.has(text)) continue
      await this.synthesizeMp3(text).catch((err) =>
        logger.warn({ err, text: text.slice(0, 20) }, 'RecallAdapter.primeSpeech: TTS warm failed'),
      )
    }
  }

  /** 固定台詞的 TTS 結果快取（開場白等重複句免重新合成）。有上限防無界成長。 */
  private readonly ttsCache = new Map<string, string>()
  private static readonly TTS_CACHE_MAX = 30

  /** text → mp3(base64)，使用 OpenAI TTS。未設定 OPENAI_API_KEY 時丟出明確錯誤。 */
  private async synthesizeMp3(text: string): Promise<string> {
    const cached = this.ttsCache.get(text)
    if (cached) return cached

    if (!env.OPENAI_API_KEY) {
      throw new Error(
        'RecallAdapter.speak: OPENAI_API_KEY 未設定，無法為 Recall bot 做 TTS（known limitation）',
      )
    }
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'mp3' }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`RecallAdapter.speak: TTS failed ${res.status}: ${t}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const mp3 = buf.toString('base64')
    if (this.ttsCache.size >= RecallAdapter.TTS_CACHE_MAX) {
      const oldest = this.ttsCache.keys().next().value
      if (oldest !== undefined) this.ttsCache.delete(oldest)
    }
    this.ttsCache.set(text, mp3)
    return mp3
  }

  async sendChat(session: BotSession, text: string): Promise<void> {
    const state = getState(session)
    // best-effort：部分平台不支援，失敗時由呼叫端容錯。
    await recallFetch<void>('POST', `/api/v1/bot/${state.botId}/send_chat_message/`, { message: text })
  }

  async leave(session: BotSession): Promise<void> {
    const state = getState(session)
    state.closed = true
    if (state.statusTimer) clearInterval(state.statusTimer)
    state.statusTimer = null
    unregisterRealtimeHandlers(state.botId)

    await recallFetch<void>('POST', `/api/v1/bot/${state.botId}/leave_call/`, {}).catch((err) =>
      logger.warn({ err, botId: state.botId }, 'RecallAdapter.leave: leave_call failed'),
    )
  }
}
