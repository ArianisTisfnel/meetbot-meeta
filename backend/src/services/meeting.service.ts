import { prisma } from '../lib/prisma.js'
import { parseGoogleMeetUrl } from '../lib/google-meet.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'
import { startBotSession, closeSession, handleSessionClose } from '../sessions/session-manager.js'
import { recordActivity } from './activity.service.js'

// ── Permission helpers ────────────────────────────────────────────────────────

async function getProjectWithAccess(projectId: string, userId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: { members: { where: { userId } } },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  return project
}

function requireCanMeeting(
  project: Awaited<ReturnType<typeof getProjectWithAccess>>,
  userId: number,
): void {
  const isOwner = project.ownerUserId === userId
  if (isOwner) return
  const m = project.members[0]
  if (!m?.canMeeting) {
    throw new AppError('PERMISSION_DENIED', 403, '您對此專案沒有建立會議的權限')
  }
}

function requireCanView(
  project: Awaited<ReturnType<typeof getProjectWithAccess>>,
  userId: number,
): void {
  const isOwner = project.ownerUserId === userId
  if (isOwner) return
  const m = project.members[0]
  if (!m || (!m.canView && !m.canEdit && !m.canMeeting)) {
    throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此專案的權限')
  }
}

/**
 * 驗證使用者對「專案內某會議」具備會議權（Owner 或被授予 canMeeting 的參與者），
 * 並確認該會議確實屬於此專案。供 bot/leave、cancel 等需要 canMeeting 的專案版 route 使用。
 * （leaveMeeting / cancelMeeting 本身不含權限檢查，且同時被全局路由以 createdBy 授權呼叫，
 *  故權限在此處的呼叫端把關，不下放到那兩個函式。）
 */
export async function requireProjectMeetingManageAccess(
  projectId: string,
  meetingId: string,
  userId: number,
): Promise<void> {
  const project = await getProjectWithAccess(projectId, userId)
  requireCanMeeting(project, userId)
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId, projectId },
    select: { id: true },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')
}

// ── Create meeting ─────────────────────────────────────────────────────────────

export async function createMeeting(params: {
  userId: number
  maxConcurrentBots: number
  googleMeetUrl: string
  name?: string
  projectId?: string | null
}) {
  const { userId, maxConcurrentBots, googleMeetUrl, projectId } = params

  // ① URL 驗證
  const nativeMeetingId = parseGoogleMeetUrl(googleMeetUrl)
  if (!nativeMeetingId) {
    throw new AppError('INVALID_REQUEST', 400, '無效的 Google Meet URL 格式')
  }

  // ② 專案權限驗證 + difyDatasetId 取得
  let difyDatasetId: string | null = null
  let projectName: string | null = null
  if (projectId) {
    const project = await getProjectWithAccess(projectId, userId)
    requireCanMeeting(project, userId)
    difyDatasetId = project.difyDatasetId
    projectName = project.name
  }

  // ③ 並發上限檢查（ACTIVE 計數）
  const activeBotCount = await prisma.meetingInstance.count({
    where: { createdByUserId: userId, status: 'ACTIVE' },
  })
  if (activeBotCount >= maxConcurrentBots) {
    throw new AppError('BOT_CONCURRENT_LIMIT', 409, `您目前已有 ${activeBotCount} 個進行中的 Bot，無法再建立`, {
      maxConcurrentBots,
      activeBotCount,
    })
  }

  const meetingName =
    params.name ??
    `會議 ${new Date().toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '-')}`

  // ④ 建立 PENDING MeetingInstance
  const meeting = await prisma.meetingInstance.create({
    data: {
      projectId: projectId ?? null,
      name: meetingName,
      googleMeetUrl,
      status: 'PENDING',
      createdByUserId: userId,
    },
  })

  // 通用活動紀錄（僅關聯專案的會議才入專案歷史）
  if (projectId) {
    await recordActivity({
      projectId,
      actorUserId: userId,
      action: 'MEETING_CREATE',
      targetLabel: meetingName,
    })
  }

  // ⑤ 透過 provider 抽象層派 bot。
  //    背景執行、不阻塞此回應：bot 被 admitted → DB 轉 ACTIVE；進不去 → DB 轉 FAILED。
  void startBotSession({
    meetingInstanceId: meeting.id,
    googleMeetUrl,
    nativeMeetingId,
    difyDatasetId,
  })

  return formatMeetingResponse(meeting, userId, projectName)
}

function formatMeetingResponse(
  meeting: { id: string; name: string; googleMeetUrl: string; status: string; projectId: string | null; createdByUserId: number; createdAt: Date },
  userId: number,
  projectName: string | null,
) {
  return {
    id: meeting.id,
    name: meeting.name,
    googleMeetUrl: meeting.googleMeetUrl,
    status: meeting.status,
    projectId: meeting.projectId ?? null,
    projectName,
    createdBy: { userId },
    createdAt: meeting.createdAt,
  }
}

// ── Leave meeting ─────────────────────────────────────────────────────────────

export async function leaveMeeting(meetingInstanceId: string): Promise<{
  id: string
  status: string
  endedAt: Date
}> {
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingInstanceId },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')
  if (meeting.status === 'ENDED' || meeting.status === 'FAILED') {
    // 會議已結束：Recall 狀態輪詢偵測 call_ended 後，session-manager 已自動收尾
    // （含摘要、DB 轉 ENDED）。使用者此時按「結束會議」→ 冪等成功即可，
    // 不再回 400（實測 2026-07-09：手動關掉 Meet 後按結束被擋的 UX 痛點）。
    return {
      id: meetingInstanceId,
      status: meeting.status,
      endedAt: meeting.endedAt ?? new Date(),
    }
  }
  if (meeting.status !== 'ACTIVE') {
    throw new AppError('INVALID_REQUEST', 400, '加入中的會議請改用「取消」；只有進行中的會議才能讓 Bot 離開')
  }

  // handleSessionClose 原子鎖更新 DB，並透過 provider 抽象層讓 bot 離開（含撤除）。
  await handleSessionClose(meetingInstanceId)

  return {
    id: meetingInstanceId,
    status: 'ENDED',
    endedAt: new Date(),
  }
}

// ── Cancel pending meeting ───────────────────────────────────────────────────

/**
 * 取消等待中（PENDING）的會議：撤除可能已派出的 bot、關閉 session，並標記為 FAILED。
 * 與 leaveMeeting 不同，不觸發摘要（會議從未真正開始）。
 * 適用情境：蜜塔卡在加入中、或想在逾時自動轉 FAILED 前手動清掉。
 */
export async function cancelMeeting(meetingInstanceId: string): Promise<{
  id: string
  status: string
  endedAt: Date
}> {
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingInstanceId },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')
  if (meeting.status !== 'PENDING') {
    throw new AppError('INVALID_REQUEST', 400, '只有等待中（蜜塔加入中）的會議才能取消')
  }

  // 關閉可能存在的 session（closeSession 先從 Map 移除再透過 provider 讓 bot 離開，避免重連/遺留）
  await closeSession(meetingInstanceId).catch((err) =>
    logger.warn({ err, meetingInstanceId }, 'cancelMeeting: closeSession failed, continuing'),
  )

  const updated = await prisma.meetingInstance.update({
    where: { id: meetingInstanceId },
    data: { status: 'FAILED', endedAt: new Date() },
  })

  return { id: meetingInstanceId, status: updated.status, endedAt: updated.endedAt! }
}

// ── Delete meeting ───────────────────────────────────────────────────────────

/**
 * 刪除一筆會議記錄（硬刪除）。
 * 授權：專案會議僅「專案擁有者」可刪；全局（無專案）會議僅建立者本人可刪。
 * 安全限制：ACTIVE / PENDING（蜜塔仍在或加入中）不可刪，須先結束或取消。
 * 清理：best-effort 刪除 Storage 內的逐字稿檔；會議 row 為硬刪除。
 * 歷史：專案會議刪除記入專案活動（MEETING_DELETE）。
 */
export async function deleteMeeting(
  meetingId: string,
  userId: number,
  projectId?: string,
): Promise<void> {
  const meeting = await prisma.meetingInstance.findUnique({
    where: projectId ? { id: meetingId, projectId } : { id: meetingId },
    select: {
      id: true,
      name: true,
      status: true,
      transcriptStoragePath: true,
      projectId: true,
      createdByUserId: true,
    },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  // 授權：專案會議僅擁有者可刪；全局會議僅建立者本人可刪（以 DB 的 projectId 為準）。
  if (meeting.projectId) {
    const project = await getProjectWithAccess(meeting.projectId, userId)
    if (project.ownerUserId !== userId) {
      throw new AppError('PERMISSION_DENIED', 403, '只有專案擁有者可刪除此會議')
    }
  } else if (meeting.createdByUserId !== userId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可刪除此會議')
  }

  if (meeting.status === 'ACTIVE' || meeting.status === 'PENDING') {
    throw new AppError('INVALID_REQUEST', 400, '進行中或加入中的會議無法刪除，請先結束或取消')
  }

  // best-effort 清掉 Storage 逐字稿檔（失敗不擋刪除）
  if (meeting.transcriptStoragePath) {
    const { deleteFile } = await import('../lib/storage.js')
    await deleteFile(meeting.transcriptStoragePath).catch((err: unknown) =>
      logger.warn({ err, meetingId }, 'deleteMeeting: failed to delete transcript storage file'),
    )
  }

  await prisma.meetingInstance.delete({ where: { id: meetingId } })

  if (meeting.projectId) {
    await recordActivity({
      projectId: meeting.projectId,
      actorUserId: userId,
      action: 'MEETING_DELETE',
      targetLabel: meeting.name,
    })
  }
}

// ── Re-invite bot ──────────────────────────────────────────────────────────────

/**
 * 重新邀請蜜塔加入既有會議。
 * 適用情境：Bot 加入失敗（FAILED）、會議已結束（ENDED）後想重新加入、
 * 或 PENDING 卡住想重試。會議若已 ACTIVE 則拒絕（蜜塔已在會議中）。
 *
 * ENDED 會議已有正式資料（摘要、逐字稿、起訖時間），重邀**不可覆寫原紀錄**：
 * 會另建一筆新的 MeetingInstance（沿用名稱/URL/專案）並回傳新 id。
 * FAILED / 卡住的 PENDING 尚無任何會議資料，沿用就地重置（避免堆積廢棄紀錄）。
 *
 * 已知取捨（不是 bug，看到一串刪不掉的 FAILED 列時別以為壞了）：
 * 對一場「蜜塔一直進不去」的 ENDED 會議反覆重邀，每次都會新建一列，而 startBotSession
 * 是背景執行、進不去就留下一列 FAILED；`deleteMeeting` 又不允許刪除 FAILED / ENDED
 * （見該函式）。所以廢棄紀錄會累積且清不掉。要解得先調整刪除策略，不在本函式的範圍。
 */
export async function reinviteBot(params: {
  meetingInstanceId: string
  userId: number
  maxConcurrentBots: number
}): Promise<{ id: string; status: string }> {
  const { meetingInstanceId, userId, maxConcurrentBots } = params

  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingInstanceId },
    include: {
      project: {
        select: {
          difyDatasetId: true,
          ownerUserId: true,
          members: { where: { userId } },
        },
      },
    },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  // 權限：建立者本人，或對關聯專案有 canMeeting
  const isCreator = meeting.createdByUserId === userId
  if (!isCreator) {
    const isOwner = meeting.project?.ownerUserId === userId
    const m = meeting.project?.members[0]
    if (!isOwner && !m?.canMeeting) {
      throw new AppError('PERMISSION_DENIED', 403, '您沒有重新邀請蜜塔的權限')
    }
  }

  if (meeting.status === 'ACTIVE') {
    throw new AppError('INVALID_REQUEST', 400, '蜜塔已在會議中，無需重新邀請')
  }

  const nativeMeetingId = parseGoogleMeetUrl(meeting.googleMeetUrl)
  if (!nativeMeetingId) {
    throw new AppError('INVALID_REQUEST', 400, '會議的 Google Meet URL 格式無效')
  }

  const activeBotCount = await prisma.meetingInstance.count({
    where: { createdByUserId: userId, status: 'ACTIVE' },
  })
  if (activeBotCount >= maxConcurrentBots) {
    throw new AppError('BOT_CONCURRENT_LIMIT', 409, `您目前已有 ${activeBotCount} 個進行中的 Bot，無法再邀請`, {
      maxConcurrentBots,
      activeBotCount,
    })
  }

  // 防禦：清掉任何殘留的 session
  await closeSession(meetingInstanceId)

  let targetMeetingId = meetingInstanceId
  if (meeting.status === 'ENDED') {
    // 保留原會議紀錄，另建新實例。
    //
    // createdByUserId = 紀錄擁有者，決定誰能改名／刪除，以及這場會議算誰的歷史。
    // **沿用原紀錄**——重邀是「把蜜塔再請回同一場會議」，不是換人接管這筆紀錄。
    // 寫成本次邀請者的話，A 建的全局會議被 B 重邀之後 A 就失去控制權了（PR #13 審查發現）。
    //
    // （移除 Vexa 前這裡還要換掉 creatorApiTokenId：per-session WS 用邀請者自己的 token
    //   建連線，Vexa 以 meeting.user_id == current_user.id 判斷授權。Recall 不用 per-user
    //   token，該欄位已隨 Vexa 一起刪除——但上面那條「擁有者不換人」是政策，與 provider 無關。）
    const newMeeting = await prisma.meetingInstance.create({
      data: {
        projectId: meeting.projectId,
        name: meeting.name,
        googleMeetUrl: meeting.googleMeetUrl,
        status: 'PENDING',
        createdByUserId: meeting.createdByUserId,
      },
    })
    targetMeetingId = newMeeting.id
    if (meeting.projectId) {
      await recordActivity({
        projectId: meeting.projectId,
        actorUserId: userId,
        action: 'MEETING_CREATE',
        targetLabel: meeting.name,
      })
    }
  } else {
    // FAILED / 卡住的 PENDING：轉回 PENDING
    await prisma.meetingInstance.update({
      where: { id: meetingInstanceId },
      data: { status: 'PENDING', startedAt: null, endedAt: null },
    })
  }

  // 透過 provider 抽象層派 bot，背景等待 admitted。
  void startBotSession({
    meetingInstanceId: targetMeetingId,
    googleMeetUrl: meeting.googleMeetUrl,
    nativeMeetingId,
    difyDatasetId: meeting.project?.difyDatasetId ?? null,
  })

  return { id: targetMeetingId, status: 'PENDING' }
}

// ── List / Get meetings ───────────────────────────────────────────────────────

export type ListMeetingsParams = {
  page?: number
  perPage?: number
  search?: string
  since?: number
  order?: 'asc' | 'desc'
  status?: string
}

export async function listMeetings(userId: number, params: ListMeetingsParams = {}) {
  const { page = 1, perPage = 20, search, since, order = 'desc', status } = params

  const where: any = {
    OR: [
      { createdByUserId: userId },
      {
        project: {
          deletedAt: null,
          OR: [
            { ownerUserId: userId },
            {
              members: {
                some: {
                  userId,
                  OR: [{ canView: true }, { canEdit: true }, { canMeeting: true }],
                },
              },
            },
          ],
        },
      },
    ],
  }

  if (search) where.name = { contains: search, mode: 'insensitive' }
  if (since) {
    const cutoff = new Date(Date.now() - since * 24 * 60 * 60 * 1000)
    where.createdAt = { gte: cutoff }
  }
  if (status) where.status = status

  const [items, total] = await Promise.all([
    prisma.meetingInstance.findMany({
      where,
      orderBy: { createdAt: order },
      skip: (page - 1) * perPage,
      take: perPage,
      include: { project: { select: { name: true, ownerUserId: true } } },
    }),
    prisma.meetingInstance.count({ where }),
  ])

  return {
    items: items.map((m) => ({
      id: m.id,
      name: m.name,
      googleMeetUrl: m.googleMeetUrl,
      status: m.status,
      projectId: m.projectId ?? null,
      projectName: m.project?.name ?? null,
      startedAt: m.startedAt ?? null,
      endedAt: m.endedAt ?? null,
      // 刪除權：專案會議看擁有者、全局會議看建立者
      canDelete: m.projectId
        ? m.project?.ownerUserId === userId
        : m.createdByUserId === userId,
      createdAt: m.createdAt,
    })),
    total,
    page,
    perPage,
  }
}

export async function listProjectMeetings(
  projectId: string,
  userId: number,
  params: ListMeetingsParams = {},
) {
  const project = await getProjectWithAccess(projectId, userId)
  requireCanView(project, userId)

  const { page = 1, perPage = 20, search, since, order = 'desc', status } = params

  const where: any = { projectId }
  if (search) where.name = { contains: search, mode: 'insensitive' }
  if (since) {
    const cutoff = new Date(Date.now() - since * 24 * 60 * 60 * 1000)
    where.createdAt = { gte: cutoff }
  }
  if (status) where.status = status

  const [items, total] = await Promise.all([
    prisma.meetingInstance.findMany({
      where,
      orderBy: { createdAt: order },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.meetingInstance.count({ where }),
  ])

  const canDelete = project.ownerUserId === userId

  return {
    items: items.map((m) => ({
      id: m.id,
      name: m.name,
      googleMeetUrl: m.googleMeetUrl,
      status: m.status,
      startedAt: m.startedAt ?? null,
      endedAt: m.endedAt ?? null,
      canDelete,
      createdAt: m.createdAt,
    })),
    total,
    page,
    perPage,
  }
}

export async function getMeeting(meetingId: string, userId: number) {
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId },
    include: { project: { select: { name: true, ownerUserId: true, members: { where: { userId } } } } },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  // 授權：建立者本人，或有 canView 的專案成員
  const isCreator = meeting.createdByUserId === userId
  if (!isCreator) {
    if (!meeting.project) throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此會議的權限')
    const isOwner = meeting.project.ownerUserId === userId
    const m = meeting.project.members[0]
    if (!isOwner && (!m || (!m.canView && !m.canEdit && !m.canMeeting))) {
      throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此會議的權限')
    }
  }

  const creator = await prisma.user.findUnique({
    where: { id: meeting.createdByUserId },
    select: { name: true },
  })

  return {
    id: meeting.id,
    name: meeting.name,
    googleMeetUrl: meeting.googleMeetUrl,
    status: meeting.status,
    projectId: meeting.projectId ?? null,
    projectName: meeting.project?.name ?? null,
    createdBy: { userId: meeting.createdByUserId, name: creator?.name ?? null },
    startedAt: meeting.startedAt ?? null,
    endedAt: meeting.endedAt ?? null,
    summary: meeting.summary ?? null,
    actionItems: meeting.actionItems ?? null,
    keyTopics: meeting.keyTopics ?? null,
    decisions: meeting.decisions ?? null,
    hasTranscript: Boolean(meeting.transcriptStoragePath),
    canDelete: meeting.projectId
      ? meeting.project?.ownerUserId === userId
      : meeting.createdByUserId === userId,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  }
}

export async function getProjectMeeting(
  projectId: string,
  meetingId: string,
  userId: number,
) {
  const project = await getProjectWithAccess(projectId, userId)
  requireCanView(project, userId)

  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId, projectId },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  const creator = await prisma.user.findUnique({
    where: { id: meeting.createdByUserId },
    select: { name: true },
  })

  return {
    id: meeting.id,
    name: meeting.name,
    googleMeetUrl: meeting.googleMeetUrl,
    status: meeting.status,
    createdBy: { userId: meeting.createdByUserId, name: creator?.name ?? null },
    startedAt: meeting.startedAt ?? null,
    endedAt: meeting.endedAt ?? null,
    summary: meeting.summary ?? null,
    actionItems: meeting.actionItems ?? null,
    keyTopics: meeting.keyTopics ?? null,
    decisions: meeting.decisions ?? null,
    hasTranscript: Boolean(meeting.transcriptStoragePath),
    canDelete: project.ownerUserId === userId,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  }
}

/**
 * 取得會後完整逐字稿的 Markdown（provider-agnostic）。
 * 來源為摘要階段存進 Storage 的 transcript.md——這是 Recall 會議結束後
 * 唯一可靠的逐字稿來源（session 已離開記憶體、Recall bot id 未持久化，無法即時重抓）。
 * 權限與 getMeeting / getProjectMeeting 一致（呼叫端先做存取檢查）。
 */
export async function getMeetingTranscriptMarkdown(meetingId: string): Promise<string | null> {
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId },
    select: { transcriptStoragePath: true },
  })
  if (!meeting?.transcriptStoragePath) return null
  const { downloadTextFile } = await import('../lib/storage.js')
  return downloadTextFile(meeting.transcriptStoragePath)
}

export async function updateMeetingName(
  meetingId: string,
  name: string,
  userId: number,
  projectId?: string,
) {
  const meeting = await prisma.meetingInstance.findUnique({ where: { id: meetingId } })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  if (projectId) {
    // 專案內：需要 canMeeting
    const project = await getProjectWithAccess(projectId, userId)
    requireCanMeeting(project, userId)
    if (meeting.projectId !== projectId) throw new AppError('NOT_FOUND', 404, '找不到此會議')
  } else {
    // 全局：只有建立者可修改
    if (meeting.createdByUserId !== userId) {
      throw new AppError('PERMISSION_DENIED', 403, '只有建立者可修改此會議名稱')
    }
  }

  const updated = await prisma.meetingInstance.update({
    where: { id: meetingId },
    data: { name },
  })
  return { id: updated.id, name: updated.name, updatedAt: updated.updatedAt }
}
