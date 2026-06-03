import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'
import { recordActivity } from './activity.service.js'

type MemberPermissions = {
  canView?: boolean
  canEdit?: boolean
  canMeeting?: boolean
}

export async function requireOwner(projectId: string, vexaUserId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  if (project.ownerVexaUserId !== vexaUserId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有擁有者可執行此操作')
  }
  return project
}

async function requireViewAccess(projectId: string, vexaUserId: number) {
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
  return project
}

export async function getMembers(projectId: string, vexaUserId: number) {
  const project = await requireViewAccess(projectId, vexaUserId)

  const ownerRows = await prisma.$queryRaw<
    Array<{ id: number; email: string; name: string | null }>
  >`SELECT id, email, name FROM public.users WHERE id = ${project.ownerVexaUserId} LIMIT 1`

  const allMembers = await prisma.projectMember.findMany({
    where: { projectId },
  })

  let memberUserRows: Array<{ id: number; email: string; name: string | null }> = []
  if (allMembers.length > 0) {
    const memberUserIds = allMembers.map((m) => m.vexaUserId)
    memberUserRows = await prisma.$queryRaw<
      Array<{ id: number; email: string; name: string | null }>
    >`SELECT id, email, name FROM public.users WHERE id IN (${Prisma.join(memberUserIds)})`
  }

  const userMap = new Map(memberUserRows.map((u) => [u.id, u]))

  // 待處理邀請（讓擁有者看到「邀請中」的人）。僅擁有者可見管理；一般成員也能看到名單。
  const pending = await prisma.projectInvitation.findMany({
    where: { projectId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  })

  return {
    owner: {
      vexaUserId: ownerRows[0]?.id ?? project.ownerVexaUserId,
      email: ownerRows[0]?.email ?? null,
      name: ownerRows[0]?.name ?? null,
    },
    members: allMembers.map((m) => {
      const user = userMap.get(m.vexaUserId)
      return {
        id: m.id,
        vexaUserId: m.vexaUserId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        canView: m.canView,
        canEdit: m.canEdit,
        canMeeting: m.canMeeting,
        invitedAt: m.createdAt,
      }
    }),
    pendingInvitations: pending.map((inv) => ({
      id: inv.id,
      email: inv.email,
      canView: inv.canView,
      canEdit: inv.canEdit,
      canMeeting: inv.canMeeting,
      expiresAt: inv.expiresAt,
      invitedAt: inv.createdAt,
    })),
  }
}

export async function updateMemberPermissions(
  projectId: string,
  ownerVexaUserId: number,
  targetVexaUserId: number,
  permissions: MemberPermissions,
) {
  await requireOwner(projectId, ownerVexaUserId)

  const member = await prisma.projectMember.findUnique({
    where: { projectId_vexaUserId: { projectId, vexaUserId: targetVexaUserId } },
  })
  if (!member) throw new AppError('NOT_FOUND', 404, '成員不存在')

  const updated = await prisma.projectMember.update({
    where: { id: member.id },
    data: permissions,
  })

  const targetRows = await prisma.$queryRaw<Array<{ email: string | null }>>`
    SELECT email FROM public.users WHERE id = ${targetVexaUserId} LIMIT 1
  `
  await recordActivity({
    projectId,
    actorVexaUserId: ownerVexaUserId,
    action: 'MEMBER_PERMISSION_UPDATE',
    targetLabel: targetRows[0]?.email ?? `使用者 #${targetVexaUserId}`,
    metadata: {
      canView: updated.canView,
      canEdit: updated.canEdit,
      canMeeting: updated.canMeeting,
    },
  })

  return {
    id: updated.id,
    vexaUserId: updated.vexaUserId,
    canView: updated.canView,
    canEdit: updated.canEdit,
    canMeeting: updated.canMeeting,
    updatedAt: updated.updatedAt,
  }
}

export async function removeMember(
  projectId: string,
  ownerVexaUserId: number,
  targetVexaUserId: number,
) {
  const project = await requireOwner(projectId, ownerVexaUserId)

  if (targetVexaUserId === project.ownerVexaUserId) {
    throw new AppError('PERMISSION_DENIED', 403, '不可移除專案擁有者')
  }

  const member = await prisma.projectMember.findUnique({
    where: { projectId_vexaUserId: { projectId, vexaUserId: targetVexaUserId } },
  })
  if (!member) throw new AppError('NOT_FOUND', 404, '成員不存在')

  // 取得被移除者 email 作為歷史快照（刪除後就查不到關聯了）
  const targetRows = await prisma.$queryRaw<Array<{ email: string | null }>>`
    SELECT email FROM public.users WHERE id = ${targetVexaUserId} LIMIT 1
  `

  await prisma.projectMember.delete({ where: { id: member.id } })

  await recordActivity({
    projectId,
    actorVexaUserId: ownerVexaUserId,
    action: 'MEMBER_REMOVE',
    targetLabel: targetRows[0]?.email ?? `使用者 #${targetVexaUserId}`,
  })
}