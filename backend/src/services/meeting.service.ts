import { prisma } from '../lib/prisma.js'
import * as vexaClient from '../lib/vexa.js'
import { VexaConcurrentLimitError, parseGoogleMeetUrl } from '../lib/vexa.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'
import { createSession, closeSession, handleSessionClose } from '../sessions/session-manager.js'
import { recordActivity } from './activity.service.js'

const PLATFORM = 'google_meet'

const BOT_REQUIRED_SCOPES = ['bot', 'browser', 'tx']

function checkBotScopes(scopes: string[]): void {
  const missing = BOT_REQUIRED_SCOPES.filter((s) => !scopes.includes(s))
  if (missing.length > 0) {
    throw new AppError(
      'INSUFFICIENT_SCOPE',
      403,
      '此 token 缺少邀請 Bot 所需的 scope（需要 bot、browser、tx）',
      { required: BOT_REQUIRED_SCOPES, missing },
    )
  }
}

// ── Permission helpers ────────────────────────────────────────────────────────

async function getProjectWithAccess(projectId: string, vexaUserId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: { members: { where: { vexaUserId } } },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  return project
}

function requireCanMeeting(
  project: Awaited<ReturnType<typeof getProjectWithAccess>>,
  vexaUserId: number,
): void {
  const isOwner = project.ownerVexaUserId === vexaUserId
  if (isOwner) return
  const m = project.members[0]
  if (!m?.canMeeting) {
    throw new AppError('PERMISSION_DENIED', 403, '您對此專案沒有建立會議的權限')
  }
}

function requireCanView(
  project: Awaited<ReturnType<typeof getProjectWithAccess>>,
  vexaUserId: number,
): void {
  const isOwner = project.ownerVexaUserId === vexaUserId
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
  vexaUserId: number,
): Promise<void> {
  const project = await getProjectWithAccess(projectId, vexaUserId)
  requireCanMeeting(project, vexaUserId)
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId, projectId },
    select: { id: true },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')
}

// ── Create meeting ─────────────────────────────────────────────────────────────

export async function createMeeting(params: {
  vexaUserId: number
  vexaApiTokenId: number
  maxConcurrentBots: number
  vexaToken: string
  vexaTokenScopes: string[]
  googleMeetUrl: string
  name?: string
  projectId?: string | null
}) {
  const {
    vexaUserId,
    vexaApiTokenId,
    maxConcurrentBots,
    vexaToken,
    vexaTokenScopes,
    googleMeetUrl,
    projectId,
  } = params

  // ① URL 驗證 + scope 檢查
  const nativeMeetingId = parseGoogleMeetUrl(googleMeetUrl)
  if (!nativeMeetingId) {
    throw new AppError('INVALID_REQUEST', 400, '無效的 Google Meet URL 格式')
  }
  checkBotScopes(vexaTokenScopes)

  // ② 專案權限驗證 + difyDatasetId 取得
  let difyDatasetId: string | null = null
  let projectName: string | null = null
  if (projectId) {
    const project = await getProjectWithAccess(projectId, vexaUserId)
    requireCanMeeting(project, vexaUserId)
    difyDatasetId = project.difyDatasetId
    projectName = project.name
  }

  // ② 並發上限檢查（ACTIVE 計數）
  const activeBotCount = await prisma.meetingInstance.count({
    where: { createdByVexaUserId: vexaUserId, status: 'ACTIVE' },
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

  // ③ 建立 PENDING MeetingInstance
  const meeting = await prisma.meetingInstance.create({
    data: {
      projectId: projectId ?? null,
      name: meetingName,
      googleMeetUrl,
      status: 'PENDING',
      createdByVexaUserId: vexaUserId,
      creatorApiTokenId: vexaApiTokenId,
    },
  })

  // 通用活動紀錄（僅關聯專案的會議才入專案歷史）
  if (projectId) {
    await recordActivity({
      projectId,
      actorVexaUserId: vexaUserId,
      action: 'MEETING_CREATE',
      targetLabel: meetingName,
    })
  }

  // ④ 邀請 Vexa Bot
  let vexaMeetingId: number
  try {
    const result = await vexaClient.inviteBot({ googleMeetUrl, vexaToken })
    vexaMeetingId = result.vexaMeetingId
  } catch (err) {
    if (err instanceof VexaConcurrentLimitError) {
      // 並發競態：刪除剛建立的 PENDING record，回傳 409
      await prisma.meetingInstance.delete({ where: { id: meeting.id } })
      throw new AppError('BOT_CONCURRENT_LIMIT', 409, `您目前已有進行中的 Bot，無法再建立`, {
        maxConcurrentBots,
        activeBotCount,
      })
    }
    // 其他錯誤（網路/逾時）：保留 PENDING，UI 顯示重試
    logger.warn({ err, meetingId: meeting.id }, 'inviteBot failed, keeping PENDING')
    return formatMeetingResponse(meeting, vexaUserId, projectName)
  }

  // ⑤ 建立 WS Session
  try {
    await createSession(meeting.id, {
      vexaMeetingId,
      platform: PLATFORM,
      nativeMeetingId,
      difyDatasetId,
      creatorVexaToken: vexaToken,
    })
    // 成功：更新 DB 中的 Vexa IDs（狀態維持 PENDING，等 WS active 事件後才轉 ACTIVE）
    await prisma.meetingInstance.update({
      where: { id: meeting.id },
      data: { vexaMeetingId, vexaNativeMeetingId: nativeMeetingId, creatorApiTokenId: vexaApiTokenId },
    })
  } catch (err) {
    // WS 連線失敗：撤銷 Bot，保留 PENDING
    logger.warn({ err, meetingId: meeting.id }, 'createSession failed, removing bot')
    await vexaClient.removeBot(PLATFORM, nativeMeetingId, vexaToken).catch((e) =>
      logger.warn({ e }, 'removeBot after createSession failure also failed'),
    )
  }

  return formatMeetingResponse(meeting, vexaUserId, projectName)
}

function formatMeetingResponse(
  meeting: { id: string; name: string; googleMeetUrl: string; status: string; projectId: string | null; createdByVexaUserId: number; createdAt: Date; vexaMeetingId?: number | null },
  vexaUserId: number,
  projectName: string | null,
) {
  return {
    id: meeting.id,
    name: meeting.name,
    googleMeetUrl: meeting.googleMeetUrl,
    status: meeting.status,
    vexaMeetingId: meeting.vexaMeetingId ?? null,
    projectId: meeting.projectId ?? null,
    projectName,
    createdBy: { vexaUserId },
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
  if (meeting.status !== 'ACTIVE') {
    throw new AppError('INVALID_REQUEST', 400, '只有進行中的會議才能讓 Bot 離開')
  }

  // 取得邀請者 token（可能已過期）
  const tokenRows = await prisma.$queryRaw<Array<{ token: string }>>`
    SELECT token FROM public.api_tokens
    WHERE id = ${meeting.creatorApiTokenId}
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `

  if (!tokenRows.length) {
    logger.warn({ meetingInstanceId }, 'leaveMeeting: creator token expired, skipping DELETE /bots')
  } else {
    try {
      await vexaClient.removeBot(PLATFORM, meeting.vexaNativeMeetingId!, tokenRows[0].token)
    } catch (err) {
      logger.warn({ err, meetingInstanceId }, 'leaveMeeting: removeBot failed, continuing')
    }
  }

  // handleSessionClose 原子鎖更新 DB
  await handleSessionClose(meetingInstanceId)

  return {
    id: meetingInstanceId,
    status: 'ENDED',
    endedAt: new Date(),
  }
}

// ── Cancel pending meeting ───────────────────────────────────────────────────

/**
 * 取消等待中（PENDING）的會議：撤除可能已派出的 Vexa bot、關閉 WS session，並標記為 FAILED。
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

  // 關閉可能存在的 WS session（closeSession 先從 Map 移除再關閉，避免自動重連）
  await closeSession(meetingInstanceId).catch((err) =>
    logger.warn({ err, meetingInstanceId }, 'cancelMeeting: closeSession failed, continuing'),
  )

  // 若已派出 Vexa bot，嘗試撤除（best effort）
  if (meeting.vexaNativeMeetingId) {
    const tokenRows = await prisma.$queryRaw<Array<{ token: string }>>`
      SELECT token FROM public.api_tokens
      WHERE id = ${meeting.creatorApiTokenId}
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `
    if (tokenRows.length) {
      try {
        await vexaClient.removeBot(PLATFORM, meeting.vexaNativeMeetingId, tokenRows[0].token)
      } catch (err) {
        logger.warn({ err, meetingInstanceId }, 'cancelMeeting: removeBot failed, continuing')
      }
    }
  }

  const updated = await prisma.meetingInstance.update({
    where: { id: meetingInstanceId },
    data: { status: 'FAILED', endedAt: new Date() },
  })

  return { id: meetingInstanceId, status: updated.status, endedAt: updated.endedAt! }
}

// ── Re-invite bot ──────────────────────────────────────────────────────────────

/**
 * 重新邀請蜜塔加入既有會議。
 * 適用情境：Bot 加入失敗（FAILED）、會議已結束（ENDED）後想重新加入、
 * 或 PENDING 卡住想重試。會議若已 ACTIVE 則拒絕（蜜塔已在會議中）。
 */
export async function reinviteBot(params: {
  meetingInstanceId: string
  vexaUserId: number
  vexaApiTokenId: number
  maxConcurrentBots: number
  vexaToken: string
  vexaTokenScopes: string[]
}): Promise<{ id: string; status: string }> {
  const {
    meetingInstanceId,
    vexaUserId,
    vexaApiTokenId,
    maxConcurrentBots,
    vexaToken,
    vexaTokenScopes,
  } = params

  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingInstanceId },
    include: {
      project: {
        select: {
          difyDatasetId: true,
          ownerVexaUserId: true,
          members: { where: { vexaUserId } },
        },
      },
    },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  // 權限：建立者本人，或對關聯專案有 canMeeting
  const isCreator = meeting.createdByVexaUserId === vexaUserId
  if (!isCreator) {
    const isOwner = meeting.project?.ownerVexaUserId === vexaUserId
    const m = meeting.project?.members[0]
    if (!isOwner && !m?.canMeeting) {
      throw new AppError('PERMISSION_DENIED', 403, '您沒有重新邀請蜜塔的權限')
    }
  }

  if (meeting.status === 'ACTIVE') {
    throw new AppError('INVALID_REQUEST', 400, '蜜塔已在會議中，無需重新邀請')
  }

  checkBotScopes(vexaTokenScopes)

  const nativeMeetingId = parseGoogleMeetUrl(meeting.googleMeetUrl)
  if (!nativeMeetingId) {
    throw new AppError('INVALID_REQUEST', 400, '會議的 Google Meet URL 格式無效')
  }

  const activeBotCount = await prisma.meetingInstance.count({
    where: { createdByVexaUserId: vexaUserId, status: 'ACTIVE' },
  })
  if (activeBotCount >= maxConcurrentBots) {
    throw new AppError('BOT_CONCURRENT_LIMIT', 409, `您目前已有 ${activeBotCount} 個進行中的 Bot，無法再邀請`, {
      maxConcurrentBots,
      activeBotCount,
    })
  }

  // 防禦：清掉任何殘留的 WS session
  await closeSession(meetingInstanceId)

  // 轉回 PENDING，記錄本次邀請者 token
  await prisma.meetingInstance.update({
    where: { id: meetingInstanceId },
    data: {
      status: 'PENDING',
      startedAt: null,
      endedAt: null,
      creatorApiTokenId: vexaApiTokenId,
    },
  })

  // 邀請 Vexa Bot
  let vexaMeetingId: number
  try {
    const result = await vexaClient.inviteBot({ googleMeetUrl: meeting.googleMeetUrl, vexaToken })
    vexaMeetingId = result.vexaMeetingId
  } catch (err) {
    if (err instanceof VexaConcurrentLimitError) {
      throw new AppError('BOT_CONCURRENT_LIMIT', 409, '您目前已有進行中的 Bot，無法再邀請', {
        maxConcurrentBots,
        activeBotCount,
      })
    }
    // 其他錯誤：保留 PENDING，UI 顯示可重試
    logger.warn({ err, meetingInstanceId }, 'reinviteBot: inviteBot failed, keeping PENDING')
    return { id: meetingInstanceId, status: 'PENDING' }
  }

  // 建立 WS Session
  try {
    await createSession(meetingInstanceId, {
      vexaMeetingId,
      platform: PLATFORM,
      nativeMeetingId,
      difyDatasetId: meeting.project?.difyDatasetId ?? null,
      creatorVexaToken: vexaToken,
    })
    await prisma.meetingInstance.update({
      where: { id: meetingInstanceId },
      data: { vexaMeetingId, vexaNativeMeetingId: nativeMeetingId },
    })
  } catch (err) {
    logger.warn({ err, meetingInstanceId }, 'reinviteBot: createSession failed, removing bot')
    await vexaClient.removeBot(PLATFORM, nativeMeetingId, vexaToken).catch((e) =>
      logger.warn({ e }, 'reinviteBot: removeBot after createSession failure also failed'),
    )
  }

  return { id: meetingInstanceId, status: 'PENDING' }
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

export async function listMeetings(vexaUserId: number, params: ListMeetingsParams = {}) {
  const { page = 1, perPage = 20, search, since, order = 'desc', status } = params

  const where: any = {
    OR: [
      { createdByVexaUserId: vexaUserId },
      {
        project: {
          deletedAt: null,
          OR: [
            { ownerVexaUserId: vexaUserId },
            {
              members: {
                some: {
                  vexaUserId,
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
      include: { project: { select: { name: true } } },
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
      createdAt: m.createdAt,
    })),
    total,
    page,
    perPage,
  }
}

export async function listProjectMeetings(
  projectId: string,
  vexaUserId: number,
  params: ListMeetingsParams = {},
) {
  const project = await getProjectWithAccess(projectId, vexaUserId)
  requireCanView(project, vexaUserId)

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

  return {
    items: items.map((m) => ({
      id: m.id,
      name: m.name,
      googleMeetUrl: m.googleMeetUrl,
      status: m.status,
      startedAt: m.startedAt ?? null,
      endedAt: m.endedAt ?? null,
      createdAt: m.createdAt,
    })),
    total,
    page,
    perPage,
  }
}

export async function getMeeting(meetingId: string, vexaUserId: number) {
  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId },
    include: { project: { select: { name: true, ownerVexaUserId: true, members: { where: { vexaUserId } } } } },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  // 授權：建立者本人，或有 canView 的專案成員
  const isCreator = meeting.createdByVexaUserId === vexaUserId
  if (!isCreator) {
    if (!meeting.project) throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此會議的權限')
    const isOwner = meeting.project.ownerVexaUserId === vexaUserId
    const m = meeting.project.members[0]
    if (!isOwner && (!m || (!m.canView && !m.canEdit && !m.canMeeting))) {
      throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此會議的權限')
    }
  }

  const creatorRows = await prisma.$queryRaw<Array<{ name: string | null }>>`
    SELECT name FROM public.users WHERE id = ${meeting.createdByVexaUserId} LIMIT 1
  `

  return {
    id: meeting.id,
    name: meeting.name,
    googleMeetUrl: meeting.googleMeetUrl,
    status: meeting.status,
    vexaMeetingId: meeting.vexaMeetingId ?? null,
    projectId: meeting.projectId ?? null,
    projectName: meeting.project?.name ?? null,
    createdBy: { vexaUserId: meeting.createdByVexaUserId, name: creatorRows[0]?.name ?? null },
    startedAt: meeting.startedAt ?? null,
    endedAt: meeting.endedAt ?? null,
    summary: meeting.summary ?? null,
    actionItems: meeting.actionItems ?? null,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  }
}

export async function getProjectMeeting(
  projectId: string,
  meetingId: string,
  vexaUserId: number,
) {
  const project = await getProjectWithAccess(projectId, vexaUserId)
  requireCanView(project, vexaUserId)

  const meeting = await prisma.meetingInstance.findUnique({
    where: { id: meetingId, projectId },
  })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  const creatorRows = await prisma.$queryRaw<Array<{ name: string | null }>>`
    SELECT name FROM public.users WHERE id = ${meeting.createdByVexaUserId} LIMIT 1
  `

  return {
    id: meeting.id,
    name: meeting.name,
    googleMeetUrl: meeting.googleMeetUrl,
    status: meeting.status,
    vexaMeetingId: meeting.vexaMeetingId ?? null,
    createdBy: { vexaUserId: meeting.createdByVexaUserId, name: creatorRows[0]?.name ?? null },
    startedAt: meeting.startedAt ?? null,
    endedAt: meeting.endedAt ?? null,
    summary: meeting.summary ?? null,
    actionItems: meeting.actionItems ?? null,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  }
}

export async function updateMeetingName(
  meetingId: string,
  name: string,
  vexaUserId: number,
  projectId?: string,
) {
  const meeting = await prisma.meetingInstance.findUnique({ where: { id: meetingId } })
  if (!meeting) throw new AppError('NOT_FOUND', 404, '找不到此會議')

  if (projectId) {
    // 專案內：需要 canMeeting
    const project = await getProjectWithAccess(projectId, vexaUserId)
    requireCanMeeting(project, vexaUserId)
    if (meeting.projectId !== projectId) throw new AppError('NOT_FOUND', 404, '找不到此會議')
  } else {
    // 全局：只有建立者可修改
    if (meeting.createdByVexaUserId !== vexaUserId) {
      throw new AppError('PERMISSION_DENIED', 403, '只有建立者可修改此會議名稱')
    }
  }

  const updated = await prisma.meetingInstance.update({
    where: { id: meetingId },
    data: { name },
  })
  return { id: updated.id, name: updated.name, updatedAt: updated.updatedAt }
}
