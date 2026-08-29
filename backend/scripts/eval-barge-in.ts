/**
 * 讓路（barge-in）判定的離線統計 —— 「她被打斷了幾次，其中幾次不該被打斷」。
 *
 * 為什麼需要這支：08-19 把字數門檻從 4 調到 7、加了開口寬限期之後，
 * 「有沒有變好」這個問題**答不出來**——當時最常走的那條出路（長度不足）完全沒有 log，
 * 誤打斷率只能事後人工從殘缺線索拼湊。沒有基準線就無法證明任何改動有效。
 *
 * 本檔只讀 log、不跑任何模型、不需要開會，可以直接對歷史檔案跑。
 *
 * 跑法（backend/ 目錄）：
 *   npx tsx scripts/eval-barge-in.ts                      # 讀 logs/backend.log 全部
 *   npx tsx scripts/eval-barge-in.ts --since 2026-08-18   # 只看這天之後
 *   npx tsx scripts/eval-barge-in.ts --log ../other.log   # 指定檔案
 *   npx tsx scripts/eval-barge-in.ts --list               # 逐筆列出真的讓路的那些
 *
 * ⚠️ **「誤打斷率」無法全自動判定**——「這次該不該停」最終要人看過才算數。
 *    本檔給的是最接近的自動代理指標：**旁人觸發率**（讓路事件裡由非提問者觸發的比例）。
 *    08-18 的人工分析顯示誤觸發幾乎全是旁人交談被切出來的半句，所以這個代理值
 *    高度相關，但它不是真值。要真值就用 --list 把清單抓出來人工標。
 *
 * ⚠️ 兩種 log 格式都吃：
 *    新格式 `barge-in decision`（2026-08-20 起，每條出路都有，含 who/reason）
 *    舊格式 `barge-in: human speech while bot speaking, yielding`（只有真的讓路的那些）
 *    舊格式沒有「沒讓路」的紀錄，所以它只算得出讓路次數，算不出比率——
 *    這正是新格式存在的理由。混在同一個檔案時會分開統計，不會互相汙染。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const LOG_PATH = resolve(HERE, '..', flagValue('--log') ?? 'logs/backend.log')
const SINCE = flagValue('--since')
const LIST = args.includes('--list')

/** 新格式的一筆判定。欄位對齊 wake-word-detector.ts 的 decide()。 */
interface Decision {
  time: number
  meetingInstanceId?: string
  decision: 'fired' | 'skipped'
  reason: string
  who: 'asker' | 'bystander' | 'unknown'
  speaker: string | null
  asker: string | null
  chars: number
  minChars: number
  stopping: boolean
  text: string
}

/** 舊格式：只有「真的讓路了」這件事，沒有被擋下來的那些。 */
interface LegacyYield {
  time: number
  meetingInstanceId?: string
  speaker: string
  text: string
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * 真實會議的 meetingInstanceId 一律是 UUID；測試 fixture 用的是 'meet-1'、'meet-ij-1' 這種。
 *
 * 為什麼要在這裡擋：logger 以前**跑單元測試也會 append 進正式的 backend.log**
 *（2026-08-20 已修，見 middleware/logger.ts），但歷史檔案裡已經躺了幾百行假資料。
 * 光靠修 logger 只能防未來，舊檔案照樣會把統計算歪——所以讀取端也要能自己認出來。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isRealMeeting = (id: unknown): boolean => typeof id === 'string' && UUID_RE.test(id)

function parse(): { decisions: Decision[]; legacy: LegacyYield[] } {
  if (!existsSync(LOG_PATH)) {
    console.error(`找不到 log：${LOG_PATH}`)
    process.exit(1)
  }
  const decisions: Decision[] = []
  const legacy: LegacyYield[] = []

  for (const line of readFileSync(LOG_PATH, 'utf8').split('\n')) {
    if (!line.includes('barge-in')) continue // 先做便宜的字串比對再 JSON.parse（log 動輒數十萬行）
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // 半行、被截斷的尾巴：略過
    }
    const time = typeof rec.time === 'number' ? rec.time : 0
    if (SINCE && day(time) < SINCE) continue
    if (!isRealMeeting(rec.meetingInstanceId)) continue // 測試 fixture，見 isRealMeeting

    if (rec.msg === 'barge-in decision') {
      decisions.push(rec as unknown as Decision)
    } else if (rec.msg === 'barge-in: human speech while bot speaking, yielding') {
      legacy.push({
        time,
        meetingInstanceId: rec.meetingInstanceId as string | undefined,
        speaker: (rec.speaker as string) ?? '',
        text: (rec.text as string) ?? '',
      })
    }
  }
  return { decisions, legacy }
}

const pct = (n: number, total: number): string =>
  total === 0 ? '—' : `${((n / total) * 100).toFixed(1)}%`

function tally<T>(rows: T[], key: (r: T) => string): Array<[string, number]> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

function main(): void {
  const { decisions, legacy } = parse()

  console.log(`log：${LOG_PATH}`)
  if (SINCE) console.log(`起算日：${SINCE}`)
  console.log('')

  // ── 新格式：完整的判定分佈 ─────────────────────────────────────────────────
  if (decisions.length === 0) {
    console.log('（沒有新格式的 `barge-in decision` 紀錄）')
    console.log('新格式從 2026-08-20 的講者閘門改動起才開始寫，舊會議只會有下面的舊格式。')
  } else {
    const fired = decisions.filter((d) => d.decision === 'fired')
    const stops = fired.filter((d) => d.stopping)
    const speech = fired.filter((d) => !d.stopping)
    const bystanderFired = speech.filter((d) => d.who === 'bystander')

    console.log('── 判定分佈（新格式）─────────────────────────────')
    console.log(`候選總數（她講話時收到的發言）  ${decisions.length}`)
    console.log(`  讓路                          ${fired.length}  (${pct(fired.length, decisions.length)})`)
    console.log(`    ├ 明確叫停                  ${stops.length}`)
    console.log(`    └ 一般發言                  ${speech.length}`)
    console.log(`  擋下                          ${decisions.length - fired.length}`)
    for (const [reason, n] of tally(decisions.filter((d) => d.decision === 'skipped'), (d) => d.reason)) {
      console.log(`    └ ${reason.padEnd(26)}${n}`)
    }

    console.log('')
    console.log('── 講者身分 ─────────────────────────────────────')
    for (const w of ['asker', 'bystander', 'unknown'] as const) {
      const all = decisions.filter((d) => d.who === w)
      const f = all.filter((d) => d.decision === 'fired')
      console.log(`${w.padEnd(11)}候選 ${String(all.length).padStart(5)}   讓路 ${String(f.length).padStart(5)}  (${pct(f.length, all.length)})`)
    }

    console.log('')
    console.log('── 代理指標 ─────────────────────────────────────')
    console.log(`旁人觸發率  ${pct(bystanderFired.length, speech.length)}  （非叫停的讓路裡，由非提問者觸發的比例）`)
    console.log('目標 < 2%（業界誤打斷率目標）。⚠️ 這是代理值不是真值，人工標請用 --list。')
    if (speech.some((d) => d.who === 'unknown')) {
      const u = speech.filter((d) => d.who === 'unknown').length
      console.log(`⚠️ 有 ${u} 次讓路的講者或提問者未知（走 7 字退路），這些不計入上面的比率。`)
      console.log('   這個數字高代表講者歸屬不可靠，講者閘門發揮不了作用——先修多音軌。')
    }

    if (LIST) {
      console.log('')
      console.log('── 逐筆讓路事件（人工標用）───────────────────────')
      for (const d of fired) {
        const when = new Date(d.time).toISOString().replace('T', ' ').slice(0, 19)
        const tag = d.stopping ? '叫停' : d.who
        console.log(`${when}  [${String(tag).padEnd(9)}] ${String(d.speaker ?? '?').padEnd(12)} ${d.chars}字  「${d.text}」`)
      }
    }
  }

  // ── 舊格式：只有讓路次數 ───────────────────────────────────────────────────
  if (legacy.length > 0) {
    console.log('')
    console.log('── 舊格式（只記讓路，無法算比率）─────────────────')
    console.log(`讓路事件總數  ${legacy.length}`)
    const named = legacy.filter((l) => l.speaker).length
    console.log(`  有講者名字  ${named}  (${pct(named, legacy.length)})`)
    console.log('')
    for (const [d, n] of tally(legacy, (l) => day(l.time)).sort()) {
      console.log(`  ${d}  ${n}`)
    }
    if (LIST) {
      console.log('')
      for (const l of legacy) {
        const when = new Date(l.time).toISOString().replace('T', ' ').slice(0, 19)
        console.log(`${when}  ${(l.speaker || '?').padEnd(12)} 「${l.text}」`)
      }
    }
  }
}

main()
