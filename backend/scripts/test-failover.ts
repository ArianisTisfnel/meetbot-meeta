/**
 * 一次性手動測試：驗證 failover 串接（走真實的 botProvider = FailoverProvider 單例）。
 *
 * 作法：傳一個無效的 vexaToken 強制 Vexa.join 失敗 → FailoverProvider 應自動 fallback 到 Recall。
 * 這走的是正式 provider 接線（與 createMeeting 用的同一個 botProvider），不是假的。
 *
 * 跑法（從 backend/）：
 *   npx tsx --env-file .env scripts/test-failover.ts "<google-meet-url>"
 *
 * Recall bot 進場時請在 30 秒內手動「准許加入」。預期最終 provider=recall。
 *
 * ⚠️ 測試用腳本，驗完可刪。
 */
import { botProvider } from '../src/provider/index.js'
import { parseGoogleMeetUrl } from '../src/lib/vexa.js'
import type { LiveHandlers } from '../src/provider/types.js'

const url = process.argv[2]
if (!url) {
  console.error('用法: npx tsx --env-file .env scripts/test-failover.ts "<google-meet-url>"')
  process.exit(1)
}
const nativeMeetingId = parseGoogleMeetUrl(url)
if (!nativeMeetingId) {
  console.error('無效的 Google Meet URL:', url)
  process.exit(1)
}

const handlers: LiveHandlers = {
  onSegment: (seg) => console.log('[SEGMENT]', JSON.stringify(seg)),
  onStatus: (ev) => console.log('[STATUS]', JSON.stringify(ev)),
  onChat: (msg) => console.log('[CHAT]', JSON.stringify(msg)),
}

async function main() {
  console.log('→ 透過 botProvider 派 bot（Vexa 會因無效 token 失敗 → 應 fallback 到 Recall）')
  console.log('→ Recall bot 進場後請在 30 秒內手動「准許加入」')

  let session
  try {
    session = await botProvider.join(
      url,
      { platform: 'google_meet', nativeMeetingId: nativeMeetingId!, vexaToken: 'INVALID_TOKEN_TO_FORCE_FAILOVER', difyDatasetId: null },
      handlers,
    )
  } catch (err) {
    console.error('✗ 兩個 provider 都失敗:', (err as Error).message)
    process.exit(1)
  }

  console.log(`✓ admitted via provider=${session.provider}  botId=${session.providerMeetingId}`)
  if (session.provider !== 'recall') {
    console.warn('⚠️ 預期 provider=recall,但拿到', session.provider)
  } else {
    console.log('✓ failover 成功:Vexa 失敗 → 自動切到 Recall')
  }

  console.log('→ 維持 30 秒後拉一次會後逐字稿並離開（會議中拉到的通常為空,屬正常）…')
  await new Promise((r) => setTimeout(r, 30_000))
  try {
    const full = await botProvider.getTranscript(session)
    console.log(`→ getTranscript 正規化結果(${full.length} 段):`, JSON.stringify(full.slice(0, 5)))
  } catch (err) {
    console.error('✗ getTranscript 失敗:', (err as Error).message)
  }
  await botProvider.leave(session)
  console.log('✓ bot 已離開,測試結束')
  process.exit(0)
}

main()
