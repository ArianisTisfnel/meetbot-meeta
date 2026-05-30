import { vi } from 'vitest'

export const mockPrisma = {
  $queryRaw: vi.fn(),
  project: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  projectMember: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  material: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  meetingInstance: {
    count: vi.fn(),
  },
}
