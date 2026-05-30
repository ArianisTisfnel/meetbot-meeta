import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockDify } from '../../../mocks/dify.mock'
import { mockSupabase } from '../../../mocks/supabase.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/dify', () => mockDify)
vi.mock('../../../../backend/src/lib/supabase', () => mockSupabase)

// crypto.randomUUID() 需要 stable 值方便斷言 storagePath
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    default: {
      ...actual,
      randomUUID: vi.fn().mockReturnValue('test-uuid'),
    },
  }
})

import {
  uploadMaterial,
  deleteMaterial,
} from '../../../../backend/src/services/material.service'

// ── shared fixtures ────────────────────────────────────────────────────────

const PDF_BUFFER = Buffer.from('%PDF-1.4 fake pdf content')
const PDF_FILE = { buffer: PDF_BUFFER, filename: 'test.pdf', mimeType: 'application/pdf' }

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Test',
  ownerVexaUserId: 1,
  difyDatasetId: 'dataset-abc',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  members: [],
}

const MOCK_MATERIAL = {
  id: 'mat-1',
  projectId: 'proj-1',
  filename: 'test.pdf',
  displayName: 'test.pdf',
  sizeBytes: BigInt(PDF_BUFFER.length),
  mimeType: 'application/pdf',
  sha256: 'deadbeef',
  storagePath: 'proj-1/test-uuid/test.pdf',
  difyDocumentId: 'doc-123',
  difyBatch: 'batch-abc',
  indexingStatus: 'PENDING' as const,
  indexingError: null,
  uploadedByVexaUserId: 1,
  uploadedAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  project: { difyDatasetId: 'dataset-abc' },
}

// ── uploadMaterial ─────────────────────────────────────────────────────────

describe('uploadMaterial', () => {
  beforeEach(() => vi.clearAllMocks())

  it('case 1: 上傳成功 → Material 與 EditHistory 均建立，storagePath 正確', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findFirst.mockResolvedValueOnce(null)
    mockSupabase.uploadFile.mockResolvedValueOnce(undefined)
    mockDify.uploadDocument.mockResolvedValueOnce({ documentId: 'doc-123', batch: 'batch-abc' })
    mockPrisma.material.create.mockResolvedValueOnce(MOCK_MATERIAL)
    mockPrisma.materialEditHistory.create.mockResolvedValueOnce({})
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 1, name: 'Alice' }])

    const result = await uploadMaterial('proj-1', 1, PDF_FILE)

    expect(result.filename).toBe('test.pdf')
    expect(result.indexingStatus).toBe('PENDING')
    expect(mockSupabase.uploadFile).toHaveBeenCalledWith(
      'proj-1/test-uuid/test.pdf',
      PDF_BUFFER,
      'application/pdf',
    )
    expect(mockPrisma.material.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'proj-1',
          storagePath: 'proj-1/test-uuid/test.pdf',
          difyDocumentId: 'doc-123',
          difyBatch: 'batch-abc',
        }),
      }),
    )
    expect(mockPrisma.materialEditHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'UPLOAD' }) }),
    )
  })

  it('case 2: MIME type 不支援 → 415，不呼叫 Storage', async () => {
    await expect(
      uploadMaterial('proj-1', 1, { ...PDF_FILE, mimeType: 'image/png', filename: 'img.png' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', statusCode: 415 })

    expect(mockSupabase.uploadFile).not.toHaveBeenCalled()
  })

  it('case 3: 超過 15MB → 413', async () => {
    const bigBuffer = Buffer.alloc(15 * 1024 * 1024 + 1)
    await expect(
      uploadMaterial('proj-1', 1, { buffer: bigBuffer, filename: 'big.pdf', mimeType: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 413 })

    expect(mockSupabase.uploadFile).not.toHaveBeenCalled()
  })

  it('case 4: SHA-256 重複（未刪除）→ 409 DUPLICATE_FILE', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findFirst.mockResolvedValueOnce({ ...MOCK_MATERIAL, deletedAt: null })

    await expect(uploadMaterial('proj-1', 1, PDF_FILE)).rejects.toMatchObject({
      code: 'DUPLICATE_FILE',
      statusCode: 409,
    })
    expect(mockSupabase.uploadFile).not.toHaveBeenCalled()
  })

  it('case 5: SHA-256 重複（已刪除）→ 舊紀錄 sha256 改為 DELETED_{id}，建立新紀錄', async () => {
    const deletedMaterial = { ...MOCK_MATERIAL, id: 'mat-old', deletedAt: new Date() }
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findFirst.mockResolvedValueOnce(deletedMaterial)
    mockPrisma.material.update.mockResolvedValueOnce({}) // free unique slot
    mockSupabase.uploadFile.mockResolvedValueOnce(undefined)
    mockDify.uploadDocument.mockResolvedValueOnce({ documentId: 'doc-new', batch: 'batch-new' })
    mockPrisma.material.create.mockResolvedValueOnce(MOCK_MATERIAL)
    mockPrisma.materialEditHistory.create.mockResolvedValueOnce({})
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 1, name: 'Alice' }])

    await uploadMaterial('proj-1', 1, PDF_FILE)

    expect(mockPrisma.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mat-old' },
        data: { sha256: 'DELETED_mat-old' },
      }),
    )
    expect(mockPrisma.material.create).toHaveBeenCalled()
  })

  it('case 6: Prisma P2002（TOCTOU 競態）→ 409 DUPLICATE_FILE，不拋 500', async () => {
    const p2002 = Object.assign(new Error('Unique constraint'), { code: 'P2002' })
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findFirst.mockResolvedValueOnce(null)
    mockSupabase.uploadFile.mockResolvedValueOnce(undefined)
    mockDify.uploadDocument.mockResolvedValueOnce({ documentId: 'doc-x', batch: 'batch-x' })
    mockPrisma.material.create.mockRejectedValueOnce(p2002)
    // rollback mocks
    mockSupabase.deleteFile.mockResolvedValueOnce(undefined)
    mockPrisma.project.findUnique.mockResolvedValueOnce(MOCK_PROJECT)
    mockDify.deleteDocument.mockResolvedValueOnce(undefined)

    await expect(uploadMaterial('proj-1', 1, PDF_FILE)).rejects.toMatchObject({
      code: 'DUPLICATE_FILE',
      statusCode: 409,
    })
  })

  it('case 7: Dify 上傳失敗（步驟④）→ 呼叫 deleteFile 回滾', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findFirst.mockResolvedValueOnce(null)
    mockSupabase.uploadFile.mockResolvedValueOnce(undefined)
    mockDify.uploadDocument.mockRejectedValueOnce(new Error('Dify down'))
    mockSupabase.deleteFile.mockResolvedValueOnce(undefined)

    await expect(uploadMaterial('proj-1', 1, PDF_FILE)).rejects.toThrow('Dify down')
    expect(mockSupabase.deleteFile).toHaveBeenCalledWith('proj-1/test-uuid/test.pdf')
    expect(mockPrisma.material.create).not.toHaveBeenCalled()
  })

  it('case 8: Prisma create 失敗（步驟⑤）→ 刪除 Storage + Dify（雙回滾）', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findFirst.mockResolvedValueOnce(null)
    mockSupabase.uploadFile.mockResolvedValueOnce(undefined)
    mockDify.uploadDocument.mockResolvedValueOnce({ documentId: 'doc-x', batch: 'batch-x' })
    mockPrisma.material.create.mockRejectedValueOnce(new Error('DB error'))
    // rollback
    mockSupabase.deleteFile.mockResolvedValueOnce(undefined)
    mockPrisma.project.findUnique.mockResolvedValueOnce(MOCK_PROJECT)
    mockDify.deleteDocument.mockResolvedValueOnce(undefined)

    await expect(uploadMaterial('proj-1', 1, PDF_FILE)).rejects.toThrow('DB error')
    expect(mockSupabase.deleteFile).toHaveBeenCalledWith('proj-1/test-uuid/test.pdf')
    expect(mockDify.deleteDocument).toHaveBeenCalledWith('dataset-abc', 'doc-x')
  })
})

// ── deleteMaterial ─────────────────────────────────────────────────────────

describe('deleteMaterial', () => {
  beforeEach(() => vi.clearAllMocks())

  it('case 9: 刪除成功 → Dify、Storage、Prisma update 均呼叫', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findUnique.mockResolvedValueOnce(MOCK_MATERIAL)
    mockDify.deleteDocument.mockResolvedValueOnce(undefined)
    mockSupabase.deleteFile.mockResolvedValueOnce(undefined)
    mockPrisma.material.update.mockResolvedValueOnce({})
    mockPrisma.materialEditHistory.create.mockResolvedValueOnce({})

    await deleteMaterial('proj-1', 'mat-1', 1)

    expect(mockDify.deleteDocument).toHaveBeenCalledWith('dataset-abc', 'doc-123')
    expect(mockSupabase.deleteFile).toHaveBeenCalledWith('proj-1/test-uuid/test.pdf')
    expect(mockPrisma.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mat-1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )
  })

  it('case 10: Dify 刪除失敗 → 不拋錯（繼續執行 Storage 與 DB）', async () => {
    mockPrisma.project.findUnique.mockResolvedValueOnce({ ...MOCK_PROJECT })
    mockPrisma.material.findUnique.mockResolvedValueOnce(MOCK_MATERIAL)
    mockDify.deleteDocument.mockRejectedValueOnce(new Error('Dify timeout'))
    mockSupabase.deleteFile.mockResolvedValueOnce(undefined)
    mockPrisma.material.update.mockResolvedValueOnce({})
    mockPrisma.materialEditHistory.create.mockResolvedValueOnce({})

    await expect(deleteMaterial('proj-1', 'mat-1', 1)).resolves.not.toThrow()
    expect(mockSupabase.deleteFile).toHaveBeenCalled()
    expect(mockPrisma.material.update).toHaveBeenCalled()
  })
})
