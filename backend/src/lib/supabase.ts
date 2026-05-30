import { env } from '../types/env.js'
import { AppError } from '../middleware/error-handler.js'

const BASE = `${env.SUPABASE_URL}/storage/v1/object`

function headers(extra?: Record<string, string>) {
  return {
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    ...extra,
  }
}

export async function uploadFile(path: string, buffer: Buffer, mimeType: string): Promise<void> {
  const res = await fetch(`${BASE}/${env.SUPABASE_STORAGE_BUCKET}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': mimeType }),
    body: buffer,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Supabase upload error ${res.status}: ${text}`)
  }
}

export async function upsertFile(path: string, buffer: Buffer, mimeType: string): Promise<void> {
  const res = await fetch(`${BASE}/${env.SUPABASE_STORAGE_BUCKET}/${path}`, {
    method: 'PUT',
    headers: headers({ 'Content-Type': mimeType, 'x-upsert': 'true' }),
    body: buffer,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Supabase upsert error ${res.status}: ${text}`)
  }
}

export async function deleteFile(path: string): Promise<void> {
  const res = await fetch(`${BASE}/${env.SUPABASE_STORAGE_BUCKET}`, {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [path] }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Supabase delete error ${res.status}: ${text}`)
  }
}