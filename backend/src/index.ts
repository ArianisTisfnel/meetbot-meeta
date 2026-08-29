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
import { waitForPendingSummaries } from './sessions/summary.service.js'
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

// ── 關機排水 ──────────────────────────────────────
//
// 為什麼需要：摘要是會議結束後的背景工作，要 11–35 秒才落地（見
// summary.service.ts 檔頭）。Node 在沒有 SIGTERM handler 時收到訊號**立刻**退出，
// 所以每一次 `pm2 restart`／部署都可能把剛結束那場會議的逐字稿與摘要一起丟掉。
// 2026-08-26 實測：會議 11:23:43 結束、11:23:53 進程被關，摘要死在第一個 sleep。
//
// ⚠️ PM2 的 kill_timeout 必須 ≥ SHUTDOWN_GRACE_MS + 5s，否則它會在排水完成前
//    改送 SIGKILL，這段就白做了（PM2 預設只有 1600ms）。
//
// ponytail: 只排水「摘要」。**進行中**的會議仍然會在關機時失去逐字稿——那是
// 逐字稿只活在記憶體的老問題，根治要讓 segment 落 DB（docs/13 § 已知限制）。
const SHUTDOWN_GRACE_MS = 40_000
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return // 連按兩次 Ctrl+C／SIGTERM 後補 SIGINT，不要重入
  shuttingDown = true
  logger.info({ signal }, 'shutdown: 等在途摘要做完')

  const drained = await waitForPendingSummaries(SHUTDOWN_GRACE_MS)
  logger.info({ signal, drained }, 'shutdown: 排水結束，準備退出')

  // server.close 只停止收新連線，既有的 WS（agent 網頁／音軌探針）不會自己斷，
  // 所以另外壓一個硬退計時器，否則進程會掛在這裡等到 orchestrator 送 SIGKILL。
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// crash 的可診斷性：原本沒有任何處理，進程靜默死亡，事後只能從「log 最後一行的
// 時間」猜。至少留一行再退。
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException：進程即將退出')
  process.exit(1)
})

// unhandledRejection 只記錄、不退出：這個 codebase 有多處 fire-and-forget，
// 為了一個良性的 rejection 把整台後端連同所有進行中的會議帶走，比不處理更糟。
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection（未退出，僅記錄）')
})
