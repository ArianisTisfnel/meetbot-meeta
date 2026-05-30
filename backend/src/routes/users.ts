import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../middleware/error-handler.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

app.get('/users/lookup', async (c) => {
  const email = c.req.query('email')
  if (!email) throw new AppError('INVALID_REQUEST', 400, '必須提供 email 參數')

  const rows = await prisma.$queryRaw<
    Array<{ id: number; email: string; name: string | null }>
  >`SELECT id, email, name FROM public.users WHERE email = ${email} LIMIT 1`

  if (!rows.length) {
    throw new AppError(
      'USER_NOT_FOUND_IN_VEXA',
      404,
      '此 email 尚未在系統中建立帳號，請對方先登入後再試',
    )
  }

  return c.json({
    vexaUserId: rows[0].id,
    email: rows[0].email,
    name: rows[0].name ?? null,
  })
})

export default app
