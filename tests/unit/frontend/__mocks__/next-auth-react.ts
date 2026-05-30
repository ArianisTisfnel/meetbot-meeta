import { vi } from 'vitest'

export const getSession = vi.fn(() =>
  Promise.resolve({ vexaToken: 'test-token' })
)

export const useSession = vi.fn(() => ({
  data: { vexaToken: 'test-token' },
  status: 'authenticated',
}))

export const signIn = vi.fn()
export const signOut = vi.fn()
export const SessionProvider = ({ children }: { children: React.ReactNode }) => children
