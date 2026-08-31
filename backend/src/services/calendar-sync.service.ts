import type { CalendarConnection } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { AppError } from '../middleware/error-handler.js'
import {
  GoogleApiError,
  GoogleAuthExpiredError,
  deleteEvent,
  insertEvent,
  isGoogleCalendarConfigured,
  patchEvent,
  queryFreeBusy,
  refreshAccessToken,
  type CalendarEventInput,
} from '../lib/google-calendar.js'

/**
 * Google Calendar 同步。
 *
 * 兩個方向：
 * - 匯入：把成員的忙碌時段抓進 BusyBlock，供疊圖與找空檔使用（只存起訖，不存標題）
 * - 寫回：本系統排定/改期/取消會議時，同步到主辦人的 GCal 並由 Google 寄邀請
 *
 * 全部設計成 best-effort：Google 掛掉不該讓「在本系統排會議」這件事失敗。
 * 失敗只記在 connection.lastSyncError，由使用者看到並可重試（spec §4.4 狀態）。
 */

/** 同步視窗：往前 7 天（讓剛過去的一週仍看得到忙碌），往後由 env 決定。 */
const SYNC_DAYS_BEHIND = 7

export function syncWindow(now = new Date()): { timeMin: Date; timeMax: Date } {
  return {
    timeMin: new Date(now.getTime() - SYNC_DAYS_BEHIND * 86_400_000),
    timeMax: new Date(now.getTime() + env.CALENDAR_SYNC_DAYS_AHEAD * 86_400_000),
  }
}

// ── 連結管理 ──────────────────────────────────────────────────────────────────

/**
 * 建立／更新某人的 Google Calendar 連結。
 *
 * 由前端登入流程（NextAuth 拿到 refresh token 後）透過 /internal 呼叫。
 * refresh token 只有在使用者重新同意授權時才拿得到，所以沒有新的就保留舊的，
 * 不要用 undefined 覆蓋掉——那會讓背景同步永久失效。
 */
export async function upsertConnection(params: {
  userId: number
  refreshToken?: string | null
}): Promise<{ connected: boolean }> {
  const { userId, refreshToken } = params

  const existing = await prisma.calendarConnection.findUnique({ where: { userId } })

  if (!refreshToken) {
    // 沒拿到新的 refresh token：已經連結過就維持原狀，沒有就什麼都不做
    return { connected: Boolean(existing) }
  }

  await prisma.calendarConnection.upsert({
    where: { userId },
    create: { userId, refreshToken, status: 'ACTIVE' },
    update: {
      refreshToken,
      status: 'ACTIVE',
      lastSyncError: null,
      // 換了新的授權，舊的 access token 一律作廢
      accessToken: null,
      accessTokenExpiresAt: null,
    },
  })
  logger.info({ userId }, 'calendar-sync: connection upserted')
  return { connected: true }
}

/** 解除連結：刪掉授權與已快取的忙碌時段（使用者按「中斷連結」時要真的清乾淨）。 */
export async function disconnect(userId: number): Promise<void> {
  await prisma.$transaction([
    prisma.calendarConnection.deleteMany({ where: { userId } }),
    prisma.busyBlock.deleteMany({ where: { userId } }),
  ])
  logger.info({ userId }, 'calendar-sync: disconnected')
}

export async function getConnectionStatus(userId: number) {
  const conn = await prisma.calendarConnection.findUnique({ where: { userId } })
  return {
    configured: isGoogleCalendarConfigured(),
    connected: Boolean(conn),
    status: conn?.status ?? null,
    lastSyncedAt: conn?.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: conn?.lastSyncError ?? null,
  }
}

// ── access token ─────────────────────────────────────────────────────────────

/**
 * 取得可用的 access token：快取還沒過期就直接用，否則換一顆新的存回去。
 *
 * refresh token 失效時把連結標成 EXPIRED 並丟 GoogleAuthExpiredError，
 * 讓前端顯示「請重新連結」而不是無聲地一直失敗。
 */
async function getAccessToken(connection: CalendarConnection): Promise<string> {
  if (
    connection.accessToken &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt > new Date()
  ) {
    return connection.accessToken
  }

  try {
    const refreshed = await refreshAccessToken(connection.refreshToken)
    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: refreshed.accessToken,
        accessTokenExpiresAt: refreshed.expiresAt,
        status: 'ACTIVE',
        lastSyncError: null,
      },
    })
    return refreshed.accessToken
  } catch (err) {
    if (err instanceof GoogleAuthExpiredError) {
      await markExpired(connection.id, err.message)
    }
    throw err
  }
}

async function markExpired(connectionId: number, message: string): Promise<void> {
  await prisma.calendarConnection.update({
    where: { id: connectionId },
    data: { status: 'EXPIRED', lastSyncError: message },
  })
}

// ── 匯入：忙碌時段 ────────────────────────────────────────────────────────────

export interface SyncResult {
  userId: number
  synced: boolean
  blockCount: number
  error?: string
}

/**
 * 把某人的 GCal 忙碌時段抓進 BusyBlock。
 *
 * 採「整個視窗汰換」而不是增量更新：freeBusy 回的是聚合後的忙碌區間，沒有穩定 id
 * 可以逐筆比對，而且刪掉的行程在增量模式下會變成永遠清不掉的殘留。
 * 一個視窗頂多幾百筆，整批換掉最單純也最不會出錯。
 */
export async function syncUserBusyBlocks(userId: number): Promise<SyncResult> {
  const connection = await prisma.calendarConnection.findUnique({ where: { userId } })
  if (!connection) return { userId, synced: false, blockCount: 0, error: '尚未連結' }

  const window = syncWindow()

  try {
    const accessToken = await getAccessToken(connection)
    const busy = await queryFreeBusy(accessToken, window)

    await prisma.$transaction([
      // 只清這個視窗內的舊資料，視窗外的（例如更久以前抓的）不動
      prisma.busyBlock.deleteMany({
        where: { userId, startAt: { lt: window.timeMax }, endAt: { gt: window.timeMin } },
      }),
      prisma.busyBlock.createMany({
        data: busy.map((b) => ({ userId, startAt: b.start, endAt: b.end })),
      }),
    ])

    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: { lastSyncedAt: new Date(), lastSyncError: null, status: 'ACTIVE' },
    })

    logger.info({ userId, blockCount: busy.length }, 'calendar-sync: busy blocks synced')
    return { userId, synced: true, blockCount: busy.length }
  } catch (err) {
    const message =
      err instanceof GoogleAuthExpiredError
        ? 'Google 授權已失效，請重新連結'
        : err instanceof GoogleApiError
          ? err.message
          : '同步失敗'

    // 授權失效已在 getAccessToken 標記過；其他錯誤只記錄，不改變連結狀態
    if (!(err instanceof GoogleAuthExpiredError)) {
      await prisma.calendarConnection.update({
        where: { id: connection.id },
        data: { lastSyncError: message },
      })
    }
    logger.warn({ err, userId }, 'calendar-sync: busy block sync failed')
    return { userId, synced: false, blockCount: 0, error: message }
  }
}

/** 使用者手動按「立即同步」。未連結時給明確錯誤，而不是靜默成功。 */
export async function syncMe(userId: number): Promise<SyncResult> {
  const connection = await prisma.calendarConnection.findUnique({ where: { userId } })
  if (!connection) {
    throw new AppError('INVALID_REQUEST', 400, '尚未連結 Google Calendar')
  }
  return syncUserBusyBlocks(userId)
}

/** 背景排程用：同步所有仍有效的連結。 */
export async function syncAllConnections(): Promise<void> {
  if (!isGoogleCalendarConfigured()) return

  const connections = await prisma.calendarConnection.findMany({
    where: { status: 'ACTIVE' },
    select: { userId: true },
  })
  if (connections.length === 0) return

  // 逐一同步而非併發：Google 有每分鐘配額，成員數不多，慢一點沒關係
  for (const { userId } of connections) {
    await syncUserBusyBlocks(userId).catch((err) =>
      logger.error({ err, userId }, 'calendar-sync: unexpected sync failure'),
    )
  }
}

// ── 寫回：把會議推到主辦人的 GCal ─────────────────────────────────────────────

/**
 * 取得主辦人可用的 access token；沒連結／沒設定就回 null（呼叫端安靜跳過寫回）。
 */
async function getOrganizerToken(userId: number): Promise<string | null> {
  if (!isGoogleCalendarConfigured()) return null
  const connection = await prisma.calendarConnection.findUnique({ where: { userId } })
  if (!connection || connection.status !== 'ACTIVE') return null
  try {
    return await getAccessToken(connection)
  } catch (err) {
    logger.warn({ err, userId }, 'calendar-sync: 取得主辦人 token 失敗，略過寫回')
    return null
  }
}

async function attendeeEmails(userIds: number[]): Promise<string[]> {
  if (userIds.length === 0) return []
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { email: true },
  })
  return users.map((u) => u.email)
}

export interface WriteBackMeeting {
  id: string
  name: string
  scheduledStartAt: Date | null
  scheduledEndAt: Date | null
  timezone: string | null
  createdByUserId: number
  gcalEventId: string | null
  attendeeUserIds: number[]
}

async function buildEventInput(meeting: WriteBackMeeting): Promise<CalendarEventInput | null> {
  if (!meeting.scheduledStartAt || !meeting.scheduledEndAt) return null
  return {
    summary: meeting.name,
    description: '由蜜塔 MeetBot 排定',
    start: meeting.scheduledStartAt,
    end: meeting.scheduledEndAt,
    timeZone: meeting.timezone ?? 'Asia/Taipei',
    attendeeEmails: await attendeeEmails(meeting.attendeeUserIds),
  }
}

/**
 * 會議建立後寫進主辦人的 GCal，並把 event id 存回來供日後更新／刪除對應。
 *
 * 整段 best-effort：Google 失敗不影響會議已經在本系統排定的事實，
 * 使用者仍可稍後手動重試（spec §4.4「同步中／失敗 → 顯示狀態，可重試」）。
 */
export async function pushMeetingToGoogle(meeting: WriteBackMeeting): Promise<void> {
  const token = await getOrganizerToken(meeting.createdByUserId)
  if (!token) return

  const input = await buildEventInput(meeting)
  if (!input) return

  try {
    if (meeting.gcalEventId) {
      await patchEvent(token, meeting.gcalEventId, input)
    } else {
      const created = await insertEvent(token, { ...input, createMeetLink: true })
      await prisma.meetingInstance.update({
        where: { id: meeting.id },
        data: {
          gcalEventId: created.id,
          // Google 順便給了 Meet 連結就存起來，省得使用者另外貼一次
          ...(created.meetUrl ? { googleMeetUrl: created.meetUrl } : {}),
        },
      })
    }
    logger.info({ meetingId: meeting.id }, 'calendar-sync: 會議已寫回 Google Calendar')
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'calendar-sync: 寫回 Google Calendar 失敗')
  }
}

/** 會議取消時把對應的 GCal 事件刪掉（spec §4.4 驗收：取消後 GCal 事件同步移除）。 */
export async function removeMeetingFromGoogle(meeting: {
  id: string
  createdByUserId: number
  gcalEventId: string | null
}): Promise<void> {
  if (!meeting.gcalEventId) return
  const token = await getOrganizerToken(meeting.createdByUserId)
  if (!token) return

  try {
    await deleteEvent(token, meeting.gcalEventId)
    await prisma.meetingInstance.update({
      where: { id: meeting.id },
      data: { gcalEventId: null },
    })
    logger.info({ meetingId: meeting.id }, 'calendar-sync: GCal 事件已移除')
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'calendar-sync: 移除 GCal 事件失敗')
  }
}
