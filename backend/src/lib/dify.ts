import { StringDecoder } from 'node:string_decoder'
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

/**
 * 取文件已切好的 chunk 內容（前 limit 段）。
 * 用於內容摘要卡：重用 Dify 的文字抽取結果，後端不必自己解析 PDF。
 */
export async function getDocumentSegments(
  datasetId: string,
  documentId: string,
  limit = 5,
): Promise<string[]> {
  const data = await request<{ data: Array<{ content?: string }> }>(
    'GET',
    `/datasets/${datasetId}/documents/${documentId}/segments?page=1&limit=${limit}`,
  )
  return (data.data ?? []).map((seg) => seg.content ?? '').filter((c) => c.trim())
}

// ── RAG Q&A（Dify Chatflow）─────────────────────────────────────────────────

export const DIFY_NO_RESULT_SENTINEL = '抱歉 沒有檢索到相關資訊'

/**
 * 從一個 SSE frame 取出 JSON payload（純函式，匯出供測試）。
 *
 * 一個 frame 可能含多行（`event: xxx` + `data: {...}`），只有 `data:` 那行有內容。
 * ping（心跳，每 10 秒）與無法解析的 frame 一律回 null 讓呼叫端略過。
 */
export function parseSsePayload(frame: string): Record<string, unknown> | null {
  for (const line of frame.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return null
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}


/**
 * RAG 問答（Dify Chatflow），走 `response_mode: 'streaming'`（SSE）。
 *
 * 2026-08-16 從 blocking 換過來。換的理由與「答案生成速度」無關——本函式仍然
 * 等整段收完才回傳，呼叫端開口的時刻**沒有變快**。真正拿到的是：
 *   - 不會撞到閘道器對單一長請求的固定逾時（blocking 下 45 秒的問題會直接斷）
 *   - 記錄 `ttftMs`（首字延遲）——要不要做「邊生成邊唸」就看這個數字
 *   - `onDelta` 是「邊收邊唸」的掛鉤（目前無人使用）
 *
 * ⚠️ 之後要把 `onDelta` 接去 TTS 之前，先處理這兩件事：
 *   1. `resolveAnswer` 的 Dify 錯誤重試會重跑一次，onDelta 會從頭再來一輪
 *   2. hybrid 意圖最後會用 LLM 重新合成，最終答案**不等於**串流出來的內容
 *   在那之前 onDelta 只適合做量測/預熱。
 */
export async function askQuestion(params: {
  datasetId: string
  question: string
  mode: 'voice' | 'chat'
  userId: string
  conversationId?: string | null
  /** 每段增量文字（已轉繁體）；acc 為到目前為止的完整答案。 */
  onDelta?: (delta: string, acc: string) => void
}): Promise<{ answer: string; conversationId: string }> {
  const startedAt = Date.now()
  const res = await fetch(`${env.DIFY_API_BASE}/chat-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DIFY_WORKFLOW_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: { dataset_id: params.datasetId, mode: params.mode },
      query: params.question,
      response_mode: 'streaming',
      user: params.userId,
      conversation_id: params.conversationId || '',
    }),
    signal: AbortSignal.timeout(env.DIFY_CHATFLOW_TIMEOUT_MS),
  })

  if (!res.ok || !res.body) {
    throw new AppError(
      'EXTERNAL_SERVICE_ERROR',
      503,
      `Dify Chatflow error: ${res.status} ${await res.text().catch(() => '')}`,
    )
  }

  // StringDecoder 而非 chunk.toString()：中文一個字 3 bytes，會被切在 chunk 邊界，
  // 直接 toString 會產生替換字元（答案出現「」）。decoder 會保留半個字等下一塊。
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let acc = ''
  let conversationId = params.conversationId || ''
  let firstDeltaMs: number | null = null
  let replaced = false

  const consumeFrame = (frame: string): void => {
    const ev = parseSsePayload(frame)
    if (!ev) return

    const cid = ev.conversation_id
    if (typeof cid === 'string' && cid) conversationId = cid

    switch (ev.event) {
      case 'message':
      case 'agent_message': {
        // LLM 輸出偶爾夾簡體 → 逐塊轉繁體（會直接顯示在聊天室 / 被 TTS 念出）
        const delta = toTraditional(String(ev.answer ?? ''))
        if (!delta) return
        if (firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt
        acc += delta
        params.onDelta?.(delta, acc)
        return
      }
      case 'message_replace':
        // 內容審查攔截 → 整段取代先前累積的內容
        acc = toTraditional(String(ev.answer ?? ''))
        replaced = true
        return
      case 'error':
        throw new AppError(
          'EXTERNAL_SERVICE_ERROR',
          503,
          `Dify Chatflow streaming error: ${String(ev.code ?? '')} ${String(ev.message ?? '')}`.trim(),
        )
      default:
        // message_end / ping / workflow_* / node_* → 沒有要累積的內容
        return
    }
  }

  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.write(Buffer.from(chunk))
    let sep: number
    // SSE frame 以空行分隔；\r\n\r\n 也要接受（經過某些反向代理會被改寫）
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const match = /\r?\n\r?\n/.exec(buffer.slice(sep))!
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + match[0].length)
      consumeFrame(frame)
    }
  }
  buffer += decoder.end()
  if (buffer.trim()) consumeFrame(buffer) // 最後一段沒有結尾空行

  const answer = acc || '抱歉，無法取得回答。'

  if (replaced) {
    logger.warn(
      { datasetId: params.datasetId },
      'Dify Chatflow: message_replace received (content moderation) — 先前串流出去的內容已被取代',
    )
  }

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
        conversationId,
        answerLength: answer.length,
        // ttftMs = 首字延遲：這才是「最快能開口的時刻」。
        // difyMs - ttftMs 就是「邊生成邊唸」能省下來的時間。
        ttftMs: firstDeltaMs,
        difyMs: Date.now() - startedAt,
      },
      'Dify Chatflow answered (RAG hit)',
    )
  }

  return { answer, conversationId }
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