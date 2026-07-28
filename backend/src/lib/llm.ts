import Anthropic from '@anthropic-ai/sdk'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'

/**
 * 輕量 LLM 呼叫抽象：插話決策與無知識庫問答共用。
 *
 * Provider 選擇：設了 GEMINI_API_KEY 就走 Gemini（AI Studio 免費額度，
 * flash 模型免費層足夠本專案用量），否則走 Anthropic（需儲值）。
 * 兩邊都是單輪 system+user → text，無工具呼叫，故可無痛互換。
 *
 * purpose: 'interjection' 時改用 GEMINI_INTERJECTION_API_KEY（第二帳號的獨立額度）；
 * 該 key 未設定時退回預設 key，呼叫方不用管有幾把 key。
 */

let anthropic: Anthropic | null = null

/**
 * 組出 Gemini 的 generationConfig。獨立成純函式是為了可單元測試——
 * 這裡踩過一個只在特定 env 組合下才炸、且只寫進 warn log 的坑。
 *
 * thinkingConfig 必須**依模型世代分流**：
 *   Gemini 2.5 系列預設會「思考」，思考 token 會吃掉 maxOutputTokens 導致空回覆
 *     → 必須送 thinkingConfig: { thinkingBudget: 0 } 關掉。
 *   Gemini 3.x 系列（gemini-3-*、gemini-flash-lite-latest 等 alias）**拒收**
 *     thinkingBudget: 0，直接回 HTTP 400 "Request contains an invalid argument"；
 *     而且它預設就不思考（實測 thoughtsTokenCount=0），根本不需要關
 *     → 整個 thinkingConfig 省略。
 *
 * 實測 2026-07-28：GEMINI_INTERJECTION_MODEL 預設是 3.x 的 gemini-flash-lite-latest，
 * 所以只要一設定 GEMINI_INTERJECTION_API_KEY（.env.example 與文件都建議設，用來隔離額度），
 * 插話決策／沉默破冰／定址裁決會同時全部 400 陣亡，症狀只是「蜜塔安靜了」。
 */
export function buildGeminiGenerationConfig(params: {
  model: string
  maxTokens: number
  temperature?: number
}): Record<string, unknown> {
  const isThinkingBudgetSupported = /2\.5/.test(params.model)
  return {
    maxOutputTokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(isThinkingBudgetSupported ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  }
}

export async function completeText(params: {
  system: string
  prompt: string
  maxTokens: number
  /** 未指定時用模型預設（Gemini 預設 1.0）。分類/決策類呼叫請給 0，避免同題不同命。 */
  temperature?: number
  purpose?: 'interjection'
}): Promise<string> {
  const useInterjectionKey = params.purpose === 'interjection' && env.GEMINI_INTERJECTION_API_KEY
  const geminiKey = useInterjectionKey ? env.GEMINI_INTERJECTION_API_KEY : env.GEMINI_API_KEY
  const geminiModel = useInterjectionKey ? env.GEMINI_INTERJECTION_MODEL : env.GEMINI_MODEL
  if (geminiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: params.system }] },
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        generationConfig: buildGeminiGenerationConfig({
          model: geminiModel,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
        }),
      }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`Gemini generateContent failed ${res.status}: ${t.slice(0, 200)}`)
    }
    const data = (await res.json()) as any
    const text = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text ?? '')
      .join('')
      .trim()
    if (!text) {
      logger.warn({ finishReason: data?.candidates?.[0]?.finishReason }, 'llm: gemini returned empty text')
    }
    return text
  }

  anthropic ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const message = await anthropic.messages.create({
    model: params.maxTokens <= 256 ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
    max_tokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    system: params.system,
    messages: [{ role: 'user', content: params.prompt }],
  })
  return message.content[0].type === 'text' ? message.content[0].text : ''
}
