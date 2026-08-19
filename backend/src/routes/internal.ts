import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { env } from '../types/env.js'
import { prisma } from '../lib/prisma.js'
import { logger } from '../middleware/logger.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

/**
 * 內部端點：前端 NextAuth 登入時鑄造/取回 authToken。
 * 認證：x-internal-secret 共享密鑰（INTERNAL_AUTH_SECRET，前後端 env 各設同值）。
 * 未設定密鑰＝端點停用（503）。
 */
app.post('/internal/token', async (c) => {
  if (!env.INTERNAL_AUTH_SECRET) {
    return c.json({ error_code: 'DISABLED', message: 'INTERNAL_AUTH_SECRET 未設定' }, 503)
  }
  if (c.req.header('x-internal-secret') !== env.INTERNAL_AUTH_SECRET) {
    return c.json({ error_code: 'UNAUTHORIZED', message: 'invalid secret' }, 401)
  }
  const body = (await c.req.json().catch(() => null)) as { email?: string; name?: string } | null
  const email = body?.email?.trim().toLowerCase()
  if (!email) {
    return c.json({ error_code: 'INVALID_REQUEST', message: 'email required' }, 400)
  }

  // get-or-create user in app schema
  const user = await prisma.user.upsert({
    where: { email },
    update: { name: body?.name ?? undefined },
    create: { email, name: body?.name ?? null },
  })

  // 重用未過期 token
  const existing = await prisma.userToken.findFirst({
    where: {
      userId: user.id,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    return c.json({ token: existing.token })
  }

  const token = randomBytes(32).toString('hex')
  await prisma.userToken.create({
    data: { token, userId: user.id },
  })
  logger.info({ email, userId: user.id }, 'internal-token: minted token')
  return c.json({ token })
})

export default app
