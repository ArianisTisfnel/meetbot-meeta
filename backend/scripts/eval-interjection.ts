/**
 * 插話決策 prompt 離線評測工具（prompt engineering 迭代迴圈用）。
 *
 * 拿「該插話 vs 不該插話」的對話劇本集，離線跑決策 prompt（與線上同一份，
 * import 自 src/sessions/interjection-prompts.ts），統計準確率——
 * 不用開真會議、不用多帳號，改完 prompt 直接重跑比較。
 *
 * ⚠️ 2026-07-29 起這份 prompt（TURN_DECISION_SYSTEM）同時產出定址／意圖／插話三個判斷，
 *    本檔只讀 interject 與 question 兩個欄位——劇本全是「沒人叫蜜塔」的情境，語意不變。
 *    另一半（定址、連續追問）由 scripts/eval-meeting.ts --address 蓋。改 prompt 兩邊都要跑。
 *
 * 跑法（從 backend/ 目錄）：
 *   npx tsx --env-file .env scripts/eval-interjection.ts                     # 全部劇本 × 全部變體
 *   npx tsx --env-file .env scripts/eval-interjection.ts --runs 3            # 每案例跑 3 次看穩定度
 *   npx tsx --env-file .env scripts/eval-interjection.ts --only 指名         # 只跑名稱含「指名」的案例
 *   npx tsx --env-file .env scripts/eval-interjection.ts --variant live      # 只跑名稱含 live 的變體
 *   npx tsx --env-file .env scripts/eval-interjection.ts --variant v2 --from 3  # 額度分段：從第 3 個案例續跑
 *   npx tsx --env-file .env scripts/eval-interjection.ts --delay-ms 12000    # 免費層限流嚴時放慢
 *   npx tsx scripts/eval-interjection.ts --dry                               # 不打 LLM，只印組出的 prompt
 *
 * 劇本集：scripts/interjection-scenarios.json
 *   - cases[]：對話窗 + 預期（expected: 該不該插話；expectQuestionIncludes: 問題忠實度）
 *   - candidates[]：要 A/B 的候選 system prompt（現行版自動列為 baseline）
 *
 * 限流：Gemini 免費層有「每分鐘」與「每日」兩種額度。429 會自動退避重試（30s/60s）；
 * 連續 3 個案例仍失敗＝多半是每日額度（RPD）用完 → 自動中止並提示（太平洋午夜重置）。
 * 建議 .env 設 GEMINI_MODEL="gemini-2.5-flash-lite"（免費額度高一個量級，llm.ts 同步生效）。
 * 結果即時印終端機並同步寫入 log 檔（--out 可自訂路徑）。
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TURN_DECISION_SYSTEM,
  formatConversation,
  type ConversationEntryLike,
} from '../src/sessions/interjection-prompts.js'

interface ScenarioCase {
  name: string
  expected: boolean
  /** expected=true 時檢查 question 欄位忠實度（需包含此子字串）。 */
  expectQuestionIncludes?: string
  window: Array<Partial<ConversationEntryLike> & { text: string }>
}
interface ScenarioFile {
  candidates?: Array<{ name: string; system: string | string[] }>
  cases: ScenarioCase[]
}

// ── CLI 參數 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const DRY = args.includes('--dry')
const RUNS = Number(flag('runs') ?? 1)
const DELAY_MS = Number(flag('delay-ms') ?? 7_000)
const ONLY = flag('only')
const VARIANT = flag('variant')
const FROM = Number(flag('from') ?? 1) // 1-based；配合額度分段，從第 N 個案例開始
const OUT = flag('out') ?? `eval-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`
const log = (line: string) => {
  console.log(line)
  if (!DRY) { try { appendFileSync(OUT, line + '\n') } catch { /* 寫檔失敗不影響評測 */ } }
}

const here = dirname(fileURLToPath(import.meta.url))
const scenarioPath = resolve(here, flag('scenarios') ?? 'interjection-scenarios.json')

const file: ScenarioFile = JSON.parse(readFileSync(scenarioPath, 'utf-8'))
const cases = file.cases.filter((c) => !ONLY || c.name.includes(ONLY)).slice(Math.max(0, FROM - 1))
if (!cases.length) {
  console.error('沒有符合的案例。')
  process.exit(1)
}

const variants: Array<{ name: string; system: string }> = [
  { name: 'live（現行線上版）', system: TURN_DECISION_SYSTEM },
  ...(file.candidates ?? []).map((c) => ({
    name: c.name,
    system: Array.isArray(c.system) ? c.system.join('\n') : c.system,
  })),
].filter((v) => !VARIANT || v.name.includes(VARIANT))
if (!variants.length) {
  console.error('沒有符合的 prompt 變體。')
  process.exit(1)
}

function buildPrompt(c: ScenarioCase): string {
  // 與 interjection.ts evaluateTurn 完全一致的輸入格式
  const entries: ConversationEntryLike[] = c.window.map((e) => ({
    speaker: e.speaker ?? '參與者',
    text: e.text,
    source: e.source ?? 'voice',
    fromBot: e.fromBot ?? false,
  }))
  return `最近的對話：\n\n${formatConversation(entries, { chatMarker: true })}`
}

function parseDecision(raw: string): { interject?: boolean; question?: string } | null {
  try {
    return JSON.parse(raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim())
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type CompleteTextFn = (p: { system: string; prompt: string; maxTokens: number }) => Promise<string>

/** 429/限流自動退避重試：30s、60s，最多兩次；其他錯誤不重試。 */
async function withRateLimitRetry(fn: CompleteTextFn, params: Parameters<CompleteTextFn>[0]): Promise<string> {
  const waits = [30_000, 60_000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(params)
    } catch (err) {
      const msg = (err as Error).message || ''
      // 429/RESOURCE_EXHAUSTED = 限流；503/UNAVAILABLE/overloaded/500/502 = Google 端暫時性故障
      const retryable =
        msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || /rate ?limit/i.test(msg) ||
        msg.includes('503') || msg.includes('UNAVAILABLE') || /overload/i.test(msg) ||
        msg.includes('500') || msg.includes('502')
      if (!retryable || attempt >= waits.length) throw err
      const label = msg.includes('503') || /overload/i.test(msg) ? '503 過載' : '429 限流'
      console.log(`    （${label}，等 ${waits[attempt] / 1000}s 後重試…）`)
      try { appendFileSync(OUT, `    （${label}，等 ${waits[attempt] / 1000}s 後重試…）\n`) } catch {}
      await sleep(waits[attempt])
    }
  }
}

async function main() {
  if (DRY) {
    for (const c of cases) {
      console.log(`\n━━ ${c.name}（預期：${c.expected ? '插話' : '不插話'}）━━\n${buildPrompt(c)}`)
    }
    console.log(`\n共 ${cases.length} 個案例、${variants.length} 個 prompt 變體（--dry 未呼叫 LLM）。`)
    return
  }

  // LLM 呼叫端的選擇：
  //   backend/.env 完整 → 走 src/lib/llm.ts（與線上完全同一條路）
  //   .env 不完整（types/env.ts 的 zod 檢查缺必填會直接 process.exit）→
  //   退回內建 Gemini 直呼叫，只需要 GEMINI_API_KEY（行為對齊 llm.ts 的 Gemini 分支）。
  const FULL_ENV = Boolean(
    process.env.ANTHROPIC_API_KEY && process.env.S3_ENDPOINT && process.env.VEXA_API_URL && process.env.DATABASE_URL,
  )
  let completeText: CompleteTextFn
  if (FULL_ENV) {
    completeText = (await import('../src/lib/llm.js')).completeText
  } else {
    const key = process.env.GEMINI_API_KEY
    if (!key) {
      console.error('backend/.env 不完整，且沒有 GEMINI_API_KEY。評測至少需要 GEMINI_API_KEY（AI Studio 免費申請）。')
      process.exit(1)
    }
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    console.log(`（backend/.env 不完整 → 使用內建 Gemini 直呼叫，模型 ${model}）`)
    completeText = async ({ system, prompt, maxTokens }) => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
          }),
        },
      )
      if (!res.ok) throw new Error(`Gemini generateContent failed ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`)
      const data = (await res.json()) as any
      return (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim()
    }
  }

  type Kind = 'pass' | 'wrong' | 'error'
  type Row = { case: ScenarioCase; run: number; kind: Kind; note: string }
  const summary: Array<{
    variant: string; pass: number; wrong: number; error: number
    falseFire: number; miss: number; fidelity: number
  }> = []

  log(`（結果同步寫入 ${OUT}）`)

  let quotaDead = false
  for (const v of variants) {
    if (quotaDead) break
    log(`\n═══ 變體：${v.name} ═══`)
    const rows: Row[] = []
    let falseFire = 0, miss = 0, fidelity = 0
    let consecutiveErrors = 0

    for (const c of cases) {
      if (quotaDead) break
      for (let run = 1; run <= RUNS; run++) {
        let note = ''
        let kind: Kind = 'wrong'
        try {
          const raw = await withRateLimitRetry(completeText, { system: v.system, prompt: buildPrompt(c), maxTokens: 200 })
          const d = parseDecision(raw)
          if (!d) {
            note = `JSON 解析失敗：${raw.slice(0, 60)}`
          } else if (Boolean(d.interject) !== c.expected) {
            note = `判定 ${d.interject ? '插話' : '不插話'}，預期 ${c.expected ? '插話' : '不插話'}`
            if (d.interject) falseFire++
            else miss++
          } else if (c.expected && c.expectQuestionIncludes && !(d.question ?? '').includes(c.expectQuestionIncludes)) {
            note = `question 忠實度不足：「${d.question}」未包含「${c.expectQuestionIncludes}」`
            fidelity++
          } else {
            kind = 'pass'
            note = c.expected ? `question=「${d.question}」` : 'stay quiet'
          }
        } catch (err) {
          kind = 'error'
          note = `LLM 錯誤（不計入準確率）：${(err as Error).message.slice(0, 80)}`
        }
        rows.push({ case: c, run, kind, note })
        const mark = kind === 'pass' ? '✓' : kind === 'error' ? '⚠' : '✗'
        log(`  ${mark} ${c.name}${RUNS > 1 ? `（run ${run}）` : ''} — ${note}`)

        // 熔斷：連續 3 個案例重試後仍限流 → 幾乎確定是每日額度用完，繼續跑只是空等
        consecutiveErrors = kind === 'error' ? consecutiveErrors + 1 : 0
        if (consecutiveErrors >= 3) {
          log('')
          log('⛔ 連續 3 個案例限流失敗 → 判定每日額度（RPD）用完，中止本次評測。')
          log('   對策：(1) .env 設 GEMINI_MODEL="gemini-2.5-flash-lite"（額度高一個量級）後重跑；')
          log('        (2) 或等太平洋午夜（台灣下午 3-4 點）額度重置。')
          quotaDead = true
          break
        }
        await sleep(DELAY_MS)
      }
    }

    summary.push({
      variant: v.name,
      pass: rows.filter((r) => r.kind === 'pass').length,
      wrong: rows.filter((r) => r.kind === 'wrong').length,
      error: rows.filter((r) => r.kind === 'error').length,
      falseFire, miss, fidelity,
    })
  }

  log('\n════════ 總結 ════════')
  for (const s of summary) {
    const scored = s.pass + s.wrong
    const acc = scored ? ((s.pass / scored) * 100).toFixed(1) : 'n/a'
    log(
      `${s.variant}\n  準確率 ${acc}%（${s.pass}/${scored} 有效案例）` +
        `｜誤插話 ${s.falseFire}｜漏插話 ${s.miss}｜問題忠實度不足 ${s.fidelity}` +
        (s.error ? `｜⚠ 限流/錯誤未計分 ${s.error}` : ''),
    )
  }
  log('\n提醒：誤插話（該閉嘴卻開口）比漏插話更傷體驗，權重請放在壓低誤插話。')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
