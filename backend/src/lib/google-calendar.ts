/**
 * Google Calendar API 的薄封裝。
 *
 * 用原生 fetch 而不是 googleapis 套件：我們只需要四個端點（換 token、freeBusy、
 * 事件增改刪），googleapis 會拉進一大包相依，跟專案既有的 Dify／Recall 呼叫風格也不一致。
 *
 * ⚠️ 這一層只管「怎麼跟 Google 說話」，不碰 DB。token 的存取與失效標記由
 * calendar-sync.service 負責。
 */

import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'

/** 使用者撤銷授權／refresh token 失效。呼叫端要據此把連結標成 EXPIRED。 */
export class GoogleAuthExpiredError extends Error {
  constructor(message = 'Google 授權已失效，請重新連結') {
    super(message)
    this.name = 'GoogleAuthExpiredError'
  }
}

/** Google API 回非 2xx 但不是授權問題（配額、暫時性錯誤等）。 */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GoogleApiError'
  }
}

/** 後端有沒有能力跟 Google 交換 token（缺 client id/secret 就整個同步功能停用）。 */
export function isGoogleCalendarConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

export interface RefreshedToken {
  accessToken: string
  expiresAt: Date
}

/**
 * 用 refresh token 換一顆新的 access token。
 *
 * Google 在 refresh token 被撤銷／過期時回 400 invalid_grant——那是「使用者要重新授權」，
 * 不是暫時性錯誤，所以獨立成 GoogleAuthExpiredError，讓呼叫端不會一直重試。
 */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshedToken> {
  if (!isGoogleCalendarConfigured()) {
    throw new GoogleApiError('後端未設定 GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET', 500)
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    let errorCode = ''
    try {
      errorCode = JSON.parse(text)?.error ?? ''
    } catch {
      /* 非 JSON 錯誤內容，只看狀態碼 */
    }
    if (res.status === 400 && (errorCode === 'invalid_grant' || errorCode === 'invalid_client')) {
      throw new GoogleAuthExpiredError()
    }
    throw new GoogleApiError(`Google token refresh 失敗（HTTP ${res.status}）`, res.status)
  }

  const data = JSON.parse(text) as { access_token: string; expires_in: number }
  return {
    accessToken: data.access_token,
    // 提早 60 秒視為過期，避免「剛好在請求送出時失效」的邊界
    expiresAt: new Date(Date.now() + (data.expires_in - 60) * 1000),
  }
}

async function callCalendar<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${CALENDAR_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (res.status === 401 || res.status === 403) {
    throw new GoogleAuthExpiredError()
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new GoogleApiError(
      `Google Calendar API 失敗（HTTP ${res.status}）：${detail.slice(0, 200)}`,
      res.status,
    )
  }
  // 204 No Content（刪除事件）沒有 body
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export interface BusyInterval {
  start: Date
  end: Date
}

/**
 * 查詢某人在一段時間內的忙碌時段。
 *
 * 用 freeBusy 而不是 events.list：freeBusy 只回「幾點到幾點忙」，不含標題與與會者。
 * 我們的疊圖與找空檔只需要這個，少拿一份別人的行程內容也少一份隱私責任（spec §5）。
 */
export async function queryFreeBusy(
  accessToken: string,
  range: { timeMin: Date; timeMax: Date },
): Promise<BusyInterval[]> {
  const data = await callCalendar<{
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>
  }>(accessToken, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: range.timeMin.toISOString(),
      timeMax: range.timeMax.toISOString(),
      items: [{ id: 'primary' }],
    }),
  })

  const primary = data.calendars?.primary
  if (primary?.errors?.length) {
    logger.warn({ errors: primary.errors }, 'freeBusy: Google 回報行事曆錯誤')
  }
  return (primary?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
}

export interface CalendarEventInput {
  summary: string
  description?: string
  start: Date
  end: Date
  /** IANA 時區；Google 用它決定事件在各人日曆上顯示成幾點 */
  timeZone: string
  /** 與會者 email。Google 會依 sendUpdates 設定寄出邀請信 */
  attendeeEmails: string[]
  /** 需要 Google Meet 連結時給 true */
  createMeetLink?: boolean
}

function toEventBody(input: CalendarEventInput, requestId?: string) {
  return {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.start.toISOString(), timeZone: input.timeZone },
    end: { dateTime: input.end.toISOString(), timeZone: input.timeZone },
    attendees: input.attendeeEmails.map((email) => ({ email })),
    ...(input.createMeetLink && requestId
      ? {
          conferenceData: {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  }
}

export interface CreatedEvent {
  id: string
  hangoutLink?: string
  meetUrl?: string
}

/**
 * 在主辦人的日曆建立事件，並把與會者加進去。
 *
 * sendUpdates=all：由 Google 負責寄出日曆邀請——這正是 spec §4.4「寫回時自動寄送
 * GCal 邀請」要的效果，也讓尚未連結本系統的與會者一樣收得到。
 */
export async function insertEvent(
  accessToken: string,
  input: CalendarEventInput,
): Promise<CreatedEvent> {
  const requestId = crypto.randomUUID()
  const query = new URLSearchParams({ sendUpdates: 'all' })
  if (input.createMeetLink) query.set('conferenceDataVersion', '1')

  const data = await callCalendar<{
    id: string
    hangoutLink?: string
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
  }>(accessToken, `/calendars/primary/events?${query}`, {
    method: 'POST',
    body: JSON.stringify(toEventBody(input, requestId)),
  })

  const meetUrl =
    data.hangoutLink ??
    data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri

  return { id: data.id, hangoutLink: data.hangoutLink, meetUrl }
}

/** 更新既有事件（改時間／與會者）。Google 會通知所有與會者。 */
export async function patchEvent(
  accessToken: string,
  eventId: string,
  input: CalendarEventInput,
): Promise<void> {
  await callCalendar(
    accessToken,
    `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: 'PATCH', body: JSON.stringify(toEventBody(input)) },
  )
}

/**
 * 刪除事件（會議取消）。
 *
 * 事件早就被使用者自己刪掉時 Google 回 404/410——那代表「目標狀態已達成」，
 * 當成成功處理，否則取消流程會被一個無關緊要的錯誤卡住。
 */
export async function deleteEvent(accessToken: string, eventId: string): Promise<void> {
  try {
    await callCalendar(
      accessToken,
      `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE' },
    )
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) {
      logger.info({ eventId }, 'deleteEvent: GCal 事件已不存在，視為已取消')
      return
    }
    throw err
  }
}
