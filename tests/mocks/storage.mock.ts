import { vi } from 'vitest'

export const mockStorage = {
  uploadFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}
