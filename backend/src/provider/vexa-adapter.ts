import WebSocket from 'ws'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import * as vexaClient from '../lib/vexa.js'
import { normalizeVexaWsSegment, normalizeVexaRestSegment } from './normalize.js'
import {
  BotAdmissionError,
  type BotOptions,
  type BotSession,
  type LiveHandlers,
  type MeetingBotProvider,
  type TranscriptSegment,
} from './types.js'

// 向後相容的別名：純正規化函式現居於 ./normalize（無 env 依賴，方便測試）。
export { normalizeVexaWsSegment as normalizeWsSegment, normalizeVexaRestSegment as normalizeRestSegment } from './normalize.js'

/** 預設等待 admitted 的逾時（毫秒）。 */
const ADMISSION_TIMEOUT_MS = 30_000
/** WS 斷線後自動重連間隔。 */
const RECONNECT_DELAY_MS = 3_000
/** Vexa TTS 預設語音設定（沿用既有 wake-word-detector 的值）。 */
const VEXA_TTS_PROVIDER = 'openai'
const VEXA_TTS_VOICE = 'alloy'

const VEXA_TERMINAL_STATUSES = ['completed', 'failed', 'needs_help', 'needs_human_help']
const VEXA_BLOCKED_STATUSES = ['needs_help', 'needs_human_help']

/** VexaAdapter 實際用到的 WS 介面子集（單元測試以假物件注入）。 */
export interface WsLike {
  send(data: string): void
  close(): void
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
}

/** 可注入的 WS 建構器；預設用真的 ws 套件。 */
export type WsFactory = (url: string, opts: { headers: Record<string, string> }) => WsLike

interface VexaSessionState extends Record<string, unknown> {
  vexaToken: string
  ws: WsLike | null
  /** 主動關閉旗標：true 時 WS close 不再重連。 */
  intentionallyClosed: boolean
  /** 是否已被 admitted（避免重複觸發 onStatus admitted）。 */
  admitted: boolean
}

function getState(session: BotSession): VexaSessionState {
  return session.state as VexaSessionState
}

export class VexaAdapter implements MeetingBotProvider {
  readonly name = 'vexa'

  constructor(
    private readonly admissionTimeoutMs: number = ADMISSION_TIMEOUT_MS,
    private readonly createWs: WsFactory = (url, opts) => new WebSocket(url, opts),
  ) {}

  async join(url: string, opts: BotOptions, handlers: LiveHandlers): Promise<BotSession> {
    const vexaToken = opts.vexaToken
    if (!vexaToken) {
      throw new BotAdmissionError(this.name, 'blocked', 'VexaAdapter.join: missing vexaToken')
    }

    // ① 派 bot（dispatch API 回 200 並不代表 bot 真的進得去）
    const { vexaMeetingId } = await vexaClient.inviteBot({ googleMeetUrl: url, vexaToken })

    const session: BotSession = {
      provider: this.name,
      platform: opts.platform,
      nativeMeetingId: opts.nativeMeetingId,
      providerMeetingId: vexaMeetingId,
      adapter: this,
      state: {
        vexaToken,
        ws: null,
        intentionallyClosed: false,
        admitted: false,
      } satisfies VexaSessionState,
    }

    // ② 開 WS + 等 admitted。被擋 / timeout → 撤 bot 並 throw。
    try {
      await this.openStreamAndAwaitAdmission(session, handlers)
    } catch (err) {
      await this.leave(session).catch((e) =>
        logger.warn({ e, nativeMeetingId: opts.nativeMeetingId }, 'VexaAdapter: cleanup after admission failure failed'),
      )
      throw err
    }

    return session
  }

  /**
   * 開啟 WS、掛上訊息處理器與自動重連，並回傳一個在 bot 被 admitted 時 resolve、
   * 被擋 / timeout 時 reject 的 promise。
   */
  private openStreamAndAwaitAdmission(session: BotSession, handlers: LiveHandlers): Promise<void> {
    const state = getState(session)

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new BotAdmissionError(this.name, 'timeout'))
      }, this.admissionTimeoutMs)

      const onAdmitted = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const onBlocked = (reason?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new BotAdmissionError(this.name, 'blocked', reason))
      }

      this.connect(session, handlers, { onAdmitted, onBlocked })
    })
  }

  /**
   * 建立並接線 WS（含自動重連）。admission callbacks 只在首次連線的等待階段使用。
   */
  private connect(
    session: BotSession,
    handlers: LiveHandlers,
    admission: { onAdmitted: () => void; onBlocked: (reason?: string) => void },
  ): void {
    const state = getState(session)
    const ws = this.createWs(`${env.VEXA_WS_URL}/ws`, {
      headers: { 'X-API-Key': state.vexaToken },
    })
    state.ws = ws

    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          meetings: [{ platform: session.platform, native_id: session.nativeMeetingId }],
        }),
      )
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this.handleWsMessage(session, msg, handlers, admission)
      } catch (err) {
        logger.warn({ err, nativeMeetingId: session.nativeMeetingId }, 'VexaAdapter: failed to parse ws message')
      }
    })

    ws.on('close', () => {
      if (state.intentionallyClosed) return
      logger.warn({ nativeMeetingId: session.nativeMeetingId }, 'VexaAdapter: WS disconnected, reconnecting')
      setTimeout(() => {
        if (state.intentionallyClosed) return
        // 重連後不再參與 admission 等待（admission 早已 settle）
        this.connect(session, handlers, admission)
      }, RECONNECT_DELAY_MS)
    })

    ws.on('error', (err) =>
      logger.error({ err, nativeMeetingId: session.nativeMeetingId }, 'VexaAdapter: WS error'),
    )
  }

  private handleWsMessage(
    session: BotSession,
    msg: any,
    handlers: LiveHandlers,
    admission: { onAdmitted: () => void; onBlocked: (reason?: string) => void },
  ): void {
    const state = getState(session)

    switch (msg.type) {
      case 'transcript.bundle':
      case 'transcript': {
        const confirmed: any[] = msg.confirmed ?? []
        for (const seg of confirmed) {
          if (!seg.text?.trim() || !seg.segment_id) continue
          handlers.onSegment?.(normalizeVexaWsSegment(seg, msg.speaker))
        }
        break
      }
      case 'meeting.status': {
        const status: string | undefined = msg.payload?.status
        if (!status) break

        if (status === 'active') {
          if (!state.admitted) {
            state.admitted = true
            admission.onAdmitted()
            handlers.onStatus?.({ type: 'admitted' })
          }
          break
        }

        if (VEXA_TERMINAL_STATUSES.includes(status)) {
          const blocked = VEXA_BLOCKED_STATUSES.includes(status)
          // 尚未 admitted 就進入 terminal → 只發「被擋」的 join 失敗訊號，**不得**發 ended。
          // ended 會觸發上層 handleSessionClose 撤掉 session，害接手的 failover bot 被立即踢出
          // （實測：bot 遇 reCAPTCHA 十餘秒內就回報 needs_human_help，必踩這條路）。
          if (!state.admitted) {
            admission.onBlocked(status)
            break
          }
          handlers.onStatus?.({
            type: 'ended',
            reason: blocked || status === 'failed' ? 'failed' : 'completed',
          })
        }
        break
      }
      case 'chat.new_message': {
        const p = msg.payload
        if (!p || p.is_from_bot) break
        handlers.onChat?.({
          sender: p.sender,
          text: p.text,
          timestamp: p.timestamp,
          isFromBot: p.is_from_bot,
        })
        break
      }
      default:
        logger.debug({ type: msg.type, nativeMeetingId: session.nativeMeetingId }, 'VexaAdapter: unhandled ws message')
    }
  }

  async getTranscript(session: BotSession): Promise<TranscriptSegment[]> {
    const state = getState(session)
    const raw = await vexaClient.getTranscriptions(
      session.platform,
      session.nativeMeetingId,
      state.vexaToken,
    )
    return raw.map(normalizeVexaRestSegment)
  }

  async speak(session: BotSession, text: string): Promise<void> {
    const state = getState(session)
    await vexaClient.speak(session.platform, session.nativeMeetingId, state.vexaToken, {
      text,
      provider: VEXA_TTS_PROVIDER,
      voice: VEXA_TTS_VOICE,
    })
  }

  async sendChat(session: BotSession, text: string): Promise<void> {
    const state = getState(session)
    await vexaClient.chatSend(session.platform, session.nativeMeetingId, state.vexaToken, { text })
  }

  async leave(session: BotSession): Promise<void> {
    const state = getState(session)
    state.intentionallyClosed = true

    try {
      state.ws?.send(
        JSON.stringify({
          action: 'unsubscribe',
          meetings: [{ platform: session.platform, native_id: session.nativeMeetingId }],
        }),
      )
      state.ws?.close()
    } catch {
      logger.warn({ nativeMeetingId: session.nativeMeetingId }, 'VexaAdapter.leave: WS already closed')
    }
    state.ws = null

    await vexaClient
      .removeBot(session.platform, session.nativeMeetingId, state.vexaToken)
      .catch((err) =>
        logger.warn({ err, nativeMeetingId: session.nativeMeetingId }, 'VexaAdapter.leave: removeBot failed'),
      )
  }
}
