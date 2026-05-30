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

const PROCESS_RULE = {
  mode: 'hierarchical',
  rules: {
    pre_processing_rules: [
      { id: 'remove_extra_spaces', enabled: true },
      { id: 'remove_urls_emails', enabled: false },
    ],
    segmentation: {
      separator: '\n',
      max_tokens: 1500,
    },
    subchunk_segmentation: {
      separator: '。',
      max_tokens: 500,
      chunk_overlap: 75,
    },
  },
  doc_language: 'Chinese',
}

export async function uploadDocument(
  datasetId: string,
  file: { buffer: Buffer; filename: string; mimeType: string },
): Promise<{ documentId: string; batch: string }> {
  const form = new FormData()

  const blob = new Blob([file.buffer], { type: file.mimeType })
  form.append('file', blob, file.filename)
  form.append(
    'data',
    JSON.stringify({
      indexing_technique: 'high_quality',
      process_rule: PROCESS_RULE,
    }),
  )

  const res = await fetch(`${env.DIFY_API_BASE}/datasets/${datasetId}/document/create_by_file`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DIFY_DATASET_API_KEY}`,
    },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Dify upload error ${res.status}: ${text}`)
  }

  const data = await res.json() as { document: { id: string }; batch: string }
  return { documentId: data.document.id, batch: data.batch }
}

type DifyIndexingItem = {
  indexing_status: string
  error?: string | null
}

const DIFY_STATUS_MAP: Record<string, 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'> = {
  waiting: 'PENDING',
  indexing: 'PROCESSING',
  completed: 'COMPLETED',
  error: 'FAILED',
}

export async function getIndexingStatus(
  datasetId: string,
  batch: string,
): Promise<{ status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'; error?: string }> {
  const data = await request<{ data: DifyIndexingItem[] }>(
    'GET',
    `/datasets/${datasetId}/documents/${batch}/indexing-status`,
  )

  const item = data.data[0]
  if (!item) {
    return { status: 'PENDING' }
  }

  const status = DIFY_STATUS_MAP[item.indexing_status] ?? 'PROCESSING'
  return {
    status,
    ...(item.error ? { error: item.error } : {}),
  }
}

export async function deleteDocument(datasetId: string, documentId: string): Promise<void> {
  await request<void>('DELETE', `/datasets/${datasetId}/documents/${documentId}`)
}