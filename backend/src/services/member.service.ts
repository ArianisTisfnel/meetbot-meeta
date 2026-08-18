import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'
import { recordActivity } from './activity.service.js'

type MemberPermissions = {
  canView?: boolean
  canEdit?: boolean
  canMeeting?: boolean
}

export async function requireOwner(projectId: string, userId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')
  if (project.ownerUserId !== userId) {
    throw new AppError('PERMISSION_DENIED', 403, '只有擁有者可執行此操作')
  }
  return project
}

async function requireViewAccess(projectId: string, userId: number) {
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
  return project
}

export async function getMembers(projectId: string, userId: number) {
  const project = await requireViewAccess(projectId, userId)

  const owner = await prisma.user.findUnique({
    where: { id: project.ownerUserId },
    select: { id: true, email: true, name: true },
  })

  const allMembers = await prisma.projectMember.findMany({
    where: { projectId },
  })

  let memberUsers: Array<{ id: number; email: string; name: string | null }> = []
  if (allMembers.length > 0) {
    const memberUserIds = allMembers.map((m) => m.userId)
    memberUsers = await prisma.user.findMany({
      where: { id: { in: memberUserIds } },
      select: { id: true, email: true, name: true },
    })
  }

  const userMap = new Map(memberUsers.map((u) => [u.id, u]))

  // 待處理邀請（讓擁有者看到「邀請中」的人）。僅擁有者可見管理；一般成員也能看到名單。
  const pending = await prisma.projectInvitation.findMany({
    where: { projectId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  })

  return {
    owner: {
      userId: owner?.id ?? project.ownerUserId,
      email: owner?.email ?? null,
      name: owner?.name ?? null,
    },
    members: allMembers.map((m) => {
      const user = userMap.get(m.userId)
      return {
        id: m.id,
        userId: m.userId,
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
  ownerUserId: number,
  targetUserId: number,
  permissions: MemberPermissions,
) {
  await requireOwner(projectId, ownerUserId)

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
  })
  if (!member) throw new AppError('NOT_FOUND', 404, '成員不存在')

  // 檢視權是每個成員的基準權限，恆為 true，不可被取消（編輯/會議為其上的加購能力）。
  // 要移除存取請改用 removeMember。任何想把 canView 設為 false 的請求都強制矯正回 true。
  const data = { ...permissions }
  if (data.canView === false) data.canView = true

  const updated = await prisma.projectMember.update({
    where: { id: member.id },
    data,
  })

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { email: true },
  })
  await recordActivity({
    projectId,
    actorUserId: ownerUserId,
    action: 'MEMBER_PERMISSION_UPDATE',
    targetLabel: targetUser?.email ?? `使用者 #${targetUserId}`,
    metadata: {
      canView: updated.canView,
      canEdit: updated.canEdit,
      canMeeting: updated.canMeeting,
    },
  })

  return {
    id: updated.id,
    userId: updated.userId,
    canView: updated.canView,
    canEdit: updated.canEdit,
    canMeeting: updated.canMeeting,
    updatedAt: updated.updatedAt,
  }
}

export async function removeMember(
  projectId: string,
  ownerUserId: number,
  targetUserId: number,
) {
  const project = await requireOwner(projectId, ownerUserId)

  if (targetUserId === project.ownerUserId) {
    throw new AppError('PERMISSION_DENIED', 403, '不可移除專案擁有者')
  }

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
  })
  if (!member) throw new AppError('NOT_FOUND', 404, '成員不存在')

  // 取得被移除者 email 作為歷史快照（刪除後就查不到關聯了）
  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { email: true },
  })

  await prisma.projectMember.delete({ where: { id: member.id } })

  await recordActivity({
    projectId,
    actorUserId: ownerUserId,
    action: 'MEMBER_REMOVE',
    targetLabel: targetUser?.email ?? `使用者 #${targetUserId}`,
  })
}
