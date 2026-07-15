import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './types/env.js'
import { authMiddleware } from './middleware/auth.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLogger, logger } from './middleware/logger.js'
import { registerRoutes } from './routes/index.js'
import { startIndexingPoller } from './jobs/indexing-poller.js'
import { startRetranscriptionPoller } from './jobs/retranscription-poller.js'
import { restoreActiveSessions } from './sessions/session-manager.js'
import type { AppEnv } from './types/hono.js'

const app = new Hono<AppEnv>()

// ── Global Middleware ─────────────────────────────
app.use('*', requestLogger())
app.use('*', cors({ origin: env.APP_CORS_ORIGINS.split(',') }))
app.use('*', authMiddleware)

// ── Routes ────────────────────────────────────────
registerRoutes(app)

// ── Error Handler ─────────────────────────────────
app.onError(errorHandler)

// ── Background Jobs ───────────────────────────────
startIndexingPoller()
// 會後重轉錄（P3）：未設定 WHISPER_SERVICE_URL 即整體關閉，PENDING 紀錄無害地留著，
// 日後設定好服務位址重啟即自動補跑。
if (env.WHISPER_SERVICE_URL) startRetranscriptionPoller()

// ── Restore Active Sessions ───────────────────────
await restoreActiveSessions()

// ── Start Server ──────────────────────────────────
serve({ fetch: app.fetch, port: env.APP_PORT }, () => {
  logger.info(`meetbot backend started on port ${env.APP_PORT}`)
})
