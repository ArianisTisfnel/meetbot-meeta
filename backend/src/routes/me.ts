import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
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

export default app
