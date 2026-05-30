import { Hono } from 'hono'
import { z } from 'zod'
import * as projectService from '../services/project.service.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

app.get('/projects', async (c) => {
  const q = c.req.query()
  const result = await projectService.listProjects(c.get('vexaUserId'), {
    search: q.search,
    type: (q.type as 'all' | 'owned' | 'shared') || 'all',
    order: (q.order as 'asc' | 'desc') || 'desc',
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 20,
  })
  return c.json(result)
})

const createProjectSchema = z.object({ name: z.string().min(1) })

app.post('/projects', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { name } = createProjectSchema.parse(body)
  const project = await projectService.createProject(c.get('vexaUserId'), name)
  return c.json(project, 201)
})

app.get('/projects/:projectId', async (c) => {
  const project = await projectService.getProject(c.req.param('projectId'), c.get('vexaUserId'))
  return c.json(project)
})

const updateProjectSchema = z.object({ name: z.string().min(1) })

app.patch('/projects/:projectId', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { name } = updateProjectSchema.parse(body)
  const result = await projectService.updateProject(
    c.req.param('projectId'),
    c.get('vexaUserId'),
    name,
  )
  return c.json(result)
})

app.delete('/projects/:projectId', async (c) => {
  await projectService.deleteProject(c.req.param('projectId'), c.get('vexaUserId'))
  return c.body(null, 204)
})

export default app
