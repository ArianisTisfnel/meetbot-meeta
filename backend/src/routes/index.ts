import type { Hono } from 'hono'
import type { AppEnv } from '../types/hono.js'
import meRoutes from './me.js'
import usersRoutes from './users.js'
import projectsRoutes from './projects.js'
import membersRoutes from './members.js'
import materialsRoutes from './materials.js'

export function registerRoutes(app: Hono<AppEnv>): void {
  app.route('/', meRoutes)
  app.route('/', usersRoutes)
  app.route('/', projectsRoutes)
  app.route('/', membersRoutes)
  app.route('/', materialsRoutes)
}
