import { prisma } from '../lib/prisma.js'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { parseGoogleMeetUrl } from '../lib/google-meet.js'
import { startBotSession } from '../sessions/session-manager.js'

/**
 * 排定的會議時間快到時，自動派蜜塔進去。
 *
 * 只處理**明確勾選**「讓蜜塔加入」的會議（botAutoJoin）。不是每場會議都需要她——
 * 一對一、對外會議就不用——而且 Recall 按 bot 分鐘計費，全部自動加入會燒掉額度。
 *
 * 冪等靠 botDispatchedAt：派出去就打上時間戳，之後每輪都跳過。少了它，poller 會
 * 每分鐘重派一次，後端重啟後又再派一次。
 */

/** 提前多久派 bot：Recall 從派出到真的進等候室實測約 30 秒，提早一點才不會遲到。 */
const LEAD_TIME_MS = 2 * 60_000

/**
 * 過期多久就放棄。會議開始 15 分鐘後才被掃到（例如後端當時沒開），
 * 這時候才把蜜塔丟進去只會打擾正在開的會，不如不派。
 */
const GRACE_MS = 15 * 60_000

async function dispatchOnce(): Promise<void> {
  const now = Date.now()

  const due = await prisma.meetingInstance.findMany({
    where: {
      status: 'SCHEDULED',
      botAutoJoin: true,
      botDispatchedAt: null,
      scheduledStartAt: {
        lte: new Date(now + LEAD_TIME_MS),
        gte: new Date(now - GRACE_MS),
      },
    },
    include: { project: { select: { difyDatasetId: true } } },
  })

  for (const meeting of due) {
    try {
      const nativeMeetingId = parseGoogleMeetUrl(meeting.googleMeetUrl)
      if (!nativeMeetingId) {
        // 沒有有效的 Meet 連結就沒得加入（多半是主辦沒連 Google Calendar）。
        // 標記為已處理，否則每輪都會重試同一筆到過期為止。
        await prisma.meetingInstance.update({
          where: { id: meeting.id },
          data: { botDispatchedAt: new Date() },
        })
        logger.warn(
          { meetingId: meeting.id },
          'meeting-dispatch: 會議沒有有效的 Google Meet 連結，略過自動加入',
        )
        continue
      }

      // 並發上限依「建立者」計算，與手動邀請同一套規則（CLAUDE.md 決策 3）
      const owner = await prisma.user.findUnique({
        where: { id: meeting.createdByUserId },
        select: { maxConcurrentBots: true },
      })
      const activeCount = await prisma.meetingInstance.count({
        where: { createdByUserId: meeting.createdByUserId, status: 'ACTIVE' },
      })
      if (activeCount >= (owner?.maxConcurrentBots ?? 1)) {
        // 不標記 botDispatchedAt：這是暫時性的，下一輪別場會議結束後就可能派得出去
        logger.warn(
          { meetingId: meeting.id, activeCount },
          'meeting-dispatch: 已達並發上限，這一輪略過',
        )
        continue
      }

      // 先標記再派：即使 startBotSession 拋錯也不會在下一輪重派。
      // 寧可漏派一次讓人手動補，也不要無限重試把額度燒光。
      await prisma.meetingInstance.update({
        where: { id: meeting.id },
        data: { botDispatchedAt: new Date(), status: 'PENDING' },
      })

      void startBotSession({
        meetingInstanceId: meeting.id,
        googleMeetUrl: meeting.googleMeetUrl,
        nativeMeetingId,
        difyDatasetId: meeting.project?.difyDatasetId ?? null,
      })

      logger.info(
        { meetingId: meeting.id, scheduledStartAt: meeting.scheduledStartAt },
        'meeting-dispatch: 已派出蜜塔',
      )
    } catch (err) {
      logger.error({ err, meetingId: meeting.id }, 'meeting-dispatch: 派出蜜塔失敗')
    }
  }
}

export function startMeetingDispatchPoller(): void {
  const seconds = env.MEETING_DISPATCH_INTERVAL_SECONDS
  if (seconds <= 0) {
    logger.info('Meeting dispatch poller 已停用（MEETING_DISPATCH_INTERVAL_SECONDS=0）')
    return
  }

  const run = () =>
    dispatchOnce().catch((err) => logger.error({ err }, 'Meeting dispatch poller: 整輪失敗'))

  run()
  setInterval(run, seconds * 1000)
  logger.info(`Meeting dispatch poller started (every ${seconds}s)`)
}
