import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

// session-manager 現在透過 provider 抽象層派 bot / 取逐字稿 / 讓 bot 離開。
const mockBotProvider = vi.hoisted(() => ({
  join: vi.fn(),
  getTranscript: vi.fn().mockResolvedValue([]),
  speak: vi.fn().mockResolvedValue(undefined),
  sendChat: vi.fn().mockResolvedValue(undefined),
  leave: vi.fn().mockResolvedValue(undefined),
}))
const generateSummaryAsync = vi.hoisted(() => vi.fn())

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/provider/index', () => ({ botProvider: mockBotProvider }))
vi.mock('../../../../backend/src/sessions/wake-word-detector', () => ({
  handleTranscriptSegment: vi.fn(),
  handlePartialSegment: vi.fn(),
  handleChatMessage: vi.fn(),
  PENDING_VOICE_KB: '好的，我收到了，正在查詢資料，請稍候。',
  PENDING_VOICE_TRANSCRIPT: '好的，我收到了，正在查閱會議記錄，請稍候。',
  ERROR_VOICE: '抱歉，查詢時發生錯誤，請稍後再試。',
}))
// interjection 直接 import 真 env（會 process.exit）與 Anthropic client → 整包 mock 掉
vi.mock('../../../../backend/src/sessions/interjection', () => ({
  recordConversation: vi.fn(),
  clearInterjection: vi.fn(),
}))
vi.mock('../../../../backend/src/sessions/summary.service', () => ({ generateSummaryAsync }))

import { activeSessions } from '../../../../backend/src/sessions/session-store'
import {
  startBotSession,
  handleSessionClose,
  closeSession,
} from '../../../../backend/src/sessions/session-manager'
import type { BotSession } from '../../../../backend/src/provider/types'
import type { MeetingSession } from '../../../../backend/src/types/session'

function fakeBotSession(overrides: Partial<BotSession> = {}): BotSession {
  return {
    provider: 'vexa',
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    providerMeetingId: 42,
    adapter: { name: 'vexa', sendChat: vi.fn().mockResolvedValue(undefined) } as any,
    state: {},
    ...overrides,
  }
}

function putSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  const session: MeetingSession = {
    meetingInstanceId: 'meet-1',
    vexaMeetingId: 42,
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    difyDatasetId: 'dataset-abc',
    creatorVexaToken: 'tok-123',
    isSpeaking: false,
    lastWakeAt: 0,
    processedSegmentIds: new Set(),
    botSession: fakeBotSession(),
    difyConversationId: null,
    lastQuestionAt: 0,
    ...overrides,
  }
  activeSessions.set(session.meetingInstanceId, session)
  return session
}

const BASE = {
  meetingInstanceId: 'meet-1',
  googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
  nativeMeetingId: 'abc-defg-hij',
  difyDatasetId: 'dataset-abc',
  creatorVexaToken: 'tok-123',
}

describe('startBotSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('bot 被 admitted（join resolve）→ DB 轉 ACTIVE、發歡迎訊息、session 入 Map', async () => {
    const bs = fakeBotSession()
    mockBotProvider.join.mockResolvedValue(bs)

    await startBotSession(BASE)

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'meet-1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    )
    expect(activeSessions.get('meet-1')?.botSession).toBe(bs)
    // 歡迎訊息走 adapter.sendChat
    await new Promise((r) => setTimeout(r, 0))
    expect(bs.adapter.sendChat).toHaveBeenCalled()
  })

  it('兩個 provider 都進不去（join reject）→ DB 轉 FAILED、session 移出 Map', async () => {
    mockBotProvider.join.mockRejectedValue(new Error('all providers failed'))

    await startBotSession(BASE)

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
    expect(activeSessions.has('meet-1')).toBe(false)
  })

  it('等待期間被取消（Map 已被移除）→ 收掉剛 admitted 的 bot，不寫 ACTIVE', async () => {
    const bs = fakeBotSession()
    // join 期間模擬取消：在 resolve 前清掉 Map
    mockBotProvider.join.mockImplementation(async () => {
      activeSessions.delete('meet-1')
      return bs
    })

    await startBotSession(BASE)

    expect(mockBotProvider.leave).toHaveBeenCalledWith(bs)
    expect(mockPrisma.meetingInstance.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    )
  })
})

describe('handleSessionClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('被呼叫兩次（雙重清理競態）→ 第二次 early return，只更新 DB 一次', async () => {
    putSession()

    await handleSessionClose('meet-1')
    await handleSessionClose('meet-1')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledTimes(1)
  })

  it('正常結束（ENDED）→ 觸發摘要、讓 bot 離開', async () => {
    const session = putSession()

    await handleSessionClose('meet-1')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ENDED' }) }),
    )
    expect(generateSummaryAsync).toHaveBeenCalledTimes(1)
    expect(mockBotProvider.leave).toHaveBeenCalledWith(session.botSession)
  })

  it('reason=failed → DB 轉 FAILED，不觸發摘要', async () => {
    putSession()

    await handleSessionClose('meet-1', 'failed')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
    expect(generateSummaryAsync).not.toHaveBeenCalled()
  })
})

describe('closeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
  })

  it('從 Map 移除並讓 bot 離開（不更新 DB、不觸發摘要）', async () => {
    const session = putSession()

    await closeSession('meet-1')

    expect(activeSessions.has('meet-1')).toBe(false)
    expect(mockBotProvider.leave).toHaveBeenCalledWith(session.botSession)
    expect(generateSummaryAsync).not.toHaveBeenCalled()
  })
})
