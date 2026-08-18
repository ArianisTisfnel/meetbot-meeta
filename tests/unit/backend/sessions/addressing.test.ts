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
  isEngaged,
  FOLLOWUP_WINDOW_MS,
  type AddressingState,
} from '../../../../backend/src/sessions/addressing'
import {
  parseTurnDecision,
  dropQuestionCopiedFromEarlierEntry,
  type TurnDecision,
} from '../../../../backend/src/sessions/response-policy'
import type { ConversationEntryLike } from '../../../../backend/src/sessions/interjection-prompts'

const NOW = 1_700_000_000_000
const fresh = (): AddressingState => ({ lastWakeAt: 0, lastEngagedAt: 0 })
/** 對話串開著（蜜塔剛被叫過）的狀態。 */
const engaged = (at = NOW): AddressingState => ({ lastWakeAt: 0, lastEngagedAt: at })
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

  it('只叫名字 → wake-only（不需要語意判斷，後面根本沒內容）', () => {
    const d = decide('蜜塔')
    expect(d.kind).toBe('wake-only')
  })

  it('只叫名字＋標點 → 一樣 wake-only', () => {
    expect(decide('蜜塔,').kind).toBe('wake-only')
    expect(decide('蜜塔，').kind).toBe('wake-only')
  })

  it('沒有喚醒詞、對話串也沒開 → ignore（連問都不問，是誤觸發與成本的主要防線）', () => {
    expect(decide('我們今天先過一下專案進度').kind).toBe('ignore')
  })
})

describe('decideAddressing — 連續追問（回報 A.3）', () => {
  it('沒喊名字但對話串開著 → followup-candidate，交給語意層', () => {
    const d = decide('那名額有限制嗎', engaged(), NOW + 12_000)
    expect(d.kind).toBe('followup-candidate')
    if (d.kind === 'followup-candidate') expect(d.candidate).toBe('那名額有限制嗎')
  })

  it('第三輪追問一樣送得出去（舊的 8 秒待命窗接不到這裡）', () => {
    expect(decide('那如果超過了會怎樣', engaged(), NOW + 20_000).kind).toBe('followup-candidate')
  })

  it('換人講話照樣是候選：誰在追問由語意層判，不靠 speaker 比對', () => {
    // 舊待命窗綁定說話者，「別人接著問」就接不上；語意層看得到整段對話。
    expect(decide('那名額有限制嗎', engaged(), NOW + 5_000, 'B').kind).toBe('followup-candidate')
  })

  it('對話串逾時 → ignore，不再花呼叫', () => {
    expect(decide('我先去倒杯水', engaged(), NOW + FOLLOWUP_WINDOW_MS + 1).kind).toBe('ignore')
  })

  it('對話串從沒開過 → ignore', () => {
    expect(decide('那名額有限制嗎', fresh(), NOW).kind).toBe('ignore')
  })

  it('isEngaged 的邊界', () => {
    expect(isEngaged({ lastEngagedAt: 0 }, NOW)).toBe(false)
    expect(isEngaged({ lastEngagedAt: NOW }, NOW + FOLLOWUP_WINDOW_MS - 1)).toBe(true)
    expect(isEngaged({ lastEngagedAt: NOW }, NOW + FOLLOWUP_WINDOW_MS)).toBe(false)
  })
})

describe('decideAddressing — debounce', () => {
  it('debounce 期間的重複喚醒 → debounced', () => {
    const state: AddressingState = { lastWakeAt: NOW, lastEngagedAt: 0 }
    expect(decide('蜜塔，報名費多少錢', state, NOW + 800).kind).toBe('debounced')
  })

  it('同一句定稿重送的追問也吃 debounce', () => {
    const state: AddressingState = { lastWakeAt: NOW, lastEngagedAt: NOW }
    expect(decide('那名額有限制嗎', state, NOW + 800).kind).toBe('debounced')
  })

  it('只叫名字不消耗 debounce（下一段真問題才算）', () => {
    // 「蜜塔」單獨成段時回 wake-only，呼叫端不會寫 lastWakeAt
    expect(decide('蜜塔').kind).toBe('wake-only')
  })
})

describe('decideAddressing — 叫停指令', () => {
  it('「蜜塔 不用了」→ stop，不可當成新問題', () => {
    // 回報 2026-07-28 定址基準裡唯一殘留的誤觸發：叫停反而觸發一次資料檢索
    expect(decide('蜜塔 不用了').kind).toBe('stop')
  })

  it('其餘叫停詞同樣涵蓋', () => {
    for (const t of ['蜜塔，閉嘴', '蜜塔 安靜', '蜜塔，停', '蜜塔 夠了！', '蜜塔，別說了～']) {
      expect(decide(t).kind).toBe('stop')
    }
  })

  it('叫停判定先於 debounce：她才剛開口就喊停也要收到', () => {
    // 叫停幾乎必然落在 debounce 窗內（她 2 秒前才被喚醒）。
    // 若讓 debounce 先攔，這句會整個被丟掉。
    const state: AddressingState = { lastWakeAt: NOW, lastEngagedAt: NOW }
    expect(decide('蜜塔 閉嘴', state, NOW + 500).kind).toBe('stop')
  })

  it('叫停判定先於 ambiguous：不花 LLM 去問「這是不是在跟我說話」', () => {
    // 「蜜塔不用了」沒有停頓標點，照原路會被判 ambiguous 送語意裁決
    expect(decide('蜜塔不用了').kind).toBe('stop')
  })

  it('整句錨定：叫停詞出現在句中不算叫停', () => {
    // 「不用了」後面還有內容 → 是討論不是叫停，不可靜音
    expect(decide('蜜塔，不用了我們改用另一個方案好嗎').kind).not.toBe('stop')
    expect(decide('蜜塔，停車場在哪裡').kind).toBe('question')
  })

  it('對話串裡回一句叫停 → stop（收回上一個呼喚，不是要問「不用了」）', () => {
    expect(decide('不用了', engaged(), NOW + 3000, 'A').kind).toBe('stop')
  })

  it('聊天室打叫停 → stop（與語音同一份詞表）', () => {
    expect(decideChatAddressing({ lastWakeAt: 0 }, { text: '蜜塔 不用了', speaker: 'U', now: NOW }).kind).toBe('stop')
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
  it('只有喚醒詞沒問題 → ignore（打字時人一定會把問題打完）', () => {
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

describe('parseTurnDecision — 語意層輸出解析', () => {
  it('完整 JSON', () => {
    const d = parseTurnDecision(
      '{"addressed":"address","question":"那名額有限制嗎","intent":"factual","interject":false}',
    )
    expect(d).toEqual({ addressed: 'address', question: '那名額有限制嗎', intent: 'factual', interject: false })
  })

  it('包在 markdown 圍欄裡也吃得下（模型常這樣回）', () => {
    const d = parseTurnDecision('```json\n{"addressed":"none","question":"","intent":"factual","interject":true}\n```')
    expect(d.addressed).toBe('none')
    expect(d.interject).toBe(true)
  })

  it('addressed 用中文講也認得', () => {
    expect(parseTurnDecision('{"addressed":"在談論蜜塔"}').addressed).toBe('mention')
  })

  it('壞掉的 JSON → unknown（呼叫端據此各自退回，不可當成 mention 或 none）', () => {
    expect(parseTurnDecision('').addressed).toBe('unknown')
    expect(parseTurnDecision('我不確定').addressed).toBe('unknown')
  })

  it('欄位缺漏 → 一律給最保守的預設值', () => {
    const d = parseTurnDecision('{"addressed":"none"}')
    expect(d).toEqual({ addressed: 'none', question: '', intent: 'factual', interject: false })
  })

  it('interject 只認真正的 true（模型回字串 "true" 不算）', () => {
    expect(parseTurnDecision('{"addressed":"none","interject":"true"}').interject).toBe(false)
  })

  // 實測 2026-07-29：窗是「[A] 蜜塔」＋「[B] 我先去倒杯水」時，模型判 address 並把前一則的
  // 「蜜塔」當成要回答的問題 → 有人喊一聲名字、別人講不相干的事，她就拿「蜜塔」去查知識庫。
  it('question 只剩喚醒詞 → 視為沒有問題（喊一聲名字不是問題）', () => {
    expect(parseTurnDecision('{"addressed":"address","question":"蜜塔"}').question).toBe('')
    expect(parseTurnDecision('{"addressed":"address","question":"蜜塔，"}').question).toBe('')
    expect(parseTurnDecision('{"addressed":"address","question":"Meeta"}').question).toBe('')
  })

  it('喚醒詞開頭的真問題不受影響', () => {
    expect(parseTurnDecision('{"addressed":"address","question":"蜜塔在嗎"}').question).toBe('蜜塔在嗎')
  })
})

// 實測 2026-08-18（第 14 次真會議的同一類錯誤）：長會議裡蜜塔被叫過很多次時，
// 模型會把前面某一則的問題原封不動搬來配給最後一則——最後一則只是「等一下」這種 STT 半句，
// 卻配上第一則的「蜜塔，剛才誰在講資料庫搬遷」送去檢索。
// prompt 那側已加了取材範圍、反例與 lastLineIsFiller 閘門，命中率上去但壓不到零，
// 這一層是結構性的第二道防線（與 meaningfulQuestion 同一個設計）。
describe('dropQuestionCopiedFromEarlierEntry — question 只能取自最後一則', () => {
  const entry = (speaker: string, text: string): ConversationEntryLike => ({
    speaker,
    text,
    source: 'voice',
    fromBot: false,
  })
  const decision = (over: Partial<TurnDecision> = {}): TurnDecision => ({
    addressed: 'address',
    question: '',
    intent: 'factual',
    interject: false,
    ...over,
  })

  const window = [
    entry('Arianis', '蜜塔，剛才誰在講資料庫搬遷'),
    entry('Arianis', '這個是'),
    entry('Ray', '等一下'),
  ]

  it('逐字抄自前面某一則 → 抹成空字串（擷不出問題就閉嘴）', () => {
    const d = dropQuestionCopiedFromEarlierEntry(
      decision({ question: '蜜塔，剛才誰在講資料庫搬遷' }),
      window,
    )
    expect(d.question).toBe('')
    expect(d.addressed).toBe('address') // 只動 question，退回方向仍由呼叫端決定
  })

  it('抄前面那一則、但把喚醒詞剝掉了也要擋', () => {
    expect(
      dropQuestionCopiedFromEarlierEntry(decision({ question: '剛才誰在講資料庫搬遷' }), window).question,
    ).toBe('')
  })

  it('取自最後一則 → 不動', () => {
    const w = [entry('Arianis', '蜜塔，報名截止日是什麼時候'), entry('Arianis', '那名額有限制嗎')]
    expect(
      dropQuestionCopiedFromEarlierEntry(decision({ question: '那名額有限制嗎' }), w).question,
    ).toBe('那名額有限制嗎')
  })

  it('最後一則的忠實濃縮不算抄襲（判準刻意只認逐字相同）', () => {
    const w = [entry('小華', '先講進度'), entry('小明', '蜜塔，我想問報名截止日是什麼時候啊')]
    expect(
      dropQuestionCopiedFromEarlierEntry(decision({ question: '報名截止日是什麼時候' }), w).question,
    ).toBe('報名截止日是什麼時候')
  })

  it('有人重複講同一句話 → 不誤殺（最後一則本身就是那句）', () => {
    const w = [entry('小明', '蜜塔，報名截止日是什麼時候'), entry('小明', '蜜塔，報名截止日是什麼時候')]
    expect(
      dropQuestionCopiedFromEarlierEntry(decision({ question: '蜜塔，報名截止日是什麼時候' }), w).question,
    ).toBe('蜜塔，報名截止日是什麼時候')
  })

  // 兩個出口的取材範圍相反：插話本來就該去撿被閒聊蓋過去、沒人回答的問題。
  it('addressed 不是 address 時完全不生效（插話出口不可被波及）', () => {
    const w = [entry('小明', '初賽是線上還是要到現場啊？'), entry('小華', '等等要不要順便訂飲料')]
    const d = dropQuestionCopiedFromEarlierEntry(
      decision({ addressed: 'none', interject: true, question: '初賽是線上還是要到現場啊？' }),
      w,
    )
    expect(d.question).toBe('初賽是線上還是要到現場啊？')
  })

  it('窗只有一則、或 question 為空 → 直接放行', () => {
    const w = [entry('小明', '蜜塔，報名截止日是什麼時候')]
    expect(
      dropQuestionCopiedFromEarlierEntry(decision({ question: '蜜塔，報名截止日是什麼時候' }), w).question,
    ).toBe('蜜塔，報名截止日是什麼時候')
    expect(dropQuestionCopiedFromEarlierEntry(decision({ question: '' }), window).question).toBe('')
  })
})
