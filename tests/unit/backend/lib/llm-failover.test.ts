import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LLM 失效轉移：一家掛掉不能讓蜜塔變啞巴。
 * 實測 2026-07-25：Gemini 免費額度用完（429）＋ Anthropic 餘額不足 → 分類一律退回 factual、
 * 閒聊只會回罐頭句，看起來像「AI 變笨」而不是「金鑰壞了」。
 */

const mockEnv = vi.hoisted(() => ({
  GEMINI_API_KEY: 'gem-key',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_INTERJECTION_API_KEY: undefined as string | undefined,
  GEMINI_INTERJECTION_MODEL: 'gemini-flash-lite-latest',
  OPENAI_API_KEY: 'openai-key',
  OPENAI_TEXT_MODEL: 'gpt-4o-mini',
  ANTHROPIC_API_KEY: undefined as string | undefined,
}))

vi.mock('../../../../backend/src/types/env', () => ({ env: mockEnv }))

import { completeText } from '../../../../backend/src/lib/llm'

const PARAMS = { system: 's', prompt: 'p', maxTokens: 10, temperature: 0 }

function geminiOk(text: string) {
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) }
}
function openaiOk(text: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
}
function httpErr(status: number, body: string) {
  return { ok: false, status, text: async () => body }
}

describe('completeText — provider 失效轉移', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockEnv.GEMINI_API_KEY = 'gem-key'
    mockEnv.OPENAI_API_KEY = 'openai-key'
    mockEnv.ANTHROPIC_API_KEY = undefined
    mockEnv.GEMINI_INTERJECTION_API_KEY = undefined
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Gemini 正常 → 用 Gemini，不打其他家', async () => {
    fetchMock.mockResolvedValueOnce(geminiOk('chitchat'))
    expect(await completeText(PARAMS)).toBe('chitchat')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('generativelanguage.googleapis.com')
  })

  it('Gemini 429（額度用完）→ 自動改用 OpenAI，呼叫端拿得到答案', async () => {
    fetchMock
      .mockResolvedValueOnce(httpErr(429, 'You exceeded your current quota'))
      .mockResolvedValueOnce(openaiOk('chitchat'))
    expect(await completeText(PARAMS)).toBe('chitchat')
    expect(String(fetchMock.mock.calls[1][0])).toContain('api.openai.com')
  })

  it('Gemini 回空字串（靜默失敗）→ 也算失敗，換下一家', async () => {
    fetchMock.mockResolvedValueOnce(geminiOk('   ')).mockResolvedValueOnce(openaiOk('factual'))
    expect(await completeText(PARAMS)).toBe('factual')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('插話專用 key 失效（400）→ 退回主 key，不必等人工改設定', async () => {
    mockEnv.GEMINI_INTERJECTION_API_KEY = 'bad-key'
    fetchMock
      .mockResolvedValueOnce(httpErr(400, 'Request contains an invalid argument.'))
      .mockResolvedValueOnce(geminiOk('{"interject":false}'))
    expect(await completeText({ ...PARAMS, purpose: 'interjection' })).toBe('{"interject":false}')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('全部供應商都失敗 → 丟例外（呼叫端各自退回罐頭句/不出聲）', async () => {
    fetchMock
      .mockResolvedValueOnce(httpErr(429, 'quota'))
      .mockResolvedValueOnce(httpErr(401, 'bad key'))
    await expect(completeText(PARAMS)).rejects.toThrow()
  })

  it('完全沒設金鑰 → 明確報錯，不是安靜回空字串', async () => {
    mockEnv.GEMINI_API_KEY = undefined as unknown as string
    mockEnv.OPENAI_API_KEY = undefined as unknown as string
    await expect(completeText(PARAMS)).rejects.toThrow(/沒有可用的 LLM 供應商/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
