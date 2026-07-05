import { env } from '../types/env.js'
import { toTraditional } from './zh.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'

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

export async function createDataset(
  name: string,
  permission: 'only_me' | 'all_team_members' | 'partial_members' = 'all_team_members',
): Promise<string> {
  const data = await request<{ id: string }>('POST', '/datasets', { name, permission })
  return data.id
}

export async function deleteDataset(datasetId: string): Promise<void> {
  await request<void>('DELETE', `/datasets/${datasetId}`)
}

export type ChunkingOptions = {
  parentMode?: 'paragraph' | 'full-doc'
  parentSeparator?: string
  parentMaxTokens?: number
  parentOverlap?: number
  childSeparator?: string
  childMaxTokens?: number
  childOverlap?: number
  docLanguage?: string
}

/**
 * 產生 parent-child（hierarchical）chunking 的 process_rule。
 * 注意：要真正啟用 parent-child，必須在 data 同時帶 `doc_form: 'hierarchical_model'`（見 uploadDocument）；
 * 只設 process_rule.mode='hierarchical' 而少了 doc_form，Dify 會退回 general（text_model）。
 */
function buildProcessRule(opts: ChunkingOptions = {}) {
  return {
    mode: 'hierarchical',
    rules: {
      pre_processing_rules: [
        { id: 'remove_extra_spaces', enabled: true },
        { id: 'remove_urls_emails', enabled: false },
      ],
      parent_mode: opts.parentMode ?? 'paragraph',
      segmentation: {
        separator: opts.parentSeparator ?? '\n\n',
        max_tokens: opts.parentMaxTokens ?? 1500,
        chunk_overlap: opts.parentOverlap ?? 150,
      },
      subchunk_segmentation: {
        separator: opts.childSeparator ?? '\n',
        max_tokens: opts.childMaxTokens ?? 500,
        chunk_overlap: opts.childOverlap ?? 75,
      },
    },
  }
}

export async function uploadDocument(
  datasetId: string,
  file: { buffer: Buffer; filename: string; mimeType: string },
  chunking: ChunkingOptions = {},
): Promise<{ documentId: string; batch: string }> {
  const form = new FormData()

  const blob = new Blob([file.buffer], { type: file.mimeType })
  form.append('file', blob, file.filename)
  form.append(
    'data',
    JSON.stringify({
      indexing_technique: 'high_quality',
      // 關鍵：doc_form=hierarchical_model 才會用 parent-child；缺這個會被當成 general。
      doc_form: 'hierarchical_model',
      doc_language: chunking.docLanguage ?? 'Chinese',
      process_rule: buildProcessRule(chunking),
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

// ── RAG Q&A（Dify Chatflow）─────────────────────────────────────────────────

const DIFY_NO_RESULT_SENTINEL = '抱歉 沒有檢索到相關資訊'

/** Chatflow 檢索不到資料時回的罐頭句（與 Dify 平台上的設定字串一致）。 */
export function isNoResultAnswer(answer: string): boolean {
  return answer.trim() === DIFY_NO_RESULT_SENTINEL
}

export async function askQuestion(params: {
  datasetId: string
  question: string
  mode: 'voice' | 'chat'
  userId: string
  conversationId?: string | null
}): Promise<{ answer: string; conversationId: string }> {
  const res = await fetch(`${env.DIFY_API_BASE}/chat-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DIFY_WORKFLOW_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: { dataset_id: params.datasetId, mode: params.mode },
      query: params.question,
      response_mode: 'blocking',
      user: params.userId,
      conversation_id: params.conversationId || '',
    }),
    signal: AbortSignal.timeout(env.DIFY_CHATFLOW_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw new AppError(
      'EXTERNAL_SERVICE_ERROR',
      503,
      `Dify Chatflow error: ${res.status} ${await res.text().catch(() => '')}`,
    )
  }

  const data = (await res.json()) as { answer?: string; conversation_id?: string }
  // LLM 輸出偶爾夾簡體 → 統一轉繁體（會直接顯示在會議聊天室 / TTS 念出）。
  const answer = toTraditional(data.answer ?? '抱歉，無法取得回答。')

  if (answer === DIFY_NO_RESULT_SENTINEL) {
    // 靜默失效偵測：RAG 可能因 DIFY_DATASET_API_KEY 未設定而失效
    logger.warn(
      { datasetId: params.datasetId },
      'Dify Chatflow returned no-result sentinel — check DIFY_DATASET_API_KEY in Dify platform env vars',
    )
  } else {
    logger.info(
      {
        datasetId: params.datasetId,
        userId: params.userId,
        conversationId: data.conversation_id ?? '',
        answerLength: answer.length,
      },
      'Dify Chatflow answered (RAG hit)',
    )
  }

  return { answer, conversationId: data.conversation_id ?? '' }
}

// ── 逐字稿 MD 上傳至 Dify Files API ────────────────────────────────────────

export async function uploadTranscriptFile(
  meetingInstanceId: string,
  markdownContent: string,
): Promise<string> {
  const form = new FormData()
  const blob = new Blob([markdownContent], { type: 'text/markdown' })
  form.append('file', blob, `transcript-${meetingInstanceId}.md`)
  form.append('user', meetingInstanceId)

  const res = await fetch(`${env.DIFY_API_BASE}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw new AppError(
      'EXTERNAL_SERVICE_ERROR',
      503,
      `Dify file upload error: ${res.status} ${await res.text().catch(() => '')}`,
    )
  }

  const data = (await res.json()) as { id: string }
  return data.id
}

// ── 會議摘要（Dify Workflow）────────────────────────────────────────────────

export async function generateSummary(params: {
  difyFileId: string
  meetingInstanceId: string
}): Promise<{
  summary: string
  actionItems: Array<{ task: string; owner: string }>
  keyTopics: string[]
  decisions: string[]
}> {
  const res = await fetch(`${env.DIFY_API_BASE}/workflows/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: {
        transcript: {
          type: 'document',
          transfer_method: 'local_file',
          upload_file_id: params.difyFileId,
        },
      },
      response_mode: 'blocking',
      user: params.meetingInstanceId,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    throw new AppError(
      'EXTERNAL_SERVICE_ERROR',
      503,
      `Dify meeting summary error: ${res.status} ${await res.text().catch(() => '')}`,
    )
  }

  const data = (await res.json()) as { data?: { status?: string; outputs?: { result_json?: string } } }
  if (data.data?.status !== 'succeeded') {
    throw new AppError(
      'EXTERNAL_SERVICE_ERROR',
      503,
      `Dify meeting summary workflow failed: ${JSON.stringify(data.data)}`,
    )
  }

  try {
    let raw = data.data.outputs?.result_json ?? ''
    raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(raw)
    return {
      summary: toTraditional(parsed.summary ?? ''),
      actionItems: (parsed.action_items ?? []).map((it: { task?: string; owner?: string }) => ({
        task: toTraditional(it.task ?? ''),
        owner: toTraditional(it.owner ?? ''),
      })),
      keyTopics: (parsed.key_topics ?? []).map((t: string) => toTraditional(t)),
      decisions: (parsed.decisions ?? []).map((d: string) => toTraditional(d)),
    }
  } catch {
    return {
      summary: toTraditional(data.data?.outputs?.result_json ?? ''),
      actionItems: [],
      keyTopics: [],
      decisions: [],
    }
  }
}