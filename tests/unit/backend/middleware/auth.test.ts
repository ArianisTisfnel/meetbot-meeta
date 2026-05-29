import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({
  prisma: mockPrisma,
}))

import { Hono } from 'hono'
import { authMiddleware, requireBotScopes } from '../../../../backend/src/middleware/auth'

// ── helpers ──────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.get('/test', (c) =>
    c.json({
      vexaUserId: c.get('vexaUserId' as never),
      vexaToken: c.get('vexaToken' as never),
      vexaTokenScopes: c.get('vexaTokenScopes' as never),
    }),
  )
  return app
}

const VALID_TOKEN_ROW = [{ user_id: 1, id: 42, scopes: ['bot', 'browser', 'tx'] }]
const VALID_USER_ROW = [{ id: 1, email: 'test@example.com', name: 'Test User', max_concurrent_bots: 1 }]

// ── authMiddleware ────────────────────────────────────────────────────

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
    mockPrisma.$queryRaw.mockResolvedValueOnce([])
    const app = createApp()
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error_code).toBe('UNAUTHORIZED')
  })

  it('returns 401 when token is expired (query returns empty due to expires_at filter)', async () => {
    // The SQL query already filters: expires_at IS NULL OR expires_at > NOW()
    // An expired token yields an empty result set — same as non-existent token
    mockPrisma.$queryRaw.mockResolvedValueOnce([])
    const app = createApp()
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer expired-token' },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error_code).toBe('UNAUTHORIZED')
  })

  it('injects vexaUserId, vexaToken, vexaTokenScopes on valid token', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(VALID_TOKEN_ROW)
      .mockResolvedValueOnce(VALID_USER_ROW)

    const app = createApp()
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.vexaUserId).toBe(1)
    expect(body.vexaToken).toBe('valid-token')
    expect(body.vexaTokenScopes).toEqual(['bot', 'browser', 'tx'])
  })
})

// ── requireBotScopes ─────────────────────────────────────────────────

describe('requireBotScopes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when all required scopes are present', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(VALID_TOKEN_ROW)
      .mockResolvedValueOnce(VALID_USER_ROW)

    let result: Response | null = null
    const app = new Hono()
    app.use('*', authMiddleware)
    app.get('/test', (c) => {
      result = requireBotScopes(c as never)
      return result ?? c.json({ ok: true })
    })

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    expect(result).toBeNull()
  })

  it('returns 403 INSUFFICIENT_SCOPE with missing scopes when tx is absent', async () => {
    const tokenRowNoTx = [{ user_id: 1, id: 42, scopes: ['bot', 'browser'] }]
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(tokenRowNoTx)
      .mockResolvedValueOnce(VALID_USER_ROW)

    const app = new Hono()
    app.use('*', authMiddleware)
    app.get('/test', (c) => {
      const err = requireBotScopes(c as never)
      return err ?? c.json({ ok: true })
    })

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer partial-scope-token' },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error_code).toBe('INSUFFICIENT_SCOPE')
    expect(body.details.missing).toContain('tx')
  })
})
