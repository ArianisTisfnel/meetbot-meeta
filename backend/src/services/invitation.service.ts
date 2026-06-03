import { randomBytes, createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { env } from '../types/env.js'
import { AppError } from '../middleware/error-handler.js'
import { sendInvitationEmail } from '../lib/email.js'
import { recordActivity } from './activity.service.js'
import { requireOwner } from './member.service.js'

type Permissions = {
  canView: boolean
  canEdit: boolean
  canMeeting: boolean
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** 產生原始 token（回傳給使用者 / 連結），與其 SHA-256 hash（存 DB）。 */
function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashToken(token) }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function acceptUrl(token: string): string {
  return `${env.APP_BASE_URL}/invitations/accept?token=${encodeURIComponent(token)}`
}

/** 以 email 查 Vexa 既有帳號（不分大小寫）。查不到回 null。 */
async function findVexaUserByEmail(
  email: string,
): Promise<{ id: number; email: string; name: string | null } | null> {
  const rows = await prisma.$queryRaw<
    Array<{ id: number; email: string; name: string | null }>
  >`SELECT id, email, name FROM public.users WHERE lower(email) = ${email} LIMIT 1`
  return rows[0] ?? null
}

// ── 擁有者側 ──────────────────────────────────────────────────────────

/**
 * 建立專案邀請（pending）。可邀請尚未在系統建立帳號的人。
 * 不再因「對方無帳號」而報錯——改為產生待處理邀請並寄出邀請信。
 */
export async function createInvitation(
  projectId: string,
  ownerVexaUserId: number,
  rawEmail: string,
  permissions: Permissions,
) {
  const project = await requireOwner(projectId, ownerVexaUserId)
  const email = normalizeEmail(rawEmail)

  // 既有帳號才有可能「已是成員」或「邀到自己」
  const existing = await findVexaUserByEmail(email)
  if (existing) {
    if (existing.id === project.ownerVexaUserId) {
      throw new AppError('SELF_INVITE', 400, '您是專案擁有者，無需邀請自己')
    }
    const member = await prisma.projectMember.findUnique({
      where: { projectId_vexaUserId: { projectId, vexaUserId: existing.id } },
    })
    if (member) {
      throw new AppError('ALREADY_MEMBER', 409, '此使用者已是此專案的成員')
    }
  }

  const duplicate = await prisma.projectInvitation.findFirst({
    where: { projectId, email, status: 'PENDING' },
  })
  if (duplicate) {
    throw new AppError(
      'ALREADY_INVITED',
      409,
      '此 email 已有待處理的邀請，請改用「重寄」',
    )
  }

  const { token, tokenHash } = generateToken()
  const expiresAt = new Date(Date.now() + env.INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)

  const invitation = await prisma.projectInvitation.create({
    data: {
      projectId,
      email,
      tokenHash,
      // 檢視權是成員基準權限，恆為 true（編輯/會議為其上的加購能力）
      canView: true,
      canEdit: permissions.canEdit,
      canMeeting: permissions.canMeeting,
      invitedByVexaUserId: ownerVexaUserId,
      expiresAt,
    },
  })

  await recordActivity({
    projectId,
    actorVexaUserId: ownerVexaUserId,
    action: 'MEMBER_INVITE',
    targetLabel: email,
  })

  const url = acceptUrl(token)
  const emailSent = await sendInvitationEmail({
    to: email,
    projectName: project.name,
    inviterName: await inviterDisplayName(ownerVexaUserId),
    acceptUrl: url,
    expiresAt,
  })

  return {
    ...toInvitationDto(invitation),
    // 回傳原始連結，方便擁有者在未設定 SMTP 時手動轉交（token 之後不會再出現）
    acceptUrl: url,
    emailSent,
  }
}

/** 重寄邀請：重產 token、刷新過期時間、再寄一次。 */
export async function resendInvitation(
  projectId: string,
  ownerVexaUserId: number,
  invitationId: string,
) {
  const project = await requireOwner(projectId, ownerVexaUserId)

  const invitation = await prisma.projectInvitation.findFirst({
    where: { id: invitationId, projectId },
  })
  if (!invitation) throw new AppError('NOT_FOUND', 404, '邀請不存在')
  if (invitation.status !== 'PENDING') {
    throw new AppError('INVITATION_NOT_PENDING', 409, '此邀請已非待處理狀態，無法重寄')
  }

  const { token, tokenHash } = generateToken()
  const expiresAt = new Date(Date.now() + env.INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)

  const updated = await prisma.projectInvitation.update({
    where: { id: invitation.id },
    data: { tokenHash, expiresAt },
  })

  const url = acceptUrl(token)
  const emailSent = await sendInvitationEmail({
    to: updated.email,
    projectName: project.name,
    inviterName: await inviterDisplayName(ownerVexaUserId),
    acceptUrl: url,
    expiresAt,
  })

  return { ...toInvitationDto(updated), acceptUrl: url, emailSent }
}

/** 撤銷邀請。 */
export async function revokeInvitation(
  projectId: string,
  ownerVexaUserId: number,
  invitationId: string,
) {
  await requireOwner(projectId, ownerVexaUserId)

  const invitation = await prisma.projectInvitation.findFirst({
    where: { id: invitationId, projectId },
  })
  if (!invitation) throw new AppError('NOT_FOUND', 404, '邀請不存在')
  if (invitation.status !== 'PENDING') {
    throw new AppError('INVITATION_NOT_PENDING', 409, '此邀請已非待處理狀態，無法撤銷')
  }

  await prisma.projectInvitation.update({
    where: { id: invitation.id },
    data: { status: 'REVOKED' },
  })
}

// 註：擁有者檢視某專案的待處理邀請，改由 member.service.getMembers 內聯回傳
// （GET .../members 的 pendingInvitations），不另設端點，故此處不再提供 listProjectInvitations。

// ── 收件者側（站內信箱） ──────────────────────────────────────────────

/** 列出「我」（以登入 email 為準）的待處理且未過期邀請。 */
export async function listMyInvitations(rawEmail: string) {
  const email = normalizeEmail(rawEmail)
  const invitations = await prisma.projectInvitation.findMany({
    where: { email, status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (invitations.length === 0) return []

  const projectIds = [...new Set(invitations.map((i) => i.projectId))]
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, name: true },
  })
  const projectMap = new Map(projects.map((p) => [p.id, p.name]))

  const inviterIds = [...new Set(invitations.map((i) => i.invitedByVexaUserId))]
  const inviterRows = await prisma.$queryRaw<
    Array<{ id: number; email: string; name: string | null }>
  >`SELECT id, email, name FROM public.users WHERE id IN (${Prisma.join(inviterIds)})`
  const inviterMap = new Map(inviterRows.map((r) => [r.id, r]))

  return invitations.map((inv) => {
    const inviter = inviterMap.get(inv.invitedByVexaUserId)
    return {
      ...toInvitationDto(inv),
      projectName: projectMap.get(inv.projectId) ?? null,
      inviterName: inviter?.name ?? inviter?.email ?? null,
    }
  })
}

/** 透過邀請 id 接受（站內信箱路徑，需 email 相符）。 */
export async function acceptInvitationById(
  invitationId: string,
  vexaUserId: number,
  rawEmail: string,
) {
  const invitation = await prisma.projectInvitation.findUnique({
    where: { id: invitationId },
  })
  return acceptInvitationRecord(invitation, vexaUserId, rawEmail)
}

/** 透過 token 接受（email 連結落地頁路徑）。 */
export async function acceptInvitationByToken(
  token: string,
  vexaUserId: number,
  rawEmail: string,
) {
  const invitation = await prisma.projectInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
  })
  return acceptInvitationRecord(invitation, vexaUserId, rawEmail)
}

async function acceptInvitationRecord(
  invitation: Awaited<ReturnType<typeof prisma.projectInvitation.findUnique>>,
  vexaUserId: number,
  rawEmail: string,
) {
  if (!invitation) throw new AppError('INVALID_INVITATION', 404, '邀請不存在或連結無效')

  const email = normalizeEmail(rawEmail)
  if (invitation.email !== email) {
    throw new AppError('EMAIL_MISMATCH', 403, '此邀請是寄給其他 email，請以受邀的帳號登入')
  }

  if (invitation.status === 'ACCEPTED') {
    // 冪等：已接受過就直接回成功
    return { projectId: invitation.projectId, alreadyAccepted: true }
  }
  if (invitation.status !== 'PENDING') {
    throw new AppError('INVITATION_NOT_PENDING', 409, '此邀請已被撤銷或拒絕')
  }
  if (invitation.expiresAt < new Date()) {
    await prisma.projectInvitation.update({
      where: { id: invitation.id },
      data: { status: 'EXPIRED' },
    })
    throw new AppError('INVITATION_EXPIRED', 410, '此邀請連結已過期，請聯絡邀請人重寄')
  }

  // 既是成員（race）→ 標記接受、冪等返回
  const existingMember = await prisma.projectMember.findUnique({
    where: { projectId_vexaUserId: { projectId: invitation.projectId, vexaUserId } },
  })
  if (existingMember) {
    await prisma.projectInvitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedByVexaUserId: vexaUserId, acceptedAt: new Date() },
    })
    return { projectId: invitation.projectId, alreadyAccepted: true }
  }

  await prisma.$transaction([
    prisma.projectMember.create({
      data: {
        projectId: invitation.projectId,
        vexaUserId,
        invitedByVexaUserId: invitation.invitedByVexaUserId,
        canView: invitation.canView,
        canEdit: invitation.canEdit,
        canMeeting: invitation.canMeeting,
      },
    }),
    prisma.projectInvitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedByVexaUserId: vexaUserId, acceptedAt: new Date() },
    }),
  ])

  await recordActivity({
    projectId: invitation.projectId,
    actorVexaUserId: vexaUserId,
    action: 'MEMBER_ADD',
    targetLabel: email,
  })

  return { projectId: invitation.projectId, alreadyAccepted: false }
}

/** 拒絕邀請（站內信箱路徑，需 email 相符）。 */
export async function declineInvitationById(
  invitationId: string,
  rawEmail: string,
) {
  const invitation = await prisma.projectInvitation.findUnique({
    where: { id: invitationId },
  })
  if (!invitation) throw new AppError('INVALID_INVITATION', 404, '邀請不存在或連結無效')
  if (invitation.email !== normalizeEmail(rawEmail)) {
    throw new AppError('EMAIL_MISMATCH', 403, '此邀請是寄給其他 email')
  }
  if (invitation.status !== 'PENDING') return // 冪等

  await prisma.projectInvitation.update({
    where: { id: invitation.id },
    data: { status: 'DECLINED' },
  })
}

// ── 輔助 ──────────────────────────────────────────────────────────────

async function inviterDisplayName(vexaUserId: number): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ email: string; name: string | null }>>`
    SELECT email, name FROM public.users WHERE id = ${vexaUserId} LIMIT 1
  `
  return rows[0]?.name ?? rows[0]?.email ?? '專案擁有者'
}

function toInvitationDto(inv: {
  id: string
  email: string
  canView: boolean
  canEdit: boolean
  canMeeting: boolean
  status: string
  expiresAt: Date
  createdAt: Date
}) {
  return {
    id: inv.id,
    email: inv.email,
    canView: inv.canView,
    canEdit: inv.canEdit,
    canMeeting: inv.canMeeting,
    status: inv.status,
    expiresAt: inv.expiresAt,
    invitedAt: inv.createdAt,
  }
}
