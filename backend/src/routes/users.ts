import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

app.get('/users/lookup', async (c) => {
  const email = c.req.query('email')
  if (!email) throw new AppError('INVALID_REQUEST', 400, '必須提供 email 參數')

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, name: true },
  })

  if (!user) {
    throw new AppError(
      'USER_NOT_FOUND',
      404,
      '此 email 尚未在系統中建立帳號，請對方先登入後再試',
    )
  }

  return c.json({
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
  })
})

export default app
