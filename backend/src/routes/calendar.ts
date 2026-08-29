import { Hono } from 'hono'
import { z } from 'zod'
import * as calendarService from '../services/calendar.service.js'
import { AppError } from '../middleware/error-handler.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

const isoDate = z.string().datetime({ offset: true })

/** 查詢區間；前端一律送 ISO 8601 絕對時間（含時區位移）。 */
function parseRange(c: { req: { query: () => Record<string, string> } }) {
  const q = c.req.query()
  if (!q.from || !q.to) {
    throw new AppError('INVALID_REQUEST', 400, '缺少 from／to 查詢參數')
  }
  return { from: new Date(q.from), to: new Date(q.to) }
}

const freeSlotSchema = z.object({
  memberUserIds: z.array(z.number().int()).min(1),
  durationMin: z.number().int().positive().max(24 * 60),
  from: isoDate,
  to: isoDate,
  /** 使用者時區相對 UTC 的偏移分鐘數（東八區 = 480） */
  tzOffsetMinutes: z.number().int().min(-840).max(840),
  workStartHour: z.number().int().min(0).max(23).default(9),
  workEndHour: z.number().int().min(1).max(24).default(18),
  includeWeekends: z.boolean().default(false),
})

const scheduleSchema = z.object({
  name: z.string().min(1),
  scheduledStartAt: isoDate,
  scheduledEndAt: isoDate,
  timezone: z.string().optional().nullable(),
  googleMeetUrl: z.string().optional().nullable(),
  attendeeUserIds: z.array(z.number().int()).default([]),
})

const updateScheduleSchema = z.object({
  name: z.string().min(1).optional(),
  scheduledStartAt: isoDate.optional(),
  scheduledEndAt: isoDate.optional(),
  attendeeUserIds: z.array(z.number().int()).optional(),
})

const rsvpSchema = z.object({
  rsvp: z.enum(['ACCEPTED', 'TENTATIVE', 'DECLINED', 'PENDING']),
})

// ── 全域層 ────────────────────────────────────────────────────────────────────

// GET /calendar?from&to — 我的跨專案行程總覽
app.get('/calendar', async (c) => {
  const range = parseRange(c)
  const result = await calendarService.getGlobalCalendar(c.get('userId'), range)
  return c.json(result)
})

// ── 專案層 ────────────────────────────────────────────────────────────────────

// GET /projects/:projectId/calendar?from&to — 專案會議 + 成員忙碌疊圖
app.get('/projects/:projectId/calendar', async (c) => {
  const range = parseRange(c)
  const result = await calendarService.getProjectCalendar(
    c.req.param('projectId'),
    c.get('userId'),
    range,
  )
  return c.json(result)
})

// POST /projects/:projectId/calendar/free-slots — 找共同空檔
//
// 用 POST 而不是 GET：參數是一組成員 id 加多個條件，塞進 query string 又長又難讀，
// 而且這個端點不該被瀏覽器或中間層快取（忙碌狀態隨時在變）。
app.post('/projects/:projectId/calendar/free-slots', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = freeSlotSchema.parse(body)
  const result = await calendarService.findProjectFreeSlots(
    c.req.param('projectId'),
    c.get('userId'),
    {
      ...parsed,
      from: new Date(parsed.from),
      to: new Date(parsed.to),
    },
  )
  return c.json(result)
})

// POST /projects/:projectId/calendar/meetings — 排定一場會議（SCHEDULED）
app.post('/projects/:projectId/calendar/meetings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = scheduleSchema.parse(body)
  const result = await calendarService.scheduleMeeting({
    projectId: c.req.param('projectId'),
    userId: c.get('userId'),
    name: parsed.name,
    scheduledStartAt: new Date(parsed.scheduledStartAt),
    scheduledEndAt: new Date(parsed.scheduledEndAt),
    timezone: parsed.timezone,
    googleMeetUrl: parsed.googleMeetUrl,
    attendeeUserIds: parsed.attendeeUserIds,
  })
  return c.json(result, 201)
})

// ── 單一會議的排程操作 ────────────────────────────────────────────────────────

// PATCH /calendar/meetings/:meetingId — 改時間／名稱／與會者
app.patch('/calendar/meetings/:meetingId', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = updateScheduleSchema.parse(body)
  const result = await calendarService.updateMeetingSchedule({
    meetingId: c.req.param('meetingId'),
    userId: c.get('userId'),
    name: parsed.name,
    scheduledStartAt: parsed.scheduledStartAt ? new Date(parsed.scheduledStartAt) : undefined,
    scheduledEndAt: parsed.scheduledEndAt ? new Date(parsed.scheduledEndAt) : undefined,
    attendeeUserIds: parsed.attendeeUserIds,
  })
  return c.json(result)
})

// POST /calendar/meetings/:meetingId/cancel — 這場會不開了（→ CANCELED）
//
// 與 /meetings/:id/cancel 是不同的東西：那個是「取消蜜塔加入」。
app.post('/calendar/meetings/:meetingId/cancel', async (c) => {
  const result = await calendarService.cancelScheduledMeeting(
    c.req.param('meetingId'),
    c.get('userId'),
  )
  return c.json(result)
})

// POST /calendar/meetings/:meetingId/rsvp — 出席回覆
app.post('/calendar/meetings/:meetingId/rsvp', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { rsvp } = rsvpSchema.parse(body)
  const result = await calendarService.respondToMeeting({
    meetingId: c.req.param('meetingId'),
    userId: c.get('userId'),
    rsvp,
  })
  return c.json(result)
})

export default app
