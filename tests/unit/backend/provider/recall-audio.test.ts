import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// recall-adapter import 時會驗證環境變數 → mock 掉避免 process.exit。
vi.mock('../../../../backend/src/types/env', () => ({
  env: { RECALL_API_URL: 'http://recall.test', RECALL_API_KEY: 'k', RECALL_TRANSCRIBE_LANGUAGE: 'auto' },
}))

import { fetchRecallAudioUrl } from '../../../../backend/src/provider/recall-adapter'

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('fetchRecallAudioUrl：會後錄音 pre-signed URL 解析', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recordings 為空 → none（呼叫端標 SKIPPED）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ recordings: [] }))

    expect(await fetchRecallAudioUrl('bot-1')).toEqual({ kind: 'none' })
  })

  it('audio_mixed shortcut 直接內含 done + download_url → ready', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        recordings: [
          {
            media_shortcuts: {
              audio_mixed: {
                id: 'am-1',
                status: { code: 'done' },
                data: { download_url: 'https://s3.example/audio.mp3?sig=x' },
              },
            },
          },
        ],
      }),
    )

    expect(await fetchRecallAudioUrl('bot-1')).toEqual({
      kind: 'ready',
      url: 'https://s3.example/audio.mp3?sig=x',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shortcut 只有 id（無 status/data）→ 二段 fetch media 端點取 download_url', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          recordings: [{ media_shortcuts: { audio_mixed: { id: 'am-1' } } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: { code: 'done' },
          data: { download_url: 'https://s3.example/audio.mp3?sig=y' },
        }),
      )

    expect(await fetchRecallAudioUrl('bot-1')).toEqual({
      kind: 'ready',
      url: 'https://s3.example/audio.mp3?sig=y',
    })
    // 第二段呼叫走 audio_mixed 端點
    expect(fetchMock.mock.calls[1][0]).toBe('http://recall.test/api/v1/audio_mixed/am-1/')
  })

  it('media 仍在 processing → pending（暫時性，下輪重試）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        recordings: [
          { media_shortcuts: { audio_mixed: { id: 'am-1', status: { code: 'processing' } } } },
        ],
      }),
    )

    expect(await fetchRecallAudioUrl('bot-1')).toEqual({ kind: 'pending' })
  })

  it('無 audio_mixed 但 video_mixed 就緒 → 用 video 的 download_url（ffmpeg 抽音軌）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        recordings: [
          {
            media_shortcuts: {
              video_mixed: {
                id: 'vm-1',
                status: { code: 'done' },
                data: { download_url: 'https://s3.example/video.mp4?sig=z' },
              },
            },
          },
        ],
      }),
    )

    expect(await fetchRecallAudioUrl('bot-1')).toEqual({
      kind: 'ready',
      url: 'https://s3.example/video.mp4?sig=z',
    })
  })

  it('有 recording 但無任何 media shortcut → none', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ recordings: [{ media_shortcuts: {} }] }))

    expect(await fetchRecallAudioUrl('bot-1')).toEqual({ kind: 'none' })
  })
})
