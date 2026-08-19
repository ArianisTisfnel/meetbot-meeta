import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { createDataset, deleteDataset, deleteDocument } from '../lib/dify.js'
import { deleteFile } from '../lib/storage.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'
import { recordActivity } from './activity.service.js'

type ProjectPermissions = {
  canView: boolean
  canEdit: boolean
  canDelete: boolean
  canManage: boolean
  canMeeting: boolean
}

const OWNER_PERMISSIONS: ProjectPermissions = {
  canView: true,
  canEdit: true,
  canDelete: true,
  canManage: true,
  canMeeting: true,
}

function memberPermissions(m: {
  canView: boolean
  canEdit: boolean
  canMeeting: boolean
}): ProjectPermissions {
  return {
    canView: m.canView,
    canEdit: m.canEdit,
    canDelete: false,
    canManage: false,
    canMeeting: m.canMeeting,
  }
}

export type ListProjectsParams = {
  search?: string
  type?: 'all' | 'owned' | 'shared'
  order?: 'asc' | 'desc'
  page?: number
  perPage?: number
}

export async function listProjects(userId: number, params: ListProjectsParams = {}) {
  const { search, type = 'all', order = 'desc', page = 1, perPage = 20 } = params

  const where: Prisma.ProjectWhereInput = { deletedAt: null }

  if (search) {
    where.name = { contains: search, mode: 'insensitive' }
  }

  const validMemberFilter: Prisma.ProjectMemberListRelationFilter = {
    some: {
      userId,
      OR: [{ canView: true }, { canEdit: true }, { canMeeting: true }],
    },
  }

  if (type === 'owned') {
    where.ownerUserId = userId
  } else if (type === 'shared') {
    where.NOT = { ownerUserId: userId }
    where.members = validMemberFilter
  } else {
    where.OR = [
      { ownerUserId: userId },
      { members: validMemberFilter },
    ]
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: { createdAt: order },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        members: { where: { userId } },
        _count: {
          select: {
            members: true,
            materials: { where: { deletedAt: null } },
            meetingInstances: { where: { status: 'ACTIVE' } },
          },
        },
      },
    }),
    prisma.project.count({ where }),
  ])

  return {
    items: projects.map((p) => {
      const isOwner = p.ownerUserId === userId
      const m = p.members[0]
      return {
        id: p.id,
        name: p.name,
        role: isOwner ? 'owner' : 'member',
        permissions: isOwner
          ? OWNER_PERMISSIONS
          : memberPermissions(m ?? { canView: false, canEdit: false, canMeeting: false }),
        memberCount: p._count.members + 1,
        materialCount: p._count.materials,
        activeMeetingCount: p._count.meetingInstances,
        createdAt: p.createdAt,
      }
    }),
    total,
  }
}

export async function createProject(userId: number, name: string) {
  // Dify dataset 名稱在整個 workspace 內必須唯一，但專案顯示名稱允許使用者間自由重複，
  // 兩者脫鉤：送給 Dify 的名稱加短 UUID 後綴，避免撞名觸發 409 dataset_name_duplicate
  const difyDatasetId = await createDataset(`${name}-${crypto.randomUUID().slice(0, 8)}`)

  try {
    const project = await prisma.project.create({
      data: { name, ownerUserId: userId, difyDatasetId },
    })
    return {
      id: project.id,
      name: project.name,
      role: 'owner',
      permissions: OWNER_PERMISSIONS,
      createdAt: project.createdAt,
    }
  } catch (err) {
    await deleteDataset(difyDatasetId).catch(() => {})
    throw err
  }
}

export async function getProject(projectId: string, userId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: {
      members: { where: { userId } },
      _count: {
        select: {
          members: true,
          materials: { where: { deletedAt: null } },
          meetingInstances: { where: { status: 'ACTIVE' } },
        },
      },
    },
  })

  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')

  const isOwner = project.ownerUserId === userId
  const m = project.members[0]

  if (!isOwner) {
    if (!m || (!m.canView && !m.canEdit && !m.canMeeting)) {
      throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此專案的權限')
    }
  }

  const owner = await prisma.user.findUnique({
    where: { id: project.ownerUserId },
    select: { id: true, email: true, name: true },
  })

  return {
    id: project.id,
    name: project.name,
    role: isOwner ? 'owner' : 'member',
    permissions: isOwner ? OWNER_PERMISSIONS : memberPermissions(m!),
    owner: {
      userId: owner?.id ?? project.ownerUserId,
      email: owner?.email ?? null,
      name: owner?.name ?? null,
    },
    memberCount: project._count.members + 1,
    materialCount: project._count.materials,
    activeMeetingCount: project._count.meetingInstances,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export async function updateProject(projectId: string, userId: number, name: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  if (project.ownerUserId !== userId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有擁有者可更新此專案')
  }

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { name },
  })

  if (updated.name !== project.name) {
    await recordActivity({
      projectId,
      actorUserId: userId,
      action: 'PROJECT_RENAME',
      targetLabel: updated.name,
      metadata: { from: project.name, to: updated.name },
    })
  }

  return { id: updated.id, name: updated.name, updatedAt: updated.updatedAt }
}

export async function deleteProject(projectId: string, userId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  if (project.ownerUserId !== userId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有擁有者可刪除此專案')
  }

  const materials = await prisma.material.findMany({
    where: { projectId, deletedAt: null },
  })

  for (const m of materials) {
    await deleteFile(m.storagePath).catch((e: unknown) =>
      logger.error({ err: e, materialId: m.id }, 'deleteProject: failed to delete Storage file'),
    )
    if (m.difyDocumentId) {
      await deleteDocument(project.difyDatasetId, m.difyDocumentId).catch((e: unknown) =>
        logger.error({ err: e, materialId: m.id }, 'deleteProject: failed to delete Dify document'),
      )
    }
  }

  await prisma.material.updateMany({
    where: { projectId, deletedAt: null },
    data: { deletedAt: new Date() },
  })

  await deleteDataset(project.difyDatasetId)

  await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date() },
  })
}
