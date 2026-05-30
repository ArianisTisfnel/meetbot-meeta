import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockDify } from '../../../mocks/dify.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({
  prisma: mockPrisma,
}))

vi.mock('../../../../backend/src/lib/dify', () => mockDify)

vi.mock('../../../../backend/src/lib/supabase', () => ({
  uploadFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}))

import {
  createProject,
  deleteProject,
  getProject,
} from '../../../../backend/src/services/project.service'

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  ownerVexaUserId: 1,
  difyDatasetId: 'dataset-abc123',
  createdAt: new Date('2026-05-30T00:00:00Z'),
  updatedAt: new Date('2026-05-30T00:00:00Z'),
  deletedAt: null,
}

// ── createProject ─────────────────────────────────────────────────────

describe('createProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns project with owner role on success', async () => {
    mockDify.createDataset.mockResolvedValueOnce('dataset-xyz')
    mockPrisma.project.create.mockResolvedValueOnce({
      ...MOCK_PROJECT,
      difyDatasetId: 'dataset-xyz',
    })

    const result = await createProject(1, 'Test Project')

    expect(result.role).toBe('owner')
    expect(result.permissions.canDelete).toBe(true)
    expect(mockDify.createDataset).toHaveBeenCalledWith('Test Project')
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ difyDatasetId: 'dataset-xyz', ownerVexaUserId: 1 }),
      }),
    )
  })

  it('throws and does not call prisma.create when Dify fails', async () => {
    mockDify.createDataset.mockRejectedValueOnce(new Error('Dify unavailable'))

    await expect(createProject(1, 'Test')).rejects.toThrow('Dify unavailable')
    expect(mockPrisma.project.create).not.toHaveBeenCalled()
  })

  it('calls deleteDataset rollback when prisma.create fails', async () => {
    mockDify.createDataset.mockResolvedValueOnce('dataset-to-rollback')
    mockPrisma.project.create.mockRejectedValueOnce(new Error('DB write failed'))
    mockDify.deleteDataset.mockResolvedValueOnce(undefined)

    await expect(createProject(1, 'Test')).rejects.toThrow('DB write failed')
    expect(mockDify.deleteDataset).toHaveBeenCalledWith('dataset-to-rollback')
  })
})

// ── deleteProject ─────────────────────────────────────────────────────

describe('deleteProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('soft deletes materials, deletes Dify dataset, then soft deletes project', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce(MOCK_PROJECT)
    // deleteProject now fetches materials first to clean up Storage/Dify
    mockPrisma.material.findMany.mockResolvedValueOnce([])
    mockPrisma.material.updateMany.mockResolvedValueOnce({ count: 2 })
    mockDify.deleteDataset.mockResolvedValueOnce(undefined)
    mockPrisma.project.update.mockResolvedValueOnce({
      ...MOCK_PROJECT,
      deletedAt: new Date(),
    })

    await deleteProject('proj-1', 1)

    expect(mockPrisma.material.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'proj-1', deletedAt: null }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )
    expect(mockDify.deleteDataset).toHaveBeenCalledWith('dataset-abc123')
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proj-1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )
  })
})

// ── getProject ────────────────────────────────────────────────────────

describe('getProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws 403 PERMISSION_DENIED when user is not a member', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({
      ...MOCK_PROJECT,
      ownerVexaUserId: 99,
      members: [],
      _count: { members: 0, materials: 0, meetingInstances: 0 },
    })

    await expect(getProject('proj-1', 1)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    })
  })

  it('throws 403 PERMISSION_DENIED when all member permissions are false', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({
      ...MOCK_PROJECT,
      ownerVexaUserId: 99,
      members: [
        {
          id: 'member-1',
          vexaUserId: 1,
          canView: false,
          canEdit: false,
          canMeeting: false,
        },
      ],
      _count: { members: 1, materials: 0, meetingInstances: 0 },
    })

    await expect(getProject('proj-1', 1)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    })
  })
})
