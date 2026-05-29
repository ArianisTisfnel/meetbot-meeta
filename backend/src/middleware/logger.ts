import pino from 'pino'
import type { MiddlewareHandler } from 'hono'

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

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
