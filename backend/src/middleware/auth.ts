import type { Context, MiddlewareHandler } from 'hono'
import { prisma } from '../lib/prisma.js'
import type { AppEnv } from '../types/hono.js'

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return c.json({ error_code: 'UNAUTHORIZED', message: '缺少 Authorization header' }, 401)
  }

  const apiTokenRows = await prisma.$queryRaw<
    Array<{ user_id: number; id: number; scopes: string[] }>
  >`
    SELECT user_id, id, scopes FROM public.api_tokens
    WHERE token = ${token}
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `

  if (!apiTokenRows.length) {
    return c.json({ error_code: 'UNAUTHORIZED', message: '無效的 token' }, 401)
  }

  const userRows = await prisma.$queryRaw<
    Array<{ id: number; email: string; name: string | null; max_concurrent_bots: number }>
  >`
    SELECT id, email, name, max_concurrent_bots FROM public.users
    WHERE id = ${apiTokenRows[0].user_id}
    LIMIT 1
  `

  c.set('vexaApiTokenId', apiTokenRows[0].id)
  c.set('vexaTokenScopes', apiTokenRows[0].scopes)
  c.set('vexaUserId', userRows[0].id)
  c.set('userEmail', userRows[0].email)
  c.set('userName', userRows[0].name)
  c.set('maxConcurrentBots', userRows[0].max_concurrent_bots)
  c.set('vexaToken', token)

  await next()
}

const BOT_REQUIRED_SCOPES = ['bot', 'browser', 'tx'] as const

export function requireBotScopes(c: Context<AppEnv>): Response | null {
  const scopes: string[] = c.get('vexaTokenScopes') ?? []
  const missing = BOT_REQUIRED_SCOPES.filter((s) => !scopes.includes(s))
  if (missing.length === 0) return null
  return c.json(
    {
      error_code: 'INSUFFICIENT_SCOPE',
      message: `此 token 缺少邀請 Bot 所需的 scope（需要 bot、browser、tx）`,
      details: { required: BOT_REQUIRED_SCOPES, missing },
    },
    403,
  )
}
