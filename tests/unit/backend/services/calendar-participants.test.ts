import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))

// 權限 helper 來自 meeting.service；這裡只驗「與會者過濾」，把權限判斷 mock 成通過。
const requireProjectViewAccess = vi.hoisted(() => vi.fn())
const requireProjectMeetingAccess = vi.hoisted(() => vi.fn())
vi.mock('../../../../backend/src/services/meeting.service', () => ({
  requireProjectViewAccess,
  requireProjectMeetingAccess,
}))
vi.mock('../../../../backend/src/services/activity.service', () => ({
  recordActivity: vi.fn(),
}))
vi.mock('../../../../backend/src/services/calendar-sync.service', () => ({
  pushMeetingToGoogle: vi.fn(),
  removeMeetingFromGoogle: vi.fn(),
}))

import { getProjectCalendar } from '../../../../backend/src/services/calendar.service'

const PROJECT_ID = 'proj-1'
const OWNER_ID = 1
const ATTENDEE_ID = 2
const OUTSIDER_ID = 3

const RANGE = {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-09-08T00:00:00Z'),
}

/** 一場只有 owner 與 ATTENDEE_ID 參加的會議，附 Meet 連結。 */
const MEETING = {
  id: 'meet-1',
  projectId: PROJECT_ID,
  name: '限定與會者的會議',
  googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
  status: 'SCHEDULED',
  scheduledStartAt: new Date('2026-09-02T01:00:00Z'),
  scheduledEndAt: new Date('2026-09-02T02:00:00Z'),
  timezone: 'Asia/Taipei',
  createdByUserId: OWNER_ID,
  botAutoJoin: false,
  attendees: [
    { userId: OWNER_ID, rsvp: 'ACCEPTED' as const, respondedAt: new Date() },
    { userId: ATTENDEE_ID, rsvp: 'PENDING' as const, respondedAt: null },
  ],
}

function arrangeProject() {
  requireProjectViewAccess.mockResolvedValue({ id: PROJECT_ID, ownerUserId: OWNER_ID })
  // getProjectMemberList 用到的三個查詢
  mockPrisma.projectMember.findMany.mockResolvedValue([
    { userId: ATTENDEE_ID },
    { userId: OUTSIDER_ID },
  ])
  mockPrisma.user.findMany.mockResolvedValue([
    { id: OWNER_ID, email: 'owner@example.com', name: '主辦' },
    { id: ATTENDEE_ID, email: 'attendee@example.com', name: '與會者' },
    { id: OUTSIDER_ID, email: 'outsider@example.com', name: '沒被邀請的成員' },
  ])
  mockPrisma.calendarConnection.findMany.mockResolvedValue([])
  mockPrisma.meetingInstance.findMany.mockResolvedValue([MEETING])
  mockPrisma.busyBlock.findMany.mockResolvedValue([])
}

describe('專案行事曆：Meet 連結只給與會者', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    arrangeProject()
  })

  it('主辦（建立者）拿得到連結', async () => {
    const result = await getProjectCalendar(PROJECT_ID, OWNER_ID, RANGE)
    expect(result.meetings[0].isParticipant).toBe(true)
    expect(result.meetings[0].googleMeetUrl).toBe(MEETING.googleMeetUrl)
  })

  it('被列為與會者的成員拿得到連結', async () => {
    const result = await getProjectCalendar(PROJECT_ID, ATTENDEE_ID, RANGE)
    expect(result.meetings[0].isParticipant).toBe(true)
    expect(result.meetings[0].googleMeetUrl).toBe(MEETING.googleMeetUrl)
  })

  it('沒被勾選的專案成員看得到會議，但拿不到連結', async () => {
    const result = await getProjectCalendar(PROJECT_ID, OUTSIDER_ID, RANGE)

    // 會議本身仍要回傳：它佔著那些人的時間，藏起來會讓「誰有空」的判斷失真
    expect(result.meetings).toHaveLength(1)
    expect(result.meetings[0].name).toBe(MEETING.name)
    // 但連結必須是空的
    expect(result.meetings[0].isParticipant).toBe(false)
    expect(result.meetings[0].googleMeetUrl).toBe('')
  })

  it('非與會者仍看得到 RSVP 統計（要知道會議規模），但沒有連結', async () => {
    const result = await getProjectCalendar(PROJECT_ID, OUTSIDER_ID, RANGE)
    expect(result.meetings[0].attendees).toHaveLength(2)
    expect(result.meetings[0].googleMeetUrl).toBe('')
  })
})
