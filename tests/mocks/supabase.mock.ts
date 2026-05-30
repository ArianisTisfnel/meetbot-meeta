import { vi } from 'vitest'

export const mockSupabase = {
  uploadFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}
