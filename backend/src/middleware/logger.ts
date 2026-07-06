import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import type { MiddlewareHandler } from 'hono'

// Log 同時輸出到 stdout 與 logs/backend.log（除錯用：console 關掉後仍可回查
// 喚醒詞/webhook 事件時序）。檔案為 append，必要時手動清除。
const logDir = path.resolve(process.cwd(), 'logs')
fs.mkdirSync(logDir, { recursive: true })

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: path.join(logDir, 'backend.log'), mkdir: true, sync: false }) },
  ]),
)

export const requestLogger = (): MiddlewareHandler => async (c, next) => {
  const start = Date.now()
  await next()
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
  })
}
