import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockEnv = vi.hoisted(() => ({ INTERNAL_AUTH_SECRET: 'test-secret-1234567890' as string | undefined }))
vi.mock('../../../../backend/src/types/env', () => ({ env: mockEnv }))

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn() },
  userToken: { findFirst: vi.fn(), create: vi.fn() },
}))
vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/middleware/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import internalRoutes from '../../../../backend/src/routes/internal'

const post = (body: unknown, secret?: string) =>
  internalRoutes.request('/internal/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-internal-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  })

describe('POST /internal/token — 登入鑄 token（免 Docker）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.INTERNAL_AUTH_SECRET = 'test-secret-1234567890'
  })

  it('未設定 INTERNAL_AUTH_SECRET → 503（端點停用）', async () => {
    mockEnv.INTERNAL_AUTH_SECRET = undefined
    const res = await post({ email: 'a@b.c' }, 'whatever')
    expect(res.status).toBe(503)
  })

  it('密鑰錯誤 → 401', async () => {
    const res = await post({ email: 'a@b.c' }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('缺 email → 400', async () => {
    const res = await post({}, 'test-secret-1234567890')
    expect(res.status).toBe(400)
  })

  it('既有使用者＋有效 token → 直接重用（不再增生新 token）', async () => {
    mockPrisma.user.upsert.mockResolvedValueOnce({ id: 7, email: 'kai@test.io', name: null })
    mockPrisma.userToken.findFirst.mockResolvedValueOnce({ token: 'existing-token' })

    const res = await post({ email: 'Kai@Test.io' }, 'test-secret-1234567890')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token: 'existing-token' })
    expect(mockPrisma.userToken.create).not.toHaveBeenCalled()
  })

  it('新使用者 → 建 user＋發新 token', async () => {
    mockPrisma.user.upsert.mockResolvedValueOnce({ id: 42, email: 'new@user.io', name: '小新' })
    mockPrisma.userToken.findFirst.mockResolvedValueOnce(null)
    mockPrisma.userToken.create.mockResolvedValueOnce({})

    const res = await post({ email: 'new@user.io', name: '小新' }, 'test-secret-1234567890')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBe(64) // randomBytes(32).hex
    expect(mockPrisma.userToken.create).toHaveBeenCalledOnce()
  })
})
