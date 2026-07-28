import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import {
  getAgentSession,
  getAgentSessionByBotId,
  unregisterAgentSession,
  verifyAgentToken,
  PCM_CACHE_MAX,
  type AgentSession,
} from './agent-registry.js'
import { resolveSpeakerAt } from './speaker-timeline.js'

/**
 * Agent relay — Output Media 網頁 ⇄ OpenAI 串流轉錄的橋（方案 A 的「耳朵和嘴巴」）。
 *
 * 資料流（對照官方 voice-agent-demo 的 relay server，差別是我們不用 Realtime 對話模型，
 * 只做轉錄，喚醒與回答仍由現有的 wake-word-detector / Dify 鏈路處理）：
 *
 *   耳朵：網頁 getUserMedia（會議音訊）→ PCM16 24kHz binary WS → 本 relay
 *         → base64 → OpenAI transcription session（gpt-4o-mini-transcribe, server_vad）
 *         → delta（partial）/ completed（final）→ 既有 LiveHandlers.onPartialSegment/onSegment
 *         → 喚醒 regex／待命窗／debounce／barge-in **一行不動**。
 *
 *   嘴巴：speak(text) → 快取命中（ack 等固定台詞已預先合成）直接推 PCM，零合成延遲；
 *         未命中 → OpenAI TTS（response_format: pcm）串流回應邊收邊轉發 → 網頁邊收邊播
 *         → 首音 ~0.5 秒（現行 mp3 路徑要等整支合成＋base64 上傳）。
 *
 *   插話讓路：stopSpeaking → speakEpoch+1（作廢串流中的轉發）＋推 {type:'stop'}
 *         → 網頁清空播放佇列，0.5 秒內靜音。
 *
 * 網頁協定（自訂、極簡）：
 *   網頁 → relay：binary = PCM16 24kHz mono 會議音訊
 *   relay → 網頁：binary = PCM16 24kHz mono 要播的語音；JSON {type:'stop'} = 立停
 *
 * 斷線行為：網頁 WS 斷 → isAgentLive 轉 false → adapter 自動退回 webhook + mp3 路徑
 * （蜜塔變慢但不失聰失聲）；OpenAI WS 斷而網頁還在 → 自動重連。
 */

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'
const TTS_MODEL = 'gpt-4o-mini-tts'
const TTS_VOICE = 'alloy'
/** 心跳間隔：兩個間隔沒 pong 就視為網頁死亡（bot 瀏覽器當掉），終止連線讓 fallback 接手。 */
const PAGE_PING_INTERVAL_MS = 15_000
const OPENAI_RECONNECT_DELAY_MS = 2_000
/** 推送快取 PCM 時的分塊大小：24kHz × 2 bytes × 0.5s，避免單一巨型 WS frame。 */
const PCM_PUSH_CHUNK_BYTES = 24_000

/** 轉錄詞彙偏置：降低喚醒詞誤轉（蜜塔→米塔/蜜桃）。語言不鎖定，支援中英夾雜。 */
const TRANSCRIPTION_PROMPT =
  '這是一場繁體中文與英文混雜的線上會議。會議助理的名字是「蜜塔」（Meeta），與會者會喊「蜜塔」來提問。'

/** OpenAI GA 轉錄 session 設定（audio/pcm 24kHz mono；server_vad 自動斷句）。 */
function buildSessionUpdate(): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          noise_reduction: { type: 'far_field' },
          transcription: { model: 'gpt-4o-mini-transcribe', prompt: TRANSCRIPTION_PROMPT },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      },
    },
  }
}

function isPageOpen(session: AgentSession): boolean {
  return Boolean(session.pageWs && session.pageWs.readyState === session.pageWs.OPEN)
}

function elapsedSec(session: AgentSession): number {
  return Math.max(0, (Date.now() - session.anchorMs) / 1000)
}

/**
 * 混音轉錄沒有講者標記 → 用 Recall 的 speech_on/off 時間軸反查（回報 2026-07-28 A.4）。
 * 查不到就維持 null，行為與改動前完全相同（喚醒／待命窗對未知講者本就寬鬆處理）。
 *
 * 用 `Date.now()` 而非 segment 的 startTime：兩者在此刻是同一個時間點
 * （startTime 就是這一刻算出來的 elapsedSec），但 epoch 免去座標換算，
 * 也免去 anchorMs 與 Recall 錄製起點是否同刻的疑慮。
 */
function resolveSpeaker(session: AgentSession): string | null {
  return resolveSpeakerAt(session.botId, Date.now())
}

// ── OpenAI 轉錄事件 → 既有 LiveHandlers ──────────────────────────────────────

/**
 * 轉錄事件分派（匯出供單元測試）。
 * delta 是增量文字 → 依 item_id 累積成「講到目前為止的整句」再餵 onPartialSegment
 * （handlePartialSegment 期望的 partial 是可跑喚醒 regex 的完整前綴，不是碎片）。
 */
export function handleTranscriptionEvent(
  session: AgentSession,
  itemTexts: Map<string, string>,
  event: { type?: string; item_id?: string; delta?: string; transcript?: string; error?: unknown },
): void {
  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    const itemId = event.item_id ?? 'unknown'
    const acc = (itemTexts.get(itemId) ?? '') + (event.delta ?? '')
    itemTexts.set(itemId, acc)
    if (!acc.trim()) return
    session.handlers.onPartialSegment?.({
      segmentId: `agent-partial:${itemId}`,
      text: acc,
      speaker: resolveSpeaker(session),
      startTime: elapsedSec(session),
      endTime: elapsedSec(session),
      language: null,
    })
    return
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const itemId = event.item_id ?? 'unknown'
    itemTexts.delete(itemId)
    const text = (event.transcript ?? '').trim()
    if (!text) return
    session.handlers.onSegment?.({
      segmentId: `agent:${itemId}`,
      text,
      speaker: resolveSpeaker(session),
      startTime: elapsedSec(session),
      endTime: elapsedSec(session),
      language: null,
    })
    return
  }

  if (event.type === 'error') {
    logger.warn({ agentId: session.agentId, error: event.error ?? event }, 'agent relay: OpenAI error event')
  }
}

// ── OpenAI 轉錄連線（每個 agent 網頁連線對應一條）─────────────────────────────

function connectOpenAI(session: AgentSession): void {
  if (session.openaiWs) return // 已在連線/重連中
  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  })
  session.openaiWs = ws
  const itemTexts = new Map<string, string>()

  ws.on('open', () => {
    ws.send(JSON.stringify(buildSessionUpdate()))
    // 轉錄鏈就緒 → isAgentLive 才回 true、webhook 喚醒才被抑制。
    // 反之持久連不上（401／額度）時 openaiReady 恆為 false，webhook fallback 自動接手。
    session.openaiReady = true
    logger.info({ agentId: session.agentId, botId: session.botId }, 'agent relay: OpenAI transcription session opened')
  })
  ws.on('message', (raw) => {
    try {
      handleTranscriptionEvent(session, itemTexts, JSON.parse(raw.toString()))
    } catch (err) {
      logger.warn({ err, agentId: session.agentId }, 'agent relay: bad OpenAI event (ignored)')
    }
  })
  ws.on('error', (err) => {
    logger.warn({ err, agentId: session.agentId }, 'agent relay: OpenAI WS error')
  })
  ws.on('close', () => {
    if (session.openaiWs === ws) session.openaiWs = null
    session.openaiReady = false // 耳朵斷了：isAgentLive 轉 false → webhook 喚醒 fallback 接手
    // 網頁還在（bot 還在會議中）→ 重連，不能失聰
    if (isPageOpen(session)) {
      setTimeout(() => {
        if (isPageOpen(session) && !session.openaiWs && getAgentSession(session.agentId)) {
          connectOpenAI(session)
        }
      }, OPENAI_RECONNECT_DELAY_MS)
    }
  })
}

function forwardAudioToOpenAI(session: AgentSession, pcm: Buffer): void {
  const ws = session.openaiWs as WebSocket | null
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }))
}

// ── WS gateway（網頁連進來的入口）────────────────────────────────────────────

/**
 * 掛在 @hono/node-server 的底層 http.Server 上：/ws/agent 的 upgrade 由這裡接手，
 * 其他路徑一律拒絕（本服務沒有別的 WS 端點）。
 */
export function attachAgentGateway(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    let url: URL
    try {
      url = new URL(req.url ?? '', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws/agent') {
      socket.destroy()
      return
    }
    const agentId = url.searchParams.get('agent') ?? ''
    const token = url.searchParams.get('token') ?? ''
    const session = agentId ? getAgentSession(agentId) : undefined
    if (!session || !token || !verifyAgentToken(agentId, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => handlePageConnection(session, ws))
  })

  logger.info('agent relay: gateway attached at /ws/agent')
}

function handlePageConnection(session: AgentSession, ws: WebSocket): void {
  // 網頁 reload / 重連：新連線取代舊的
  if (session.pageWs && session.pageWs !== (ws as unknown as AgentSession['pageWs'])) {
    try {
      session.pageWs.close()
    } catch {
      /* 舊連線可能已死 */
    }
  }
  session.pageWs = ws as unknown as AgentSession['pageWs']
  logger.info({ agentId: session.agentId, botId: session.botId }, 'agent relay: page connected（耳朵/嘴巴上線）')

  connectOpenAI(session)

  // 心跳：瀏覽器會自動回 protocol-level pong；兩個間隔沒回應＝bot 瀏覽器當掉
  let alive = true
  ws.on('pong', () => {
    alive = true
  })
  const pingTimer = setInterval(() => {
    if (!alive) {
      logger.warn({ agentId: session.agentId }, 'agent relay: page heartbeat lost, terminating（退回 webhook+mp3）')
      ws.terminate()
      return
    }
    alive = false
    ws.ping()
  }, PAGE_PING_INTERVAL_MS)

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      forwardAudioToOpenAI(session, data as Buffer)
      return
    }
    // 目前網頁沒有需要上行的 JSON 控制訊息；保留解析容錯即可
  })

  ws.on('close', () => {
    clearInterval(pingTimer)
    if (session.pageWs === (ws as unknown as AgentSession['pageWs'])) {
      session.pageWs = null
      logger.warn(
        { agentId: session.agentId, botId: session.botId },
        'agent relay: page disconnected → fallback to webhook + mp3 until reconnect',
      )
      // 轉錄連線隨網頁一起收掉（沒耳朵就不用付串流轉錄錢；網頁重連時會再開）
      const openai = session.openaiWs as WebSocket | null
      if (openai) {
        session.openaiWs = null
        try {
          openai.close()
        } catch {
          /* best-effort */
        }
      }
    }
  })
  ws.on('error', (err) => {
    logger.warn({ err, agentId: session.agentId }, 'agent relay: page WS error')
  })
}

// ── 嘴巴：TTS 串流 / 快取推送 / 立停 ─────────────────────────────────────────

function sendPcmToPage(session: AgentSession, pcm: Buffer, epoch: number): void {
  for (let off = 0; off < pcm.length; off += PCM_PUSH_CHUNK_BYTES) {
    if (session.speakEpoch !== epoch || !isPageOpen(session)) return
    session.pageWs!.send(pcm.subarray(off, off + PCM_PUSH_CHUNK_BYTES))
  }
}

function cachePcm(session: AgentSession, text: string, pcm: Buffer): void {
  if (session.pcmCache.size >= PCM_CACHE_MAX) {
    const oldest = session.pcmCache.keys().next().value
    if (oldest !== undefined) session.pcmCache.delete(oldest)
  }
  session.pcmCache.set(text, pcm)
}

/** text → PCM(24kHz s16le mono) 完整 buffer（預熱用，不串流）。 */
async function synthesizePcm(text: string): Promise<Buffer> {
  const res = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'pcm' }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`agent relay: TTS failed ${res.status}: ${t}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * 讓 bot 用 agent 網頁說話。回傳 false = 網頁不在線（呼叫端退回 mp3 路徑）。
 * 快取命中（ack 等預熱句）→ 整段直接推，零合成延遲；
 * 未命中 → TTS 串流回應邊收邊轉發，網頁邊收邊播（首音 ~0.5s）。
 */
export async function agentSpeak(botId: string, text: string): Promise<boolean> {
  const session = getAgentSessionByBotId(botId)
  if (!session || !isPageOpen(session)) return false

  const epoch = session.speakEpoch
  const cached = session.pcmCache.get(text)
  if (cached) {
    sendPcmToPage(session, cached, epoch)
    sendFlush(session, epoch)
    return true
  }

  const res = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'pcm' }),
  }).catch((err) => {
    logger.warn({ err, botId }, 'agent relay: streaming TTS request failed')
    return null
  })
  if (!res || !res.ok || !res.body) {
    if (res) logger.warn({ botId, status: res.status }, 'agent relay: streaming TTS bad response')
    return false // 讓呼叫端退回 mp3 路徑重試
  }

  // PCM 是 16-bit：WS frame 必須偶數位元組對齊，跨 chunk 的落單位元組先留著（carry）
  let carry: Buffer | null = null
  for await (const raw of res.body) {
    // 被 barge-in 停掉不算失敗，不要再走 mp3 蓋台（return 讓 async iterator 自動 cancel 串流）
    if (session.speakEpoch !== epoch || !isPageOpen(session)) return true
    let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
    if (carry) {
      chunk = Buffer.concat([carry, chunk])
      carry = null
    }
    if (chunk.length % 2 === 1) {
      carry = chunk.subarray(chunk.length - 1)
      chunk = chunk.subarray(0, chunk.length - 1)
    }
    if (chunk.length) session.pageWs!.send(chunk)
  }
  sendFlush(session, epoch)
  return true
}

/** 通知網頁「這一句的串流已結束」：播放端剩多少播多少，短句不用等 jitter buffer 積滿。 */
function sendFlush(session: AgentSession, epoch: number): void {
  if (session.speakEpoch !== epoch || !isPageOpen(session)) return
  session.pageWs!.send(JSON.stringify({ type: 'flush' }))
}

/** 預先合成台詞進 PCM 快取（不播放）。網頁未連線也可預熱（純 API 呼叫）。 */
export async function agentPrimeSpeech(botId: string, texts: string[]): Promise<void> {
  const session = getAgentSessionByBotId(botId)
  if (!session) return
  for (const text of texts) {
    if (session.pcmCache.has(text)) continue
    const pcm = await synthesizePcm(text).catch((err) => {
      logger.warn({ err, text: text.slice(0, 20) }, 'agent relay: primeSpeech synth failed')
      return null
    })
    if (pcm) cachePcm(session, text, pcm)
  }
}

/** 立即停止播放（barge-in 讓路）。回傳 false = 網頁不在線（呼叫端走 Recall API 停）。 */
export function agentStopSpeaking(botId: string): boolean {
  const session = getAgentSessionByBotId(botId)
  if (!session || !isPageOpen(session)) return false
  session.speakEpoch++ // 作廢串流中的 TTS 轉發
  session.pageWs!.send(JSON.stringify({ type: 'stop' }))
  return true
}

/** bot 離開會議：關閉兩側連線並移除註冊（adapter.leave 呼叫）。 */
export function teardownAgentSession(agentId: string): void {
  const session = unregisterAgentSession(agentId)
  if (!session) return
  try {
    session.pageWs?.close()
  } catch {
    /* best-effort */
  }
  try {
    ;(session.openaiWs as WebSocket | null)?.close()
  } catch {
    /* best-effort */
  }
  session.pageWs = null
  session.openaiWs = null
}
