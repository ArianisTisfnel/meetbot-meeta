import Anthropic from '@anthropic-ai/sdk'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'

/**
 * 輕量 LLM 呼叫抽象：意圖分類、閒聊、逐字稿問答、插話決策與破冰共用。
 *
 * ⚠️ 這一層掛掉 = 蜜塔整個「腦袋」掛掉，但症狀非常不像故障：
 *   分類失敗 → 一律當成事實題丟去 RAG（閒聊也被拿專案文件回答）
 *   閒聊失敗 → 回罐頭句「我在喔！有什麼需要幫忙的」
 *   插話/破冰失敗 → 安靜不出聲
 * 實測 2026-07-25：Gemini 免費額度用完（429）＋ Anthropic 餘額不足（400），
 * 三種症狀同時出現，看起來卻像「AI 變笨」而不是「金鑰壞了」。
 *
 * 因此這裡採 **provider 失效轉移**（與 provider/failover-provider 同一個思路）：
 * 依序嘗試已設定的供應商，全部失敗才丟例外，且每次跳轉都留 warn log 指名是誰失敗。
 * 任何一家能用，蜜塔就能正常對話。
 *
 * 順序（可依 .env 設定自動略過）：
 *   1. Gemini：purpose='interjection' 時優先用第二把 key（獨立免費額度）
 *   2. Gemini：主 key
 *   3. OpenAI：專案本來就需要 OPENAI_API_KEY 做 TTS/轉錄，等於免費多一層保險
 *   4. Anthropic：需儲值
 */

let anthropic: Anthropic | null = null

export interface CompleteTextParams {
  system: string
  prompt: string
  maxTokens: number
  /** 未指定時用模型預設（Gemini 預設 1.0）。分類/決策類呼叫請給 0，避免同題不同命。 */
  temperature?: number
  /** 'interjection'：優先用插話專用的第二把 Gemini key（另一個帳號的額度）。 */
  purpose?: 'interjection'
  /**
   * 單一供應商的逾時（毫秒）。未指定時用 {@link DEFAULT_LLM_TIMEOUT_MS}。
   *
   * 為什麼需要：undici 預設幾乎不逾時，供應商「卡住」（不是報錯）時整條鏈會停在那裡，
   * 而 failover 只接得到 rejection、接不到停滯。實測 2026-07-29 的 log：
   * classifyMs 中位數 0.8 秒、p90 1.0 秒，卻出現過一筆 **10.8 秒** ——
   * 那 10 秒完全白等，而且發生在 Dify 查詢**之前**。
   *
   * ⚠️ 不要把預設值調小：產生答案的呼叫（answerFromTranscript / hybrid 合成，
   * maxTokens 512）本來就會跑好幾秒，設太緊會把正常的回答砍掉。
   * 要壓短的是**分類**這種本來就該很快的呼叫 → 由呼叫端自行指定。
   */
  timeoutMs?: number
}

/**
 * 預設逾時：這是「解除卡死」用的上限，不是延遲控制。
 * 長文生成（maxTokens 512）跑個 10 幾秒是正常的，所以取值必須寬鬆。
 */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000
/** 分類類呼叫的建議逾時：實測 p90 僅 1 秒，逾時就退回 factual，代價很小。 */
export const CLASSIFY_LLM_TIMEOUT_MS = 3_000

interface Provider {
  label: string
  run: (params: CompleteTextParams) => Promise<string>
}

async function callGemini(key: string, model: string, params: CompleteTextParams): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: params.system }] },
      contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        // 2.5 系列預設會「思考」，會吃掉輸出額度導致空回覆 → 關閉（低延遲也更適合即時場景）
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Gemini generateContent failed ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = (await res.json()) as any
  return (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('')
    .trim()
}

async function callOpenAI(params: CompleteTextParams): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_TEXT_MODEL,
      // max_completion_tokens 是新版正式參數（舊的 max_tokens 在新模型會被拒）
      max_completion_tokens: params.maxTokens,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.prompt },
      ],
    }),
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`OpenAI chat.completions failed ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = (await res.json()) as any
  return (data?.choices?.[0]?.message?.content ?? '').trim()
}

async function callAnthropic(params: CompleteTextParams): Promise<string> {
  anthropic ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const message = await anthropic.messages.create({
    model: params.maxTokens <= 256 ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
    max_tokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    system: params.system,
    messages: [{ role: 'user', content: params.prompt }],
  }, { timeout: params.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS })
  return message.content[0].type === 'text' ? message.content[0].text.trim() : ''
}

/** 依 .env 組出這次呼叫的嘗試順序（未設定金鑰的供應商直接不排進來）。 */
function buildChain(params: CompleteTextParams): Provider[] {
  const chain: Provider[] = []
  if (params.purpose === 'interjection' && env.GEMINI_INTERJECTION_API_KEY) {
    chain.push({
      label: 'gemini(interjection)',
      run: (p) => callGemini(env.GEMINI_INTERJECTION_API_KEY!, env.GEMINI_INTERJECTION_MODEL, p),
    })
  }
  if (env.GEMINI_API_KEY) {
    chain.push({ label: 'gemini', run: (p) => callGemini(env.GEMINI_API_KEY!, env.GEMINI_MODEL, p) })
  }
  if (env.OPENAI_API_KEY) {
    chain.push({ label: `openai(${env.OPENAI_TEXT_MODEL})`, run: callOpenAI })
  }
  if (env.ANTHROPIC_API_KEY) {
    chain.push({ label: 'anthropic', run: callAnthropic })
  }
  return chain
}

export async function completeText(params: CompleteTextParams): Promise<string> {
  const chain = buildChain(params)
  if (!chain.length) {
    throw new Error('completeText: 沒有可用的 LLM 供應商（請設定 GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY）')
  }

  let lastErr: unknown
  for (const [index, provider] of chain.entries()) {
    try {
      const text = await provider.run(params)
      if (text) {
        if (index > 0) {
          logger.info({ provider: provider.label }, 'llm: answered by fallback provider')
        }
        return text
      }
      // 空回覆通常是額度/截斷造成的靜默失敗 → 當成失敗換下一家，不要回空字串給呼叫端
      lastErr = new Error(`${provider.label} returned empty text`)
      logger.warn({ provider: provider.label }, 'llm: empty text, trying next provider')
    } catch (err) {
      lastErr = err
      logger.warn({ err, provider: provider.label }, 'llm: provider failed, trying next')
    }
  }

  logger.error(
    { providers: chain.map((p) => p.label), err: lastErr },
    'llm: all providers failed — 蜜塔會退回罐頭回覆/不出聲，請檢查金鑰與額度',
  )
  throw lastErr
}
