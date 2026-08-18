/**
 * 驗證後端 /projects API 完整 CRUD 流程：
 *   1. 取得 API token（POST /internal/token，共享密鑰 INTERNAL_AUTH_SECRET）
 *   2. 未帶 token → 401
 *   3. 帶 token GET → 200，body 為分頁陣列
 *   4. 建立 project → 回傳含 id 的物件
 *   5. 再次 GET → 新 project 出現在列表
 *   6. 刪除 project → 成功（cleanup）
 *
 * 前提：後端在 localhost:4000 運行，且 backend/.env 有 INTERNAL_AUTH_SECRET。
 * （移除 Vexa 之前這裡是 docker exec 進 vexa-lite 打 Admin API 拿 token，
 *   身份層搬進 app schema 之後改走後端自己的內部端點。）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:4000'
const INTERNAL_SECRET = process.env.INTERNAL_AUTH_SECRET ?? ''
const TEST_EMAIL = 'test-integration@example.com'

async function getApiToken(): Promise<string> {
  if (!INTERNAL_SECRET) {
    throw new Error('INTERNAL_AUTH_SECRET 未設定（backend/.env 與此測試環境需同值）')
  }
  const res = await fetch(`${BACKEND}/internal/token`, {
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, name: 'Integration Test' }),
  })
  if (!res.ok) throw new Error(`/internal/token 回 ${res.status}`)
  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error('/internal/token 沒有回 token')
  return data.token
}

describe('Backend /projects API', () => {
  let token: string
  let createdProjectId: string

  beforeAll(async () => {
    token = await getApiToken()
  })

  afterAll(async () => {
    if (createdProjectId) {
      await fetch(`${BACKEND}/projects/${createdProjectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  })

  it('未帶 token → 401', async () => {
    const res = await fetch(`${BACKEND}/projects`)
    expect(res.status).toBe(401)
  })

  it('帶 token GET /projects → 200，body 含 items 陣列', async () => {
    const res = await fetch(`${BACKEND}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { items: unknown[] }
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('POST /projects 建立 project → 回傳含 id 的物件', async () => {
    const res = await fetch(`${BACKEND}/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Integration Test Project',
        description: '整合測試用，執行後自動刪除',
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; name: string }
    expect(typeof body.id).toBe('string')
    expect(body.name).toBe('Integration Test Project')
    createdProjectId = body.id
  })

  it('GET /projects → 新建 project 出現在列表', async () => {
    const res = await fetch(`${BACKEND}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = await res.json() as { items: Array<{ id: string }> }
    const ids = body.items.map((p) => p.id)
    expect(ids).toContain(createdProjectId)
  })

  it('DELETE /projects/:id → 成功刪除', async () => {
    const res = await fetch(`${BACKEND}/projects/${createdProjectId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(204)
    createdProjectId = '' // 避免 afterAll 重複刪除
  })
})
