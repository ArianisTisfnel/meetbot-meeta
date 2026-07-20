import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getServerSession } from 'next-auth/next'

// 避免載入真實 auth.ts（會拉進 next-auth GoogleProvider 與 child_process）
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { POST } from '../../../../frontend/src/app/api/meet/create/route'

const mockedGetServerSession = vi.mocked(getServerSession)

const MEET_URL = 'https://meet.google.com/abc-defg-hij'

/** 模擬 Google Calendar API 的成功回應（含 video entry point） */
function googleOkResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1-234' },
          { entryPointType: 'video', uri: MEET_URL },
        ],
      },
      ...overrides,
    }),
  }
}

function googleErrorResponse(status: number, bodyText: string) {
  return {
    ok: false,
    status,
    text: async () => bodyText,
  }
}

describe('POST /api/meet/create', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // 錯誤路徑會 console.error，測試中靜音避免干擾輸出
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('授權檢查', () => {
    it('無 session → 401，且不呼叫 Google API', async () => {
      mockedGetServerSession.mockResolvedValue(null)

      const res = await POST()
      const body = await res.json()

      expect(res.status).toBe(401)
      expect(body.error).toContain('未授權')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('session 存在但無 googleAccessToken → 401', async () => {
      mockedGetServerSession.mockResolvedValue({ user: { email: 'a@b.c' } })

      const res = await POST()

      expect(res.status).toBe(401)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('成功路徑', () => {
    beforeEach(() => {
      mockedGetServerSession.mockResolvedValue({ googleAccessToken: 'token-123' })
    })

    it('回傳 video entry point 的 meetUrl', async () => {
      fetchMock.mockResolvedValue(googleOkResponse())

      const res = await POST()
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toEqual({ meetUrl: MEET_URL })
    })

    it('以 Bearer token 呼叫 Calendar API，URL 帶 conferenceDataVersion=1', async () => {
      fetchMock.mockResolvedValue(googleOkResponse())

      await POST()

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1'
      )
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer token-123')
      expect(init.headers['Content-Type']).toBe('application/json')
    })

    it('事件 body：hangoutsMeet + requestId + 一小時長度', async () => {
      fetchMock.mockResolvedValue(googleOkResponse())

      await POST()

      const [, init] = fetchMock.mock.calls[0]
      const payload = JSON.parse(init.body)

      expect(payload.summary).toBe('蜜塔會議')
      expect(payload.conferenceData.createRequest.conferenceSolutionKey.type).toBe(
        'hangoutsMeet'
      )
      // requestId 需存在且唯一性由 UUID 保證（格式檢查即可）
      expect(payload.conferenceData.createRequest.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )

      const start = new Date(payload.start.dateTime).getTime()
      const end = new Date(payload.end.dateTime).getTime()
      expect(end - start).toBe(60 * 60 * 1000)
    })
  })

  describe('Google API 錯誤處理', () => {
    beforeEach(() => {
      mockedGetServerSession.mockResolvedValue({ googleAccessToken: 'token-123' })
    })

    it('JSON 錯誤 body → 502，訊息取 error.message', async () => {
      fetchMock.mockResolvedValue(
        googleErrorResponse(
          403,
          JSON.stringify({ error: { message: 'Calendar API has not been used' } })
        )
      )

      const res = await POST()
      const body = await res.json()

      expect(res.status).toBe(502)
      expect(body.error).toBe('建立 Meet 失敗：Calendar API has not been used')
    })

    it('JSON 錯誤 body 但無 error.message → 502，退回 HTTP 狀態碼', async () => {
      fetchMock.mockResolvedValue(googleErrorResponse(500, JSON.stringify({ foo: 'bar' })))

      const res = await POST()
      const body = await res.json()

      expect(res.status).toBe(502)
      expect(body.error).toBe('建立 Meet 失敗：HTTP 500')
    })

    it('HTML 錯誤頁（非 JSON）→ 502，僅保留狀態碼、不外洩頁面內容', async () => {
      fetchMock.mockResolvedValue(
        googleErrorResponse(401, '<html><body>Unauthorized</body></html>')
      )

      const res = await POST()
      const body = await res.json()

      expect(res.status).toBe(502)
      expect(body.error).toBe('建立 Meet 失敗：HTTP 401')
      expect(body.error).not.toContain('<html>')
    })
  })

  describe('回應缺 Meet 連結', () => {
    beforeEach(() => {
      mockedGetServerSession.mockResolvedValue({ googleAccessToken: 'token-123' })
    })

    it('無 conferenceData → 502「未取得 Meet 連結」', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })

      const res = await POST()
      const body = await res.json()

      expect(res.status).toBe(502)
      expect(body.error).toBe('未取得 Meet 連結')
    })

    it('entryPoints 只有非 video 類型 → 502', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          conferenceData: {
            entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1-234' }],
          },
        }),
      })

      const res = await POST()

      expect(res.status).toBe(502)
    })

    it('video entry point 存在但缺 uri → 502', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          conferenceData: { entryPoints: [{ entryPointType: 'video' }] },
        }),
      })

      const res = await POST()

      expect(res.status).toBe(502)
    })
  })
})
