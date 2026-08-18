import type { ActivityAction } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'

/**
 * 寫入一筆通用活動紀錄。Best-effort：失敗只記 log，不影響主流程。
 */
export async function recordActivity(params: {
  projectId: string
  actorUserId: number
  action: ActivityAction
  targetLabel: string
  metadata?: Prisma.InputJsonValue
}): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: params.action,
        targetLabel: params.targetLabel,
        metadata: params.metadata,
      },
    })
  } catch (e: unknown) {
    logger.error({ err: e, action: params.action }, 'recordActivity failed')
  }
}

/**
 * 列出專案的活動紀錄。需要對該專案有檢視權限。
 */
export async function listActivity(
  projectId: string,
  userId: number,
  params: { page?: number; perPage?: number } = {},
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: { members: { where: { userId } } },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  const isOwner = project.ownerUserId === userId
  if (!isOwner) {
    const m = project.members[0]
    if (!m || (!m.canView && !m.canEdit && !m.canMeeting)) {
      throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此專案的權限')
    }
  }

  const { page = 1, perPage = 30 } = params

  const [items, total] = await Promise.all([
    prisma.activityLog.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.activityLog.count({ where: { projectId } }),
  ])

  const actorIds = [...new Set(items.map((i) => i.actorUserId))]
  let actorMap = new Map<number, { email: string; name: string | null }>()
  if (actorIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, email: true, name: true },
    })
    actorMap = new Map(users.map((u) => [u.id, { email: u.email, name: u.name }]))
  }

  return {
    items: items.map((i) => ({
      id: i.id,
      action: i.action,
      targetLabel: i.targetLabel,
      metadata: i.metadata ?? null,
      actor: {
        userId: i.actorUserId,
        email: actorMap.get(i.actorUserId)?.email ?? null,
        name: actorMap.get(i.actorUserId)?.name ?? null,
      },
      createdAt: i.createdAt,
    })),
    total,
    page,
    perPage,
  }
}
