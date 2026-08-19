import type { MiddlewareHandler } from 'hono'
import { prisma } from '../lib/prisma.js'
import type { AppEnv } from '../types/hono.js'

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // 外部 webhook（如 Recall realtime）不帶我們的 Bearer，改用各自的 ?token= 密鑰自行驗證。
  if (c.req.path.startsWith('/webhooks/') || c.req.path.startsWith('/internal/')) {
    // /internal/：前端伺服器端的信任呼叫（x-internal-secret 各自驗證）
    return next()
  }
  // Output Media agent 網頁：bot 的雲端瀏覽器直接開啟（無 Bearer）。
  // 頁面本身無機密；後續 WS 連線由簽名 token（/ws/agent?agent&token）把關。
  if (c.req.path === '/agent') {
    return next()
  }

  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return c.json({ error_code: 'UNAUTHORIZED', message: '缺少 Authorization header' }, 401)
  }

  const userToken = await prisma.userToken.findUnique({
    where: { token },
    include: { user: true },
  })

  if (!userToken || (userToken.expiresAt && userToken.expiresAt < new Date())) {
    return c.json({ error_code: 'UNAUTHORIZED', message: '無效的 token' }, 401)
  }

  c.set('userId', userToken.user.id)
  c.set('userEmail', userToken.user.email)
  c.set('userName', userToken.user.name)
  c.set('maxConcurrentBots', userToken.user.maxConcurrentBots)

  await next()
}
