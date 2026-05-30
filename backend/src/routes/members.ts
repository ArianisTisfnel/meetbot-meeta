import { Hono } from 'hono'
import { z } from 'zod'
import * as memberService from '../services/member.service.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

app.get('/projects/:projectId/members', async (c) => {
  const result = await memberService.getMembers(c.req.param('projectId'), c.get('vexaUserId'))
  return c.json(result)
})

const inviteMemberSchema = z.object({
  email: z.string().email(),
  canView: z.boolean().default(true),
  canEdit: z.boolean().default(false),
  canMeeting: z.boolean().default(false),
})

app.post('/projects/:projectId/members', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { email, canView, canEdit, canMeeting } = inviteMemberSchema.parse(body)
  const member = await memberService.inviteMember(
    c.req.param('projectId'),
    c.get('vexaUserId'),
    email,
    { canView, canEdit, canMeeting },
  )
  return c.json(member, 201)
})

const updateMemberSchema = z.object({
  canView: z.boolean().optional(),
  canEdit: z.boolean().optional(),
  canMeeting: z.boolean().optional(),
})

app.patch('/projects/:projectId/members/:targetUserId', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const permissions = updateMemberSchema.parse(body)
  const result = await memberService.updateMemberPermissions(
    c.req.param('projectId'),
    c.get('vexaUserId'),
    parseInt(c.req.param('targetUserId')),
    permissions,
  )
  return c.json(result)
})

app.delete('/projects/:projectId/members/:targetUserId', async (c) => {
  await memberService.removeMember(
    c.req.param('projectId'),
    c.get('vexaUserId'),
    parseInt(c.req.param('targetUserId')),
  )
  return c.body(null, 204)
})

export default app
