import { vi } from 'vitest'

export const mockDify = {
  createDataset: vi.fn().mockResolvedValue('dataset-abc123'),
  deleteDataset: vi.fn().mockResolvedValue(undefined),
  uploadDocument: vi.fn().mockResolvedValue({ documentId: 'doc-123', batch: 'batch-abc' }),
  getIndexingStatus: vi.fn().mockResolvedValue({ status: 'COMPLETED' }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
}
