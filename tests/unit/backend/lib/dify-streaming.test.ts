import { vi, describe, it, expect, beforeEach } from 'vitest'

// OpenCC 轉繁體在這裡不是測試重點（且載入成本高）→ 換成 identity。
vi.mock('../../../../backend/src/lib/zh', () => ({ toTraditional: (s: string) => s }))
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    DIFY_API_BASE: 'http://dify.test',
    DIFY_WORKFLOW_API_KEY: 'app-test',
    DIFY_CHATFLOW_TIMEOUT_MS: 45_000,
  },
}))

import { askQuestion, parseSsePayload, DIFY_NO_RESULT_SENTINEL } from '../../../../backend/src/lib/dify'

/** 把整段 SSE 文字切成指定的位元組塊，模擬網路分塊到達。 */
function streamOf(sse: string, splitAtBytes?: number[]) {
  const full = Buffer.from(sse, 'utf8')
  const chunks: Buffer[] = []
  let prev = 0
  for (const at of splitAtBytes ?? []) {
    chunks.push(full.subarray(prev, at))
    prev = at
  }
  chunks.push(full.subarray(prev))

  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const c of chunks) yield new Uint8Array(c)
    })(),
  }
}

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const baseParams = {
  datasetId: 'ds-1',
  question: '報名日期是什麼時候',
  mode: 'voice' as const,
  userId: 'meet-1',
}

describe('parseSsePayload — SSE frame 解析', () => {
  it('取出 data: 那行的 JSON', () => {
    expect(parseSsePayload('event: message\ndata: {"event":"message","answer":"嗨"}')).toEqual({
      event: 'message',
      answer: '嗨',
    })
  })

  it('ping／空 frame／壞掉的 JSON → null（略過，不中斷串流）', () => {
    expect(parseSsePayload('event: ping')).toBeNull()
    expect(parseSsePayload('')).toBeNull()
    expect(parseSsePayload('data: {不是 JSON')).toBeNull()
    expect(parseSsePayload('data: [DONE]')).toBeNull()
  })
})

describe('askQuestion — Dify SSE 串流', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('多個 message chunk → 依序累積成完整答案，onDelta 逐段收到', async () => {
    const sse =
      frame({ event: 'message', conversation_id: 'conv-9', answer: '報名日期' }) +
      frame({ event: 'message', conversation_id: 'conv-9', answer: '是 3 月 1 日' }) +
      frame({ event: 'message_end', conversation_id: 'conv-9' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(sse)))

    const deltas: string[] = []
    const result = await askQuestion({ ...baseParams, onDelta: (d) => deltas.push(d) })

    expect(result.answer).toBe('報名日期是 3 月 1 日')
    expect(result.conversationId).toBe('conv-9')
    expect(deltas).toEqual(['報名日期', '是 3 月 1 日'])
  })

  it('送出的是 response_mode: streaming', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamOf(frame({ event: 'message', answer: 'ok' })))
    vi.stubGlobal('fetch', fetchMock)

    await askQuestion(baseParams)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.response_mode).toBe('streaming')
  })

  // 中文一個字 3 bytes。網路分塊會切在任意位元組上，直接 chunk.toString() 會產生
  // 替換字元（答案裡出現「」）。StringDecoder 必須把半個字留到下一塊。
  it('中文字被切在 chunk 邊界 → 不亂碼', async () => {
    const sse = frame({ event: 'message', conversation_id: 'c1', answer: '報名日期是三月一日' })
    const total = Buffer.byteLength(sse, 'utf8')
    // 在中間附近逐位元組切三刀，必然有一刀落在某個中文字的中間
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamOf(sse, [total - 20, total - 19, total - 18])),
    )

    const result = await askQuestion(baseParams)

    expect(result.answer).toBe('報名日期是三月一日')
    expect(result.answer).not.toContain('�')
  })

  it('message_replace → 整段取代先前累積的內容', async () => {
    const sse =
      frame({ event: 'message', conversation_id: 'c2', answer: '原本的答案' }) +
      frame({ event: 'message_replace', conversation_id: 'c2', answer: '已被審查取代' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(sse)))

    const result = await askQuestion(baseParams)
    expect(result.answer).toBe('已被審查取代')
  })

  it('error 事件 → 丟出錯誤（不會回一個半截的答案）', async () => {
    const sse =
      frame({ event: 'message', answer: '一半' }) +
      frame({ event: 'error', code: 'quota_exceeded', message: 'out of credits' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(sse)))

    await expect(askQuestion(baseParams)).rejects.toThrow(/quota_exceeded/)
  })

  it('ping 與 workflow/node 事件 → 略過不影響答案', async () => {
    const sse =
      'event: ping\n\n' +
      frame({ event: 'workflow_started', task_id: 't1' }) +
      frame({ event: 'message', conversation_id: 'c3', answer: '乾淨的答案' }) +
      frame({ event: 'node_finished', task_id: 't1' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(sse)))

    const result = await askQuestion(baseParams)
    expect(result.answer).toBe('乾淨的答案')
  })

  it('沒有結尾空行的最後一個 frame 也要收得到', async () => {
    const sse = frame({ event: 'message', answer: '前段' }) + 'data: {"event":"message","answer":"末段"}'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(sse)))

    const result = await askQuestion(baseParams)
    expect(result.answer).toBe('前段末段')
  })

  it('沒有檢索到 → 回傳哨兵句（呼叫端據此走會議脈絡）', async () => {
    const sse = frame({ event: 'message', conversation_id: 'c4', answer: DIFY_NO_RESULT_SENTINEL })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(sse)))

    const result = await askQuestion(baseParams)
    expect(result.answer).toBe(DIFY_NO_RESULT_SENTINEL)
  })

  it('HTTP 非 2xx → 丟出 EXTERNAL_SERVICE_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' }),
    )
    await expect(askQuestion(baseParams)).rejects.toThrow(/502/)
  })
})
