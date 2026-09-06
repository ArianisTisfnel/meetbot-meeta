import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { env } from '../types/env.js'
import { prisma } from '../lib/prisma.js'
import * as calendarSync from '../services/calendar-sync.service.js'
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

/**
 * 內部端點：前端登入拿到 Google refresh token 後交給後端保存。
 *
 * 為什麼要存在後端：疊圖同步與（日後的）會前提醒都是背景工作，使用者不在線上時
 * 也要能呼叫 Google API，而 NextAuth 的 token 只在瀏覽器有 session 時拿得到。
 *
 * Google 只在使用者「重新同意授權」時才發 refresh token，所以這個端點可能收到
 * 沒有 token 的請求——那不是錯誤，維持既有連結即可（見 upsertConnection）。
 */
app.post('/internal/calendar-connection', async (c) => {
  if (!env.INTERNAL_AUTH_SECRET) {
    return c.json({ error_code: 'DISABLED', message: 'INTERNAL_AUTH_SECRET 未設定' }, 503)
  }
  if (c.req.header('x-internal-secret') !== env.INTERNAL_AUTH_SECRET) {
    return c.json({ error_code: 'UNAUTHORIZED', message: 'invalid secret' }, 401)
  }

  const body = (await c.req.json().catch(() => null)) as
    | { email?: string; refreshToken?: string | null }
    | null
  const email = body?.email?.trim().toLowerCase()
  if (!email) {
    return c.json({ error_code: 'INVALID_REQUEST', message: 'email required' }, 400)
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    return c.json({ error_code: 'NOT_FOUND', message: 'user not found' }, 404)
  }

  const result = await calendarSync.upsertConnection({
    userId: user.id,
    refreshToken: body?.refreshToken ?? null,
  })

  // 剛連上就先抓一次忙碌時段，使用者回到行事曆立刻看得到東西，
  // 不必等下一輪背景排程（最久 15 分鐘）。失敗不影響登入。
  if (result.connected && body?.refreshToken) {
    calendarSync
      .syncUserBusyBlocks(user.id)
      .catch((err) => logger.warn({ err, userId: user.id }, 'internal: 初次同步失敗'))
  }

  return c.json(result)
})

export default app
