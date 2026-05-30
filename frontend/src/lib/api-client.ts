import { getSession } from 'next-auth/react'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

async function getAuthHeader(): Promise<HeadersInit> {
  const session = await getSession()
  const token = (session as any)?.vexaToken
  if (!token) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${token}` }
}

export const apiClient = {
  async get<T>(path: string): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, { headers })
    if (!res.ok) throw await res.json()
    return res.json()
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw await res.json()
    return res.json()
  },

  async postForm<T>(path: string, formData: FormData): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    })
    if (!res.ok) throw await res.json()
    return res.json()
  },

  async patch<T>(path: string, body: unknown): Promise<T> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await res.json()
    return res.json()
  },

  async delete(path: string): Promise<void> {
    const headers = await getAuthHeader()
    const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers })
    if (!res.ok) throw await res.json()
  },
}
