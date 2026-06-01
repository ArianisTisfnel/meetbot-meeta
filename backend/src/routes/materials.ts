import { Hono } from 'hono'
import * as materialService from '../services/material.service.js'
import * as activityService from '../services/activity.service.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

app.post('/projects/:projectId/materials', async (c) => {
  const projectId = c.req.param('projectId')
  const vexaUserId = c.get('vexaUserId')

  const formData = await c.req.formData()
  const fileField = formData.get('file')
  if (!fileField || !(fileField instanceof File)) {
    return c.json({ error_code: 'INVALID_REQUEST', message: '缺少 file 欄位' }, 400)
  }

  const displayName = formData.get('display_name')

  const arrayBuffer = await fileField.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const result = await materialService.uploadMaterial(projectId, vexaUserId, {
    buffer,
    filename: fileField.name,
    mimeType: fileField.type,
    displayName: typeof displayName === 'string' ? displayName : undefined,
  })

  return c.json(result, 201)
})

app.get('/projects/:projectId/materials', async (c) => {
  const projectId = c.req.param('projectId')
  const q = c.req.query()

  const result = await materialService.listMaterials(projectId, c.get('vexaUserId'), {
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 20,
    status: q.status,
  })

  return c.json(result)
})

app.get('/projects/:projectId/materials/:materialId', async (c) => {
  const result = await materialService.getMaterial(
    c.req.param('projectId'),
    c.req.param('materialId'),
    c.get('vexaUserId'),
  )
  return c.json(result)
})

app.delete('/projects/:projectId/materials/:materialId', async (c) => {
  await materialService.deleteMaterial(
    c.req.param('projectId'),
    c.req.param('materialId'),
    c.get('vexaUserId'),
  )
  return c.body(null, 204)
})

// 專案活動紀錄（通用：素材增刪、成員增減、權限變更、會議建立、改名等）
app.get('/projects/:projectId/history', async (c) => {
  const q = c.req.query()
  const result = await activityService.listActivity(c.req.param('projectId'), c.get('vexaUserId'), {
    page: q.page ? parseInt(q.page) : 1,
    perPage: q.per_page ? parseInt(q.per_page) : 30,
  })
  return c.json(result)
})

export default app
