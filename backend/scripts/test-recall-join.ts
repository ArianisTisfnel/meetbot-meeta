/**
 * 一次性手動測試：單獨驗證 RecallAdapter（不碰 Vexa、不走 failover）。
 *
 * 用途：證明 Recall 真的能派 bot 進 Google Meet、admission 偵測正確、
 *       逐字稿能正規化成統一 schema。順便驗證 transcription_options 參數對不對。
 *
 * 跑法（從 backend/）：
 *   npx tsx --env-file .env scripts/test-recall-join.ts "<google-meet-url>"
 *
 * 進場後請在 Google Meet 手動按「准許加入」（Recall bot 預設匿名、卡等候室）。
 * 腳本會印出 admission 狀態與即時逐字稿，約 90 秒後自動讓 bot 離開。
 *
 * ⚠️ 這是測試用腳本，驗證完可刪。
 */
import { RecallAdapter } from '../src/provider/recall-adapter.js'
import { parseGoogleMeetUrl } from '../src/lib/google-meet.js'
import type { LiveHandlers } from '../src/provider/types.js'

const url = process.argv[2]
if (!url) {
  console.error('用法: npx tsx --env-file .env scripts/test-recall-join.ts "<google-meet-url>"')
  process.exit(1)
}

const nativeMeetingId = parseGoogleMeetUrl(url)
if (!nativeMeetingId) {
  console.error('無效的 Google Meet URL:', url)
  process.exit(1)
}

// admission timeout 放寬到 90 秒，給你時間手動 admit。
const recall = new RecallAdapter(90_000)

const handlers: LiveHandlers = {
  onSegment: (seg) => console.log('[SEGMENT]', JSON.stringify(seg)),
  onStatus: (ev) => console.log('[STATUS]', JSON.stringify(ev)),
  onChat: (msg) => console.log('[CHAT]', JSON.stringify(msg)),
}

async function main() {
  console.log('→ 派 Recall bot 進場…請在 Google Meet 手動「准許加入」(最多等 90 秒)')
  const t0 = Date.now()

  let session
  try {
    session = await recall.join(url, { platform: 'google_meet', nativeMeetingId: nativeMeetingId! }, handlers)
  } catch (err) {
    console.error('✗ join 失敗:', (err as Error).message)
    process.exit(1)
  }

  console.log(`✓ admitted! 耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s  provider=${session.provider} botId=${session.providerMeetingId}`)
  console.log('→ 維持 90 秒監看即時逐字稿（請在會議裡講幾句話）…')

  // 90 秒後拉一次完整逐字稿並離開
  await new Promise((r) => setTimeout(r, 90_000))

  try {
    const full = await recall.getTranscript(session)
    console.log(`→ 完整逐字稿正規化結果（${full.length} 段）:`)
    console.log(JSON.stringify(full.slice(0, 10), null, 2))
  } catch (err) {
    console.error('✗ getTranscript 失敗:', (err as Error).message)
  }

  await recall.leave(session)
  console.log('✓ bot 已離開，測試結束')
  process.exit(0)
}

main()
