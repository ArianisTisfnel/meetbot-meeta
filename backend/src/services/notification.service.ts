import type { ActivityAction, ProjectSection } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'

/**
 * 專案未讀通知。
 *
 * 紅點掛在**分頁**上：哪裡有變動就在哪裡亮。有人上傳資料 →「資料」分頁亮；
 * 有人排了會議 →「行事曆」分頁亮。專案卡上的那顆是各分頁的總和。
 *
 * 兩種來源，刻意分開算，因為消失的條件不同：
 * - activityCount：專案動態中「我還沒看過、且不是我自己做的」。打開那個分頁就歸零。
 * - rsvpCount：我被列為與會者但還沒回覆出席的會議（算在行事曆分頁）。
 *   這是待辦不是消息，**不會因為打開分頁而消失**，要真的回覆才會歸零。
 */

/** 前端路由用的小寫 section key，對應 /projects/:id/<section> */
export type SectionKey = 'materials' | 'meetings' | 'calendar' | 'members' | 'history'

export type SectionCounts = Record<SectionKey, number>

export type ProjectUnread = {
  total: number
  activityCount: number
  rsvpCount: number
  sections: SectionCounts
}

export const SECTION_KEYS: SectionKey[] = [
  'materials',
  'meetings',
  'calendar',
  'members',
  'history',
]

const SECTION_ENUM: Record<SectionKey, ProjectSection> = {
  materials: 'MATERIALS',
  meetings: 'MEETINGS',
  calendar: 'CALENDAR',
  members: 'MEMBERS',
  history: 'HISTORY',
}

const SECTION_KEY_OF: Record<ProjectSection, SectionKey> = {
  MATERIALS: 'materials',
  MEETINGS: 'meetings',
  CALENDAR: 'calendar',
  MEMBERS: 'members',
  HISTORY: 'history',
}

/**
 * 每一種活動歸屬於哪個分頁——刻意是「一對一」的分割，
 * 這樣專案卡的總數才會等於各分頁紅點相加，不會兜不攏。
 *
 * PROJECT_RENAME 沒有專屬分頁（專案名在頁首），唯一列得出它的地方是歷史，
 * 所以歸在 history；不歸的話卡片會多出一顆卻沒有分頁對得上。
 */
const SECTION_OF_ACTION: Record<ActivityAction, SectionKey> = {
  MATERIAL_UPLOAD: 'materials',
  MATERIAL_DELETE: 'materials',
  MEMBER_INVITE: 'members',
  MEMBER_ADD: 'members',
  MEMBER_REMOVE: 'members',
  MEMBER_PERMISSION_UPDATE: 'members',
  MEETING_CREATE: 'meetings',
  MEETING_DELETE: 'meetings',
  MEETING_SCHEDULE: 'calendar',
  PROJECT_RENAME: 'history',
}

const ACTIONS_OF_SECTION = SECTION_KEYS.reduce(
  (acc, key) => {
    acc[key] = (Object.keys(SECTION_OF_ACTION) as ActivityAction[]).filter(
      (a) => SECTION_OF_ACTION[a] === key,
    )
    return acc
  },
  {} as Record<SectionKey, ActivityAction[]>,
)

/** 尚未被取消／結束、還有機會參加的會議狀態 */
const OPEN_MEETING_STATUS = ['SCHEDULED', 'PENDING', 'ACTIVE'] as const

function emptyCounts(): SectionCounts {
  return { materials: 0, meetings: 0, calendar: 0, members: 0, history: 0 }
}

function emptyUnread(): ProjectUnread {
  return { total: 0, activityCount: 0, rsvpCount: 0, sections: emptyCounts() }
}

/** 專案存取權檢查，回傳 { project, isOwner, joinedAt }。 */
async function requireProjectAccess(projectId: string, userId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: { members: { where: { userId } } },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')

  const isOwner = project.ownerUserId === userId
  const m = project.members[0]
  if (!isOwner && (!m || (!m.canView && !m.canEdit && !m.canMeeting))) {
    throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此專案的權限')
  }

  // 沒有已讀紀錄時的起算點：owner 從建專案起算，成員從被加入起算。
  // 用專案建立時間當所有人的起點，會讓新成員一進來就背幾百則舊動態。
  return { project, isOwner, joinedAt: isOwner ? project.createdAt : m!.createdAt }
}

/** (projectId, section) → lastReadAt，查無則退回 joinedAt。 */
function thresholdLookup(
  readStates: { projectId: string; section: ProjectSection; lastReadAt: Date }[],
  joinedAtOf: Map<string, Date>,
) {
  const map = new Map<string, Date>()
  for (const r of readStates) {
    map.set(`${r.projectId}:${SECTION_KEY_OF[r.section]}`, r.lastReadAt)
  }
  return (projectId: string, section: SectionKey) =>
    map.get(`${projectId}:${section}`) ?? joinedAtOf.get(projectId) ?? new Date(0)
}

/**
 * 批次計算多個專案、各分頁的未讀數。
 *
 * joinedAt 由呼叫端提供（listProjects 手上已經有 project／member 資料），
 * 免得為了拿一個時間戳再打一輪 DB。
 */
export async function getProjectsUnread(
  userId: number,
  projects: { id: string; joinedAt: Date }[],
): Promise<Map<string, ProjectUnread>> {
  const result = new Map<string, ProjectUnread>()
  if (projects.length === 0) return result

  const projectIds = projects.map((p) => p.id)
  for (const id of projectIds) result.set(id, emptyUnread())
  const joinedAtOf = new Map(projects.map((p) => [p.id, p.joinedAt]))

  const readStates = await prisma.projectReadState.findMany({
    where: { userId, projectId: { in: projectIds } },
    select: { projectId: true, section: true, lastReadAt: true },
  })
  const since = thresholdLookup(readStates, joinedAtOf)

  // 每個 (專案, 分頁) 的門檻時間都不同，所以攤成 OR 一次撈完再自己歸戶。
  // 不管幾個專案都只有這一發查詢，不會變成 N 次 count。
  const activity = await prisma.activityLog.groupBy({
    by: ['projectId', 'action'],
    where: {
      actorUserId: { not: userId },
      OR: projects.flatMap((p) =>
        SECTION_KEYS.map((section) => ({
          projectId: p.id,
          action: { in: ACTIONS_OF_SECTION[section] },
          createdAt: { gt: since(p.id, section) },
        })),
      ),
    },
    _count: { _all: true },
  })
  for (const row of activity) {
    const entry = result.get(row.projectId)
    if (!entry) continue
    entry.sections[SECTION_OF_ACTION[row.action]] += row._count._all
    entry.activityCount += row._count._all
  }

  // MeetingAttendee 沒有 projectId，groupBy 跨不過關聯，改撈會議再自己數
  const pendingMeetings = await prisma.meetingInstance.findMany({
    where: {
      projectId: { in: projectIds },
      status: { in: [...OPEN_MEETING_STATUS] },
      OR: [{ scheduledEndAt: null }, { scheduledEndAt: { gt: new Date() } }],
      attendees: { some: { userId, rsvp: 'PENDING' } },
    },
    select: { projectId: true },
  })
  for (const m of pendingMeetings) {
    const entry = m.projectId ? result.get(m.projectId) : undefined
    if (!entry) continue
    // 待回覆出席是行事曆上的事
    entry.sections.calendar += 1
    entry.rsvpCount += 1
  }

  for (const entry of result.values()) {
    entry.total = entry.activityCount + entry.rsvpCount
  }
  return result
}

/** 單一專案的未讀數（給專案頁的分頁紅點用）。 */
export async function getProjectUnread(
  projectId: string,
  userId: number,
  joinedAt: Date,
): Promise<ProjectUnread> {
  const map = await getProjectsUnread(userId, [{ id: projectId, joinedAt }])
  return map.get(projectId) ?? emptyUnread()
}

/**
 * 單一專案的未讀明細，供前端點開圓點時列出「1. 2. 3. 4.」。
 * 待回覆的會議排在最前面（那是要動手的事），其後才是新動態。
 */
export async function listProjectNotifications(projectId: string, userId: number) {
  const { joinedAt } = await requireProjectAccess(projectId, userId)

  const readStates = await prisma.projectReadState.findMany({
    where: { projectId, userId },
    select: { projectId: true, section: true, lastReadAt: true },
  })
  const since = thresholdLookup(readStates, new Map([[projectId, joinedAt]]))

  const [meetings, activities] = await Promise.all([
    prisma.meetingInstance.findMany({
      where: {
        projectId,
        status: { in: [...OPEN_MEETING_STATUS] },
        OR: [{ scheduledEndAt: null }, { scheduledEndAt: { gt: new Date() } }],
        attendees: { some: { userId, rsvp: 'PENDING' } },
      },
      orderBy: { scheduledStartAt: 'asc' },
      select: { id: true, name: true, scheduledStartAt: true, scheduledEndAt: true },
    }),
    prisma.activityLog.findMany({
      where: {
        projectId,
        actorUserId: { not: userId },
        OR: SECTION_KEYS.map((section) => ({
          action: { in: ACTIONS_OF_SECTION[section] },
          createdAt: { gt: since(projectId, section) },
        })),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ])

  const actorIds = [...new Set(activities.map((a) => a.actorUserId))]
  const actors =
    actorIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, name: true },
        })
      : []
  const actorMap = new Map(actors.map((u) => [u.id, u]))

  const sections = emptyCounts()
  for (const a of activities) sections[SECTION_OF_ACTION[a.action]] += 1
  sections.calendar += meetings.length

  return {
    rsvpItems: meetings.map((m) => ({
      meetingId: m.id,
      name: m.name,
      scheduledStartAt: m.scheduledStartAt,
      scheduledEndAt: m.scheduledEndAt,
    })),
    activityItems: activities.map((a) => ({
      id: a.id,
      action: a.action,
      section: SECTION_OF_ACTION[a.action],
      targetLabel: a.targetLabel,
      actor: {
        userId: a.actorUserId,
        email: actorMap.get(a.actorUserId)?.email ?? null,
        name: actorMap.get(a.actorUserId)?.name ?? null,
      },
      createdAt: a.createdAt,
    })),
    unread: {
      total: activities.length + meetings.length,
      activityCount: activities.length,
      rsvpCount: meetings.length,
      sections,
    },
  }
}

/**
 * 標記已讀。給了 section 就只清那個分頁（前端切到哪個分頁就清哪個），
 * 沒給就五個分頁一起清（「全部標為已讀」用）。
 *
 * 只清掉動態未讀。待回覆的會議不受影響——那是待辦，要按了才算數。
 */
export async function markProjectRead(
  projectId: string,
  userId: number,
  section?: SectionKey,
) {
  await requireProjectAccess(projectId, userId)

  const targets = section ? [section] : SECTION_KEYS
  const now = new Date()

  await prisma.$transaction(
    targets.map((key) =>
      prisma.projectReadState.upsert({
        where: {
          projectId_userId_section: {
            projectId,
            userId,
            section: SECTION_ENUM[key],
          },
        },
        create: { projectId, userId, section: SECTION_ENUM[key], lastReadAt: now },
        update: { lastReadAt: now },
      }),
    ),
  )

  return { projectId, sections: targets, lastReadAt: now }
}
