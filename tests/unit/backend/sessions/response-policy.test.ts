import { describe, it, expect, vi } from 'vitest'

// parseTurnDecision 的純函式測試已經在 addressing.test.ts（它「借用」response-policy 的純解析
// 函式）。本檔只補 addressing.test.ts 沒蓋到的兩塊：decideTurn 的呼叫失敗路徑（需要 mock
// completeText），以及 routeForIntent 的純映射。
vi.mock('../../../../backend/src/types/env', () => ({ env: {} }))
const completeText = vi.hoisted(() => vi.fn())
vi.mock('../../../../backend/src/lib/llm', () => ({ completeText }))

import { decideTurn, routeForIntent } from '../../../../backend/src/sessions/response-policy'

const window = [{ speaker: 'Arianis', text: '報名截止日是什麼時候', source: 'voice' as const, fromBot: false }]

describe('decideTurn — 呼叫失敗要 failed:true，不能悄悄變成一次「真的判成 factual」', () => {
  it('completeText 拋例外 → FAILED_DECISION，failed:true', async () => {
    completeText.mockRejectedValueOnce(new Error('429'))
    const d = await decideTurn({ window })
    expect(d).toEqual({ addressed: 'unknown', question: '', intent: 'factual', interject: false, failed: true })
  })

  it('completeText 回傳合法 JSON → failed:false，intent 是真分類', async () => {
    completeText.mockResolvedValueOnce(
      '{"addressed":"address","question":"報名截止日是什麼時候","intent":"factual","interject":false}',
    )
    const d = await decideTurn({ window })
    expect(d.failed).toBe(false)
    expect(d.intent).toBe('factual')
  })
})

describe('routeForIntent — 意圖 → 資料來源的純映射', () => {
  it('沒有知識庫 → 一律 transcript，不管 intent 判成什麼', () => {
    expect(routeForIntent('factual', false)).toBe('transcript')
    expect(routeForIntent('hybrid', false)).toBe('transcript')
    expect(routeForIntent('chitchat', false)).toBe('transcript')
    expect(routeForIntent('context', false)).toBe('transcript')
  })

  it('有知識庫：chitchat→chitchat、context→transcript、factual/hybrid→rag', () => {
    expect(routeForIntent('chitchat', true)).toBe('chitchat')
    expect(routeForIntent('context', true)).toBe('transcript')
    expect(routeForIntent('factual', true)).toBe('rag')
    expect(routeForIntent('hybrid', true)).toBe('rag')
  })
})
