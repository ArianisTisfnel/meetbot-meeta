import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'

type MemberPermissions = {
  canView?: boolean
  canEdit?: boolean
  canMeeting?: boolean
}

async function requireOwner(projectId: string, vexaUserId: number) {
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
  }
}

export async function inviteMember(
  projectId: string,
  ownerVexaUserId: number,
  email: string,
  permissions: Required<MemberPermissions>,
) {
  await requireOwner(projectId, ownerVexaUserId)

  const userRows = await prisma.$queryRaw<
    Array<{ id: number; email: string; name: string | null }>
  >`SELECT id, email, name FROM public.users WHERE email = ${email} LIMIT 1`

  if (!userRows.length) {
    throw new AppError(
      'USER_NOT_FOUND_IN_VEXA',
      422,
      '此 email 尚未在系統中建立帳號，請對方先登入後再試',
    )
  }

  const targetUser = userRows[0]

  try {
    const member = await prisma.projectMember.create({
      data: {
        projectId,
        vexaUserId: targetUser.id,
        invitedByVexaUserId: ownerVexaUserId,
        ...permissions,
      },
    })
    return {
      id: member.id,
      vexaUserId: targetUser.id,
      email: targetUser.email,
      name: targetUser.name ?? null,
      canView: member.canView,
      canEdit: member.canEdit,
      canMeeting: member.canMeeting,
      invitedAt: member.createdAt,
    }
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw new AppError('ALREADY_MEMBER', 409, '此使用者已是此專案的成員')
    }
    throw err
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

  await prisma.projectMember.delete({ where: { id: member.id } })
}