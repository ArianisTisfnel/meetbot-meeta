import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockVexa } from '../../../mocks/vexa.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/vexa', () => mockVexa)
vi.mock('../../../../backend/src/sessions/session-manager', () => ({
  createSession: vi.fn().mockResolvedValue(undefined),
  handleSessionClose: vi.fn().mockResolvedValue(undefined),
}))

import { parseGoogleMeetUrl } from '../../../../backend/src/lib/vexa'
import { createMeeting, leaveMeeting } from '../../../../backend/src/services/meeting.service'
import * as sessionManagerMock from '../../../../backend/src/sessions/session-manager'

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  vexaUserId: 1,
  vexaApiTokenId: 42,
  maxConcurrentBots: 1,
  vexaToken: 'tok-123',
  vexaTokenScopes: ['bot', 'browser', 'tx'],
  googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
  name: '測試會議',
}

const MOCK_MEETING = {
  id: 'meet-uuid-1',
  projectId: null,
  vexaMeetingId: null,
  vexaNativeMeetingId: null,
  name: '測試會議',
  googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
  status: 'PENDING',
  createdByVexaUserId: 1,
  creatorApiTokenId: 42,
  startedAt: null,
  endedAt: null,
  summary: null,
  actionItems: null,
  keyTopics: null,
  decisions: null,
  transcriptStoragePath: null,
  createdAt: new Date('2026-05-30T10:00:00Z'),
  updatedAt: new Date('2026-05-30T10:00:00Z'),
}

// ── parseGoogleMeetUrl ───────────────────────────────────────────────────────

describe('parseGoogleMeetUrl', () => {
  it('標準格式（3-4-3）解析成功', () => {
    expect(parseGoogleMeetUrl('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij')
  })

  it('Workspace 暱稱（自訂長名稱）解析成功', () => {
    expect(parseGoogleMeetUrl('https://meet.google.com/my-weekly-standup')).toBe('my-weekly-standup')
  })

  it('無效 URL 返回 null', () => {
    expect(parseGoogleMeetUrl('https://not.a.meet.url/xxx')).toBeNull()
    expect(parseGoogleMeetUrl('invalid')).toBeNull()
  })
})

// ── createMeeting ────────────────────────────────────────────────────────────

describe('createMeeting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVexa.inviteBot.mockResolvedValue({ vexaMeetingId: 42, nativeMeetingId: 'abc-defg-hij' })
    mockPrisma.meetingInstance.count.mockResolvedValue(0)
    mockPrisma.meetingInstance.create.mockResolvedValue(MOCK_MEETING)
    mockPrisma.meetingInstance.update.mockResolvedValue({ ...MOCK_MEETING })
    mockPrisma.meetingInstance.delete.mockResolvedValue(MOCK_MEETING)
  })

  it('scope 不足 → 403 INSUFFICIENT_SCOPE，不進行 DB 操作', async () => {
    await expect(
      createMeeting({ ...BASE_PARAMS, vexaTokenScopes: ['bot'] }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE', statusCode: 403 })

    expect(mockPrisma.meetingInstance.create).not.toHaveBeenCalled()
  })

  it('activeBotCount ≥ maxConcurrentBots → 409 BOT_CONCURRENT_LIMIT，不建立 PENDING', async () => {
    mockPrisma.meetingInstance.count.mockResolvedValue(1)

    await expect(createMeeting(BASE_PARAMS)).rejects.toMatchObject({
      code: 'BOT_CONCURRENT_LIMIT',
      statusCode: 409,
    })

    expect(mockPrisma.meetingInstance.create).not.toHaveBeenCalled()
  })

  it('Vexa 403 並發競態 → 刪除 PENDING record → 409 BOT_CONCURRENT_LIMIT', async () => {
    mockVexa.inviteBot.mockRejectedValue(new mockVexa.VexaConcurrentLimitError())

    await expect(createMeeting(BASE_PARAMS)).rejects.toMatchObject({
      code: 'BOT_CONCURRENT_LIMIT',
      statusCode: 409,
    })

    expect(mockPrisma.meetingInstance.create).toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.delete).toHaveBeenCalledWith({
      where: { id: MOCK_MEETING.id },
    })
  })

  it('Vexa 其他錯誤 → 保留 PENDING record，不刪除', async () => {
    mockVexa.inviteBot.mockRejectedValue(new Error('network error'))

    const result = await createMeeting(BASE_PARAMS)

    expect(result.status).toBe('PENDING')
    expect(mockPrisma.meetingInstance.delete).not.toHaveBeenCalled()
  })
})

// ── leaveMeeting ─────────────────────────────────────────────────────────────

describe('leaveMeeting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVexa.removeBot.mockResolvedValue(undefined)
  })

  it('status 非 ACTIVE → 400 INVALID_REQUEST，不呼叫 removeBot', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'PENDING',
    })

    await expect(leaveMeeting('meet-uuid-1')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
    })

    expect(mockVexa.removeBot).not.toHaveBeenCalled()
  })

  it('token 已過期 → warn log，仍繼續呼叫 handleSessionClose（DB 更新為 ENDED）', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'ACTIVE',
      vexaNativeMeetingId: 'abc-defg-hij',
    })
    // token 查不到（空陣列）
    mockPrisma.$queryRaw.mockResolvedValue([])

    const result = await leaveMeeting('meet-uuid-1')

    expect(mockVexa.removeBot).not.toHaveBeenCalled()
    expect(sessionManagerMock.handleSessionClose).toHaveBeenCalledWith('meet-uuid-1')
    expect(result.status).toBe('ENDED')
  })
})
