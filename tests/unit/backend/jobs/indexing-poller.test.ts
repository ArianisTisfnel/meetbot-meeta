import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockDify } from '../../../mocks/dify.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/dify', () => mockDify)

const mockCompleteText = vi.hoisted(() => vi.fn())
vi.mock('../../../../backend/src/lib/llm', () => ({ completeText: mockCompleteText }))

import { pollOnce, generateMissingCards } from '../../../../backend/src/jobs/indexing-poller'

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

describe('indexing-poller: generateMissingCards — 內容摘要卡', () => {
  beforeEach(() => vi.clearAllMocks())

  const cardlessMaterial = {
    id: 'mat-1',
    displayName: '2025銷售報表',
    difyDocumentId: 'doc-1',
    contentCard: null,
    project: MOCK_PROJECT,
  }

  it('COMPLETED 且無卡 → 抓 segments、LLM 產卡、存回 contentCard', async () => {
    mockPrisma.material.findMany.mockResolvedValueOnce([cardlessMaterial])
    mockDify.getDocumentSegments.mockResolvedValueOnce(['Q1 銷售 100 萬', 'Q2 銷售 200 萬'])
    mockCompleteText.mockResolvedValueOnce('本文件包含各季銷售數據與年度目標。')
    mockPrisma.material.update.mockResolvedValueOnce({})

    await generateMissingCards()

    expect(mockDify.getDocumentSegments).toHaveBeenCalledWith('dataset-abc', 'doc-1', 5)
    expect(mockPrisma.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mat-1' },
        data: { contentCard: '本文件包含各季銷售數據與年度目標。' },
      }),
    )
  })

  it('segments 為空（抽不出文字）→ 存 \'\' sentinel，不呼叫 LLM、不再重試', async () => {
    mockPrisma.material.findMany.mockResolvedValueOnce([cardlessMaterial])
    mockDify.getDocumentSegments.mockResolvedValueOnce([])
    mockPrisma.material.update.mockResolvedValueOnce({})

    await generateMissingCards()

    expect(mockCompleteText).not.toHaveBeenCalled()
    expect(mockPrisma.material.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { contentCard: '' } }),
    )
  })

  it('LLM 失敗 → 不更新（保持 null 下輪重試）、不 throw', async () => {
    mockPrisma.material.findMany.mockResolvedValueOnce([cardlessMaterial])
    mockDify.getDocumentSegments.mockResolvedValueOnce(['內容'])
    mockCompleteText.mockRejectedValueOnce(new Error('LLM down'))

    await expect(generateMissingCards()).resolves.toBeUndefined()

    expect(mockPrisma.material.update).not.toHaveBeenCalled()
  })
})
