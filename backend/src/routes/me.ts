import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import * as invitationService from '../services/invitation.service.js'
import { AppError } from '../middleware/error-handler.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

app.get('/me', async (c) => {
  const vexaUserId = c.get('vexaUserId')
  const activeBotCount = await prisma.meetingInstance.count({
    where: { createdByVexaUserId: vexaUserId, status: 'ACTIVE' },
  })
  return c.json({
    vexaUserId,
    email: c.get('userEmail'),
    name: c.get('userName'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
    activeBotCount,
  })
})

// ── 站內信箱：我的待處理邀請 ──────────────────────────────────────────

function requireEmail(c: Context<AppEnv>): string {
  const email = c.get('userEmail')
  if (!email) throw new AppError('UNAUTHORIZED', 401, '無法取得登入者 email')
  return email
}

// 我（以登入 email 為準）的待處理邀請。
app.get('/me/invitations', async (c) => {
  const items = await invitationService.listMyInvitations(requireEmail(c))
  return c.json({ items })
})

// 透過邀請 id 接受（信箱路徑）。
app.post('/me/invitations/:invitationId/accept', async (c) => {
  const result = await invitationService.acceptInvitationById(
    c.req.param('invitationId'),
    c.get('vexaUserId'),
    requireEmail(c),
  )
  return c.json(result)
})

// 透過邀請 id 拒絕。
app.post('/me/invitations/:invitationId/decline', async (c) => {
  await invitationService.declineInvitationById(c.req.param('invitationId'), requireEmail(c))
  return c.body(null, 204)
})

// 透過 token 接受（email 邀請連結落地頁）。
const acceptByTokenSchema = z.object({ token: z.string().min(1) })
app.post('/me/invitations/accept-by-token', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { token } = acceptByTokenSchema.parse(body)
  const result = await invitationService.acceptInvitationByToken(
    token,
    c.get('vexaUserId'),
    requireEmail(c),
  )
  return c.json(result)
})

export default app
