import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/sessions/session-manager', () => ({
  startBotSession: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  handleSessionClose: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../backend/src/middleware/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../../backend/src/services/activity.service', () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}))

import { parseGoogleMeetUrl } from '../../../../backend/src/lib/google-meet'
import { createMeeting, leaveMeeting, reinviteBot } from '../../../../backend/src/services/meeting.service'
import * as sessionManagerMock from '../../../../backend/src/sessions/session-manager'

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  userId: 1,
  maxConcurrentBots: 1,
  googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
  name: '測試會議',
}

const MOCK_MEETING = {
  id: 'meet-uuid-1',
  projectId: null,
  nativeMeetingId: null,
  name: '測試會議',
  googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
  status: 'PENDING',
  createdByUserId: 1,
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

  it('無效 URL 返回 null', () => {
    expect(parseGoogleMeetUrl('https://not.a.meet.url/xxx')).toBeNull()
    expect(parseGoogleMeetUrl('invalid')).toBeNull()
  })
})

// ── createMeeting ────────────────────────────────────────────────────────────

describe('createMeeting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.meetingInstance.count.mockResolvedValue(0)
    mockPrisma.meetingInstance.create.mockResolvedValue(MOCK_MEETING)
    mockPrisma.meetingInstance.update.mockResolvedValue({ ...MOCK_MEETING })
    mockPrisma.meetingInstance.delete.mockResolvedValue(MOCK_MEETING)
  })

  it('activeBotCount ≥ maxConcurrentBots → 409 BOT_CONCURRENT_LIMIT，不建立 PENDING', async () => {
    mockPrisma.meetingInstance.count.mockResolvedValue(1)

    await expect(createMeeting(BASE_PARAMS)).rejects.toMatchObject({
      code: 'BOT_CONCURRENT_LIMIT',
      statusCode: 409,
    })

    expect(mockPrisma.meetingInstance.create).not.toHaveBeenCalled()
  })

  it('通過前置檢查 → 建立 PENDING、回傳 PENDING、並在背景觸發 startBotSession', async () => {
    const result = await createMeeting(BASE_PARAMS)

    expect(result.status).toBe('PENDING')
    expect(mockPrisma.meetingInstance.create).toHaveBeenCalled()
    expect(sessionManagerMock.startBotSession).toHaveBeenCalledTimes(1)
    expect(sessionManagerMock.startBotSession).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingInstanceId: MOCK_MEETING.id,
        googleMeetUrl: BASE_PARAMS.googleMeetUrl,
        nativeMeetingId: 'abc-defg-hij',
        difyDatasetId: null,
      }),
    )
  })
})

// ── leaveMeeting ─────────────────────────────────────────────────────────────

describe('leaveMeeting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('status = ENDED（會議已自然結束、自動收尾完成）→ 冪等成功，不丟 400', async () => {
    const endedAt = new Date('2026-07-09T10:00:00Z')
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'ENDED',
      endedAt,
    })

    const result = await leaveMeeting('meet-uuid-1')
    expect(result).toEqual({ id: 'meet-uuid-1', status: 'ENDED', endedAt })
    expect(sessionManagerMock.handleSessionClose).not.toHaveBeenCalled()
  })

  it('status = PENDING → 400 INVALID_REQUEST', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'PENDING',
    })

    await expect(leaveMeeting('meet-uuid-1')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
    })
  })

  it('ACTIVE 會議 → 呼叫 handleSessionClose，回傳 ENDED', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'ACTIVE',
    })

    const result = await leaveMeeting('meet-uuid-1')

    expect(sessionManagerMock.handleSessionClose).toHaveBeenCalledWith('meet-uuid-1')
    expect(result.status).toBe('ENDED')
  })
})

// ── reinviteBot ──────────────────────────────────────────────────────────────

describe('reinviteBot', () => {
  const REINVITE_PARAMS = {
    meetingInstanceId: 'meet-uuid-1',
    userId: 1,
    maxConcurrentBots: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.meetingInstance.count.mockResolvedValue(0)
  })

  it('ENDED 會議 → 保留原紀錄、另建新 MeetingInstance、回傳新 id', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'ENDED',
      summary: '既有摘要',
      transcriptStoragePath: 'transcripts/meet-uuid-1.md',
      project: null,
    })
    mockPrisma.meetingInstance.create.mockResolvedValue({
      ...MOCK_MEETING,
      id: 'meet-uuid-2',
    })

    const result = await reinviteBot(REINVITE_PARAMS)

    expect(result).toEqual({ id: 'meet-uuid-2', status: 'PENDING' })
    // 原紀錄不可被覆寫
    expect(mockPrisma.meetingInstance.update).not.toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: MOCK_MEETING.name,
        googleMeetUrl: MOCK_MEETING.googleMeetUrl,
        status: 'PENDING',
        createdByUserId: 1,
      }),
    })
    // bot 派往新實例
    expect(sessionManagerMock.startBotSession).toHaveBeenCalledWith(
      expect.objectContaining({ meetingInstanceId: 'meet-uuid-2' }),
    )
  })

  // 上面那個案例的建立者與重邀者都是 1，分不出「沿用」與「改成本次邀請者」。
  // 這裡讓別人來重邀，才鎖得住擁有權不轉移（PR #13 審查發現）。
  it('別人重邀 ENDED 會議 → 擁有權沿用原建立者（createdByUserId 不改變）', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      projectId: 'proj-1',
      status: 'ENDED',
      // 專案會議：重邀者靠 canMeeting 過權限檢查，不是靠「我是建立者」
      project: { difyDatasetId: null, ownerUserId: 99, members: [{ canMeeting: true }] },
    })
    mockPrisma.meetingInstance.create.mockResolvedValue({ ...MOCK_MEETING, id: 'meet-uuid-2' })
    mockPrisma.activityLog.create.mockResolvedValueOnce({})

    // 會議是 1 建的，這次由 2 重邀
    await reinviteBot({ ...REINVITE_PARAMS, userId: 2 })

    expect(mockPrisma.meetingInstance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        // 擁有權不轉移：否則 1 會失去改名／刪除這場會議的權限
        createdByUserId: 1,
      }),
    })
  })

  it('FAILED 會議 → 就地重置為 PENDING，不另建實例', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'FAILED',
      project: null,
    })
    mockPrisma.meetingInstance.update.mockResolvedValue({ ...MOCK_MEETING })

    const result = await reinviteBot(REINVITE_PARAMS)

    expect(result).toEqual({ id: 'meet-uuid-1', status: 'PENDING' })
    expect(mockPrisma.meetingInstance.create).not.toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith({
      where: { id: 'meet-uuid-1' },
      data: expect.objectContaining({ status: 'PENDING' }),
    })
    expect(sessionManagerMock.startBotSession).toHaveBeenCalledWith(
      expect.objectContaining({ meetingInstanceId: 'meet-uuid-1' }),
    )
  })

  it('ACTIVE 會議 → 400 INVALID_REQUEST（蜜塔已在會議中）', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValue({
      ...MOCK_MEETING,
      status: 'ACTIVE',
      project: null,
    })

    await expect(reinviteBot(REINVITE_PARAMS)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
    })
    expect(mockPrisma.meetingInstance.create).not.toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.update).not.toHaveBeenCalled()
  })
})
