import type { Hono } from 'hono'
import type { AppEnv } from '../types/hono.js'

export function registerRoutes(app: Hono<AppEnv>): void {
  app.get('/me', (c) =>
    c.json({
      vexaUserId: c.get('vexaUserId'),
      email: c.get('userEmail'),
      name: c.get('userName'),
      maxConcurrentBots: c.get('maxConcurrentBots'),
    }),
  )
}
