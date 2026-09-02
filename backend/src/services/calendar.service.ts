import type { RsvpStatus } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'
import { findFreeSlots, type Interval } from '../lib/free-slots.js'
import { canSeeJoinLink } from '../lib/meeting-access.js'
import {
  requireProjectMeetingAccess,
  requireProjectViewAccess,
} from './meeting.service.js'
import { recordActivity } from './activity.service.js'
import {
  pushMeetingToGoogle,
  removeMeetingFromGoogle,
} from './calendar-sync.service.js'

/**
 * 行事曆服務。
 *
 * 邊界說明：
 * - 「排定的會議」與「蜜塔的 bot session」是兩件事。這裡只管排程（SCHEDULED），
 *   讓蜜塔真的進會議仍走 meeting.service 的 createMeeting/reinviteBot。
 *   因此 SCHEDULED **不佔並發額度**（並發只數 ACTIVE，見 CLAUDE.md 決策 3）。
 * - 忙碌時段來自 BusyBlock（Google Calendar 匯入的快取）。尚未連結 GCal 的成員
 *   沒有 BusyBlock，前端會標「未同步」，計算時就只看得到他的專案會議。
 */

/** 行事曆一次最多可查詢的天數，避免前端誤傳一整年把 DB 掃爛。 */
const MAX_RANGE_DAYS = 62

function assertRange(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError('INVALID_REQUEST', 400, 'from／to 需為合法的 ISO 時間')
  }
  if (to <= from) {
    throw new AppError('INVALID_REQUEST', 400, 'to 必須晚於 from')
  }
  const days = (to.getTime() - from.getTime()) / 86_400_000
  if (days > MAX_RANGE_DAYS) {
    throw new AppError('INVALID_REQUEST', 400, `查詢範圍不可超過 ${MAX_RANGE_DAYS} 天`)
  }
}

/** 行事曆上要顯示的會議狀態：排定中、加入中、進行中、已結束、已取消都要畫。 */
const CALENDAR_MEETING_STATUSES = ['SCHEDULED', 'PENDING', 'ACTIVE', 'ENDED', 'CANCELED'] as const

// ── 專案成員 ──────────────────────────────────────────────────────────────────

/** 專案的完整成員名單（擁有者 + 成員），附 Google Calendar 同步狀態。 */
async function getProjectMemberList(projectId: string, ownerUserId: number) {
  const members = await prisma.projectMember.findMany({ where: { projectId } })
  const userIds = [...new Set([ownerUserId, ...members.map((m) => m.userId)])]

  const [users, connections] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, name: true },
    }),
    prisma.calendarConnection.findMany({ where: { userId: { in: userIds } } }),
  ])

  const userMap = new Map(users.map((u) => [u.id, u]))
  const connMap = new Map(connections.map((c) => [c.userId, c]))

  return userIds.map((userId) => {
    const user = userMap.get(userId)
    const conn = connMap.get(userId)
    return {
      userId,
      name: user?.name ?? null,
      email: user?.email ?? '',
      isOwner: userId === ownerUserId,
      // 前端疊圖用：未連結與授權失效要分開標，使用者的下一步不同
      syncState: !conn ? ('unsynced' as const) : conn.status === 'EXPIRED' ? ('expired' as const) : ('synced' as const),
    }
  })
}

// ── 查詢：專案層行事曆 ────────────────────────────────────────────────────────

export interface CalendarRange {
  from: Date
  to: Date
}

/**
 * 專案層行事曆：該專案的會議 + 已同步成員的 GCal 忙碌時段。
 *
 * 忙碌時段只回「幾點到幾點」，不含標題——疊圖與找空檔不需要，少傳一份別人的
 * 行程內容也少一份隱私風險（spec §5 隱私）。
 */
export async function getProjectCalendar(
  projectId: string,
  userId: number,
  range: CalendarRange,
) {
  assertRange(range.from, range.to)
  const project = await requireProjectViewAccess(projectId, userId)
  const members = await getProjectMemberList(projectId, project.ownerUserId)
  const memberUserIds = members.map((m) => m.userId)

  const [meetings, busyBlocks] = await Promise.all([
    prisma.meetingInstance.findMany({
      where: {
        projectId,
        status: { in: [...CALENDAR_MEETING_STATUSES] },
        scheduledStartAt: { lt: range.to },
        scheduledEndAt: { gt: range.from },
      },
      include: { attendees: true },
      orderBy: { scheduledStartAt: 'asc' },
    }),
    prisma.busyBlock.findMany({
      where: {
        userId: { in: memberUserIds },
        startAt: { lt: range.to },
        endAt: { gt: range.from },
      },
      orderBy: { startAt: 'asc' },
    }),
  ])

  return {
    members,
    meetings: meetings.map((m) => serializeMeeting(m, userId)),
    busyBlocks: busyBlocks.map((b) => ({
      id: b.id,
      userId: b.userId,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
    })),
  }
}

/**
 * 會議序列化：行事曆只需要排程資訊與 RSVP，逐字稿／摘要不在這裡回。
 *
 * viewerUserId 有給時，**非與會者拿不到 Meet 連結**。主辦挑了與會者，就代表
 * 其他人不該進這場會——把連結一併發給整個專案等於那份挑選沒有意義。
 * 會議本身仍然回傳：它佔著那些人的時間，對「誰有空」的判斷有用，
 * 藏起來反而會讓行事曆說謊。
 */
function serializeMeeting(meeting: {
  id: string
  projectId: string | null
  name: string
  googleMeetUrl: string
  status: string
  scheduledStartAt: Date | null
  scheduledEndAt: Date | null
  timezone: string | null
  createdByUserId: number
  botAutoJoin: boolean
  attendees: Array<{ userId: number; rsvp: RsvpStatus; respondedAt: Date | null }>
}, viewerUserId?: number) {
  const isParticipant =
    viewerUserId === undefined ||
    canSeeJoinLink({
      viewerUserId,
      createdByUserId: meeting.createdByUserId,
      attendeeUserIds: meeting.attendees.map((a) => a.userId),
    })

  // 我自己的出席回覆。前端拿它在行事曆上標「待回覆」，不必自己拿 userId 去對 attendees。
  // null = 我不是與會者（或沒有 viewer 脈絡），與 'PENDING'（是與會者但還沒回）不同。
  const myRsvp =
    viewerUserId === undefined
      ? null
      : (meeting.attendees.find((a) => a.userId === viewerUserId)?.rsvp ?? null)

  return {
    id: meeting.id,
    projectId: meeting.projectId,
    name: meeting.name,
    googleMeetUrl: isParticipant ? meeting.googleMeetUrl : '',
    /** 我是不是這場會議的與會者（決定看不看得到連結） */
    isParticipant,
    myRsvp,
    status: meeting.status,
    scheduledStartAt: meeting.scheduledStartAt?.toISOString() ?? null,
    scheduledEndAt: meeting.scheduledEndAt?.toISOString() ?? null,
    timezone: meeting.timezone,
    createdByUserId: meeting.createdByUserId,
    botAutoJoin: meeting.botAutoJoin,
    attendees: meeting.attendees.map((a) => ({
      userId: a.userId,
      rsvp: a.rsvp,
      respondedAt: a.respondedAt?.toISOString() ?? null,
    })),
  }
}

// ── 查詢：全域層行事曆 ────────────────────────────────────────────────────────

/**
 * 全域層行事曆：我建立的 + 我被邀請的所有會議（跨專案），加上我自己的 GCal 事件。
 *
 * 只回「我的」——別人的忙碌時段屬於專案層的協作視圖，全域層沒有明確的成員集合
 * （spec §3 設計原則）。
 */
export async function getGlobalCalendar(userId: number, range: CalendarRange) {
  assertRange(range.from, range.to)

  const meetings = await prisma.meetingInstance.findMany({
    where: {
      status: { in: [...CALENDAR_MEETING_STATUSES] },
      scheduledStartAt: { lt: range.to },
      scheduledEndAt: { gt: range.from },
      OR: [{ createdByUserId: userId }, { attendees: { some: { userId } } }],
    },
    include: {
      attendees: true,
      project: { select: { id: true, name: true } },
    },
    orderBy: { scheduledStartAt: 'asc' },
  })

  const busyBlocks = await prisma.busyBlock.findMany({
    where: { userId, startAt: { lt: range.to }, endAt: { gt: range.from } },
    orderBy: { startAt: 'asc' },
  })

  // 與會者的姓名對照。全域層沒有「專案成員名單」可查（會議來自多個專案），
  // 但會議詳情要顯示「誰回覆了什麼」，所以把這批人的名字一起回。
  const attendeeIds = [...new Set(meetings.flatMap((m) => m.attendees.map((a) => a.userId)))]
  const people = attendeeIds.length
    ? await prisma.user.findMany({
        where: { id: { in: attendeeIds } },
        select: { id: true, email: true, name: true },
      })
    : []

  return {
    people: people.map((u) => ({ userId: u.id, name: u.name, email: u.email })),
    meetings: meetings.map((m) => ({
      ...serializeMeeting(m, userId),
      projectName: m.project?.name ?? null,
    })),
    busyBlocks: busyBlocks.map((b) => ({
      id: b.id,
      userId: b.userId,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
    })),
  }
}

// ── 找共同空檔 ────────────────────────────────────────────────────────────────

export interface FreeSlotRequest {
  memberUserIds: number[]
  durationMin: number
  from: Date
  to: Date
  tzOffsetMinutes: number
  workStartHour: number
  workEndHour: number
  includeWeekends: boolean
}

/**
 * 找出所選成員都有空的時段。
 *
 * 忙碌來源 = 專案會議（該成員是與會者，且未取消）+ 該成員的 GCal 忙碌快取。
 * 已取消的會議不佔忙碌判斷（spec §4.1）。
 */
export async function findProjectFreeSlots(
  projectId: string,
  userId: number,
  req: FreeSlotRequest,
) {
  assertRange(req.from, req.to)
  const project = await requireProjectViewAccess(projectId, userId)

  if (req.memberUserIds.length === 0) {
    throw new AppError('INVALID_REQUEST', 400, '請至少選擇一位參與成員')
  }
  if (req.durationMin <= 0) {
    throw new AppError('INVALID_REQUEST', 400, '會議時長需大於 0')
  }

  // 只接受確實屬於本專案的成員，避免用別的專案的人試探他人行程
  const members = await getProjectMemberList(projectId, project.ownerUserId)
  const allowed = new Set(members.map((m) => m.userId))
  const unknown = req.memberUserIds.filter((id) => !allowed.has(id))
  if (unknown.length > 0) {
    throw new AppError('INVALID_REQUEST', 400, '參與成員必須是此專案的成員')
  }

  const [meetings, busyBlocks] = await Promise.all([
    prisma.meetingInstance.findMany({
      where: {
        status: { in: ['SCHEDULED', 'PENDING', 'ACTIVE', 'ENDED'] },
        scheduledStartAt: { lt: req.to },
        scheduledEndAt: { gt: req.from },
        attendees: { some: { userId: { in: req.memberUserIds } } },
      },
      select: { scheduledStartAt: true, scheduledEndAt: true },
    }),
    prisma.busyBlock.findMany({
      where: {
        userId: { in: req.memberUserIds },
        startAt: { lt: req.to },
        endAt: { gt: req.from },
      },
      select: { startAt: true, endAt: true },
    }),
  ])

  const busy: Interval[] = [
    ...meetings
      .filter((m) => m.scheduledStartAt && m.scheduledEndAt)
      .map((m) => ({ start: m.scheduledStartAt!, end: m.scheduledEndAt! })),
    ...busyBlocks.map((b) => ({ start: b.startAt, end: b.endAt })),
  ]

  const slots = findFreeSlots({
    busy,
    from: req.from,
    to: req.to,
    durationMin: req.durationMin,
    tzOffsetMinutes: req.tzOffsetMinutes,
    workStartHour: req.workStartHour,
    workEndHour: req.workEndHour,
    includeWeekends: req.includeWeekends,
  })

  const unsyncedMembers = members
    .filter((m) => req.memberUserIds.includes(m.userId) && m.syncState !== 'synced')
    .map((m) => ({ userId: m.userId, name: m.name, email: m.email, syncState: m.syncState }))

  return {
    slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    // 前端要據此標示「結果僅依已知忙碌計算」（spec §4.3 狀態）
    unsyncedMembers,
  }
}

// ── 排定會議 ──────────────────────────────────────────────────────────────────

export interface ScheduleMeetingParams {
  projectId: string
  userId: number
  name: string
  scheduledStartAt: Date
  scheduledEndAt: Date
  timezone?: string | null
  googleMeetUrl?: string | null
  attendeeUserIds: number[]
  /** 時間到時要不要自動派蜜塔進去 */
  botAutoJoin?: boolean
}

function assertSchedule(start: Date, end: Date): void {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError('INVALID_REQUEST', 400, '開始／結束時間需為合法的 ISO 時間')
  }
  if (end <= start) {
    throw new AppError('INVALID_REQUEST', 400, '結束時間必須晚於開始時間')
  }
}

/**
 * 在專案內排定一場會議（狀態 SCHEDULED，蜜塔還沒進去）。
 *
 * 與會者一律包含建立者本人並自動標為出席——主辦不必再回覆自己發的邀請。
 */
export async function scheduleMeeting(params: ScheduleMeetingParams) {
  const { projectId, userId, name, scheduledStartAt, scheduledEndAt } = params
  assertSchedule(scheduledStartAt, scheduledEndAt)

  const project = await requireProjectMeetingAccess(projectId, userId)
  const members = await getProjectMemberList(projectId, project.ownerUserId)
  const allowed = new Set(members.map((m) => m.userId))

  const attendeeIds = [...new Set([userId, ...params.attendeeUserIds])]
  if (attendeeIds.some((id) => !allowed.has(id))) {
    throw new AppError('INVALID_REQUEST', 400, '與會者必須是此專案的成員')
  }

  const meeting = await prisma.meetingInstance.create({
    data: {
      projectId,
      name,
      // 排定時還沒有 Meet 連結也合理（可之後補），DB 欄位非空所以先存空字串
      googleMeetUrl: params.googleMeetUrl ?? '',
      status: 'SCHEDULED',
      createdByUserId: userId,
      botAutoJoin: params.botAutoJoin ?? false,
      scheduledStartAt,
      scheduledEndAt,
      timezone: params.timezone ?? null,
      attendees: {
        create: attendeeIds.map((attendeeId) => ({
          userId: attendeeId,
          rsvp: attendeeId === userId ? 'ACCEPTED' : 'PENDING',
          respondedAt: attendeeId === userId ? new Date() : null,
        })),
      },
    },
    include: { attendees: true },
  })

  // MEETING_SCHEDULE 不是 MEETING_CREATE：排定未來的會議屬於「行事曆」，
  // 立刻開一場（meeting.service）才屬於「會議」。未讀紅點靠這個分辨要亮在哪個分頁。
  await recordActivity({
    projectId,
    actorUserId: userId,
    action: 'MEETING_SCHEDULE',
    targetLabel: name,
  })

  // 寫回主辦人的 Google Calendar（由 Google 寄出邀請）。
  // 刻意 await：使用者按下「排定」後就該看到最終結果（含 Google 生成的 Meet 連結），
  // 而且 pushMeetingToGoogle 內部已吞掉所有錯誤，不會讓排定失敗。
  await pushMeetingToGoogle({
    id: meeting.id,
    name: meeting.name,
    scheduledStartAt: meeting.scheduledStartAt,
    scheduledEndAt: meeting.scheduledEndAt,
    timezone: meeting.timezone,
    createdByUserId: meeting.createdByUserId,
    gcalEventId: meeting.gcalEventId,
    attendeeUserIds: meeting.attendees.map((a) => a.userId),
  })

  // 寫回可能補上了 gcalEventId 與 Meet 連結，重讀一次才不會回舊值
  const fresh = await prisma.meetingInstance.findUnique({
    where: { id: meeting.id },
    include: { attendees: true },
  })
  return serializeMeeting(fresh ?? meeting, userId)
}

/** 取回一筆排定會議並確認呼叫者有權管理它。 */
async function requireManageableMeeting(meetingId: string, userId: number) {
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId },
    include: { attendees: true },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  if (meeting.projectId) {
    await requireProjectMeetingAccess(meeting.projectId, userId)
  } else if (meeting.createdByUserId !== userId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可管理此會議')
  }
  return meeting
}

export async function updateMeetingSchedule(params: {
  meetingId: string
  userId: number
  name?: string
  scheduledStartAt?: Date
  scheduledEndAt?: Date
  attendeeUserIds?: number[]
  botAutoJoin?: boolean
}) {
  const { meetingId, userId } = params
  const meeting = await requireManageableMeeting(meetingId, userId)

  const start = params.scheduledStartAt ?? meeting.scheduledStartAt
  const end = params.scheduledEndAt ?? meeting.scheduledEndAt
  if (start && end) assertSchedule(start, end)

  // 時間改了就把別人的 RSVP 打回未回覆——對「原本那個時間」的出席承諾已經不成立
  const timeChanged =
    (params.scheduledStartAt && params.scheduledStartAt.getTime() !== meeting.scheduledStartAt?.getTime()) ||
    (params.scheduledEndAt && params.scheduledEndAt.getTime() !== meeting.scheduledEndAt?.getTime())

  const updated = await prisma.$transaction(async (tx) => {
    if (params.attendeeUserIds) {
      const next = new Set([meeting.createdByUserId, ...params.attendeeUserIds])
      const current = new Set(meeting.attendees.map((a) => a.userId))

      const toRemove = [...current].filter((id) => !next.has(id))
      const toAdd = [...next].filter((id) => !current.has(id))

      if (toRemove.length > 0) {
        await tx.meetingAttendee.deleteMany({
          where: { meetingId, userId: { in: toRemove } },
        })
      }
      if (toAdd.length > 0) {
        await tx.meetingAttendee.createMany({
          data: toAdd.map((id) => ({
            meetingId,
            userId: id,
            rsvp: id === meeting.createdByUserId ? ('ACCEPTED' as const) : ('PENDING' as const),
            respondedAt: id === meeting.createdByUserId ? new Date() : null,
          })),
        })
      }
    }

    if (timeChanged) {
      await tx.meetingAttendee.updateMany({
        where: { meetingId, userId: { not: meeting.createdByUserId } },
        data: { rsvp: 'PENDING', respondedAt: null },
      })
    }

    return tx.meetingInstance.update({
      where: { id: meetingId },
      data: {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.scheduledStartAt ? { scheduledStartAt: params.scheduledStartAt } : {}),
        ...(params.scheduledEndAt ? { scheduledEndAt: params.scheduledEndAt } : {}),
        ...(params.botAutoJoin !== undefined ? { botAutoJoin: params.botAutoJoin } : {}),
        // 改了時間就把派送標記清掉，讓排程器依新時間重新判斷
        ...(timeChanged ? { botDispatchedAt: null } : {}),
      },
      include: { attendees: true },
    })
  })

  // 時間或與會者變了就同步更新 GCal（Google 會通知所有與會者）
  await pushMeetingToGoogle({
    id: updated.id,
    name: updated.name,
    scheduledStartAt: updated.scheduledStartAt,
    scheduledEndAt: updated.scheduledEndAt,
    timezone: updated.timezone,
    createdByUserId: updated.createdByUserId,
    gcalEventId: updated.gcalEventId,
    attendeeUserIds: updated.attendees.map((a) => a.userId),
  })

  return { ...serializeMeeting(updated, params.userId), rsvpReset: Boolean(timeChanged) }
}

/**
 * 取消一場已排定的會議。
 *
 * 與 meeting.service 的 cancelMeeting 不同：那個是「取消蜜塔加入」（PENDING → FAILED），
 * 這個是「這場會不開了」（→ CANCELED），行事曆上劃掉且不再佔忙碌判斷。
 */
export async function cancelScheduledMeeting(meetingId: string, userId: number) {
  const meeting = await requireManageableMeeting(meetingId, userId)

  if (meeting.status === 'ACTIVE' || meeting.status === 'ENDED') {
    throw new AppError('INVALID_REQUEST', 400, '已開始或已結束的會議不能取消')
  }
  if (meeting.status === 'CANCELED') {
    return serializeMeeting(meeting, userId)
  }

  const updated = await prisma.meetingInstance.update({
    where: { id: meetingId },
    data: { status: 'CANCELED' },
    include: { attendees: true },
  })

  await removeMeetingFromGoogle({
    id: updated.id,
    createdByUserId: updated.createdByUserId,
    gcalEventId: updated.gcalEventId,
  })

  return serializeMeeting(updated, userId)
}

// ── RSVP ──────────────────────────────────────────────────────────────────────

/** 成員回覆出席狀態。只有被列為與會者的人能回覆。 */
export async function respondToMeeting(params: {
  meetingId: string
  userId: number
  rsvp: RsvpStatus
}) {
  const { meetingId, userId, rsvp } = params

  const attendee = await prisma.meetingAttendee.findUnique({
    where: { meetingId_userId: { meetingId, userId } },
  })
  if (!attendee) {
    throw new AppError('PERMISSION_DENIED', 403, '你不是這場會議的與會者')
  }

  await prisma.meetingAttendee.update({
    where: { id: attendee.id },
    data: { rsvp, respondedAt: new Date() },
  })

  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId },
    include: { attendees: true },
  })
  return serializeMeeting(meeting!, userId)
}
