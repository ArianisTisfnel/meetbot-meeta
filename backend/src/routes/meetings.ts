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
    userId: c.get('userId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
    googleMeetUrl,
    name,
    projectId,
  })
  return c.json(result, 201)
})

// GET /meetings — 全局列表
app.get('/meetings', async (c) => {
  const q = c.req.query()
  const result = await meetingService.listMeetings(c.get('userId'), {
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
  const meeting = await meetingService.getMeeting(c.req.param('meetingId'), c.get('userId'))
  return c.json(meeting)
})

// PATCH /meetings/:meetingId — 全局改名（建立者本人）
app.patch('/meetings/:meetingId', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { name } = updateMeetingSchema.parse(body)
  const result = await meetingService.updateMeetingName(
    c.req.param('meetingId'),
    name,
    c.get('userId'),
  )
  return c.json(result)
})

// POST /meetings/:meetingId/bot/leave — 全局 Bot 離開
app.post('/meetings/:meetingId/bot/leave', async (c) => {
  const meetingId = c.req.param('meetingId')
  const meeting = await meetingService.getMeeting(meetingId, c.get('userId'))
  if (meeting.createdBy.userId !== c.get('userId')) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可讓 Bot 離開')
  }
  const result = await meetingService.leaveMeeting(meetingId)
  return c.json(result)
})

// POST /meetings/:meetingId/cancel — 取消等待中的會議（建立者本人）
app.post('/meetings/:meetingId/cancel', async (c) => {
  const meetingId = c.req.param('meetingId')
  const meeting = await meetingService.getMeeting(meetingId, c.get('userId'))
  if (meeting.createdBy.userId !== c.get('userId')) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可取消會議')
  }
  const result = await meetingService.cancelMeeting(meetingId)
  return c.json(result)
})

// POST /meetings/:meetingId/bot/reinvite — 全局重新邀請蜜塔
app.post('/meetings/:meetingId/bot/reinvite', async (c) => {
  const result = await meetingService.reinviteBot({
    meetingInstanceId: c.req.param('meetingId'),
    userId: c.get('userId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
  })
  return c.json(result)
})

// GET /meetings/:meetingId/transcriptions — 全局逐字稿
app.get('/meetings/:meetingId/transcriptions', async (c) => {
  const meetingId = c.req.param('meetingId')
  const meeting = await meetingService.getMeeting(meetingId, c.get('userId'))
  if (meeting.createdBy.userId !== c.get('userId')) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可查看此會議的逐字稿')
  }

  const q = c.req.query()
  const result = await transcriptionService.getTranscriptions({
    meetingInstanceId: meetingId,
    sinceStartTime: q.since_start_time ? parseFloat(q.since_start_time) : undefined,
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 50,
  })
  return c.json(result)
})

// DELETE /meetings/:meetingId — 全局刪除會議記錄（建立者本人）
app.delete('/meetings/:meetingId', async (c) => {
  await meetingService.deleteMeeting(c.req.param('meetingId'), c.get('userId'))
  return c.body(null, 204)
})

// GET /meetings/:meetingId/transcript — 全局會後完整逐字稿（Markdown，讀 Storage）
app.get('/meetings/:meetingId/transcript', async (c) => {
  const meetingId = c.req.param('meetingId')
  const meeting = await meetingService.getMeeting(meetingId, c.get('userId'))
  if (meeting.createdBy.userId !== c.get('userId')) {
    throw new AppError('PERMISSION_DENIED', 403, '只有建立者可查看此會議的逐字稿')
  }
  const markdown = await meetingService.getMeetingTranscriptMarkdown(meetingId)
  return c.json({ markdown })
})

// ── 專案內 meeting 端點 ──────────────────────────────────────────────────────

// POST /projects/:projectId/meetings
app.post('/projects/:projectId/meetings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { googleMeetUrl, name } = z
    .object({ googleMeetUrl: z.string().min(1), name: z.string().min(1).optional() })
    .parse(body)
  const result = await meetingService.createMeeting({
    userId: c.get('userId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
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
    c.get('userId'),
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
    c.get('userId'),
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
    c.get('userId'),
    c.req.param('projectId'),
  )
  return c.json(result)
})

// POST /projects/:projectId/meetings/:meetingId/bot/leave
app.post('/projects/:projectId/meetings/:meetingId/bot/leave', async (c) => {
  // bot/leave 需要會議權（canMeeting）：在後端強制驗證，不可只靠前端隱藏按鈕。
  await meetingService.requireProjectMeetingManageAccess(
    c.req.param('projectId'),
    c.req.param('meetingId'),
    c.get('userId'),
  )
  const result = await meetingService.leaveMeeting(c.req.param('meetingId'))
  return c.json(result)
})

// POST /projects/:projectId/meetings/:meetingId/cancel
app.post('/projects/:projectId/meetings/:meetingId/cancel', async (c) => {
  // cancel 同樣需要會議權（canMeeting）。
  await meetingService.requireProjectMeetingManageAccess(
    c.req.param('projectId'),
    c.req.param('meetingId'),
    c.get('userId'),
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
    c.get('userId'),
  )
  const result = await meetingService.reinviteBot({
    meetingInstanceId: c.req.param('meetingId'),
    userId: c.get('userId'),
    maxConcurrentBots: c.get('maxConcurrentBots'),
  })
  return c.json(result)
})

// GET /projects/:projectId/meetings/:meetingId/transcriptions
app.get('/projects/:projectId/meetings/:meetingId/transcriptions', async (c) => {
  const meetingId = c.req.param('meetingId')
  await meetingService.getProjectMeeting(
    c.req.param('projectId'),
    meetingId,
    c.get('userId'),
  )

  const q = c.req.query()
  const result = await transcriptionService.getTranscriptions({
    meetingInstanceId: meetingId,
    sinceStartTime: q.since_start_time ? parseFloat(q.since_start_time) : undefined,
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 50,
  })
  return c.json(result)
})

// DELETE /projects/:projectId/meetings/:meetingId — 專案內刪除會議記錄（需擁有者）
app.delete('/projects/:projectId/meetings/:meetingId', async (c) => {
  await meetingService.deleteMeeting(
    c.req.param('meetingId'),
    c.get('userId'),
    c.req.param('projectId'),
  )
  return c.body(null, 204)
})

// GET /projects/:projectId/meetings/:meetingId/transcript — 專案內會後完整逐字稿
app.get('/projects/:projectId/meetings/:meetingId/transcript', async (c) => {
  const meetingId = c.req.param('meetingId')
  // 存取權限驗證（getProjectMeeting 內含 canView 檢查）
  await meetingService.getProjectMeeting(c.req.param('projectId'), meetingId, c.get('userId'))
  const markdown = await meetingService.getMeetingTranscriptMarkdown(meetingId)
  return c.json({ markdown })
})

export default app
