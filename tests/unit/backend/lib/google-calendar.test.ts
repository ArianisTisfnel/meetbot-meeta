import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// env 在 import 時會驗證環境變數（缺就 process.exit），故先 mock 掉
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
  },
}))

import {
  GoogleApiError,
  GoogleAuthExpiredError,
  deleteEvent,
  insertEvent,
  isGoogleCalendarConfigured,
  queryFreeBusy,
  refreshAccessToken,
} from '../../../../backend/src/lib/google-calendar'

function mockFetch(responses: Array<{ status: number; body?: unknown; text?: string }>) {
  const fn = vi.fn()
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.text ?? JSON.stringify(r.body ?? {}),
      json: async () => r.body ?? {},
    })
  }
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isGoogleCalendarConfigured', () => {
  it('有 client id/secret 時回 true', () => {
    expect(isGoogleCalendarConfigured()).toBe(true)
  })
})

describe('refreshAccessToken', () => {
  it('成功時回傳 access token，且到期時間提早 60 秒', async () => {
    // 固定時鐘：到期時間是精確計算的結果，不該讓測試去容忍幾毫秒的執行時間
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    try {
      mockFetch([{ status: 200, body: { access_token: 'at-1', expires_in: 3600 } }])
      const result = await refreshAccessToken('rt-1')

      expect(result.accessToken).toBe('at-1')
      // 3600 - 60 = 3540 秒後過期
      expect(result.expiresAt.toISOString()).toBe('2026-09-01T00:59:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalid_grant 要獨立成授權失效錯誤，不能當成暫時性失敗', async () => {
    mockFetch([{ status: 400, text: JSON.stringify({ error: 'invalid_grant' }) }])
    await expect(refreshAccessToken('revoked')).rejects.toBeInstanceOf(GoogleAuthExpiredError)
  })

  it('其他錯誤是 GoogleApiError（可重試）', async () => {
    mockFetch([{ status: 500, text: 'boom' }])
    await expect(refreshAccessToken('rt-1')).rejects.toBeInstanceOf(GoogleApiError)
  })
})

describe('queryFreeBusy', () => {
  it('解析 primary 行事曆的忙碌區間', async () => {
    mockFetch([
      {
        status: 200,
        body: {
          calendars: {
            primary: {
              busy: [
                { start: '2026-09-01T01:00:00Z', end: '2026-09-01T02:00:00Z' },
                { start: '2026-09-01T05:00:00Z', end: '2026-09-01T06:30:00Z' },
              ],
            },
          },
        },
      },
    ])

    const busy = await queryFreeBusy('at-1', {
      timeMin: new Date('2026-09-01T00:00:00Z'),
      timeMax: new Date('2026-09-02T00:00:00Z'),
    })

    expect(busy).toHaveLength(2)
    expect(busy[0].start.toISOString()).toBe('2026-09-01T01:00:00.000Z')
    expect(busy[1].end.toISOString()).toBe('2026-09-01T06:30:00.000Z')
  })

  it('沒有忙碌時段時回空陣列而不是丟錯', async () => {
    mockFetch([{ status: 200, body: { calendars: { primary: {} } } }])
    const busy = await queryFreeBusy('at-1', {
      timeMin: new Date('2026-09-01T00:00:00Z'),
      timeMax: new Date('2026-09-02T00:00:00Z'),
    })
    expect(busy).toEqual([])
  })

  it('401 視為授權失效', async () => {
    mockFetch([{ status: 401, text: 'unauthorized' }])
    await expect(
      queryFreeBusy('stale', {
        timeMin: new Date('2026-09-01T00:00:00Z'),
        timeMax: new Date('2026-09-02T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(GoogleAuthExpiredError)
  })
})

describe('insertEvent', () => {
  it('回傳事件 id 與 Meet 連結（hangoutLink 優先）', async () => {
    mockFetch([{ status: 200, body: { id: 'evt-1', hangoutLink: 'https://meet.google.com/abc' } }])
    const created = await insertEvent('at-1', {
      summary: '測試',
      start: new Date('2026-09-01T01:00:00Z'),
      end: new Date('2026-09-01T02:00:00Z'),
      timeZone: 'Asia/Taipei',
      attendeeEmails: ['a@example.com'],
      createMeetLink: true,
    })
    expect(created.id).toBe('evt-1')
    expect(created.meetUrl).toBe('https://meet.google.com/abc')
  })

  it('沒有 hangoutLink 時退回 conferenceData 的 video entry point', async () => {
    mockFetch([
      {
        status: 200,
        body: {
          id: 'evt-2',
          conferenceData: {
            entryPoints: [
              { entryPointType: 'phone', uri: 'tel:+123' },
              { entryPointType: 'video', uri: 'https://meet.google.com/xyz' },
            ],
          },
        },
      },
    ])
    const created = await insertEvent('at-1', {
      summary: '測試',
      start: new Date('2026-09-01T01:00:00Z'),
      end: new Date('2026-09-01T02:00:00Z'),
      timeZone: 'Asia/Taipei',
      attendeeEmails: [],
      createMeetLink: true,
    })
    expect(created.meetUrl).toBe('https://meet.google.com/xyz')
  })

  it('帶 sendUpdates=all，讓 Google 負責寄邀請', async () => {
    const fetchMock = mockFetch([{ status: 200, body: { id: 'evt-3' } }])
    await insertEvent('at-1', {
      summary: '測試',
      start: new Date('2026-09-01T01:00:00Z'),
      end: new Date('2026-09-01T02:00:00Z'),
      timeZone: 'Asia/Taipei',
      attendeeEmails: ['a@example.com'],
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('sendUpdates=all')
  })
})

describe('deleteEvent', () => {
  it('事件已不存在（404）視為成功——目標狀態已達成', async () => {
    mockFetch([{ status: 404, text: 'not found' }])
    await expect(deleteEvent('at-1', 'gone')).resolves.toBeUndefined()
  })

  it('410 Gone 同樣視為成功', async () => {
    mockFetch([{ status: 410, text: 'gone' }])
    await expect(deleteEvent('at-1', 'gone')).resolves.toBeUndefined()
  })

  it('其他錯誤照樣往外丟', async () => {
    mockFetch([{ status: 500, text: 'boom' }])
    await expect(deleteEvent('at-1', 'evt-1')).rejects.toBeInstanceOf(GoogleApiError)
  })
})
