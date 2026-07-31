import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { toTraditional } from '../lib/zh.js'
import { createProbeState, ingestProbeMessage, maybeLogSummary } from './recall-audio-probe.js'
import {
  getAgentSession,
  getAgentSessionByBotId,
  unregisterAgentSession,
  verifyAgentToken,
  currentSpeakerName,
  PCM_CACHE_MAX,
  type AgentSession,
} from './agent-registry.js'

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
/** PCM16 24kHz mono 的位元組/毫秒：由送出的位元組數推算播放長度（用於解除靜音的時機）。 */
const PCM_BYTES_PER_MS = 48

/**
 * 轉錄詞彙偏置：降低喚醒詞誤轉（蜜塔→米塔/蜜桃）＋指定輸出字體。
 *
 * 語言不鎖定（中英夾雜的會議兩種都要轉得出來），但要求中文輸出**繁體**——
 * 模型預設常吐簡體。prompt 只能偏置不能保證，所以 {@link handleTranscriptionEvent}
 * 還會用 OpenCC 做一次確定性轉換（webhook 路徑早就這樣做，見 provider/normalize.ts）。
 *
 * 寫成「詞彙表」而非完整句子：轉錄模型在靜音/雜訊段會把通順的提示句原封不動吐成
 * 轉錄結果（實測 2026-07-22：整句提示被當成使用者提問送去查詢），詞彙表比較不會。
 * 即使仍被吐出來，也會被 {@link isEchoOf} 的提示回音比對擋掉。
 */
export const TRANSCRIPTION_PROMPT = '會議專有名詞：蜜塔、Meeta、小幫手。中文輸出繁體字，英文保留原文。'

/** 播放結束後仍要維持的靜音尾巴：會議混音回灌有數百毫秒延遲。 */
const SELF_AUDIO_TAIL_MS = 1_200
/** 讓路（barge-in）時的靜音尾巴：要立刻聽得到打斷的人，尾巴取短。 */
const BARGE_IN_TAIL_MS = 300
/** 文字層回音比對保留的最近語句數。 */
const RECENT_SPEECH_MAX = 6
/** 回音比對的最短長度（正規化後）：太短的句子（「蜜塔」「好」）比對會誤殺真人發言。 */
const ECHO_MIN_CHARS = 8
/** 回音比對的相似度門檻（bigram Dice）。 */
const ECHO_SIMILARITY = 0.65
/**
 * 沒有 PCM 位元組數可用時的播放長度估算（mp3 fallback、串流開始前的暫定值）。
 * 刻意估得比實際保守一點點就好：串流路徑等 PCM 送完會用精確值取大值修正，
 * 估太長只會讓蜜塔講完後多聾幾秒（聽不到馬上接話的人）。
 */
const FALLBACK_SPEECH_MS_PER_CHAR = 200
const FALLBACK_SPEECH_EXTRA_MS = 1_000

// ── 回音判斷（自身語音／提示句被轉錄回來）──────────────────────────────────────

/** 去標點、去空白、轉小寫：轉錄回來的標點與原文幾乎不會一致，只比對文字本身。 */
export function normalizeForEcho(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigramCounts(s: string): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** Dice 係數（bigram）：轉錄會漏字/改字，純字串相等擋不住，用相似度。 */
function diceSimilarity(a: string, b: string): number {
  const ga = bigramCounts(a)
  const gb = bigramCounts(b)
  let overlap = 0
  let totalA = 0
  let totalB = 0
  for (const n of ga.values()) totalA += n
  for (const [g, n] of gb) {
    totalB += n
    overlap += Math.min(n, ga.get(g) ?? 0)
  }
  return totalA + totalB === 0 ? 0 : (2 * overlap) / (totalA + totalB)
}

/**
 * candidate 是不是 reference 的回音？（reference = 蜜塔說過的話 / 轉錄提示句）
 * 兩條規則：candidate 是 reference 的片段（回灌常只錄到一部分），或整體高度相似。
 */
export function isEchoOf(candidate: string, reference: string): boolean {
  const a = normalizeForEcho(candidate)
  const b = normalizeForEcho(reference)
  if (a.length < ECHO_MIN_CHARS || b.length < ECHO_MIN_CHARS) return false
  if (b.includes(a)) return true
  return diceSimilarity(a, b) >= ECHO_SIMILARITY
}

/**
 * 這段轉錄該不該丟棄？回傳丟棄原因（null = 保留）。
 *
 * ⚠️ 只看「內容像不像回音」，**不能**看「事件到達時是不是靜音窗」：
 * 定稿轉錄比說話晚 1.5–3 秒，使用者問完問題後蜜塔正在說「我收到了」，
 * 那句問題的定稿正好落在靜音窗裡——用時間判斷會把真正的問題丟掉，
 * 症狀就是「蜜塔說收到，然後沒有下文、聊天室也沒有訊息」（實測 2026-07-25）。
 * 自身語音是在**輸入端**擋掉的（{@link forwardAudioToOpenAI} 送靜音蓋掉），
 * 這裡只負責殘留的漏網之魚（提示句回音、混音延遲回灌）。
 */
export function dropTranscriptReason(session: AgentSession, text: string): string | null {
  if (isEchoOf(text, TRANSCRIPTION_PROMPT)) return 'prompt-echo'
  if (session.recentSpeech.some((spoken) => isEchoOf(text, spoken))) return 'self-speech-echo'
  return null
}

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
            // 斷句門檻（見 env.ts 的說明）：這是唯一決定句子在哪切開的參數，
            // 可用 STT_SILENCE_DURATION_MS 調整以便實測不同值的斷句品質。
            silence_duration_ms: env.STT_SILENCE_DURATION_MS,
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
    // 逐塊轉繁體：喚醒詞比對、聊天室確認訊息、逐字稿都要是繁體
    //（模型即使被 prompt 要求也常吐簡體；英文與數字不受影響）。
    const acc = (itemTexts.get(itemId) ?? '') + toTraditional(event.delta ?? '')
    itemTexts.set(itemId, acc)
    if (!acc.trim()) return
    const partialDrop = dropTranscriptReason(session, acc)
    if (partialDrop) {
      logger.debug({ agentId: session.agentId, reason: partialDrop, text: acc.slice(0, 40) }, 'agent relay: partial dropped')
      return
    }
    session.handlers.onPartialSegment?.({
      segmentId: `agent-partial:${itemId}`,
      text: acc,
      // 混音轉錄本身沒有講者標記 → 用 Recall 的 speech_on/off 推出「現在是誰在講」
      //（判斷不出來時為 null，喚醒/待命窗對未知講者本就寬鬆處理）
      speaker: currentSpeakerName(session.botId),
      startTime: elapsedSec(session),
      endTime: elapsedSec(session),
      language: null,
    })
    return
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const itemId = event.item_id ?? 'unknown'
    itemTexts.delete(itemId)
    const text = toTraditional((event.transcript ?? '').trim())
    if (!text) return
    const drop = dropTranscriptReason(session, text)
    if (drop) {
      // 這裡擋掉的多半是蜜塔自己的聲音或提示句回音——放行就會變成「自己問自己」的迴圈。
      logger.info({ agentId: session.agentId, reason: drop, text: text.slice(0, 60) }, 'agent relay: transcript dropped')
      return
    }
    session.handlers.onSegment?.({
      segmentId: `agent:${itemId}`,
      text,
      speaker: currentSpeakerName(session.botId),
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
  // 靜音窗內（蜜塔正在出聲）改送等長的靜音：網頁的靜音指令有往返延遲，
  // 這期間送上來的音訊就是蜜塔自己的聲音。
  // 送靜音而不是整塊丟掉——server_vad 靠連續的音訊流判斷「講完了」，
  // 中間斷流會讓正在進行的那句遲遲不定稿（使用者的問題就這樣卡住不見）。
  const payload = Date.now() < session.selfAudioGuardUntil ? Buffer.alloc(pcm.length) : pcm
  ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload.toString('base64') }))
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
    // /ws/agent      = Output Media 網頁（耳朵＋嘴巴，現行路徑）
    // /ws/recall-audio = Recall 獨立音軌探針（唯讀統計，見 recall-audio-probe.ts）
    const isAgentPath = url.pathname === '/ws/agent'
    const isProbePath = url.pathname === '/ws/recall-audio'
    if (!isAgentPath && !isProbePath) {
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
    wss.handleUpgrade(req, socket, head, (ws) =>
      isProbePath ? handleProbeConnection(session, ws) : handlePageConnection(session, ws),
    )
  })

  logger.info('agent relay: gateway attached at /ws/agent (+ /ws/recall-audio probe)')
}

/**
 * Recall 獨立音軌探針的連線處理。
 *
 * **只統計不轉錄** —— 這條路的目的是驗證「耳朵能不能從 Output Media 網頁搬到
 * Recall 的 per-participant 音軌」。驗證通過後才會把它接到 OpenAI 轉錄，
 * 那時 selfAudioGuard／inputMute 整套靜音窗就可以拆掉（改用 participant id 濾自己）。
 */
function handleProbeConnection(session: AgentSession, ws: WebSocket): void {
  const state = createProbeState(session.botName)
  logger.info(
    { agentId: session.agentId, botId: session.botId },
    'audio probe: Recall 獨立音軌連線已建立',
  )

  ws.on('message', (data, isBinary) => {
    if (isBinary) return // 協定是 JSON；二進位不該出現在這條
    ingestProbeMessage(state, data.toString())
    maybeLogSummary(state)
  })
  ws.on('close', () => {
    maybeLogSummary(state, true)
    logger.info({ agentId: session.agentId, totalMessages: state.totalMessages }, 'audio probe: 連線結束')
  })
  ws.on('error', (err) => logger.warn({ err, agentId: session.agentId }, 'audio probe: WS error'))
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
  // 新網頁一律從「未靜音」開始（reload 後網頁端狀態歸零，伺服器端要跟著同步，
  // 否則 inputMuted 殘留 true 會讓靜音指令被去重掉、蜜塔對自己的聲音失去防護）。
  session.inputMuted = false
  session.selfAudioGuardUntil = 0
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

/** 要求網頁停/開上行收音（重複狀態不重送）。 */
function setInputMuted(session: AgentSession, muted: boolean): void {
  if (!isPageOpen(session)) {
    session.inputMuted = false // 網頁不在線：狀態歸零，重連後不會誤以為還靜音著
    return
  }
  if (session.inputMuted === muted) return
  session.inputMuted = muted
  session.pageWs!.send(JSON.stringify({ type: 'input-mute', muted }))
}

/**
 * 靜音窗到期才解除收音。期間又開口（新的一句）會把 selfAudioGuardUntil 往後推，
 * 這裡自動重排——因此「先前那句的解除計時器」不會在新句子播到一半時把麥克風打開。
 */
function scheduleUnmute(session: AgentSession): void {
  const delay = session.selfAudioGuardUntil - Date.now()
  if (delay > 0) {
    setTimeout(() => scheduleUnmute(session), delay + 50)
    return
  }
  setInputMuted(session, false)
}

/** 開口前的共同準備：記住說了什麼（文字層回音比對用）＋靜音上行。 */
function beginSpeaking(session: AgentSession, text: string, estimatedMs: number): void {
  session.recentSpeech.push(text)
  if (session.recentSpeech.length > RECENT_SPEECH_MAX) session.recentSpeech.shift()
  session.selfAudioGuardUntil = Math.max(session.selfAudioGuardUntil, Date.now() + estimatedMs)
  setInputMuted(session, true)
}

/** 語音送完：依實際 PCM 位元組數推算播完的時刻，之後才解除靜音。 */
function endSpeaking(session: AgentSession, bytesSent: number, startedAt: number): void {
  const playbackMs = bytesSent / PCM_BYTES_PER_MS
  const endsAt = Math.max(Date.now(), startedAt + playbackMs) + SELF_AUDIO_TAIL_MS
  session.selfAudioGuardUntil = Math.max(session.selfAudioGuardUntil, endsAt)
  scheduleUnmute(session)
}

/** 出聲失敗（沒有半個音播出去）：立刻解除靜音，否則蜜塔會永久失聰。 */
function abortSpeaking(session: AgentSession): void {
  session.selfAudioGuardUntil = Date.now()
  setInputMuted(session, false)
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
  const startedAt = Date.now()
  // Mute upstream capture before sending any output audio. The Output Media
  // microphone can contain the meeting mix, including Meeta's own playback.
  // 先以字數粗估靜音長度，實際長度等 PCM 送完再依位元組數修正。
  beginSpeaking(session, text, estimateFallbackSpeechMs(text))

  const cached = session.pcmCache.get(text)
  if (cached) {
    sendPcmToPage(session, cached, epoch)
    sendFlush(session, epoch)
    endSpeaking(session, cached.length, startedAt)
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
    abortSpeaking(session)
    return false // 讓呼叫端退回 mp3 路徑重試
  }

  // PCM 是 16-bit：WS frame 必須偶數位元組對齊，跨 chunk 的落單位元組先留著（carry）
  let carry: Buffer | null = null
  let bytesSent = 0
  try {
    for await (const raw of res.body) {
      // 被 barge-in 停掉不算失敗，不要再走 mp3 蓋台（return 讓 async iterator 自動 cancel 串流）
      // 靜音解除由 agentStopSpeaking 負責（它會把靜音窗縮到讓路的短尾巴）。
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
      if (chunk.length) {
        session.pageWs!.send(chunk)
        bytesSent += chunk.length
      }
    }
  } catch (err) {
    // 串流中斷：已播出去的部分照樣要等它播完（bytesSent > 0），完全沒播出去就直接解靜音。
    logger.warn({ err, botId }, 'agent relay: TTS stream aborted mid-way')
    if (bytesSent === 0) {
      abortSpeaking(session)
      return false
    }
  }
  sendFlush(session, epoch)
  endSpeaking(session, bytesSent, startedAt)
  return true
}

/** 字數估算播放毫秒（PCM 位元組數拿不到時的退路：mp3 fallback／尚未開始串流）。 */
function estimateFallbackSpeechMs(text: string): number {
  return text.length * FALLBACK_SPEECH_MS_PER_CHAR + FALLBACK_SPEECH_EXTRA_MS
}

/**
 * 走 Recall mp3 路徑出聲時通知 relay（recall-adapter 呼叫）。
 * mp3 是由 Recall 播進會議，網頁的「麥克風」照樣收得到 → 沒有這道通知就沒有回音防護。
 */
export function agentNoteExternalSpeech(botId: string, text: string): void {
  const session = getAgentSessionByBotId(botId)
  if (!session) return
  beginSpeaking(session, text, estimateFallbackSpeechMs(text) + SELF_AUDIO_TAIL_MS)
  scheduleUnmute(session)
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
  // 讓路 = 要立刻聽得見打斷的人：靜音窗縮成短尾巴（只擋殘留在會議混音裡的尾音）。
  session.selfAudioGuardUntil = Date.now() + BARGE_IN_TAIL_MS
  scheduleUnmute(session)
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
