import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({
  prisma: mockPrisma,
}))

import { Hono } from 'hono'
import { authMiddleware } from '../../../../backend/src/middleware/auth'

function createApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.get('/test', (c) =>
    c.json({
      userId: c.get('userId' as never),
      userEmail: c.get('userEmail' as never),
      userName: c.get('userName' as never),
    }),
  )
  return app
}

const VALID_TOKEN_WITH_USER = {
  id: 42,
  token: 'valid-token',
  userId: 1,
  expiresAt: null,
  user: { id: 1, email: 'test@example.com', name: 'Test User', maxConcurrentBots: 1 },
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const app = createApp()
    const res = await app.request('/test')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error_code).toBe('UNAUTHORIZED')
  })

  it('returns 401 when token does not exist in db', async () => {
    mockPrisma.userToken.findUnique.mockResolvedValueOnce(null)
    const app = createApp()
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error_code).toBe('UNAUTHORIZED')
  })

  it('returns 401 when token is expired', async () => {
    mockPrisma.userToken.findUnique.mockResolvedValueOnce({
      ...VALID_TOKEN_WITH_USER,
      expiresAt: new Date(Date.now() - 1000),
    })
    const app = createApp()
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer expired-token' },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error_code).toBe('UNAUTHORIZED')
  })

  it('injects userId, userEmail, userName on valid token', async () => {
    mockPrisma.userToken.findUnique.mockResolvedValueOnce(VALID_TOKEN_WITH_USER)

    const app = createApp()
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.userId).toBe(1)
    expect(body.userEmail).toBe('test@example.com')
    expect(body.userName).toBe('Test User')
  })
})
