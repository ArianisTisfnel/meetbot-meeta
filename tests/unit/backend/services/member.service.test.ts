import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({
  prisma: mockPrisma,
}))

import {
  inviteMember,
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

// ── inviteMember ──────────────────────────────────────────────────────

describe('inviteMember', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws 422 USER_NOT_FOUND_IN_VEXA when email does not exist in Vexa', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(MOCK_PROJECT)
    mockPrisma.$queryRaw.mockResolvedValueOnce([]) // no user found

    await expect(
      inviteMember('proj-1', 1, 'unknown@example.com', {
        canView: true,
        canEdit: false,
        canMeeting: false,
      }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND_IN_VEXA', statusCode: 422 })
  })

  it('throws 409 ALREADY_MEMBER when prisma returns P2002 unique constraint error', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(MOCK_PROJECT)
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { id: 2, email: 'existing@example.com', name: 'Existing User' },
    ])
    const p2002 = Object.assign(new Error('Unique constraint violation'), { code: 'P2002' })
    mockPrisma.projectMember.create.mockRejectedValueOnce(p2002)

    await expect(
      inviteMember('proj-1', 1, 'existing@example.com', {
        canView: true,
        canEdit: false,
        canMeeting: false,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_MEMBER', statusCode: 409 })
  })
})

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
