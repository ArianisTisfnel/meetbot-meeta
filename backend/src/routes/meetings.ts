import { Hono } from 'hono'
import { z } from 'zod'
import * as meetingService from '../services/meeting.service.js'
import * as transcriptionService from '../services/transcription.service.js'
import { AppError } from '../middleware/error-handler.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

const createMeetingSchema = z.object({
  googleMeetUrl: z.string().min(1),
  name: z.string().min(1).optional(),
  projectId: z.string().uuid().optional().nullable(),
})

const updateMeetingSchema = z.object({ name: z.string().min(1) })

// ── 全局 meeting 端點 ──────────────────────────────────────────────────────

// POST /meetings — 全局建立（projectId 選填）
app.post('/meetings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { googleMeetUrl, name, projectId } = createMeetingSchema.parse(body)
  const result = await meetingService.createMeeting({
    vexaUserId: c.get('vexaUserId'),
    vexaApiTokenId: c.get('vexaApiTokenId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
    vexaToken: c.get('vexaToken'),
    vexaTokenScopes: c.get('vexaTokenScopes'),
    googleMeetUrl,
    name,
    projectId,
  })
  return c.json(result, 201)
})

// GET /meetings — 全局列表
app.get('/meetings', async (c) => {
  const q = c.req.query()
  const result = await meetingService.listMeetings(c.get('vexaUserId'), {
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 20,
    search: q.search,
    since: q.since ? parseInt(q.since) : undefined,
    order: (q.order as 'asc' | 'desc') || 'desc',
    status: q.status,
  })
  return c.json(result)
})

// GET /meetings/:meetingId — 全局取單一
app.get('/meetings/:meetingId', async (c) => {
  const meeting = await meetingService.getMeeting(c.req.param('meetingId'), c.get('vexaUserId'))
  return c.json(meeting)
})

// PATCH /meetings/:meetingId — 全局改名（建立者本人）
app.patch('/meetings/:meetingId', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { name } = updateMeetingSchema.parse(body)
  const result = await meetingService.updateMeetingName(
    c.req.param('meetingId'),
    name,
    c.get('vexaUserId'),
  )
  return c.json(result)
})

// POST /meetings/:meetingId/bot/leave — 全局 Bot 離開
app.post('/meetings/:meetingId/bot/leave', async (c) => {
  const meetingId = c.req.param('meetingId')
  const meeting = await meetingService.getMeeting(meetingId, c.get('vexaUserId'))
  if (meeting.createdBy.vexaUserId !== c.get('vexaUserId')) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可讓 Bot 離開')
  }
  const result = await meetingService.leaveMeeting(meetingId)
  return c.json(result)
})

// POST /meetings/:meetingId/cancel — 取消等待中的會議（建立者本人）
app.post('/meetings/:meetingId/cancel', async (c) => {
  const meetingId = c.req.param('meetingId')
  const meeting = await meetingService.getMeeting(meetingId, c.get('vexaUserId'))
  if (meeting.createdBy.vexaUserId !== c.get('vexaUserId')) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可取消會議')
  }
  const result = await meetingService.cancelMeeting(meetingId)
  return c.json(result)
})

// POST /meetings/:meetingId/bot/reinvite — 全局重新邀請蜜塔
app.post('/meetings/:meetingId/bot/reinvite', async (c) => {
  const result = await meetingService.reinviteBot({
    meetingInstanceId: c.req.param('meetingId'),
    vexaUserId: c.get('vexaUserId'),
    vexaApiTokenId: c.get('vexaApiTokenId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
    vexaToken: c.get('vexaToken'),
    vexaTokenScopes: c.get('vexaTokenScopes'),
  })
  return c.json(result)
})

// GET /meetings/:meetingId/transcriptions — 全局逐字稿
app.get('/meetings/:meetingId/transcriptions', async (c) => {
  const meetingId = c.req.param('meetingId')
  const meeting = await meetingService.getMeeting(meetingId, c.get('vexaUserId'))
  if (meeting.createdBy.vexaUserId !== c.get('vexaUserId')) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可查看此會議的逐字稿')
  }
  if (!meeting.vexaMeetingId) {
    return c.json({ items: [], total: 0, page: 1, perPage: 50 })
  }

  // ENDED 會議的逐字稿需 creatorApiTokenId + vexaNativeMeetingId（getMeeting 未回傳，從 DB 補查）
  const { prisma } = await import('../lib/prisma.js')
  const raw = await prisma.meetingInstance.findUnique({
    where: { id: meetingId },
    select: { creatorApiTokenId: true, vexaNativeMeetingId: true },
  })

  const q = c.req.query()
  const result = await transcriptionService.getTranscriptions({
    meetingInstanceId: meetingId,
    creatorApiTokenId: raw?.creatorApiTokenId ?? 0,
    platform: 'google_meet',
    vexaNativeMeetingId: raw?.vexaNativeMeetingId ?? '',
    sinceStartTime: q.since_start_time ? parseFloat(q.since_start_time) : undefined,
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 50,
  })
  return c.json(result)
})

// ── 專案內 meeting 端點 ──────────────────────────────────────────────────────

// POST /projects/:projectId/meetings
app.post('/projects/:projectId/meetings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { googleMeetUrl, name } = z
    .object({ googleMeetUrl: z.string().min(1), name: z.string().min(1).optional() })
    .parse(body)
  const result = await meetingService.createMeeting({
    vexaUserId: c.get('vexaUserId'),
    vexaApiTokenId: c.get('vexaApiTokenId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
    vexaToken: c.get('vexaToken'),
    vexaTokenScopes: c.get('vexaTokenScopes'),
    googleMeetUrl,
    name,
    projectId: c.req.param('projectId'),
  })
  return c.json(result, 201)
})

// GET /projects/:projectId/meetings
app.get('/projects/:projectId/meetings', async (c) => {
  const q = c.req.query()
  const result = await meetingService.listProjectMeetings(
    c.req.param('projectId'),
    c.get('vexaUserId'),
    {
      page: q.page ? parseInt(q.page) : 1,
      perPage: q.per_page ? parseInt(q.per_page) : 20,
      search: q.search,
      since: q.since ? parseInt(q.since) : undefined,
      order: (q.order as 'asc' | 'desc') || 'desc',
      status: q.status,
    },
  )
  return c.json(result)
})

// GET /projects/:projectId/meetings/:meetingId
app.get('/projects/:projectId/meetings/:meetingId', async (c) => {
  const meeting = await meetingService.getProjectMeeting(
    c.req.param('projectId'),
    c.req.param('meetingId'),
    c.get('vexaUserId'),
  )
  return c.json(meeting)
})

// PATCH /projects/:projectId/meetings/:meetingId
app.patch('/projects/:projectId/meetings/:meetingId', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { name } = updateMeetingSchema.parse(body)
  const result = await meetingService.updateMeetingName(
    c.req.param('meetingId'),
    name,
    c.get('vexaUserId'),
    c.req.param('projectId'),
  )
  return c.json(result)
})

// POST /projects/:projectId/meetings/:meetingId/bot/leave
app.post('/projects/:projectId/meetings/:meetingId/bot/leave', async (c) => {
  // 權限在 getProjectMeeting 內部已驗證（requireCanView），
  // 但 bot/leave 需要 canMeeting，由 meeting.service.createMeeting 路徑的授權邏輯保證。
  // 這裡先取得 meeting 確認存在與歸屬，再呼叫 leaveMeeting。
  await meetingService.getProjectMeeting(
    c.req.param('projectId'),
    c.req.param('meetingId'),
    c.get('vexaUserId'),
  )
  const result = await meetingService.leaveMeeting(c.req.param('meetingId'))
  return c.json(result)
})

// POST /projects/:projectId/meetings/:meetingId/cancel
app.post('/projects/:projectId/meetings/:meetingId/cancel', async (c) => {
  await meetingService.getProjectMeeting(
    c.req.param('projectId'),
    c.req.param('meetingId'),
    c.get('vexaUserId'),
  )
  const result = await meetingService.cancelMeeting(c.req.param('meetingId'))
  return c.json(result)
})

// POST /projects/:projectId/meetings/:meetingId/bot/reinvite
app.post('/projects/:projectId/meetings/:meetingId/bot/reinvite', async (c) => {
  // 先確認會議歸屬此專案且使用者有存取權；canMeeting 由 reinviteBot 內部再驗證
  await meetingService.getProjectMeeting(
    c.req.param('projectId'),
    c.req.param('meetingId'),
    c.get('vexaUserId'),
  )
  const result = await meetingService.reinviteBot({
    meetingInstanceId: c.req.param('meetingId'),
    vexaUserId: c.get('vexaUserId'),
    vexaApiTokenId: c.get('vexaApiTokenId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
    vexaToken: c.get('vexaToken'),
    vexaTokenScopes: c.get('vexaTokenScopes'),
  })
  return c.json(result)
})

// GET /projects/:projectId/meetings/:meetingId/transcriptions
app.get('/projects/:projectId/meetings/:meetingId/transcriptions', async (c) => {
  const meetingId = c.req.param('meetingId')
  // 先驗證存取權限並取得 meeting 資料
  const meeting = await meetingService.getProjectMeeting(
    c.req.param('projectId'),
    meetingId,
    c.get('vexaUserId'),
  )

  if (!(meeting as any).vexaMeetingId) {
    return c.json({ items: [], total: 0, page: 1, perPage: 50 })
  }

  // 需要 creatorApiTokenId：從 DB 查詢
  const { prisma } = await import('../lib/prisma.js')
  const raw = await prisma.meetingInstance.findUnique({
    where: { id: meetingId },
    select: { creatorApiTokenId: true, vexaNativeMeetingId: true },
  })

  const q = c.req.query()
  const result = await transcriptionService.getTranscriptions({
    meetingInstanceId: meetingId,
    creatorApiTokenId: raw?.creatorApiTokenId ?? 0,
    platform: 'google_meet',
    vexaNativeMeetingId: raw?.vexaNativeMeetingId ?? '',
    sinceStartTime: q.since_start_time ? parseFloat(q.since_start_time) : undefined,
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 50,
  })
  return c.json(result)
})

export default app
