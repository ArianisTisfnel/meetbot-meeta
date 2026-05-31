/**
 * 驗證後端 /projects API 完整 CRUD 流程：
 *   1. 取得 Vexa token（透過 docker exec Admin API）
 *   2. 未帶 token → 401
 *   3. 帶 token GET → 200，body 為分頁陣列
 *   4. 建立 project → 回傳含 id 的物件
 *   5. 再次 GET → 新 project 出現在列表
 *   6. 刪除 project → 成功（cleanup）
 *
 * 前提：後端在 localhost:4000 運行，vexa-lite 容器正在運行
 */
import { execFileSync } from 'child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:4000'
const ADMIN_KEY = process.env.VEXA_ADMIN_API_KEY ?? 'my-local-admin-token-2026'
const TEST_EMAIL = 'test-integration@example.com'

function getVexaToken(): string {
  const idResult = execFileSync(
    'docker',
    ['ps', '--filter', 'ancestor=vexaai/vexa-lite:latest', '-q'],
    { timeout: 5000 }
  )
  const containerId = idResult.toString().trim().split('\n')[0]
  if (!containerId) throw new Error('vexa-lite 容器未啟動')

  function dockerCurl(args: string[]): unknown {
    const r = execFileSync('docker', ['exec', containerId, 'curl', '-s', ...args], {
      timeout: 10000,
    })
    return JSON.parse(r.toString())
  }

  const user = dockerCurl([
    '-X', 'POST',
    '-H', `X-Admin-API-Key: ${ADMIN_KEY}`,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ email: TEST_EMAIL }),
    'http://localhost:8057/admin/users',
  ]) as { id: number }

  const tokenResp = dockerCurl([
    '-X', 'POST',
    '-H', `X-Admin-API-Key: ${ADMIN_KEY}`,
    `http://localhost:8057/admin/users/${user.id}/tokens`,
  ]) as { token: string }

  return tokenResp.token
}

describe('Backend /projects API', () => {
  let token: string
  let createdProjectId: string

  beforeAll(() => {
    token = getVexaToken()
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
