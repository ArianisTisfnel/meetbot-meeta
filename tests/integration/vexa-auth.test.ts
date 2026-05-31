/**
 * 驗證 auth.ts 的 docker exec 邏輯：
 *   1. 取得 vexa-lite 容器 ID
 *   2. POST /admin/users  → 建立或取得 user（回傳 id）
 *   3. POST /admin/users/:id/tokens → 建立 token（回傳 token 字串）
 *
 * 前提：vexa-lite 容器正在運行，VEXA_ADMIN_API_KEY 設定正確
 */
import { execFileSync } from 'child_process'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_KEY = process.env.VEXA_ADMIN_API_KEY ?? 'my-local-admin-token-2026'
const TEST_EMAIL = 'test-integration@example.com'

function getVexaContainerId(): string {
  const result = execFileSync(
    'docker',
    ['ps', '--filter', 'ancestor=vexaai/vexa-lite:latest', '-q'],
    { timeout: 5000 }
  )
  const id = result.toString().trim().split('\n')[0]
  if (!id) throw new Error('vexa-lite 容器未啟動')
  return id
}

function dockerCurl(containerId: string, args: string[]): unknown {
  const result = execFileSync('docker', ['exec', containerId, 'curl', '-s', ...args], {
    timeout: 10000,
  })
  return JSON.parse(result.toString())
}

describe('Vexa Admin API via docker exec', () => {
  let containerId: string

  beforeAll(() => {
    containerId = getVexaContainerId()
  })

  it('容器存在且健康', () => {
    expect(containerId).toBeTruthy()
  })

  it('POST /admin/users 回傳含 id 的物件', () => {
    const user = dockerCurl(containerId, [
      '-X', 'POST',
      '-H', `X-Admin-API-Key: ${ADMIN_KEY}`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ email: TEST_EMAIL }),
      'http://localhost:8057/admin/users',
    ]) as Record<string, unknown>

    expect(typeof user.id).toBe('number')
    expect(user.email).toBe(TEST_EMAIL)
  })

  it('POST /admin/users/:id/tokens 回傳含 token 字串', () => {
    const user = dockerCurl(containerId, [
      '-X', 'POST',
      '-H', `X-Admin-API-Key: ${ADMIN_KEY}`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ email: TEST_EMAIL }),
      'http://localhost:8057/admin/users',
    ]) as { id: number }

    const tokenResp = dockerCurl(containerId, [
      '-X', 'POST',
      '-H', `X-Admin-API-Key: ${ADMIN_KEY}`,
      `http://localhost:8057/admin/users/${user.id}/tokens`,
    ]) as Record<string, unknown>

    expect(typeof tokenResp.token).toBe('string')
    expect((tokenResp.token as string).length).toBeGreaterThan(0)
  })
})
