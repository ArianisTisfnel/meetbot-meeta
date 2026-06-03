import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({
  prisma: mockPrisma,
}))

import {
  updateMemberPermissions,
  removeMember,
} from '../../../../backend/src/services/member.service'

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  ownerVexaUserId: 1,
  difyDatasetId: 'dataset-abc123',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
}

// 註：邀請流程已改為「pending 邀請」模型，inviteMember 已移除，
// 相關測試見 invitation.service.test.ts。

// ── updateMemberPermissions ───────────────────────────────────────────

describe('updateMemberPermissions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws 403 PERMISSION_DENIED when caller is not the project owner', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({
      ...MOCK_PROJECT,
      ownerVexaUserId: 99, // different owner
    })

    await expect(updateMemberPermissions('proj-1', 1, 2, { canView: true })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    })
  })

  it('強制矯正 canView=false 回 true（檢視為基準權限，不可取消）', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(MOCK_PROJECT) // requireOwner
    mockPrisma.projectMember.findUnique.mockResolvedValueOnce({ id: 'mem-1', vexaUserId: 2 })
    mockPrisma.projectMember.update.mockResolvedValueOnce({
      id: 'mem-1',
      vexaUserId: 2,
      canView: true,
      canEdit: false,
      canMeeting: false,
      updatedAt: new Date(),
    })
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ email: 'm@x.com' }])

    await updateMemberPermissions('proj-1', 1, 2, { canView: false })

    expect(mockPrisma.projectMember.update.mock.calls[0][0].data.canView).toBe(true)
  })
})

// ── removeMember ──────────────────────────────────────────────────────

describe('removeMember', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws 403 PERMISSION_DENIED when trying to remove the project owner', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(MOCK_PROJECT) // ownerVexaUserId = 1

    await expect(
      removeMember('proj-1', 1, 1), // targetVexaUserId === ownerVexaUserId
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 })
  })
})
