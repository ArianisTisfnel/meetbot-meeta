import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FailoverProvider } from '../../../../backend/src/provider/failover-provider'
import {
  BotAdmissionError,
  type BotSession,
  type LiveHandlers,
  type MeetingBotProvider,
  type TranscriptSegment,
} from '../../../../backend/src/provider/types'

// 用假的 provider 驗證 failover 決策邏輯，無任何網路。

function makeFakeProvider(name: string): MeetingBotProvider & {
  join: ReturnType<typeof vi.fn>
  getTranscript: ReturnType<typeof vi.fn>
  speak: ReturnType<typeof vi.fn>
  sendChat: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
} {
  const provider: any = { name }
  const session: BotSession = {
    provider: name,
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    providerMeetingId: name === 'vexa' ? 42 : 'recall-bot-1',
    adapter: provider,
    state: {},
  }
  provider.join = vi.fn().mockResolvedValue(session)
  provider.getTranscript = vi.fn().mockResolvedValue([] as TranscriptSegment[])
  provider.speak = vi.fn().mockResolvedValue(undefined)
  provider.sendChat = vi.fn().mockResolvedValue(undefined)
  provider.leave = vi.fn().mockResolvedValue(undefined)
  return provider
}

const URL = 'https://meet.google.com/abc-defg-hij'
const OPTS = { platform: 'google_meet', nativeMeetingId: 'abc-defg-hij', vexaToken: 'tok' }
const HANDLERS: LiveHandlers = {}

describe('FailoverProvider.join', () => {
  let primary: ReturnType<typeof makeFakeProvider>
  let secondary: ReturnType<typeof makeFakeProvider>

  beforeEach(() => {
    primary = makeFakeProvider('vexa')
    secondary = makeFakeProvider('recall')
  })

  it('primary 成功 admitted → 回傳 primary session，且完全不呼叫 secondary（成本原則）', async () => {
    const fp = new FailoverProvider(primary, secondary)
    const session = await fp.join(URL, OPTS, HANDLERS)

    expect(session.provider).toBe('vexa')
    expect(primary.join).toHaveBeenCalledTimes(1)
    expect(secondary.join).not.toHaveBeenCalled()
  })

  it('primary 被擋在門外（BotAdmissionError）→ fallback 到 secondary', async () => {
    primary.join.mockRejectedValue(new BotAdmissionError('vexa', 'blocked', 'needs_help'))
    const fp = new FailoverProvider(primary, secondary)

    const session = await fp.join(URL, OPTS, HANDLERS)

    expect(session.provider).toBe('recall')
    expect(primary.join).toHaveBeenCalledTimes(1)
    expect(secondary.join).toHaveBeenCalledTimes(1)
  })

  it('primary timeout（API 200 但沒進會議）→ fallback 到 secondary', async () => {
    primary.join.mockRejectedValue(new BotAdmissionError('vexa', 'timeout'))
    const fp = new FailoverProvider(primary, secondary)

    const session = await fp.join(URL, OPTS, HANDLERS)
    expect(session.provider).toBe('recall')
    expect(secondary.join).toHaveBeenCalledTimes(1)
  })

  it('未設定 secondary 時，primary 失敗則向上拋出（退化為只用 Vexa）', async () => {
    primary.join.mockRejectedValue(new BotAdmissionError('vexa', 'timeout'))
    const fp = new FailoverProvider(primary, null)

    await expect(fp.join(URL, OPTS, HANDLERS)).rejects.toBeInstanceOf(BotAdmissionError)
  })
})

describe('FailoverProvider 委派（無 provider 名稱分支）', () => {
  it('getTranscript/speak/sendChat/leave 一律委派給建立該 session 的 adapter', async () => {
    const primary = makeFakeProvider('vexa')
    const secondary = makeFakeProvider('recall')
    // 讓 primary 失敗，session 由 secondary 建立
    primary.join.mockRejectedValue(new BotAdmissionError('vexa', 'blocked'))

    const fp = new FailoverProvider(primary, secondary)
    const session = await fp.join(URL, OPTS, HANDLERS)

    await fp.getTranscript(session)
    await fp.speak(session, '哈囉')
    await fp.sendChat(session, '聊天訊息')
    await fp.leave(session)

    // 委派到 secondary（建立 session 者），primary 完全沒被碰
    expect(secondary.getTranscript).toHaveBeenCalledWith(session)
    expect(secondary.speak).toHaveBeenCalledWith(session, '哈囉')
    expect(secondary.sendChat).toHaveBeenCalledWith(session, '聊天訊息')
    expect(secondary.leave).toHaveBeenCalledWith(session)
    expect(primary.getTranscript).not.toHaveBeenCalled()
    expect(primary.speak).not.toHaveBeenCalled()
  })

  it('winning adapter 不支援 sendChat → 丟出明確 known-limitation 錯誤', async () => {
    const primary = makeFakeProvider('vexa')
    const session = await new FailoverProvider(primary, null).join(URL, OPTS, HANDLERS)
    // 移除 adapter 的 sendChat 能力
    ;(session.adapter as any).sendChat = undefined

    await expect(new FailoverProvider(primary, null).sendChat(session, 'x')).rejects.toThrow(
      /sendChat not supported/,
    )
  })
})
