import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { env } from '../types/env.js'
import { prisma } from '../lib/prisma.js'
import { logger } from '../middleware/logger.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

/**
 * 內部端點：前端 NextAuth 登入時鑄造/取回 vexaToken。
 *
 * 背景：身分層仍使用 Vexa 的 public.users / public.api_tokens 表，原流程靠
 * docker exec 進 vexa-lite 容器打 admin API 寫這些表——容器不在（或 Vexa 雲端
 * 轉錄餘額歸零、容器開不起來）時登入拿不到 token，全站 401。
 * 此端點改為直接對 DB 做 get-or-create，登入不再依賴容器。
 *
 * 認證：x-internal-secret 共享密鑰（INTERNAL_AUTH_SECRET，前後端 env 各設同值）。
 * 未設定密鑰＝端點停用（503），前端自動退回 docker exec 舊路——組員未更新 env 也不受影響。
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

  // get-or-create user（public schema 一律 $queryRaw，禁 FK/model，見 CLAUDE.md）
  const users = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM public.users WHERE email = ${email} LIMIT 1
  `
  let userId = users[0]?.id
  if (!userId) {
    const inserted = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO public.users (email, name) VALUES (${email}, ${body?.name ?? null})
      RETURNING id
    `
    userId = inserted[0].id
    logger.info({ email, userId }, 'internal-token: created user')
  }

  // 重用未過期 token（舊 admin 流程每次登入都新發一顆；這裡順手治好 token 增生）
  const existing = await prisma.$queryRaw<Array<{ token: string }>>`
    SELECT token FROM public.api_tokens
    WHERE user_id = ${userId} AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC LIMIT 1
  `
  if (existing.length) {
    return c.json({ token: existing[0].token })
  }

  const token = randomBytes(32).toString('hex')
  await prisma.$queryRaw`
    INSERT INTO public.api_tokens (token, user_id, scopes, name)
    VALUES (${token}, ${userId}, ARRAY['bot','browser','tx']::text[], 'meetbot-login')
  `
  logger.info({ email, userId }, 'internal-token: minted token')
  return c.json({ token })
})

export default app
