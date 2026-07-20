import { vi } from 'vitest'

// getServerSession 的可控 mock：各測試用 mockResolvedValue 設定 session
export const getServerSession = vi.fn()
