import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockDify } from '../../../mocks/dify.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/dify', () => mockDify)

import { pollOnce } from '../../../../backend/src/jobs/indexing-poller'

const MOCK_PROJECT = { difyDatasetId: 'dataset-abc' }

const processingMaterial = {
  id: 'mat-1',
  difyBatch: 'batch-001',
  project: MOCK_PROJECT,
  indexingStatus: 'PROCESSING',
}

describe('indexing-poller: pollOnce', () => {
  beforeEach(() => vi.clearAllMocks())

  it('case 1: PROCESSING 的 material → 呼叫 getIndexingStatus 並更新 DB', async () => {
    mockPrisma.material.findMany.mockResolvedValueOnce([processingMaterial])
    mockDify.getIndexingStatus.mockResolvedValueOnce({ status: 'COMPLETED' })
    mockPrisma.material.update.mockResolvedValueOnce({})

    await pollOnce()

    expect(mockDify.getIndexingStatus).toHaveBeenCalledWith('dataset-abc', 'batch-001')
    expect(mockPrisma.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mat-1' },
        data: expect.objectContaining({ indexingStatus: 'COMPLETED' }),
      }),
    )
  })

  it('case 2: COMPLETED material → 查詢範圍不含已完成（findMany 回傳空陣列，不呼叫 Dify）', async () => {
    mockPrisma.material.findMany.mockResolvedValueOnce([])

    await pollOnce()

    expect(mockDify.getIndexingStatus).not.toHaveBeenCalled()
    expect(mockPrisma.material.update).not.toHaveBeenCalled()
  })

  it('case 3: difyBatch 為 null → skip，不呼叫 Dify', async () => {
    mockPrisma.material.findMany.mockResolvedValueOnce([
      { ...processingMaterial, difyBatch: null },
    ])

    await pollOnce()

    expect(mockDify.getIndexingStatus).not.toHaveBeenCalled()
    expect(mockPrisma.material.update).not.toHaveBeenCalled()
  })

  it('case 4: Dify 回傳 FAILED → 更新 indexingStatus 為 FAILED', async () => {
    mockPrisma.material.findMany.mockResolvedValueOnce([processingMaterial])
    mockDify.getIndexingStatus.mockResolvedValueOnce({
      status: 'FAILED',
      error: 'Chunking failed',
    })
    mockPrisma.material.update.mockResolvedValueOnce({})

    await pollOnce()

    expect(mockPrisma.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          indexingStatus: 'FAILED',
          indexingError: 'Chunking failed',
        }),
      }),
    )
  })
})
