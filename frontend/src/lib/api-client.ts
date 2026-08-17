import { getSession } from 'next-auth/react'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

async function getAuthHeader(): Promise<HeadersInit> {
  const session = await getSession()
  const token = (session as any)?.authToken
  if (!token) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${token}` }
}

/**
 * 從失敗回應丟出結構化錯誤。
 * 後端錯誤多為 JSON（{ error_code, message }），但 404/500 等可能回純文字
 * （如 Hono 預設的 "404 Not Found"）。直接 res.json() 會丟出令人困惑的
 * 「Unexpected non-whitespace character after JSON」而非真正的 HTTP 錯誤，
 * 故先讀文字再嘗試解析，非 JSON 時退回帶狀態碼的通用錯誤物件。
 */
async function throwHttpError(res: Response): Promise<never> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') throw parsed
    } catch (e) {
      // 已是解析後的錯誤物件（非 SyntaxError）→ 直接往外拋
      if (!(e instanceof SyntaxError)) throw e
      // 否則為非 JSON body，落到下方通用錯誤
    }
  }
  throw { error_code: 'HTTP_ERROR', message: `操作失敗（HTTP ${res.status}）`, status: res.status }
}

export const apiClient = {
  async get<T>(path: string): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, { headers })
    if (!res.ok) await throwHttpError(res)
    return res.json()
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) await throwHttpError(res)
    return res.json()
  },

  async postForm<T>(path: string, formData: FormData): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    })
    if (!res.ok) await throwHttpError(res)
    return res.json()
  },

  async patch<T>(path: string, body: unknown): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) await throwHttpError(res)
    return res.json()
  },

  async delete(path: string): Promise<void> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers })
    if (!res.ok) await throwHttpError(res)
  },
}
