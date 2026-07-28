import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../backend/src/types/env', () => ({ env: {} }))

import { buildGeminiGenerationConfig } from '../../../../backend/src/lib/llm'

/**
 * 回歸測試：thinkingConfig 依模型世代分流。
 * 實測 2026-07-28 踩過的坑——Gemini 3.x 拒收 thinkingBudget: 0（HTTP 400），
 * 而 GEMINI_INTERJECTION_MODEL 的預設值正是 3.x 的 alias，
 * 導致一設定 GEMINI_INTERJECTION_API_KEY 就讓插話／破冰／定址裁決全部靜默陣亡。
 */
describe('buildGeminiGenerationConfig — thinkingConfig 分流', () => {
  it('2.5 系列：送 thinkingBudget 0（否則思考 token 吃光輸出額度）', () => {
    const cfg = buildGeminiGenerationConfig({ model: 'gemini-2.5-flash', maxTokens: 10 })
    expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  it('2.5-flash-lite 也送', () => {
    const cfg = buildGeminiGenerationConfig({ model: 'gemini-2.5-flash-lite', maxTokens: 200 })
    expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  it('3.x 系列：完全不送 thinkingConfig（送了會 400）', () => {
    for (const model of ['gemini-flash-lite-latest', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite']) {
      const cfg = buildGeminiGenerationConfig({ model, maxTokens: 10 })
      expect(cfg, model).not.toHaveProperty('thinkingConfig')
    }
  })

  it('maxOutputTokens 與 temperature 照常帶上；temperature 未指定則不帶', () => {
    expect(buildGeminiGenerationConfig({ model: 'gemini-3-flash-preview', maxTokens: 512, temperature: 0 })).toEqual({
      maxOutputTokens: 512,
      temperature: 0,
    })
    expect(buildGeminiGenerationConfig({ model: 'gemini-3-flash-preview', maxTokens: 512 })).toEqual({
      maxOutputTokens: 512,
    })
  })
})
