import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({
  prisma: mockPrisma,
}))

import {
  getProjectsUnread,
  listProjectNotifications,
  markProjectRead,
  type ProjectUnread,
} from '../../../../backend/src/services/notification.service'

const JOINED = new Date('2026-08-01T00:00:00Z')
const LAST_READ = new Date('2026-09-01T00:00:00Z')

const OWNED_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  ownerUserId: 1,
  createdAt: JOINED,
  deletedAt: null,
  members: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  // $transaction 收到的是一組 promise，照原樣解析即可
  mockPrisma.$transaction.mockImplementation((ops: unknown) =>
    Array.isArray(ops) ? Promise.all(ops) : Promise.resolve([]),
  )
})

// ── getProjectsUnread ─────────────────────────────────────────────────

describe('getProjectsUnread', () => {
  it('returns an empty map without touching the DB when given no projects', async () => {
    const result = await getProjectsUnread(1, [])

    expect(result.size).toBe(0)
    expect(mockPrisma.projectReadState.findMany).not.toHaveBeenCalled()
  })

  it('files each activity under the tab it belongs to', async () => {
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([])
    mockPrisma.activityLog.groupBy.mockResolvedValueOnce([
      { projectId: 'proj-1', action: 'MATERIAL_UPLOAD', _count: { _all: 2 } },
      { projectId: 'proj-1', action: 'MEMBER_ADD', _count: { _all: 1 } },
      // 排定的會議算行事曆，立刻開的會議算會議 —— 這是兩種不同的 action
      { projectId: 'proj-1', action: 'MEETING_SCHEDULE', _count: { _all: 3 } },
      { projectId: 'proj-1', action: 'MEETING_CREATE', _count: { _all: 1 } },
      { projectId: 'proj-1', action: 'PROJECT_RENAME', _count: { _all: 1 } },
    ])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([])

    const result = await getProjectsUnread(1, [{ id: 'proj-1', joinedAt: JOINED }])

    expect(result.get('proj-1')!.sections).toEqual({
      materials: 2,
      members: 1,
      calendar: 3,
      meetings: 1,
      history: 1,
    })
    expect(result.get('proj-1')!.activityCount).toBe(8)
  })

  it('counts a pending RSVP under the calendar tab', async () => {
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([])
    mockPrisma.activityLog.groupBy.mockResolvedValueOnce([])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([
      { projectId: 'proj-1' },
      { projectId: 'proj-1' },
    ])

    const result = await getProjectsUnread(1, [{ id: 'proj-1', joinedAt: JOINED }])

    expect(result.get('proj-1')!.sections.calendar).toBe(2)
    expect(result.get('proj-1')!.rsvpCount).toBe(2)
  })

  it('keeps total equal to the sum of every tab', async () => {
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([])
    mockPrisma.activityLog.groupBy.mockResolvedValueOnce([
      { projectId: 'proj-1', action: 'MATERIAL_UPLOAD', _count: { _all: 2 } },
      { projectId: 'proj-1', action: 'PROJECT_RENAME', _count: { _all: 1 } },
    ])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ projectId: 'proj-1' }])

    const u = result_of(await getProjectsUnread(1, [{ id: 'proj-1', joinedAt: JOINED }]))

    const summed = Object.values(u.sections).reduce((a, b) => a + b, 0)
    expect(summed).toBe(u.total)
    expect(u.total).toBe(4)
  })

  it('reads each tab from its own lastReadAt, falling back to joinedAt', async () => {
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([
      { projectId: 'proj-1', section: 'MATERIALS', lastReadAt: LAST_READ },
    ])
    mockPrisma.activityLog.groupBy.mockResolvedValueOnce([])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([])

    await getProjectsUnread(1, [{ id: 'proj-1', joinedAt: JOINED }])

    const where = mockPrisma.activityLog.groupBy.mock.calls[0][0].where
    // 自己做的事不算未讀
    expect(where.actorUserId).toEqual({ not: 1 })

    const materials = where.OR.find((c: any) =>
      c.action.in.includes('MATERIAL_UPLOAD'),
    )
    const members = where.OR.find((c: any) => c.action.in.includes('MEMBER_ADD'))
    // 資料分頁看過了 → 從 lastReadAt 起算
    expect(materials.createdAt).toEqual({ gt: LAST_READ })
    // 成員分頁沒看過 → 退回 joinedAt，不會被資料分頁的已讀連坐清掉
    expect(members.createdAt).toEqual({ gt: JOINED })
  })

  it('only counts meetings that are still open and awaiting my reply', async () => {
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([])
    mockPrisma.activityLog.groupBy.mockResolvedValueOnce([])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([])

    await getProjectsUnread(7, [{ id: 'proj-1', joinedAt: JOINED }])

    const where = mockPrisma.meetingInstance.findMany.mock.calls[0][0].where
    expect(where.status).toEqual({ in: ['SCHEDULED', 'PENDING', 'ACTIVE'] })
    expect(where.attendees).toEqual({ some: { userId: 7, rsvp: 'PENDING' } })
  })

  it('gives zeros to projects with no activity and no pending RSVP', async () => {
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([])
    mockPrisma.activityLog.groupBy.mockResolvedValueOnce([])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([])

    const u = result_of(await getProjectsUnread(1, [{ id: 'proj-1', joinedAt: JOINED }]))

    expect(u.total).toBe(0)
    expect(u.sections).toEqual({
      materials: 0,
      meetings: 0,
      calendar: 0,
      members: 0,
      history: 0,
    })
  })
})

function result_of(map: Map<string, ProjectUnread>): ProjectUnread {
  return map.get('proj-1')!
}

// ── markProjectRead ───────────────────────────────────────────────────

describe('markProjectRead', () => {
  it('clears only the tab it was given', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNED_PROJECT)

    const result = await markProjectRead('proj-1', 1, 'materials')

    expect(result.sections).toEqual(['materials'])
    expect(mockPrisma.projectReadState.upsert).toHaveBeenCalledTimes(1)
    expect(mockPrisma.projectReadState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_userId_section: {
            projectId: 'proj-1',
            userId: 1,
            section: 'MATERIALS',
          },
        },
      }),
    )
  })

  it('clears every tab when no section is given', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNED_PROJECT)

    const result = await markProjectRead('proj-1', 1)

    expect(result.sections).toHaveLength(5)
    expect(mockPrisma.projectReadState.upsert).toHaveBeenCalledTimes(5)
  })

  it('rejects a user with no access to the project', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({
      ...OWNED_PROJECT,
      members: [],
    })

    await expect(markProjectRead('proj-1', 99, 'materials')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(mockPrisma.projectReadState.upsert).not.toHaveBeenCalled()
  })

  it('404s on a missing project', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(null)

    await expect(markProjectRead('nope', 1)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

// ── listProjectNotifications ──────────────────────────────────────────

describe('listProjectNotifications', () => {
  it('lists pending RSVPs and unread activity, each tagged with its tab', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNED_PROJECT)
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([
      { projectId: 'proj-1', section: 'MATERIALS', lastReadAt: LAST_READ },
    ])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([
      {
        id: 'meet-1',
        name: '週會',
        scheduledStartAt: new Date('2026-09-10T02:00:00Z'),
        scheduledEndAt: new Date('2026-09-10T03:00:00Z'),
      },
    ])
    mockPrisma.activityLog.findMany.mockResolvedValueOnce([
      {
        id: 'act-1',
        action: 'MATERIAL_UPLOAD',
        targetLabel: 'spec.pdf',
        actorUserId: 2,
        createdAt: new Date('2026-09-02T00:00:00Z'),
      },
    ])
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 2, email: 'bee@example.com', name: '小蜂' },
    ])

    const result = await listProjectNotifications('proj-1', 1)

    expect(result.unread.total).toBe(2)
    expect(result.unread.sections.materials).toBe(1)
    // 待回覆的會議算在行事曆
    expect(result.unread.sections.calendar).toBe(1)
    expect(result.rsvpItems[0].name).toBe('週會')
    expect(result.activityItems[0].section).toBe('materials')
    expect(result.activityItems[0].actor.name).toBe('小蜂')
  })

  it('skips the user lookup when there is no unread activity', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNED_PROJECT)
    mockPrisma.projectReadState.findMany.mockResolvedValueOnce([])
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([])
    mockPrisma.activityLog.findMany.mockResolvedValueOnce([])

    const result = await listProjectNotifications('proj-1', 1)

    expect(result.unread.total).toBe(0)
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled()
  })
})
