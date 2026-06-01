import { Prisma } from '@prisma/client'
import type { ActivityAction } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'

/**
 * 寫入一筆通用活動紀錄。Best-effort：失敗只記 log，不影響主流程。
 */
export async function recordActivity(params: {
  projectId: string
  actorVexaUserId: number
  action: ActivityAction
  targetLabel: string
  metadata?: Prisma.InputJsonValue
}): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        projectId: params.projectId,
        actorVexaUserId: params.actorVexaUserId,
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
  vexaUserId: number,
  params: { page?: number; perPage?: number } = {},
) {
  // 存取權限檢查（擁有者或具任一權限的成員）
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: { members: { where: { vexaUserId } } },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  const isOwner = project.ownerVexaUserId === vexaUserId
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

  const actorIds = [...new Set(items.map((i) => i.actorVexaUserId))]
  let actorMap = new Map<number, { email: string | null; name: string | null }>()
  if (actorIds.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ id: number; email: string | null; name: string | null }>>`
      SELECT id, email, name FROM public.users WHERE id IN (${Prisma.join(actorIds)})
    `
    actorMap = new Map(rows.map((r) => [r.id, { email: r.email, name: r.name }]))
  }

  return {
    items: items.map((i) => ({
      id: i.id,
      action: i.action,
      targetLabel: i.targetLabel,
      metadata: i.metadata ?? null,
      actor: {
        vexaUserId: i.actorVexaUserId,
        email: actorMap.get(i.actorVexaUserId)?.email ?? null,
        name: actorMap.get(i.actorVexaUserId)?.name ?? null,
      },
      createdAt: i.createdAt,
    })),
    total,
    page,
    perPage,
  }
}
