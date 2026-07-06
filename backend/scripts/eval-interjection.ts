/**
 * 插話決策 prompt 離線評測工具（prompt engineering 迭代迴圈用）。
 *
 * 拿「該插話 vs 不該插話」的對話劇本集，離線跑決策 prompt（與線上同一份，
 * import 自 src/sessions/interjection-prompts.ts），統計準確率——
 * 不用開真會議、不用多帳號，改完 prompt 直接重跑比較。
 *
 * 跑法（從 backend/ 目錄）：
 *   npx tsx --env-file .env scripts/eval-interjection.ts                # 全部劇本 × 全部變體
 *   npx tsx --env-file .env scripts/eval-interjection.ts --runs 3      # 每案例跑 3 次看穩定度
 *   npx tsx --env-file .env scripts/eval-interjection.ts --only 指名   # 只跑名稱含「指名」的案例
 *   npx tsx scripts/eval-interjection.ts --dry                          # 不打 LLM，只印組出的 prompt
 *
 * 劇本集：scripts/interjection-scenarios.json
 *   - cases[]：對話窗 + 預期（expected: 該不該插話；expectQuestionIncludes: 問題忠實度）
 *   - candidates[]：要 A/B 的候選 system prompt（現行版自動列為 baseline）
 *
 * 注意：Gemini 免費層約 10-15 RPM，預設每次呼叫間隔 4.5s（--delay-ms 可調）。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INTERJECTION_DECISION_SYSTEM,
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
const DELAY_MS = Number(flag('delay-ms') ?? 4_500)
const ONLY = flag('only')
const here = dirname(fileURLToPath(import.meta.url))
const scenarioPath = resolve(here, flag('scenarios') ?? 'interjection-scenarios.json')

const file: ScenarioFile = JSON.parse(readFileSync(scenarioPath, 'utf-8'))
const cases = file.cases.filter((c) => !ONLY || c.name.includes(ONLY))
if (!cases.length) {
  console.error('沒有符合的案例。')
  process.exit(1)
}

const variants: Array<{ name: string; system: string }> = [
  { name: 'live（現行線上版）', system: INTERJECTION_DECISION_SYSTEM },
  ...(file.candidates ?? []).map((c) => ({
    name: c.name,
    system: Array.isArray(c.system) ? c.system.join('\n') : c.system,
  })),
]

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
  //   這是給「只做 prompt、沒配全套後端環境」的人用的降級路徑。
  const FULL_ENV = Boolean(
    process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_URL && process.env.VEXA_API_URL && process.env.DATABASE_URL,
  )
  let completeText: (p: { system: string; prompt: string; maxTokens: number }) => Promise<string>
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
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`)
      const data = (await res.json()) as any
      return (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim()
    }
  }

  type Row = { case: ScenarioCase; run: number; pass: boolean; note: string }
  const summary: Array<{ variant: string; acc: number; falseFire: number; miss: number; fidelity: number; rows: Row[] }> = []

  for (const v of variants) {
    console.log(`\n═══ 變體：${v.name} ═══`)
    const rows: Row[] = []
    let falseFire = 0, miss = 0, fidelity = 0

    for (const c of cases) {
      for (let run = 1; run <= RUNS; run++) {
        let note = ''
        let pass = false
        try {
          const raw = await completeText({ system: v.system, prompt: buildPrompt(c), maxTokens: 200 })
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
            pass = true
            note = c.expected ? `question=「${d.question}」` : 'stay quiet'
          }
        } catch (err) {
          note = `LLM 錯誤：${(err as Error).message.slice(0, 80)}`
        }
        rows.push({ case: c, run, pass, note })
        console.log(`  ${pass ? '✓' : '✗'} ${c.name}${RUNS > 1 ? `（run ${run}）` : ''} — ${note}`)
        await sleep(DELAY_MS)
      }
    }

    const acc = rows.filter((r) => r.pass).length / rows.length
    summary.push({ variant: v.name, acc, falseFire, miss, fidelity, rows })
  }

  console.log('\n════════ 總結 ════════')
  for (const s of summary) {
    console.log(
      `${s.variant}\n  準確率 ${(s.acc * 100).toFixed(1)}%（${s.rows.filter((r) => r.pass).length}/${s.rows.length}）` +
        `｜誤插話 ${s.falseFire}｜漏插話 ${s.miss}｜問題忠實度不足 ${s.fidelity}`,
    )
  }
  console.log('\n提醒：誤插話（該閉嘴卻開口）比漏插話更傷體驗，權重請放在壓低誤插話。')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
