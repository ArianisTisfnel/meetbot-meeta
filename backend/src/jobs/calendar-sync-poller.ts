import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { syncAllConnections } from '../services/calendar-sync.service.js'
import { isGoogleCalendarConfigured } from '../lib/google-calendar.js'

/**
 * 背景同步所有已連結成員的 Google Calendar 忙碌時段。
 *
 * 為什麼要輪詢而不是用 Google 的推播（channels.watch）：推播需要一個公開可達的
 * webhook URL 與定期續訂，而且每個使用者一條 channel。目前這個規模輪詢就夠，
 * 也少一份「隧道沒開就整個失效」的耦合（那是 Recall webhook 已經踩過的坑）。
 * 之後要換推播，換掉這個 job 即可，service 層不動。
 *
 * 比照 indexing-poller：錯誤只記 log，不讓單一使用者的失敗中斷整輪。
 */
export function startCalendarSyncPoller(): void {
  if (!isGoogleCalendarConfigured()) {
    logger.info('Calendar sync poller 未啟動：未設定 GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET')
    return
  }
  const minutes = env.CALENDAR_SYNC_INTERVAL_MINUTES
  if (minutes <= 0) {
    logger.info('Calendar sync poller 已停用（CALENDAR_SYNC_INTERVAL_MINUTES=0），僅保留手動同步')
    return
  }

  const intervalMs = minutes * 60_000
  const run = () =>
    syncAllConnections().catch((err) =>
      logger.error({ err }, 'Calendar sync poller: 整輪同步失敗'),
    )

  // 啟動時先跑一輪：後端重啟後不必等一個完整週期才有新資料
  run()
  setInterval(run, intervalMs)
  logger.info(`Calendar sync poller started (every ${minutes}m)`)
}
