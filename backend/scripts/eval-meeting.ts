/**
 * 蜜塔「定址判斷」離線評測（回報 2026-07-28 C 的第一層）。
 *
 * 拿手寫的會議劇本，逐句跑「這句該不該回應／該走哪條資料來源」，統計準確率——
 * 不用開真會議、不用多帳號，改完判斷邏輯直接重跑比較。
 *
 * 與 eval-interjection.ts 的分工：
 *   eval-interjection → 「沒人叫我，我該不該主動補充」（插話決策層）
 *   eval-meeting（本檔）→ 「這句是不是在對我說話、要走哪條路」（定址層 + 意圖分流）
 * 兩者共用同一個原則：評測 import 的是**線上跑的同一份實作**，不抄寫。
 *
 * 跑法（backend/ 目錄）：
 *   npx tsx scripts/eval-meeting.ts                           # 規則層，零 LLM 成本、秒回
 *   npx tsx --env-file .env scripts/eval-meeting.ts --address # 加上語意定址裁決（會打 LLM）
 *   npx tsx --env-file .env scripts/eval-meeting.ts --intent  # 加上意圖分流評測（會打 LLM）
 *   npx tsx scripts/eval-meeting.ts --only 代詞               # 只跑名稱含「代詞」的劇本
 *   npx tsx scripts/eval-meeting.ts --verbose                 # 連通過的案例也印出來
 *
 * ⚠️ 不加 --address 時，非呼喚句型一律當「談論蜜塔」→ 沉默，
 *    所以「該回應卻沉默」會偏高，那是預期的：那些案例本來就要靠語意裁決才會過。
 *    要看真實表現必須加 --address。
 *
 * ⚠️ 若總結出現「語意裁決有 N 次呼叫失敗」，代表 Gemini 免費層額度用完，
 *    該次數字不可信（實測踩過：429 被吞成裁決失敗，看起來像 prompt 改壞了）。
 *    額度在太平洋午夜重置（台灣下午 3-4 點）。
 *
 * 讀 scripts/meeting-scenarios.json（格式與欄位說明見該檔的 _readme）。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideAddressing,
  WAKE_PENDING_MS,
  type AddressingState,
} from '../src/sessions/addressing.js'

interface Turn {
  speaker: string
  text: string
  gapMs?: number
  why?: string
  knownFail?: boolean
  expect: { respond: boolean; route?: 'rag' | 'transcript' | 'chitchat'; question?: string }
}
interface Scenario {
  name: string
  kb: boolean
  turns: Turn[]
}
interface ScenarioFile {
  scenarios: Scenario[]
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const ONLY = flag('only')
const VERBOSE = args.includes('--verbose')
const WITH_INTENT = args.includes('--intent')
/** 句中提及是否真的送去語意裁決（會打 LLM）。不開時一律當「談論蜜塔」→ 沉默。 */
const WITH_ADDRESS = args.includes('--address')
const DEFAULT_GAP_MS = 5_000
/**
 * LLM 呼叫之間的間隔（ms）。Gemini 免費層有每分鐘額度，連續打會 429——
 * 而 429 會被吞成「裁決失敗」，讓評測結果看起來像 prompt 變差（實測踩過）。
 */
const DELAY_MS = Number(flag('delay-ms') ?? (WITH_ADDRESS || WITH_INTENT ? 5_000 : 0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 裁決呼叫失敗次數：>0 代表本次結果不可信（多半是額度用完）。 */
let unknownCount = 0

const here = dirname(fileURLToPath(import.meta.url))
const file: ScenarioFile = JSON.parse(
  readFileSync(resolve(here, flag('scenarios') ?? 'meeting-scenarios.json'), 'utf-8'),
)
const scenarios = file.scenarios.filter((s) => !ONLY || s.name.includes(ONLY))
if (!scenarios.length) {
  console.error('沒有符合的劇本。')
  process.exit(1)
}

// ── 一筆評測結果 ──────────────────────────────────────────────────────────────

type Failure = 'false-fire' | 'missed' | 'question-fidelity' | 'wrong-route'

interface Row {
  scenario: string
  turn: Turn
  pass: boolean
  failure?: Failure
  note: string
  /** 未開 --address 時遇到非呼喚句型：規則層無從判斷，不列入計分。 */
  skipped?: boolean
}

const FAILURE_LABEL: Record<Failure, string> = {
  'false-fire': '誤觸發（不該回應卻回應）',
  missed: '漏回應（該回應卻沉默）',
  'question-fidelity': '問題擷取不符',
  'wrong-route': '資料來源走錯',
}

/**
 * 跑一個劇本。
 * 以模擬時鐘推進（gapMs），並比照 wake-word-detector 施加狀態轉移，
 * 讓 debounce 與待命窗這類**跨句的時間相依行為**在離線也成立。
 */
async function runScenario(
  s: Scenario,
  classify: ((q: string, kb: boolean) => Promise<'rag' | 'transcript' | 'chitchat'>) | null,
  arbitrate: ((text: string, speaker: string, recent: Turn[]) => Promise<boolean | null>) | null,
): Promise<Row[]> {
  const state: AddressingState = { lastWakeAt: 0, wakePendingUntil: 0, wakePendingSpeaker: null }
  let now = 1_700_000_000_000 // 固定起點：結果可重現
  const rows: Row[] = []
  const history: Turn[] = []

  for (const turn of s.turns) {
    now += turn.gapMs ?? DEFAULT_GAP_MS
    let decision = decideAddressing(state, { text: turn.text, speaker: turn.speaker, now })

    // 句中提及 → 語意裁決。--address 未開時當作「談論蜜塔」（沉默），
    // 與線上「裁決失敗一律安靜」的退回行為一致。
    let skipped = false
    if (decision.kind === 'ambiguous') {
      // 沒開裁決器時，非呼喚句型無從判斷 → 標記略過，不當成回歸失敗
      if (!arbitrate) skipped = true
      // null = 呼叫失敗；線上此時退回舊行為照常回答，評測必須模擬同一條路
      if (arbitrate && DELAY_MS) await sleep(DELAY_MS)
      const verdict = arbitrate ? await arbitrate(turn.text, turn.speaker, history) : false
      const shouldAnswer = verdict !== false
      decision = shouldAnswer && decision.candidate
        ? {
            kind: 'question',
            question: decision.candidate,
            reason: verdict === null ? '⚠ 裁決呼叫失敗 → 退回舊行為' : '語意裁決 = address',
            viaPendingWindow: false,
          }
        : { kind: 'ignore', reason: arbitrate ? '語意裁決 = mention' : '非呼喚句型（未開 --address，預設沉默）' }
    }
    history.push(turn)

    // 狀態轉移必須與 handleTranscriptSegment 一致，否則測的不是真實行為
    if (decision.kind === 'wake-pending') {
      state.wakePendingUntil = now + WAKE_PENDING_MS
      state.wakePendingSpeaker = turn.speaker || null
    } else if (decision.kind === 'question') {
      state.wakePendingUntil = 0
      state.wakePendingSpeaker = null
      state.lastWakeAt = now
    }

    const responded = decision.kind === 'question'
    let pass = responded === turn.expect.respond
    let failure: Failure | undefined
    let note: string

    if (!pass) {
      failure = responded ? 'false-fire' : 'missed'
      note = responded
        ? `判定回應「${decision.kind === 'question' ? decision.question : ''}」，預期沉默`
        : `判定沉默（${decision.reason}），預期回應`
    } else if (responded && decision.kind === 'question') {
      note = `question=「${decision.question}」`
      if (turn.expect.question && !decision.question.includes(turn.expect.question)) {
        pass = false
        failure = 'question-fidelity'
        note = `question「${decision.question}」未包含預期的「${turn.expect.question}」`
      } else if (classify && turn.expect.route) {
        const route = await classify(decision.question, s.kb)
        if (route !== turn.expect.route) {
          pass = false
          failure = 'wrong-route'
          note = `走了 ${route}，預期 ${turn.expect.route}（question=「${decision.question}」）`
        } else {
          note += ` route=${route}`
        }
      }
    } else {
      note = `沉默（${decision.reason}）`
    }

    rows.push({ scenario: s.name, turn, pass, failure: skipped ? undefined : failure, note, skipped })
  }
  return rows
}

async function main() {
  // 規則層評測完全不需要 .env；只有 --intent 才載入會讀 env 的線上模組。
  let classify: ((q: string, kb: boolean) => Promise<'rag' | 'transcript' | 'chitchat'>) | null = null
  if (WITH_INTENT) {
    const wwd = await import('../src/sessions/wake-word-detector.js')
    classify = async (q, kb) => wwd.routeForIntent(await wwd.classifyIntent(q, null), kb)
    console.log('（--intent：意圖分流會打 LLM，每個回應案例一次呼叫）')
  }

  let arbitrate: ((text: string, speaker: string, recent: Turn[]) => Promise<boolean | null>) | null = null
  if (WITH_ADDRESS) {
    const { arbitrateAddress } = await import('../src/sessions/response-policy.js')
    arbitrate = async (text, speaker, recent) => {
      const v = await arbitrateAddress({
        text,
        speaker,
        recent: recent.map((t) => ({ speaker: t.speaker, text: t.text, source: 'voice' as const, fromBot: false })),
      })
      if (v === 'unknown') unknownCount++
      return v === 'unknown' ? null : v === 'address'
    }
    console.log(`（--address：非呼喚句型會送語意裁決，每次呼叫間隔 ${DELAY_MS}ms 以避開免費層限流）`)
  }
  console.log('')

  const rows: Row[] = []
  for (const s of scenarios) {
    const scenarioRows = await runScenario(s, classify, arbitrate)
    rows.push(...scenarioRows)

    const failed = scenarioRows.filter((r) => !r.pass && !r.skipped)
    const head = failed.length ? `✗ ${s.name}（${failed.length}/${scenarioRows.length} 不符）` : `✓ ${s.name}`
    console.log(head)
    for (const r of scenarioRows) {
      if (r.pass && !VERBOSE) continue
      if (r.skipped && !VERBOSE) continue
      const mark = r.pass ? '  ✓' : r.skipped ? '  －' : r.turn.knownFail ? '  ⊘' : '  ✗'
      console.log(`${mark} [${r.turn.speaker}] ${r.turn.text}`)
      console.log(`      ${r.note}`)
      if (!r.pass && r.turn.why) console.log(`      理由：${r.turn.why}`)
    }
  }

  // ── 總結 ───────────────────────────────────────────────────────────────────
  // 「已知缺口」（knownFail）與「回歸失敗」分開統計：前者是等語意層來修的待辦，
  // 後者是本來會過卻被改壞的——只有後者該擋住 commit。
  // 略過的案例（未開 --address 的非呼喚句型）完全不計分：規則層本來就無從判斷，
  // 算它失敗只會製造假訊號，讓人以為改壞了什麼。
  const skippedRows = rows.filter((r) => r.skipped && !r.pass)
  const knownGap = rows.filter((r) => !r.pass && !r.skipped && r.turn.knownFail)
  const regressions = rows.filter((r) => !r.pass && !r.skipped && !r.turn.knownFail)
  const unexpectedPass = rows.filter((r) => r.pass && r.turn.knownFail)
  const scored = rows.length - skippedRows.length

  console.log('\n════════ 總結 ════════')
  console.log(`計分案例 ${scored}｜通過 ${rows.filter((r) => r.pass).length}`)
  if (skippedRows.length) {
    console.log(`略過 ${skippedRows.length}（非呼喚句型，規則層無從判斷）——加 --address 才測得到`)
  }
  console.log(`回歸失敗 ${regressions.length}（本來該過的壞掉了，必須修）`)
  console.log(`已知缺口 ${knownGap.length}（目前做不到，等後續實作）`)
  if (unexpectedPass.length) {
    console.log(`意外通過 ${unexpectedPass.length}（knownFail 標記可以拿掉了）：`)
    for (const r of unexpectedPass) console.log(`  · ${r.scenario} — ${r.turn.text}`)
  }

  const byFailure = new Map<Failure, number>()
  for (const r of rows) if (r.failure) byFailure.set(r.failure, (byFailure.get(r.failure) ?? 0) + 1)
  if (byFailure.size) {
    console.log('\n失敗類型分佈：')
    for (const [f, n] of byFailure) console.log(`  ${FAILURE_LABEL[f]}：${n}`)
  }

  if (regressions.length) {
    console.log('\n回歸失敗明細：')
    for (const r of regressions) console.log(`  · ${r.scenario} — [${r.turn.speaker}] ${r.turn.text}\n    ${r.note}`)
  }

  console.log('\n提醒：誤觸發（沒在叫她卻插嘴）比漏回應更傷體驗，權重放在壓低誤觸發。')
  // 回歸失敗才給非零退出碼，方便之後掛進 CI；已知缺口不擋。
  process.exit(regressions.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
