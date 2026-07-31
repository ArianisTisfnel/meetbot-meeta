import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../types/env.js'
import type { LiveHandlers } from '../provider/types.js'

/**
 * Agent session registry — Output Media 即時語音 agent（方案 A）的共用狀態。
 *
 * 一個 agent session 對應「一個 Recall bot ＋ 它瀏覽器裡開的 agent 網頁」。
 * bot 建立時（recall-adapter.join）先產生 agentId 放進網頁 URL（bot id 要等
 * POST 回來才知道，網頁 URL 卻必須在同一個 payload 裡 → 用自產 id 解雞生蛋），
 * 網頁載入後帶 agentId＋簽名 token 連回 /ws/agent，由 relay 依 agentId 找回這裡的註冊。
 *
 * 與 recall-adapter 的 realtimeRegistry 分開：那邊管 webhook（逐字稿/聊天室），
 * 這邊管串流語音（喚醒/回答）。兩邊共用同一組 LiveHandlers。
 */

/** WS 連線的最小介面（避免 registry 依賴 ws 套件的執行期物件；ws 與瀏覽器皆相容）。 */
export interface PageSocketLike {
  readonly readyState: number
  readonly OPEN: number
  send(data: string | Buffer): void
  close(): void
}

export interface AgentSession {
  agentId: string
  botId: string
  botName: string
  handlers: LiveHandlers
  /** agent 網頁目前的 WS 連線（null = 尚未連上 / 已斷線 → 退回 webhook + mp3）。 */
  pageWs: PageSocketLike | null
  /** relay 對 OpenAI 轉錄 WS 的把手（型別由 relay 管理，registry 只負責存放）。 */
  openaiWs: unknown
  /**
   * OpenAI 轉錄鏈是否就緒（WS 連上＝true，斷線／未連＝false，由 relay 維護）。
   * isAgentLive 一併判斷：網頁在線但轉錄鏈掛掉（持久 401／額度／API 變動）時，
   * webhook 喚醒抑制自動解除、退回 webhook fallback，避免「網頁連著卻聽不到」的全聾狀態。
   */
  openaiReady: boolean
  /** 語音世代計數：stopSpeaking 時 +1，讓串流中的 TTS 轉發知道自己已作廢。 */
  speakEpoch: number
  /**
   * 自身語音的回灌防護（epoch ms）：此時刻之前收到的轉錄一律丟棄。
   * 「麥克風」是會議混音，蜜塔自己的聲音會延遲數百毫秒回灌進來——沒有這道閘，
   * 蜜塔會把自己的回答當成新問題再答一次（無限迴圈的主因）。
   */
  selfAudioGuardUntil: number
  /** 是否已要求網頁靜音上行（避免重複送，且失敗路徑一定解得掉）。 */
  inputMuted: boolean
  /** 最近說過的話（原文）：文字層比對，擋掉延遲回灌的自身語音轉錄。 */
  recentSpeech: string[]
  /** 固定台詞（ack/進度句）與預熱答案的 TTS PCM 快取（24kHz s16le mono）。 */
  pcmCache: Map<string, Buffer>
  /**
   * 會議相對時間錨點（epoch ms）：segment startTime = (now - anchorMs) / 1000。
   * 註冊時先填建立時間，admitted 時由 adapter 更新成與 session.sessionStartedAt
   * 幾乎同刻的值——barge-in 的晚到事件防護用 sessionStartedAt + startTime 還原
   * 開口時刻，錨點不對齊會把即時插話誤判成晚到事件而略過。
   */
  anchorMs: number
}

const byAgentId = new Map<string, AgentSession>()
const agentIdByBotId = new Map<string, string>()

/** PCM 快取上限（同 adapter 的 mp3 快取；答案預熱會進來，防無界成長）。 */
export const PCM_CACHE_MAX = 30

// ── 現正發言者（agent 模式的講者歸屬）────────────────────────────────────────
//
// agent 網頁的「麥克風」是會議混音，串流轉錄拿不到講者標記（誰問的都變成匿名）。
// Recall 的 participant_events.speech_on/off 是低延遲的與會者事件（與逐字稿無關），
// 用它維護「現在誰在講話」，relay 產生 segment 時就能標上真名——
// 聊天室的確認訊息才寫得出「收到 Arianis 的語音提問」，插話決策也才知道是誰說的。

interface SpeechState {
  /** 正在說話的人 → 開始時間（epoch ms）。 */
  speaking: Map<string, number>
  /** 最後一個停止說話的人：定稿轉錄比 speech_off 晚到，剛講完的人仍是最佳歸屬。 */
  lastStopped: { name: string; at: number } | null
}

const speechByBotId = new Map<string, SpeechState>()

/** speech_off 之後仍可歸屬給該講者的時間（定稿轉錄比說話晚 1.5–3 秒）。 */
const RECENT_SPEAKER_MS = 6_000

/** Recall participant_events.speech_on/off → 更新發言狀態（recall-adapter 呼叫）。 */
export function noteParticipantSpeech(botId: string, name: string, speaking: boolean): void {
  const trimmed = name.trim()
  if (!trimmed) return // 沒有名字就無從歸屬
  let state = speechByBotId.get(botId)
  if (!state) {
    state = { speaking: new Map(), lastStopped: null }
    speechByBotId.set(botId, state)
  }
  if (speaking) {
    state.speaking.set(trimmed, Date.now())
  } else if (state.speaking.delete(trimmed)) {
    state.lastStopped = { name: trimmed, at: Date.now() }
  }
}

/**
 * 這段話最可能是誰說的？（null = 無法判斷，呼叫端就當匿名處理）
 * 兩人以上同時在說話時一律回 null——寧可匿名，也不要把問題掛到錯的人頭上。
 */
export function currentSpeakerName(botId: string): string | null {
  const state = speechByBotId.get(botId)
  if (!state) return null
  if (state.speaking.size === 1) return [...state.speaking.keys()][0]
  if (state.speaking.size > 1) return null
  const last = state.lastStopped
  return last && Date.now() - last.at < RECENT_SPEAKER_MS ? last.name : null
}

/** bot 離開會議時清掉發言狀態（recall-adapter 的 leave 呼叫）。 */
export function clearParticipantSpeech(botId: string): void {
  speechByBotId.delete(botId)
}

/** agent 模式是否啟用（開關 on 且必要設定齊全）。 */
export function isAgentModeEnabled(): boolean {
  return (
    env.AGENT_MODE === 'on' &&
    Boolean(env.AGENT_PAGE_URL && env.OPENAI_API_KEY && env.RECALL_WEBHOOK_URL && env.RECALL_WEBHOOK_TOKEN)
  )
}

/** agentId 的簽名 token（HMAC-SHA256，密鑰沿用 RECALL_WEBHOOK_TOKEN，不新增必填 env）。 */
export function signAgentToken(agentId: string): string {
  return createHmac('sha256', env.RECALL_WEBHOOK_TOKEN ?? '').update(agentId).digest('hex')
}

export function verifyAgentToken(agentId: string, token: string): boolean {
  const expected = Buffer.from(signAgentToken(agentId))
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * bot 瀏覽器要開的網頁 URL。
 * 網頁由後端自己供應（routes/agent-page.ts），與 /ws/agent 同源——頁面拿 agent+token
 * 自行組同源 WS URL，因此網頁與 WS 只需要「一條」公開 tunnel（cloudflared，無 ngrok 警告頁）。
 * 跨源部署（頁面放前端）時，頁面另支援 ?ws= 完整 WS URL 覆蓋（手動測試用）。
 */
export function buildAgentPageUrl(agentId: string): string {
  const base = (env.AGENT_PAGE_URL ?? '').replace(/\/+$/, '')
  return `${base}?agent=${agentId}&token=${signAgentToken(agentId)}`
}

export function registerAgentSession(
  agentId: string,
  botId: string,
  botName: string,
  handlers: LiveHandlers,
): AgentSession {
  const session: AgentSession = {
    agentId,
    botId,
    botName,
    handlers,
    pageWs: null,
    openaiWs: null,
    openaiReady: false,
    speakEpoch: 0,
    selfAudioGuardUntil: 0,
    inputMuted: false,
    recentSpeech: [],
    pcmCache: new Map(),
    anchorMs: Date.now(),
  }
  byAgentId.set(agentId, session)
  agentIdByBotId.set(botId, agentId)
  return session
}

export function unregisterAgentSession(agentId: string): AgentSession | undefined {
  const session = byAgentId.get(agentId)
  if (!session) return undefined
  byAgentId.delete(agentId)
  agentIdByBotId.delete(session.botId)
  return session
}

export function getAgentSession(agentId: string): AgentSession | undefined {
  return byAgentId.get(agentId)
}

export function getAgentSessionByBotId(botId: string): AgentSession | undefined {
  const agentId = agentIdByBotId.get(botId)
  return agentId ? byAgentId.get(agentId) : undefined
}

/** admitted 時對齊時間錨點（與 session.sessionStartedAt 同刻，誤差毫秒級）。 */
export function markAgentAnchor(agentId: string): void {
  const session = byAgentId.get(agentId)
  if (session) session.anchorMs = Date.now()
}

/**
 * agent「耳朵」是否在線（webhook 喚醒抑制的依據）。
 * 需同時滿足：網頁 WS 連著 ＋ OpenAI 轉錄鏈就緒。少任一條（網頁斷／轉錄掛）→ false，
 * webhook 喚醒 fallback 自動接手。注意：speak 分流走 isPageOpen（嘴巴與轉錄無關），不看這裡。
 */
export function isAgentLive(botId: string): boolean {
  const session = getAgentSessionByBotId(botId)
  return Boolean(
    session?.pageWs &&
      session.pageWs.readyState === session.pageWs.OPEN &&
      session.openaiReady,
  )
}
