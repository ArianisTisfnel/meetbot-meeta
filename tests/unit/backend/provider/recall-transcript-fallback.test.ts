import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// recall-adapter import 時會驗證環境變數 → mock 掉避免 process.exit。
vi.mock('../../../../backend/src/types/env', () => ({
  env: { RECALL_API_URL: 'http://recall.test', RECALL_API_KEY: 'k', RECALL_TRANSCRIBE_LANGUAGE: 'auto' },
}))

import { RecallAdapter } from '../../../../backend/src/provider/recall-adapter'
import type { BotSession, TranscriptSegment } from '../../../../backend/src/provider/types'

const REALTIME_SEGMENTS: TranscriptSegment[] = [
  { segmentId: 'rt-1', text: '第一句', speaker: 'Wendy', startTime: 1, endTime: 2, language: 'zh' },
  { segmentId: 'rt-2', text: '第二句', speaker: 'Wendy', startTime: 3, endTime: 4, language: 'zh' },
]

function makeSession(adapter: RecallAdapter): BotSession {
  return {
    provider: 'recall',
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    providerMeetingId: 'bot-1',
    adapter,
    state: { botId: 'bot-1', statusTimer: null, closed: false, segments: [...REALTIME_SEGMENTS] },
  }
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('RecallAdapter.getTranscript：最終逐字稿 vs realtime 回退', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('最終逐字稿尚未就緒（無 transcript id）→ 回退用 realtime 累積', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ recordings: [] }))

    const adapter = new RecallAdapter()
    const segs = await adapter.getTranscript(makeSession(adapter))

    expect(segs).toEqual(REALTIME_SEGMENTS)
  })

  it('最終逐字稿仍在 processing → 回退用 realtime 累積', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ recordings: [{ media_shortcuts: { transcript: { id: 'tx-1' } } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: { code: 'processing' } }))

    const adapter = new RecallAdapter()
    const segs = await adapter.getTranscript(makeSession(adapter))

    expect(segs).toEqual(REALTIME_SEGMENTS)
  })

  it('最終逐字稿 done → 優先用最終版（非 realtime 累積）', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ recordings: [{ media_shortcuts: { transcript: { id: 'tx-1' } } }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: { code: 'done' }, data: { download_url: 'http://dl.test/t.json' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            speaker: 'Wendy',
            words: [
              { text: '完整', start_timestamp: { relative: 1 }, end_timestamp: { relative: 2 } },
              { text: '版本', start_timestamp: { relative: 2 }, end_timestamp: { relative: 3 } },
            ],
          },
        ]),
      )

    const adapter = new RecallAdapter()
    const segs = await adapter.getTranscript(makeSession(adapter))

    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('完整版本')
    expect(segs[0].speaker).toBe('Wendy')
  })

  it('Recall API 出錯 → 回退用 realtime 累積（不丟錯、不回空）', async () => {
    fetchMock.mockRejectedValue(new Error('recall down'))

    const adapter = new RecallAdapter()
    const segs = await adapter.getTranscript(makeSession(adapter))

    expect(segs).toEqual(REALTIME_SEGMENTS)
  })

  it('buffer 含 relay（agent:）段 → 直接用 buffer 依時間排序，完全不抓最終逐字稿', async () => {
    // 最終逐字稿出自 recallai_streaming，VAD 關不上時整段黏住（實測 2026-08-17）；
    // relay 段一句一段品質更好。bot 自己的 webhook 段（分鐘級晚到、插入順序亂）一併排序。
    const adapter = new RecallAdapter()
    const session = makeSession(adapter)
    ;(session.state as { segments: TranscriptSegment[] }).segments = [
      { segmentId: 'agent:i1', text: '第一句', speaker: 'Wendy', startTime: 5, endTime: 6, language: null },
      { segmentId: 'rt-bot', text: '蜜塔的回答', speaker: '蜜塔', startTime: 8, endTime: 12, language: 'zh' },
      { segmentId: 'agent:i2', text: '第二句', speaker: 'Wendy', startTime: 2, endTime: 3, language: null },
    ]
    const segs = await adapter.getTranscript(session)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(segs.map((s) => s.segmentId)).toEqual(['agent:i2', 'agent:i1', 'rt-bot'])
  })
})
