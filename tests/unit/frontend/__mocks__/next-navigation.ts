import { vi } from 'vitest'

export const usePathname = vi.fn(() => '/')
export const useRouter = vi.fn(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
}))
export const redirect = vi.fn()
