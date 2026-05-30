import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { createDataset, deleteDataset, deleteDocument } from '../lib/dify.js'
import { deleteFile } from '../lib/supabase.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'

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

export async function listProjects(vexaUserId: number, params: ListProjectsParams = {}) {
  const { search, type = 'all', order = 'desc', page = 1, perPage = 20 } = params

  const where: Prisma.ProjectWhereInput = { deletedAt: null }

  if (search) {
    where.name = { contains: search, mode: 'insensitive' }
  }

  const validMemberFilter: Prisma.ProjectMemberListRelationFilter = {
    some: {
      vexaUserId,
      OR: [{ canView: true }, { canEdit: true }, { canMeeting: true }],
    },
  }

  if (type === 'owned') {
    where.ownerVexaUserId = vexaUserId
  } else if (type === 'shared') {
    where.NOT = { ownerVexaUserId: vexaUserId }
    where.members = validMemberFilter
  } else {
    where.OR = [
      { ownerVexaUserId: vexaUserId },
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
        members: { where: { vexaUserId } },
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
      const isOwner = p.ownerVexaUserId === vexaUserId
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

export async function createProject(vexaUserId: number, name: string) {
  const difyDatasetId = await createDataset(name)

  try {
    const project = await prisma.project.create({
      data: { name, ownerVexaUserId: vexaUserId, difyDatasetId },
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

export async function getProject(projectId: string, vexaUserId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: {
      members: { where: { vexaUserId } },
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

  const isOwner = project.ownerVexaUserId === vexaUserId
  const m = project.members[0]

  if (!isOwner) {
    if (!m || (!m.canView && !m.canEdit && !m.canMeeting)) {
      throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此專案的權限')
    }
  }

  const ownerRows = await prisma.$queryRaw<
    Array<{ id: number; email: string; name: string | null }>
  >`SELECT id, email, name FROM public.users WHERE id = ${project.ownerVexaUserId} LIMIT 1`

  return {
    id: project.id,
    name: project.name,
    role: isOwner ? 'owner' : 'member',
    permissions: isOwner ? OWNER_PERMISSIONS : memberPermissions(m!),
    owner: {
      vexaUserId: ownerRows[0]?.id ?? project.ownerVexaUserId,
      email: ownerRows[0]?.email ?? null,
      name: ownerRows[0]?.name ?? null,
    },
    memberCount: project._count.members + 1,
    materialCount: project._count.materials,
    activeMeetingCount: project._count.meetingInstances,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export async function updateProject(projectId: string, vexaUserId: number, name: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  if (project.ownerVexaUserId !== vexaUserId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有擁有者可更新此專案')
  }

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { name },
  })
  return { id: updated.id, name: updated.name, updatedAt: updated.updatedAt }
}

export async function deleteProject(projectId: string, vexaUserId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  if (project.ownerVexaUserId !== vexaUserId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有擁有者可刪除此專案')
  }

  // Step 1: Clean up each material's Storage file and Dify document, then soft delete
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

  // Step 2: Delete Dify dataset
  await deleteDataset(project.difyDatasetId)

  // Step 3: Soft delete project
  await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date() },
  })
}