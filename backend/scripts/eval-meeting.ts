/**
 * 蜜塔「定址判斷」離線評測（回報 2026-07-28 C 的第一層）。
 *
 * 拿手寫的會議劇本，逐句跑「這句該不該回應／該走哪條資料來源」，統計準確率——
 * 不用開真會議、不用多帳號，改完判斷邏輯直接重跑比較。
 *
 * 與 eval-interjection.ts 的分工：
 *   eval-interjection → 「沒人叫我，我該不該主動補充」（插話決策層）
 *   eval-meeting（本檔）→ 「這句是不是在對我說話、要走哪條路」（定址層 + 意圖分流）
 *   兩者現在打的是**同一份 prompt**（TURN_DECISION_SYSTEM），只是看它輸出的不同欄位。
 * 兩者共用同一個原則：評測 import 的是**線上跑的同一份實作**，不抄寫。
 *
 * 跑法（backend/ 目錄）：
 *   npx tsx scripts/eval-meeting.ts                           # 規則層，零 LLM 成本、秒回
 *   npx tsx --env-file .env scripts/eval-meeting.ts --address # 加上語意決策層（會打 LLM）
 *   npx tsx --env-file .env scripts/eval-meeting.ts --intent  # 加上意圖分流評測（會打 LLM）
 *   npx tsx scripts/eval-meeting.ts --only 代詞               # 只跑名稱含「代詞」的劇本
 *   npx tsx scripts/eval-meeting.ts --verbose                 # 連通過的案例也印出來
 *
 * ⚠️ 不加 --address 時，規則層不定案的句子（句中提及、沒喊名字的追問）一律當沉默、
 *    標成「略過」不計分——規則層本來就無從判斷。要看真實表現必須加 --address。
 *
 * ⚠️ 若總結出現「語意層有 N 次呼叫失敗」，代表 Gemini 免費層額度用完，
 *    該次數字不可信（實測踩過：429 被吞成語意層失敗，看起來像 prompt 改壞了）。
 *    額度在太平洋午夜重置（台灣下午 3-4 點）。
 *
 * 讀 scripts/meeting-scenarios.json（格式與欄位說明見該檔的 _readme）。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideAddressing, type AddressingState } from '../src/sessions/addressing.js'
import type { ConversationEntryLike } from '../src/sessions/interjection-prompts.js'
import type { TurnDecision, QuestionIntent } from '../src/sessions/response-policy.js'

interface Turn {
  speaker: string
  text: string
  gapMs?: number
  why?: string
  knownFail?: boolean
  expect: {
    respond: boolean
    /** 4 分類正解。給了就只比對 intent（route 純供 note 顯示，不比對）——見 _readme。 */
    intent?: QuestionIntent
    route?: 'rag' | 'transcript' | 'chitchat'
    question?: string
  }
}
interface Scenario {
  name: string
  kb: boolean
  /** 模擬 session.kbContentCard，餵給 decideTurn 的 ③ 規則。省略＝沒有內容卡。 */
  kbContentCard?: string
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
/** 規則層不定案的句子是否真的送語意層（會打 LLM）。不開時一律當沉默、不計分。 */
const WITH_ADDRESS = args.includes('--address')
const DEFAULT_GAP_MS = 5_000
/**
 * LLM 呼叫之間的間隔（ms）。Gemini 免費層有每分鐘額度，連續打會 429——
 * 而 429 會被吞成「語意層失敗」，讓評測結果看起來像 prompt 變差（實測踩過）。
 *
 * 為什麼是 12 秒而不是原本的 5 秒：2026-07-29 實測，5 秒間隔下**每次跑都剛好 1 次
 * 429**，換三把不同的 key（含全新未用的）都一樣——是每分鐘速率上限，不是每日額度。
 * 12 秒同一份劇本可跑出零失敗。整份跑完約多花一分鐘，換一個可信的基準很划算。
 */
const DELAY_MS = Number(flag('delay-ms') ?? (WITH_ADDRESS || WITH_INTENT ? 12_000 : 0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 語意層呼叫失敗次數：>0 代表本次結果不可信（多半是額度用完）。 */
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

type Failure = 'false-fire' | 'missed' | 'question-fidelity' | 'wrong-route' | 'wrong-intent'

interface Row {
  scenario: string
  turn: Turn
  pass: boolean
  failure?: Failure
  note: string
  /** 未開 --address 時遇到規則層不定案的句子：無從判斷，不列入計分。 */
  skipped?: boolean
}

const FAILURE_LABEL: Record<Failure, string> = {
  'false-fire': '誤觸發（不該回應卻回應）',
  missed: '漏回應（該回應卻沉默）',
  'question-fidelity': '問題擷取不符',
  'wrong-route': '資料來源走錯',
  'wrong-intent': '意圖判錯（factual/hybrid/context/chitchat 分類錯誤）',
}

/**
 * 跑一個劇本。
 * 以模擬時鐘推進（gapMs），並比照 wake-word-detector 施加狀態轉移，
 * 讓 debounce 與「對話串還開著嗎」這類**跨句的時間相依行為**在離線也成立。
 */
async function runScenario(
  s: Scenario,
  decide: ((window: ConversationEntryLike[], kbContentCard?: string | null) => Promise<TurnDecision>) | null,
  routeForIntent: ((intent: QuestionIntent, hasKb: boolean) => 'rag' | 'transcript' | 'chitchat') | null,
): Promise<Row[]> {
  const state: AddressingState = { lastWakeAt: 0, lastEngagedAt: 0 }
  let now = 1_700_000_000_000 // 固定起點：結果可重現
  const rows: Row[] = []
  /**
   * 送進語意層的對話窗（最後一則永遠是要判斷的那一句，與線上同一種形狀）。
   * ⚠️ 這裡**不含蜜塔的回答**——劇本只寫人講的話。線上的窗會夾著她的回覆，
   * 也就是說評測看到的追問線索比線上少，這一側偏嚴不偏鬆。
   */
  const window: ConversationEntryLike[] = []

  for (const turn of s.turns) {
    now += turn.gapMs ?? DEFAULT_GAP_MS
    let decision = decideAddressing(state, { text: turn.text, speaker: turn.speaker, now })
    window.push({ speaker: turn.speaker, text: turn.text, source: 'voice', fromBot: false })

    // 規則層不定案的兩種情形都送同一個 decideTurn（線上也是同一個）：
    //   ambiguous          有喊名字，分不出對她說 vs 談論她
    //   followup-candidate 沒喊名字，但對話串還開著（可能是連續追問）
    // --address 未開時一律當沉默並標記略過——規則層本來就無從判斷，算它失敗只是假訊號。
    let skipped = false
    // 這輪若在此處已經打過語意層，下面的 intent/route 檢查直接重用這次結果，不再多打一次
    // （--address 與 --intent 同開時，過去分別打一次，其中一次還是準度較差的單句假窗）。
    let addressTurnDecision: TurnDecision | undefined
    if (decision.kind === 'ambiguous' || decision.kind === 'followup-candidate') {
      const isMention = decision.kind === 'ambiguous'
      const candidate = decision.candidate
      if (!decide || !WITH_ADDRESS) {
        skipped = true
        decision = { kind: 'ignore', reason: '需要語意層（未開 --address，預設沉默）' }
      } else {
        if (DELAY_MS) await sleep(DELAY_MS)
        const turnDecision = await decide(window, s.kbContentCard ?? null)
        addressTurnDecision = turnDecision
        const failed = turnDecision.failed
        if (failed) unknownCount++
        // 呼叫失敗的退回方向兩邊相反，與線上完全一致（見 AddressVerdict 的說明）：
        //   有喊名字 → 照常回答（判不出來不等於沒在叫我）
        //   沒喊名字 → 安靜（否則額度枯竭時每一句話都會被當成在問她）
        const answer = failed ? isMention : turnDecision.addressed === 'address'
        // 問題內容（與線上完全同一套規則）：
        //   有喊名字 → 用規則層擷取的原話，避免送進 Dify 的字串被語意層改寫走樣
        //   沒喊名字 → 用語意層回的那句，且**不補 fallback**：它判 address 卻擷不出問題時
        //              就是不該回答（線上 interjection.ts 同此，見 answerFollowUp 的呼叫條件）
        const question = isMention ? candidate : turnDecision.question
        decision = answer && question
          ? {
              kind: 'question',
              question,
              reason: failed ? '⚠ 語意層呼叫失敗 → 退回舊行為' : `語意層 = ${turnDecision.addressed}`,
            }
          : {
              kind: 'ignore',
              reason: failed ? '⚠ 語意層呼叫失敗 → 退回安靜' : `語意層 = ${turnDecision.addressed}`,
            }
      }
    }

    // 狀態轉移必須與 handleTranscriptSegment 一致，否則測的不是真實行為
    if (decision.kind === 'wake-only') {
      state.lastEngagedAt = now
    } else if (decision.kind === 'question') {
      state.lastEngagedAt = now
      state.lastWakeAt = now
    } else if (decision.kind === 'stop') {
      state.lastEngagedAt = 0
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
      } else if (WITH_INTENT && (turn.expect.intent || turn.expect.route)) {
        let turnDecision: TurnDecision
        let callFailed: boolean
        if (addressTurnDecision) {
          // 這輪的定址已經用真實對話窗打過一次 decideTurn（句中提及／連續追問）→ 重用同一次
          // 呼叫的 intent，不再打第二次（失敗次數已經在上面那個區塊算過，這裡不重複計）。
          turnDecision = addressTurnDecision
          callFailed = addressTurnDecision.failed
        } else {
          // 規則層純靠正則定案的呼喚句（"蜜塔，X"）：定址不需要語意層，但 intent 仍要——
          // 與線上完全對應（resolveAnswerRouted 在 knownIntent 為 undefined 時的那次呼叫），
          // 用累積到這一輪的真實對話窗，不是單句假窗。
          if (DELAY_MS) await sleep(DELAY_MS)
          turnDecision = await decide!(window, s.kbContentCard ?? null)
          callFailed = turnDecision.failed
          if (callFailed) unknownCount++
        }

        if (callFailed) {
          // 呼叫/解析失敗：intent 是 FAILED_DECISION 的保守預設值 'factual'，不是真分類。
          // 不比對、不判 pass/fail——讓它跟著 unknownCount 機制一起讓整輪結果「不可信」，
          // 而不是讓 routeForIntent('factual', kb) 巧合對到 expect.route 變成假通過。
          note += ' ｜⚠ intent/route 語意層呼叫失敗，未計分'
        } else {
          const intent = turnDecision.intent
          const route = routeForIntent!(intent, s.kb)
          if (turn.expect.intent) {
            if (intent !== turn.expect.intent) {
              pass = false
              failure = 'wrong-intent'
              note = `intent 判為 ${intent}，預期 ${turn.expect.intent}（question=「${decision.question}」）`
            } else {
              note += ` intent=${intent} route=${route}`
            }
          } else if (turn.expect.route) {
            if (route !== turn.expect.route) {
              pass = false
              failure = 'wrong-route'
              note = `走了 ${route}，預期 ${turn.expect.route}（question=「${decision.question}」）`
            } else {
              note += ` route=${route}`
            }
          }
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
  // 規則層評測完全不需要 .env；只有 --address／--intent 才載入會讀 env 的線上模組。
  let decide: ((window: ConversationEntryLike[], kbContentCard?: string | null) => Promise<TurnDecision>) | null = null
  let routeForIntent: ((intent: QuestionIntent, hasKb: boolean) => 'rag' | 'transcript' | 'chitchat') | null = null
  if (WITH_ADDRESS || WITH_INTENT) {
    // --address 與 --intent 現在共用同一支 decideTurn：--address 用它裁決定址，--intent 用它
    // （或重用同一次呼叫的結果）拿 intent。不再 import wake-word-detector.js 的 classifyIntent——
    // 那支函式把 decideTurn 塞進一個單句、kbContentCard 永遠 null 的假窗，測不出追問脈絡與 KB
    // 相關性，且與 --address 的呼叫各自獨立，同開時等於多打一次較不準的 LLM 呼叫。
    const rp = await import('../src/sessions/response-policy.js')
    decide = (window, kbContentCard) => rp.decideTurn({ window, kbContentCard })
    routeForIntent = rp.routeForIntent
    if (WITH_ADDRESS) {
      console.log(`（--address：規則層不定案的句子會送語意層，每次呼叫間隔 ${DELAY_MS}ms 以避開免費層限流）`)
    }
    if (WITH_INTENT) {
      console.log('（--intent：改用 decideTurn 的真實對話窗＋kbContentCard 評測意圖，不再打單句 classifyIntent）')
    }
  }
  console.log('')

  const rows: Row[] = []
  for (const s of scenarios) {
    const scenarioRows = await runScenario(s, decide, routeForIntent)
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
  // 語意層失敗的警告必須在數字**之前**印：失敗時線上對 ambiguous 退回「照常回答」，
  // 評測照做，於是那些案例全變成「回應」→ 誤觸發與回歸失敗憑空暴增，
  // 看起來完全像 prompt 被改壞（實測 2026-07-28 又踩一次：429 造成假的 3 個回歸失敗）。
  if (unknownCount > 0) {
    console.log(`\n⚠️  語意層有 ${unknownCount} 次呼叫失敗（多半是 Gemini 免費層 429）。`)
    console.log('    失敗時「有喊名字」退回照常回答、「沒喊名字」退回安靜，兩邊的數字都會歪，下列結果**不可信**。')
    console.log('    換一把不同額度池的 key 重跑，或等額度重置（太平洋午夜＝台灣下午 3-4 點）。')
    console.log('    不改 .env 的換 key 跑法（shell 環境變數優先於 --env-file）：')
    console.log('      GEMINI_API_KEY=<另一把> npx tsx --env-file .env scripts/eval-meeting.ts --address\n')
  }
  console.log(`計分案例 ${scored}｜通過 ${rows.filter((r) => r.pass).length}`)
  if (skippedRows.length) {
    console.log(`略過 ${skippedRows.length}（規則層無從判斷）——加 --address 才測得到`)
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
  // 語意層失敗同樣給非零：這種跑法沒有產出可信基準，等同於沒跑，不該被當成綠燈放行。
  process.exit(regressions.length || unknownCount ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
