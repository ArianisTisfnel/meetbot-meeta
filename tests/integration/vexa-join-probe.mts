/**
 * Vexa 加入能力探測（手動執行，非 vitest）
 *
 * 目的：撇開 meetbot 後端與 failover，單獨驗證「Vexa bot 到底進不進得去 Google Meet」，
 * 並即時把 Vexa 存在 DB 的 bot log（reCAPTCHA / 等候室 / 准入）翻出來，給出明確判定：
 *   - ADMITTED：bot 成功進會議（會再聽 45 秒逐字稿驗證轉錄）
 *   - BLOCKED-CAPTCHA：Google reCAPTCHA bot 偵測（換網路 / 降頻 / VNC 人工解才有救）
 *   - BLOCKED-WAITING：bot 有到等候室，但無人按「允許」或被拒
 *   - TIMEOUT-UNKNOWN：逾時且 log 看不出原因
 *
 * 用法（從 backend/ 目錄執行，重用 backend 的 .env 與 node_modules）：
 *   cd backend
 *   npx tsx --env-file .env ../tests/integration/vexa-join-probe.mts <google-meet-url> [timeout秒=300]
 *
 * 步驟：
 *   1. 自己先用瀏覽器開好一場 Google Meet 並留在會議中
 *   2. 執行本腳本，等 bot 出現在等候室時按「允許加入」
 *   3. 看腳本輸出的判定結果
 */
import { execFileSync } from 'child_process'
import { prisma } from '../../backend/src/lib/prisma.js'
import { parseGoogleMeetUrl } from '../../backend/src/lib/vexa.js'
import { VexaAdapter } from '../../backend/src/provider/vexa-adapter.js'
import { BotAdmissionError, type BotSession } from '../../backend/src/provider/types.js'

const meetUrl = process.argv[2]
const timeoutSec = Number(process.argv[3] ?? 300)

if (!meetUrl) {
  console.error('用法: npx tsx --env-file .env ../tests/integration/vexa-join-probe.mts <google-meet-url> [timeout秒=300]')
  process.exit(1)
}

const nativeMeetingId = parseGoogleMeetUrl(meetUrl)
if (!nativeMeetingId) {
  console.error(`無效的 Google Meet URL: ${meetUrl}`)
  process.exit(1)
}

// ── 1. 透過 Admin API 建立/取得探測用 user + token ────────────────────────────
// Admin API（8057）從主機直連會被 reset，只能 docker exec 進容器打（與 vexa-auth.test.ts 同法）。

const ADMIN_KEY = process.env.VEXA_ADMIN_API_KEY ?? 'my-local-admin-token-2026'
const PROBE_EMAIL = 'vexa-join-probe@example.com'

function getVexaContainerId(): string {
  const ids = execFileSync('docker', ['ps', '-q'], { timeout: 5_000 }).toString().trim().split('\n')
  for (const id of ids) {
    if (!id) continue
    const img = execFileSync('docker', ['inspect', id, '--format', '{{.Config.Image}}'], { timeout: 5_000 })
      .toString()
      .trim()
    if (img.startsWith('vexaai/vexa-lite')) return id
  }
  throw new Error('找不到運行中的 vexaai/vexa-lite 容器')
}

function adminFetch<T>(containerId: string, method: string, path: string, body?: unknown): T {
  const args = ['exec', containerId, 'curl', '-s', '-X', method, '-H', `X-Admin-API-Key: ${ADMIN_KEY}`]
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body))
  args.push(`http://localhost:8057${path}`)
  const out = execFileSync('docker', args, { timeout: 15_000 }).toString()
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`Admin API ${method} ${path} 回應非 JSON: ${out.slice(0, 200)}`)
  }
}

// ── 2. 背景 tail Vexa 存到 DB 的 bot log（過濾出 admission 相關訊息） ─────────────

const INTERESTING = /recaptcha|captcha|bot-detection|admission|admitted|waiting|reject|denied|return to home|ask to join|joined|kicked|removed/i
const NOISE = /trying selector|no button found|page-error|screenshot|polling for google meet admission|leave button detection/i

const seenLogs = new Set<string>()
let sawCaptcha = false
let sawWaitingRoom = false
let lastMeetingStatus: string | null = null
const probeStartedAt = new Date()

async function tailBotLogs(): Promise<void> {
  try {
    const rows = await prisma.$queryRaw<Array<{ id: number; status: string; data: any }>>`
      SELECT id, status, data FROM public.meetings
      WHERE platform_specific_id = ${nativeMeetingId} AND created_at >= ${probeStartedAt}
      ORDER BY id DESC LIMIT 1
    `
    const row = rows[0]
    if (!row) return

    if (row.status !== lastMeetingStatus) {
      lastMeetingStatus = row.status
      console.log(`[vexa] meeting ${row.id} 狀態 → ${row.status}`)
    }

    const botLogs: string[] = row.data?.bot_logs ?? []
    for (const line of botLogs) {
      let entry: { ts?: string; msg?: string }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const msg = entry.msg ?? ''
      if (!INTERESTING.test(msg) || NOISE.test(msg)) continue
      const key = `${entry.ts}|${msg}`
      if (seenLogs.has(key)) continue
      seenLogs.add(key)

      if (/recaptcha|captcha|bot-detection/i.test(msg)) sawCaptcha = true
      if (/waiting room|waiting for .* admission/i.test(msg)) sawWaitingRoom = true
      console.log(`[bot ] ${entry.ts} ${msg}`)
    }
  } catch (err) {
    console.warn('[probe] bot log 讀取失敗（略過）:', (err as Error).message)
  }
}

// ── 3. 派 bot + 等 admitted（與正式流程走同一條 VexaAdapter 路徑） ────────────────

let session: BotSession | null = null
let segmentCount = 0

async function main(): Promise<number> {
  console.log(`[probe] 目標會議: ${meetUrl}（native id: ${nativeMeetingId}）`)
  console.log(`[probe] admission timeout: ${timeoutSec} 秒`)
  console.log('[probe] 請確認你人已在會議中，bot 出現在等候室時記得按「允許加入」\n')

  const containerId = getVexaContainerId()
  const user = adminFetch<{ id: number }>(containerId, 'POST', '/admin/users', { email: PROBE_EMAIL })
  if (typeof user.id !== 'number') throw new Error(`Admin API 建立 user 失敗: ${JSON.stringify(user)}`)
  const { token } = adminFetch<{ token: string }>(containerId, 'POST', `/admin/users/${user.id}/tokens`)
  if (!token) throw new Error('Admin API 建立 token 失敗')
  console.log(`[probe] 已取得探測用 token（user id: ${user.id}）`)

  const tailTimer = setInterval(() => void tailBotLogs(), 3_000)
  const adapter = new VexaAdapter(timeoutSec * 1_000)

  try {
    session = await adapter.join(
      meetUrl,
      { platform: 'google_meet', nativeMeetingId, vexaToken: token },
      {
        onSegment: (seg) => {
          segmentCount++
          if (segmentCount <= 5) console.log(`[逐字稿] ${seg.speaker ?? '?'}: ${seg.text}`)
        },
        onStatus: (ev) => console.log(`[status] ${JSON.stringify(ev)}`),
      },
    )

    console.log('\n✅ 判定: ADMITTED — Vexa bot 成功進入會議！')
    console.log('[probe] 接下來 45 秒請隨便說幾句話，驗證即時轉錄...\n')
    await new Promise((r) => setTimeout(r, 45_000))
    console.log(
      segmentCount > 0
        ? `\n✅ 即時轉錄正常（收到 ${segmentCount} 個 segment）`
        : '\n⚠️ bot 進去了，但 45 秒內沒收到任何逐字稿 segment（轉錄可能有問題）',
    )
    await adapter.leave(session)
    console.log('[probe] bot 已離開會議')
    clearInterval(tailTimer)
    return 0
  } catch (err) {
    clearInterval(tailTimer)
    await tailBotLogs() // 失敗後再撈一次完整 log，確保證據都印出來

    if (err instanceof BotAdmissionError) {
      console.log(`\n[probe] join 失敗: ${err.reason}`)
      if (sawCaptcha) {
        console.log('❌ 判定: BLOCKED-CAPTCHA — Google reCAPTCHA bot 偵測擋住了 bot')
        console.log('   對策: 換網路（IP）/ 降低測試頻率 / 重建容器加 -p 5900:5900 用 VNC 人工解')
      } else if (sawWaitingRoom) {
        console.log('❌ 判定: BLOCKED-WAITING — bot 有到等候室，但無人按「允許」或被主持人拒絕')
        console.log('   對策: 確認你人在會議中，且等候室提示出現時按了「允許加入」')
      } else {
        console.log('❓ 判定: TIMEOUT-UNKNOWN — 逾時且 log 看不出明確原因，請看上面 [bot] 訊息')
      }
      return 2
    }
    console.error('\n[probe] 非 admission 錯誤（dispatch/API 層就失敗了）:', err)
    return 3
  }
}

process.on('SIGINT', async () => {
  console.log('\n[probe] 收到中斷，撤除 bot...')
  if (session) await new VexaAdapter().leave(session).catch(() => {})
  await prisma.$disconnect().catch(() => {})
  process.exit(130)
})

const code = await main()
await prisma.$disconnect().catch(() => {})
process.exit(code)
