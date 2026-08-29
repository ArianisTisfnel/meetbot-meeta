import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import type { MiddlewareHandler } from 'hono'

// Log 同時輸出到 stdout 與 logs/backend.log（除錯用：console 關掉後仍可回查
// 喚醒詞/webhook 事件時序）。檔案為 append，必要時手動清除。
//
// ⚠️ **測試時不寫檔**：單元測試的假 session（meetingInstanceId: 'meet-1' 之類）
// 原本會一路 append 進正式的 backend.log。以前只是雜訊，但 scripts/eval-barge-in.ts
// 這種「從 log 算指標」的工具一出現就變成會算錯數字的汙染源——跑一輪測試就憑空
// 多出十幾筆讓路事件。stdout 照舊（vitest 本來就會顯示），只是不落檔。
const underTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
const logDir = path.resolve(process.cwd(), 'logs')
if (!underTest) fs.mkdirSync(logDir, { recursive: true })

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  pino.multistream([
    { stream: process.stdout },
    ...(underTest
      ? []
      : [{ stream: pino.destination({ dest: path.join(logDir, 'backend.log'), mkdir: true, sync: false }) }]),
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
