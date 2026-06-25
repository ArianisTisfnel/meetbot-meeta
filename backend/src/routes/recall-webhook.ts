import { Hono } from 'hono'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { dispatchRecallEvent } from '../provider/recall-adapter.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

/**
 * Recall realtime webhook 接收端。
 *
 * Recall 雲端會主動 POST 即時事件（transcript.data / participant_events.chat_message）進來，
 * 由 dispatchRecallEvent 依 bot.id 分派到對應 session 的 handlers → 驅動喚醒詞問答。
 *
 * - 認證：用 ?token= 共享密鑰（Recall 不會帶我們的 Bearer；此路徑在 authMiddleware 被跳過）。
 * - 一律回 200（即使內部出錯），避免觸發 Recall 的重試風暴（每事件最多 60 次重試）。
 */
app.post('/webhooks/recall', async (c) => {
  // 未設定密鑰時直接擋掉（避免誤開放）。
  if (!env.RECALL_WEBHOOK_TOKEN || c.req.query('token') !== env.RECALL_WEBHOOK_TOKEN) {
    return c.json({ error_code: 'UNAUTHORIZED', message: 'invalid webhook token' }, 401)
  }

  try {
    const body = await c.req.json().catch(() => null)
    if (body) dispatchRecallEvent(body)
  } catch (err) {
    logger.warn({ err }, 'recall webhook: dispatch error (ignored to avoid retry storm)')
  }

  return c.json({ ok: true })
})

export default app
