import { describe, it, expect, vi } from 'vitest'

// addressing.ts 本身是純函式無依賴，但 response-policy.ts 會拉進 lib/llm → types/env
//（env 驗證失敗會 process.exit）。只借用它的純解析函式，故整條依賴 mock 掉。
vi.mock('../../../../backend/src/types/env', () => ({ env: {} }))
vi.mock('../../../../backend/src/lib/llm', () => ({ completeText: vi.fn() }))

import {
  decideAddressing,
  decideChatAddressing,
  isVocativeWake,
  stripLeadingPunct,
  WAKE_PENDING_MS,
  type AddressingState,
} from '../../../../backend/src/sessions/addressing'
import { parseVerdict } from '../../../../backend/src/sessions/response-policy'

const NOW = 1_700_000_000_000
const fresh = (): AddressingState => ({ lastWakeAt: 0, wakePendingUntil: 0, wakePendingSpeaker: null })
const decide = (text: string, state = fresh(), now = NOW, speaker = 'A') =>
  decideAddressing(state, { text, speaker, now })

describe('stripLeadingPunct — 全形半形都要清', () => {
  it('半形標點（OpenAI 轉錄輸出）', () => {
    expect(stripLeadingPunct(', 可以告訴我嗎?')).toBe('可以告訴我嗎?')
    expect(stripLeadingPunct('. 報名費')).toBe('報名費')
    expect(stripLeadingPunct('?什麼')).toBe('什麼')
  })
  it('全形標點（Recall 轉錄輸出）', () => {
    expect(stripLeadingPunct('，請問報名日期')).toBe('請問報名日期')
    expect(stripLeadingPunct('、…　好')).toBe('好')
  })
  it('句中標點不動', () => {
    expect(stripLeadingPunct('報名費是多少，含稅嗎')).toBe('報名費是多少，含稅嗎')
  })
})

describe('decideAddressing — 呼喚 vs 提及', () => {
  it('句首呼喚（有停頓標點）→ 直接派發，不花 LLM', () => {
    const d = decide('蜜塔，請問這份規則是最新版嗎')
    expect(d.kind).toBe('question')
    if (d.kind === 'question') expect(d.question).toBe('請問這份規則是最新版嗎')
  })

  it('空白也算停頓 → 呼喚', () => {
    const d = decide('mita 今天的議程是什麼')
    expect(d.kind).toBe('question')
  })

  it('發語詞在前不影響呼喚判定', () => {
    expect(decide('那個蜜塔，幫我查一下報名費').kind).toBe('question')
    expect(decide('欸蜜塔，你可以查嗎').kind).toBe('question')
  })

  // 回報 2026-07-28 A.1 的病灶：這些句子過去全部會誤觸發
  it('句中提及（我覺得蜜塔…）→ ambiguous，不自行定案', () => {
    const d = decide('我覺得蜜塔這個功能是不是有點難做啊')
    expect(d.kind).toBe('ambiguous')
    if (d.kind === 'ambiguous') expect(d.candidate).toBe('這個功能是不是有點難做啊')
  })

  it('句首但直接黏名詞（蜜塔這個功能）→ ambiguous', () => {
    expect(decide('蜜塔這個功能是不是有點難做啊').kind).toBe('ambiguous')
  })

  it('轉述蜜塔說過的話 → ambiguous', () => {
    expect(decide('蜜塔剛才說截止日是六月三十號對吧').kind).toBe('ambiguous')
  })

  it('英文名的句中提及 → ambiguous', () => {
    expect(decide('剛剛那個 Meeta 的回應真的很怪').kind).toBe('ambiguous')
  })

  it('只叫名字 → wake-pending（不需要語意判斷，後面根本沒內容）', () => {
    const d = decide('蜜塔')
    expect(d.kind).toBe('wake-pending')
  })

  it('只叫名字＋標點 → 一樣 wake-pending', () => {
    expect(decide('蜜塔,').kind).toBe('wake-pending')
    expect(decide('蜜塔，').kind).toBe('wake-pending')
  })

  it('沒有喚醒詞 → ignore', () => {
    expect(decide('我們今天先過一下專案進度').kind).toBe('ignore')
  })
})

describe('decideAddressing — 待命窗與 debounce', () => {
  it('待命窗內同一人的下一段 → 視為問題', () => {
    const state: AddressingState = { lastWakeAt: 0, wakePendingUntil: NOW + WAKE_PENDING_MS, wakePendingSpeaker: 'A' }
    const d = decide('我們的評分標準是什麼', state, NOW + 3000, 'A')
    expect(d.kind).toBe('question')
    if (d.kind === 'question') expect(d.viaPendingWindow).toBe(true)
  })

  it('待命窗逾時 → 不接', () => {
    const state: AddressingState = { lastWakeAt: 0, wakePendingUntil: NOW + 1000, wakePendingSpeaker: 'A' }
    expect(decide('我先去倒杯水', state, NOW + 20_000, 'A').kind).toBe('ignore')
  })

  it('待命窗屬於別人 → 不接', () => {
    const state: AddressingState = { lastWakeAt: 0, wakePendingUntil: NOW + WAKE_PENDING_MS, wakePendingSpeaker: 'A' }
    expect(decide('我先去倒杯水', state, NOW + 2000, 'B').kind).toBe('ignore')
  })

  it('debounce 期間的重複喚醒 → debounced', () => {
    const state: AddressingState = { lastWakeAt: NOW, wakePendingUntil: 0, wakePendingSpeaker: null }
    expect(decide('蜜塔，報名費多少錢', state, NOW + 800).kind).toBe('debounced')
  })

  it('只叫名字不消耗 debounce（下一段真問題才算）', () => {
    // 「蜜塔」單獨成段時回 wake-pending，呼叫端不會寫 lastWakeAt
    expect(decide('蜜塔').kind).toBe('wake-pending')
  })
})

describe('decideChatAddressing — 聊天室', () => {
  it('句首呼喚 → 派發', () => {
    const d = decideChatAddressing({ lastWakeAt: 0 }, { text: '蜜塔 這份文件是什麼？', speaker: 'U', now: NOW })
    expect(d.kind).toBe('question')
  })
  it('句中提及 → ambiguous（與語音同一套準則）', () => {
    const d = decideChatAddressing({ lastWakeAt: 0 }, { text: '我覺得蜜塔的回應怪怪的', speaker: 'U', now: NOW })
    expect(d.kind).toBe('ambiguous')
  })
  it('只有喚醒詞沒問題 → ignore（聊天室沒有待命窗）', () => {
    expect(decideChatAddressing({ lastWakeAt: 0 }, { text: '蜜塔', speaker: 'U', now: NOW }).kind).toBe('ignore')
  })
})

describe('isVocativeWake — partial 片段的快速 ack 判準', () => {
  // partial 尚未加標點，故只看位置不要求分隔符
  it('句首（未加標點的 partial）→ 可以 ack', () => {
    expect(isVocativeWake('蜜塔請問')).toBe(true)
    expect(isVocativeWake('蜜塔可以')).toBe(true)
  })
  it('句中提及 → 不 ack（避免討論到一半被插嘴）', () => {
    expect(isVocativeWake('我覺得蜜塔這個')).toBe(false)
    expect(isVocativeWake('剛剛那個 Meeta 的')).toBe(false)
  })
  it('沒有喚醒詞 → 不 ack', () => {
    expect(isVocativeWake('今天天氣不錯')).toBe(false)
  })
})

describe('parseVerdict — 語意裁決輸出解析', () => {
  it('明確輸出', () => {
    expect(parseVerdict('address')).toBe('address')
    expect(parseVerdict('mention')).toBe('mention')
    expect(parseVerdict(' Address\n')).toBe('address')
  })
  it('無法解析 → unknown（呼叫端據此退回舊行為，不可當成 mention）', () => {
    expect(parseVerdict('')).toBe('unknown')
    expect(parseVerdict('我不確定')).toBe('unknown')
  })
})
