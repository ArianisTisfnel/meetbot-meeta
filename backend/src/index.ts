import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Server as HttpServer } from 'node:http'
import { env } from './types/env.js'
import { authMiddleware } from './middleware/auth.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLogger, logger } from './middleware/logger.js'
import { registerRoutes } from './routes/index.js'
import { startIndexingPoller } from './jobs/indexing-poller.js'
import { restoreActiveSessions } from './sessions/session-manager.js'
import { isAgentModeEnabled } from './agent/agent-registry.js'
import { attachAgentGateway } from './agent/agent-relay.js'
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

// ── Restore Active Sessions ───────────────────────
await restoreActiveSessions()

// ── Start Server ──────────────────────────────────
const server = serve({ fetch: app.fetch, port: env.APP_PORT }, () => {
  logger.info(`meetbot backend started on port ${env.APP_PORT}`)
})

// ── Agent WS gateway（方案 A：Output Media 即時語音）──
// off 時完全不掛載，行為與現行版本一致（回退驗證用）。
if (isAgentModeEnabled()) {
  attachAgentGateway(server as HttpServer)
} else if (env.AGENT_MODE === 'on') {
  logger.warn(
    'AGENT_MODE=on 但 AGENT_PAGE_URL / OPENAI_API_KEY / RECALL_WEBHOOK_URL / RECALL_WEBHOOK_TOKEN 未齊全 → agent 模式未啟用',
  )
}
