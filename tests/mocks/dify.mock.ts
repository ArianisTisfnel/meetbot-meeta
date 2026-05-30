import { vi } from 'vitest'

export const mockDify = {
  createDataset: vi.fn().mockResolvedValue('dataset-abc123'),
  deleteDataset: vi.fn().mockResolvedValue(undefined),
}
