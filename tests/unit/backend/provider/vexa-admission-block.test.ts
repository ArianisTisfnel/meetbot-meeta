import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// vexa-adapter import 時會驗證環境變數 → mock 掉避免 process.exit。
vi.mock('../../../../backend/src/types/env', () => ({
  env: { VEXA_API_URL: 'http://vexa.test', VEXA_WS_URL: 'ws://vexa.test' },
}))

// 不打真實 Vexa API。
vi.mock('../../../../backend/src/lib/vexa', () => ({
  inviteBot: vi.fn().mockResolvedValue({ vexaMeetingId: 42, nativeMeetingId: 'abc-defg-hij' }),
  removeBot: vi.fn().mockResolvedValue(undefined),
  getTranscriptions: vi.fn().mockResolvedValue([]),
  speak: vi.fn().mockResolvedValue(undefined),
  chatSend: vi.fn().mockResolvedValue(undefined),
}))

import { VexaAdapter } from '../../../../backend/src/provider/vexa-adapter'
import { BotAdmissionError, type LiveHandlers } from '../../../../backend/src/provider/types'

// 假 WebSocket：以 WsFactory 注入，測試端直接 emit 事件驅動 adapter 的 WS 訊息處理。
class FakeWebSocket extends EventEmitter {
  send = vi.fn()
  close = vi.fn()
}

const URL = 'https://meet.google.com/abc-defg-hij'
const OPTS = { platform: 'google_meet', nativeMeetingId: 'abc-defg-hij', vexaToken: 'tok' }

function statusMsg(status: string): string {
  return JSON.stringify({ type: 'meeting.status', payload: { status } })
}

let sockets: FakeWebSocket[] = []

function makeAdapter(timeoutMs: number): VexaAdapter {
  return new VexaAdapter(timeoutMs, () => {
    const ws = new FakeWebSocket()
    sockets.push(ws)
    return ws
  })
}

async function startJoin(handlers: LiveHandlers) {
  const adapter = makeAdapter(5_000)
  const joinPromise = adapter.join(URL, OPTS, handlers)
  joinPromise.catch(() => {}) // 測試中稍後才 await；先掛 no-op 避免 unhandled rejection
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0))
  return { adapter, joinPromise, ws: sockets[sockets.length - 1] }
}

describe('VexaAdapter admission 訊號處理', () => {
  beforeEach(() => {
    sockets = []
  })

  it('pre-admission terminal（needs_human_help，如 reCAPTCHA）→ join 以 blocked reject，且不發 ended（failover 才不會被上層撤銷）', async () => {
    const onStatus = vi.fn()
    const { joinPromise, ws } = await startJoin({ onStatus })

    ws.emit('message', statusMsg('needs_human_help'))

    await expect(joinPromise).rejects.toMatchObject({
      name: 'BotAdmissionError',
      reason: 'blocked',
    })
    // 關鍵斷言：join 失敗時不得發出任何 status 事件（特別是 ended）
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('active → join resolve 並發 admitted；之後 terminal → 發 ended', async () => {
    const onStatus = vi.fn()
    const { joinPromise, ws } = await startJoin({ onStatus })

    ws.emit('message', statusMsg('active'))
    const session = await joinPromise
    expect(session.provider).toBe('vexa')
    expect(onStatus).toHaveBeenCalledWith({ type: 'admitted' })

    ws.emit('message', statusMsg('completed'))
    expect(onStatus).toHaveBeenCalledWith({ type: 'ended', reason: 'completed' })
  })

  it('admission timeout → join 以 timeout reject', async () => {
    const adapter = makeAdapter(50)
    const joinPromise = adapter.join(URL, OPTS, {})
    joinPromise.catch(() => {})
    await expect(joinPromise).rejects.toBeInstanceOf(BotAdmissionError)
    await expect(joinPromise).rejects.toMatchObject({ reason: 'timeout' })
  })
})
