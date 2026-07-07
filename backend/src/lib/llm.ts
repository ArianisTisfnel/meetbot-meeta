import Anthropic from '@anthropic-ai/sdk'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'

/**
 * 輕量 LLM 呼叫抽象：插話決策與無知識庫問答共用。
 *
 * Provider 選擇：設了 GEMINI_API_KEY 就走 Gemini（AI Studio 免費額度，
 * flash 模型免費層足夠本專案用量），否則走 Anthropic（需儲值）。
 * 兩邊都是單輪 system+user → text，無工具呼叫，故可無痛互換。
 */

let anthropic: Anthropic | null = null

export async function completeText(params: {
  system: string
  prompt: string
  maxTokens: number
  /** 未指定時用模型預設（Gemini 預設 1.0）。分類/決策類呼叫請給 0，避免同題不同命。 */
  temperature?: number
}): Promise<string> {
  if (env.GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`
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
