import { env } from '../types/env.js'
import { AppError } from '../middleware/error-handler.js'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.DIFY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.DIFY_DATASET_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Dify error ${res.status}: ${text}`)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function createDataset(name: string): Promise<string> {
  const data = await request<{ id: string }>('POST', '/datasets', {
    name,
    permission: 'only_me',
  })
  return data.id
}

export async function deleteDataset(datasetId: string): Promise<void> {
  await request<void>('DELETE', `/datasets/${datasetId}`)
}