import type { Hono } from 'hono'
import type { AppEnv } from '../types/hono.js'
import meRoutes from './me.js'
import usersRoutes from './users.js'
import projectsRoutes from './projects.js'
import membersRoutes from './members.js'
import materialsRoutes from './materials.js'
import meetingsRoutes from './meetings.js'
import recallWebhookRoutes from './recall-webhook.js'

export function registerRoutes(app: Hono<AppEnv>): void {
  app.route('/', meRoutes)
  app.route('/', usersRoutes)
  app.route('/', projectsRoutes)
  app.route('/', membersRoutes)
  app.route('/', materialsRoutes)
  app.route('/', meetingsRoutes)
  // Recall realtime webhook（無 Bearer 認證，用 ?token= 密鑰；authMiddleware 已跳過 /webhooks/）
  app.route('/', recallWebhookRoutes)
}
