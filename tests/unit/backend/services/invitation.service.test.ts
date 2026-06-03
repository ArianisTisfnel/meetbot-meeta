import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))

// EmailService：預設「已寄出」（用 vi.hoisted 以便在被提升的 mock 工廠中引用）
const { sendInvitationEmail } = vi.hoisted(() => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../../../backend/src/lib/email', () => ({ sendInvitationEmail }))

vi.mock('../../../../backend/src/types/env', () => ({
  env: { APP_BASE_URL: 'http://localhost:3000', INVITATION_TTL_DAYS: 7 },
}))

import {
  createInvitation,
  acceptInvitationByToken,
  revokeInvitation,
} from '../../../../backend/src/services/invitation.service'

const OWNER_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  ownerVexaUserId: 1,
  difyDatasetId: 'd',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
}

const PERMS = { canView: true, canEdit: false, canMeeting: false }

beforeEach(() => {
  vi.clearAllMocks()
  sendInvitationEmail.mockResolvedValue(true)
})

// ── createInvitation ──────────────────────────────────────────────────

describe('createInvitation', () => {
  it('建立 PENDING 邀請並寄信（即使對方尚未在系統建立帳號）', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNER_PROJECT) // requireOwner
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([]) // findVexaUserByEmail → 查無此人（未註冊）
      .mockResolvedValueOnce([{ email: 'owner@x.com', name: 'Owner' }]) // inviterDisplayName
    mockPrisma.projectInvitation.findFirst.mockResolvedValueOnce(null) // 無重複 pending
    mockPrisma.projectInvitation.create.mockResolvedValueOnce({
      id: 'inv-1',
      email: 'new@example.com',
      canView: true,
      canEdit: false,
      canMeeting: false,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 7 * 86400000),
      createdAt: new Date(),
    })

    const result = await createInvitation('proj-1', 1, 'New@Example.com', PERMS)

    expect(mockPrisma.projectInvitation.create).toHaveBeenCalledOnce()
    // email 應被正規化為小寫
    expect(mockPrisma.projectInvitation.create.mock.calls[0][0].data.email).toBe(
      'new@example.com',
    )
    expect(sendInvitationEmail).toHaveBeenCalledOnce()
    expect(result.emailSent).toBe(true)
    expect(result.acceptUrl).toContain('/invitations/accept?token=')
    expect(result.status).toBe('PENDING')
  })

  it('擋自我邀請（被邀 email 屬於擁有者）', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNER_PROJECT)
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { id: 1, email: 'owner@x.com', name: 'Owner' }, // 與 ownerVexaUserId 相同
    ])

    await expect(
      createInvitation('proj-1', 1, 'owner@x.com', PERMS),
    ).rejects.toMatchObject({ code: 'SELF_INVITE', statusCode: 400 })
    expect(mockPrisma.projectInvitation.create).not.toHaveBeenCalled()
  })

  it('既有使用者已是成員 → ALREADY_MEMBER 409', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNER_PROJECT)
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 2, email: 'm@x.com', name: null }])
    mockPrisma.projectMember.findUnique.mockResolvedValueOnce({ id: 'mem-1' })

    await expect(
      createInvitation('proj-1', 1, 'm@x.com', PERMS),
    ).rejects.toMatchObject({ code: 'ALREADY_MEMBER', statusCode: 409 })
  })

  it('已有待處理邀請 → ALREADY_INVITED 409', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNER_PROJECT)
    mockPrisma.$queryRaw.mockResolvedValueOnce([]) // 未註冊
    mockPrisma.projectInvitation.findFirst.mockResolvedValueOnce({ id: 'inv-existing' })

    await expect(
      createInvitation('proj-1', 1, 'dup@example.com', PERMS),
    ).rejects.toMatchObject({ code: 'ALREADY_INVITED', statusCode: 409 })
  })

  it('非擁有者 → PERMISSION_DENIED 403', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...OWNER_PROJECT, ownerVexaUserId: 99 })

    await expect(
      createInvitation('proj-1', 1, 'x@example.com', PERMS),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 })
  })
})

// ── acceptInvitationByToken ───────────────────────────────────────────

describe('acceptInvitationByToken', () => {
  const pendingInvitation = {
    id: 'inv-1',
    projectId: 'proj-1',
    email: 'invitee@example.com',
    canView: true,
    canEdit: false,
    canMeeting: false,
    status: 'PENDING',
    invitedByVexaUserId: 1,
    expiresAt: new Date(Date.now() + 86400000),
  }

  it('成功接受：建立 ProjectMember 並標記 ACCEPTED', async () => {
    mockPrisma.projectInvitation.findUnique.mockResolvedValueOnce(pendingInvitation)
    mockPrisma.projectMember.findUnique.mockResolvedValueOnce(null) // 尚非成員
    mockPrisma.$transaction.mockResolvedValueOnce([])

    const result = await acceptInvitationByToken('rawtoken', 5, 'Invitee@example.com')

    expect(result).toMatchObject({ projectId: 'proj-1', alreadyAccepted: false })
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce()
  })

  it('接受者 email 與邀請不符 → EMAIL_MISMATCH 403', async () => {
    mockPrisma.projectInvitation.findUnique.mockResolvedValueOnce(pendingInvitation)

    await expect(
      acceptInvitationByToken('rawtoken', 5, 'someone-else@example.com'),
    ).rejects.toMatchObject({ code: 'EMAIL_MISMATCH', statusCode: 403 })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('邀請已過期 → INVITATION_EXPIRED 410 並標記 EXPIRED', async () => {
    mockPrisma.projectInvitation.findUnique.mockResolvedValueOnce({
      ...pendingInvitation,
      expiresAt: new Date(Date.now() - 1000),
    })

    await expect(
      acceptInvitationByToken('rawtoken', 5, 'invitee@example.com'),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED', statusCode: 410 })
    expect(mockPrisma.projectInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    )
  })

  it('邀請已被撤銷 → INVITATION_NOT_PENDING 409', async () => {
    mockPrisma.projectInvitation.findUnique.mockResolvedValueOnce({
      ...pendingInvitation,
      status: 'REVOKED',
    })

    await expect(
      acceptInvitationByToken('rawtoken', 5, 'invitee@example.com'),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_PENDING', statusCode: 409 })
  })

  it('token 無效 → INVALID_INVITATION 404', async () => {
    mockPrisma.projectInvitation.findUnique.mockResolvedValueOnce(null)

    await expect(
      acceptInvitationByToken('badtoken', 5, 'x@example.com'),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION', statusCode: 404 })
  })
})

// ── revokeInvitation ──────────────────────────────────────────────────

describe('revokeInvitation', () => {
  it('將 PENDING 邀請標記為 REVOKED', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(OWNER_PROJECT) // requireOwner
    mockPrisma.projectInvitation.findFirst.mockResolvedValueOnce({
      id: 'inv-1',
      projectId: 'proj-1',
      status: 'PENDING',
    })

    await revokeInvitation('proj-1', 1, 'inv-1')

    expect(mockPrisma.projectInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REVOKED' } }),
    )
  })
})
