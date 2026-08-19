import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// 喚醒詞偵測現在透過 provider 抽象層說話 / 發聊天室訊息（不再直接呼叫 vexaClient）。
const mockBotProvider = vi.hoisted(() => ({
  speak: vi.fn().mockResolvedValue(undefined),
  sendChat: vi.fn().mockResolvedValue(undefined),
  stopSpeaking: vi.fn().mockResolvedValue(undefined),
  getTranscript: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../../backend/src/provider/index', () => ({ botProvider: mockBotProvider }))
vi.mock('../../../../backend/src/lib/dify', () => ({
  askQuestion: vi.fn().mockResolvedValue({ answer: '測試回答', conversationId: 'conv-1' }),
  DIFY_NO_RESULT_SENTINEL: '抱歉 沒有檢索到相關資訊',
}))
// 直接 mock lib/llm：原本只 mock @anthropic-ai/sdk，但 llm.ts 解析到 backend/node_modules
// 的實體套件，mock 從未生效（classify 路徑靠 catch 回退 factual 才沒炸）。
vi.mock('../../../../backend/src/lib/llm', () => ({
  completeText: vi.fn().mockResolvedValue('Claude 回答'),
}))
// hoisted：REPLY_TAGS 要能在個別測試裡切換（標籤開關）
const mockEnv = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: 'sk-ant-test',
  DIFY_API_BASE: 'http://dify.test',
  DIFY_WORKFLOW_API_KEY: 'app-test',
  DIFY_CHATFLOW_TIMEOUT_MS: 45000,
  REPLY_TAGS: 'on' as 'on' | 'off',
}))
vi.mock('../../../../backend/src/types/env', () => ({ env: mockEnv }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Claude 回答' }],
      }),
    },
  })),
}))

import {
  handleTranscriptSegment,
  handlePartialSegment,
  handleChatMessage,
  handleBargeIn,
  parseIntent,
  speakProactive,
  speechTiming,
  sendChatBestEffort,
} from '../../../../backend/src/sessions/wake-word-detector'
import { completeText } from '../../../../backend/src/lib/llm'
import * as dify from '../../../../backend/src/lib/dify'

// 語音播放估時歸零：測試裡 speak 是即時 mock，不能真等「開場白唸完」的 3-6 秒
speechTiming.msPerChar = 0
speechTiming.extraMs = 0
speechTiming.floorMs = 0
import type { MeetingSession } from '../../../../backend/src/types/session'
import type { BotSession } from '../../../../backend/src/provider/types'

const fakeBotSession: BotSession = {
  provider: 'recall',
  platform: 'google_meet',
  nativeMeetingId: 'abc-defg-hij',
  providerMeetingId: 42,
  adapter: mockBotProvider as any,
  state: {},
}

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    meetingInstanceId: 'meet-1',
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    difyDatasetId: 'dataset-abc',
    isSpeaking: false,
    lastWakeAt: 0,
    lastEngagedAt: 0,
    partialAckAt: 0,
    currentSpeech: null,
    speechStartedAt: 0,
    speechEndsAt: 0,
    bargeEpoch: 0,
    lastStopAt: 0,
    speechGen: 0,
    chatLog: [],
    sessionStartedAt: 0,
    processedSegmentIds: new Set<string>(),
    botSession: fakeBotSession,
    difyConversationId: null,
    lastQuestionAt: 0,
    kbContentCard: null,
    ...overrides,
  }
}

describe('handleTranscriptSegment — 喚醒詞偵測', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('「蜜塔，請問這份規則是最新版嗎？」→ 觸發，question 正確', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-1',
      text: '蜜塔，請問這份規則是最新版嗎？',
      speaker: 'A',
      start_time: 1,
      end_time: 3,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「小幫手請問」→ 觸發（前置標點去除）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-2',
      text: '小幫手請問',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「Meeta, what is this?」→ 觸發（英文）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-3',
      text: 'Meeta, what is this?',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「蜜桃，請問報名日期」→ 觸發（STT 把「蜜塔」聽成「蜜桃」）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-peach',
      text: '蜜桃，請問報名日期',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「mita 今天的議程」→ 觸發（小寫英文）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-4',
      text: 'mita 今天的議程',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('同一 segment_id 第二次 → 不觸發（processedSegmentIds 去重）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-dup',
      text: '蜜塔，重複測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    vi.clearAllMocks()

    await handleTranscriptSegment(session, {
      segment_id: 'seg-dup',
      text: '蜜塔，重複測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('2 秒內第二個觸發 → 被 debounce 阻止', async () => {
    const session = makeSession()
    session.lastWakeAt = Date.now() - 500  // 500ms 前剛觸發過

    await handleTranscriptSegment(session, {
      segment_id: 'seg-debounce',
      text: '蜜塔，debounce 測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('segment 無 segment_id → 不處理', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: '',  // 空字串視為無 ID
      text: '蜜塔，測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('processedSegmentIds 超過 5000 → 減半（size 約 2500）', async () => {
    const session = makeSession()
    // 填入 5000 個 ID
    for (let i = 0; i < 5000; i++) {
      session.processedSegmentIds.add(`seg-fill-${i}`)
    }
    expect(session.processedSegmentIds.size).toBe(5000)

    await handleTranscriptSegment(session, {
      segment_id: 'seg-trigger',
      text: '蜜塔，觸發減半',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })

    // 減半後加入新 ID，size 應約為 2501
    expect(session.processedSegmentIds.size).toBeLessThanOrEqual(2502)
    expect(session.processedSegmentIds.size).toBeGreaterThan(2400)
  })

  it('問題為空字串（只說了「蜜塔」）→ 不觸發 speak', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-empty',
      text: '蜜塔',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })
})

describe('handlePartialSegment — partial 快速喚醒', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('partial 含喚醒詞 → 立即說開場白；同句重複 partial 在抑制期內只 ack 一次', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '蜜塔可以', speaker: 'A' })
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(1)

    await handlePartialSegment(session, { text: '蜜塔可以告訴我', speaker: 'A' })
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(1)
  })

  it('partial 無喚醒詞 → 不動作', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '今天天氣不錯', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('partial ack 後 final 派發 → 跳過開場白（ack + 答案共 2 次 speak）', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '蜜塔請問', speaker: 'A' })
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(1) // 開場白（提早）

    await handleTranscriptSegment(session, {
      segment_id: 'seg-final',
      text: '蜜塔請問今天的議程是什麼',
      speaker: 'A',
      start_time: 1,
      end_time: 3,
    })
    // final 跳過開場白、只說答案 → 總共 2 次（未跳過會是 3 次）
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(2)
    expect(session.partialAckAt).toBe(0) // 一次性消耗
  })

  it('bot 正在說話（isSpeaking）→ 不 ack', async () => {
    const session = makeSession({ isSpeaking: true })
    await handlePartialSegment(session, { text: '蜜塔請問', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('叫停後的靜默期內，只到「蜜塔」的 partial → 不 ack（實測 2026-08-16 連喊兩次閉嘴）', async () => {
    const session = makeSession({ lastStopAt: Date.now() - 3000 })
    await handlePartialSegment(session, { text: '蜜塔', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('殘響閘也擋呼喚路徑：「蜜塔,請。」帶逗號 → 丟棄不回答（實測回「好喔」的雷）', async () => {
    const session = makeSession({ lastStopAt: Date.now() - 2300 })
    await handleTranscriptSegment(session, {
      segment_id: 'seg-residue-vocative',
      text: '蜜塔,請。',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled()
  })

  it('她說話時「立大安靜」（喚醒詞爛掉＋叫停詞結尾）→ 視為叫停：停止且不轉貼', async () => {
    const session = makeSession({
      isSpeaking: true,
      currentSpeech: '被打斷的答案',
      speechGen: 1,
    })
    await handleBargeIn(session, { text: '立大安靜', speaker: 'A' })
    expect(mockBotProvider.stopSpeaking).toHaveBeenCalled()
    expect(session.lastStopAt).toBeGreaterThan(0) // 停得乾淨：靜默期起算
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled() // 叫停不轉貼被打斷內容
  })

  it('叫停時查詢還在路上 → bargeEpoch 作廢在途語音（答案改走聊天室）', async () => {
    const session = makeSession()
    const before = session.bargeEpoch
    await handleTranscriptSegment(session, {
      segment_id: 'seg-stop-inflight',
      text: '蜜塔不用查',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(session.bargeEpoch).toBe(before + 1)
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('叫停靜默期內的殘響碎片（「蜜塔不來」）→ 丟棄，不送語意層也不回答', async () => {
    const session = makeSession({ lastStopAt: Date.now() - 3000 })
    await handleTranscriptSegment(session, {
      segment_id: 'seg-residue',
      text: '蜜塔不來',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled()
  })

  it('sendChatBestEffort 的 refLine：聊天室看得到引用行，chatLog 存原文', async () => {
    const session = makeSession()
    await sendChatBestEffort(session, '答案內容', 'chat', undefined, '↪ 回 A 問「X」')
    expect(vi.mocked(mockBotProvider.sendChat).mock.calls[0][1]).toBe('↪ 回 A 問「X」\n答案內容')
    expect(session.chatLog.at(-1)?.text).toBe('答案內容')
  })

  it('聊天室顯示：句末標點後換行；chatLog 仍存原文', async () => {
    const session = makeSession()
    await sendChatBestEffort(session, '第一句。第二句；第三句「引文。」結尾。', 'chat')
    expect(vi.mocked(mockBotProvider.sendChat).mock.calls[0][1]).toBe('第一句。\n第二句；\n第三句「引文。」結尾。')
    expect(session.chatLog.at(-1)?.text).toBe('第一句。第二句；第三句「引文。」結尾。')
  })

  it('ack 輪替：抑制期外的第二次喚醒 → 不同的 ack 措辭（不像錄音機）', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '蜜塔請問A', speaker: 'A' })
    // 跳過抑制期與 debounce，模擬下一題
    session.partialAckAt = Date.now() - 13_000
    session.lastWakeAt = Date.now() - 13_000
    await handlePartialSegment(session, { text: '蜜塔請問B', speaker: 'B' })
    const first = vi.mocked(mockBotProvider.speak).mock.calls[0][1]
    const second = vi.mocked(mockBotProvider.speak).mock.calls[1][1]
    expect(first).not.toBe(second)
  })

  it('partial 判為叫停 → 標記 lastStopAt（final 沒來也要起算靜默期）', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '蜜塔閉嘴', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
    expect(session.lastStopAt).toBeGreaterThan(0)
  })
})

describe('語音問題但嘴巴被佔用 → 改走聊天室', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('isSpeaking 時的語音喚醒 → 不 speak，答案走 sendChat（含 👂 確認）', async () => {
    const session = makeSession({ isSpeaking: true })
    await handleTranscriptSegment(session, {
      segment_id: 'seg-busy',
      text: '蜜塔，報名費是多少',
      speaker: 'B',
      start_time: 1,
      end_time: 2,
    })

    expect(mockBotProvider.speak).not.toHaveBeenCalled()
    // 👂 確認 + 答案 = 至少兩次 sendChat
    expect(mockBotProvider.sendChat.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mockBotProvider.sendChat.mock.calls[0][1]).toContain('👂')
    expect(mockBotProvider.sendChat.mock.calls[0][1]).toContain('B')
  })
})

describe('喚醒詞剝除後的開頭標點清理', () => {
  beforeEach(() => vi.clearAllMocks())

  // AGENT_MODE 走 OpenAI 轉錄，輸出半形標點；舊版只清全形 → 蜜塔覆誦出「,可以…」
  // 且逗號一路帶進 Dify 檢索字串（回報 2026-07-28）。
  it('半形逗號開頭（OpenAI 轉錄）→ 問題不含前置逗號', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-halfwidth',
      text: '蜜塔, 可以告訴我我們的資料中有什麼內容嗎?',
      speaker: 'A',
      start_time: 1,
      end_time: 3,
    })
    const ack = String(mockBotProvider.sendChat.mock.calls[0][1])
    expect(ack).toContain('「可以告訴我')
    expect(ack).not.toContain('「,')
  })

  it('聊天室的半形標點同樣清乾淨', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'User',
      text: 'Meeta. 報名費多少?',
      timestamp: Date.now(),
      isFromBot: false,
    })
    // 第一則是 ack，答案在後面；檢查送進 Dify 的問題不帶前置句點
    const dify = await import('../../../../backend/src/lib/dify')
    expect((dify.askQuestion as any).mock.calls[0][0].question).toBe('報名費多少?')
  })

  it('只叫名字＋標點（「蜜塔，」）→ 仍視為沒問題，開對話串而不派發', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-name-only-punct',
      text: '蜜塔,',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
    expect(session.lastEngagedAt).toBeGreaterThan(0)
  })
})

describe('回覆功能標籤（REPLY_TAGS）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.REPLY_TAGS = 'on'
  })

  // ack 在意圖分類前就送出，所以既不能宣稱要查什麼，也不能斷定對方是在提問。
  // 兩者都踩過：07-28 是「正在查詢資料中」，07-29 是對「哈囉」寫「收到…的問題」。
  it('ack 措辭中性：不宣稱查詢、也不預設對方在提問', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-ack',
      text: '蜜塔，哈囉',
      speaker: 'Arianis',
      start_time: 1,
      end_time: 2,
    })
    const ack = String(mockBotProvider.sendChat.mock.calls[0][1])
    expect(ack).toContain('【收到】')
    expect(ack).toContain('Arianis')
    expect(ack).toContain('哈囉')
    expect(ack).not.toContain('查詢資料')
    expect(ack).not.toContain('查閱會議記錄')
    expect(ack).not.toContain('問題') // 「哈囉」不是提問
  })

  it('檢索沒中時，送出的是人話而不是內部哨兵句', async () => {
    const dify = await import('../../../../backend/src/lib/dify')
    ;(dify.askQuestion as any).mockResolvedValueOnce({
      answer: '抱歉 沒有檢索到相關資訊',
      conversationId: 'c1',
    })
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'User',
      text: '蜜塔 報名費是多少',
      timestamp: Date.now(),
      isFromBot: false,
    })
    const texts = mockBotProvider.sendChat.mock.calls.map((c: any[]) => String(c[1]))
    // 哨兵句沒有標點，是給程式精確比對用的內部訊號，不該原樣呈現給使用者
    expect(texts.some((t) => t.includes('抱歉 沒有檢索到相關資訊'))).toBe(false)
    expect(texts.some((t) => t.includes('找不到相關內容'))).toBe(true)
  })

  it('走 Dify RAG 的答案 → 聊天室標【資料檢索】，但語音不唸標籤', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-tag-rag',
      text: '蜜塔，報名費是多少',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    const chats = mockBotProvider.sendChat.mock.calls.map((c: any[]) => String(c[1]))
    expect(chats.some((t) => t.includes('\n【資料檢索】') && t.includes('測試回答'))).toBe(true)
    const spoken = mockBotProvider.speak.mock.calls.map((c: any[]) => String(c[1]))
    expect(spoken.every((t) => !t.includes('【'))).toBe(true)
  })

  it('閒聊路徑 → 標【閒聊】（分類器回 chitchat）', async () => {
    const session = makeSession()
    ;(completeText as any)
      .mockResolvedValueOnce('{"addressed":"address","question":"你好啊","intent":"chitchat","interject":false}')
      .mockResolvedValueOnce('我在喔！')
    await handleTranscriptSegment(session, {
      segment_id: 'seg-tag-chitchat',
      text: '蜜塔，你好啊',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    const chats = mockBotProvider.sendChat.mock.calls.map((c: any[]) => String(c[1]))
    expect(chats.some((t) => t.includes('\n【閒聊】'))).toBe(true)
  })

  it('無知識庫 → 標【會議記錄】', async () => {
    const session = makeSession({ difyDatasetId: null })
    await handleChatMessage(session, {
      sender: 'User',
      text: '蜜塔，我們剛剛的結論是什麼',
      timestamp: Date.now(),
      isFromBot: false,
    })
    const chats = mockBotProvider.sendChat.mock.calls.map((c: any[]) => String(c[1]))
    expect(chats.some((t) => t.includes('\n【會議記錄】'))).toBe(true)
  })

  it('REPLY_TAGS=off → 完全沒有標籤', async () => {
    mockEnv.REPLY_TAGS = 'off'
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-tag-off',
      text: '蜜塔，報名費是多少',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    const chats = mockBotProvider.sendChat.mock.calls.map((c: any[]) => String(c[1]))
    expect(chats.every((t) => !t.includes('【'))).toBe(true)
  })

  it('標籤不進 chatLog／對話窗：留存的是未加標籤的原文', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-tag-log',
      text: '蜜塔，報名費是多少',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(session.chatLog.length).toBeGreaterThan(0)
    expect(session.chatLog.every((m) => !m.text.includes('【'))).toBe(true)
  })
})

describe('parseIntent — 問答意圖分流', () => {
  it('chitchat / factual / context / hybrid 關鍵字正確解析', () => {
    expect(parseIntent('chitchat')).toBe('chitchat')
    expect(parseIntent('factual')).toBe('factual')
    expect(parseIntent('context')).toBe('context')
    expect(parseIntent('hybrid')).toBe('hybrid')
    expect(parseIntent('這是閒聊')).toBe('chitchat')
    expect(parseIntent('寒暄')).toBe('chitchat')
    expect(parseIntent('這是意見型問題')).toBe('context')
    expect(parseIntent('混合')).toBe('hybrid')
  })

  it('未知輸出 → 回退 factual（保持原 RAG 行為）', () => {
    expect(parseIntent('Claude 回答')).toBe('factual')
    expect(parseIntent('')).toBe('factual')
  })
})

describe('handleBargeIn — 說話中被打斷讓路', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('蜜塔說話中有人講話 → 停止語音、被打斷的回答貼聊天室、isSpeaking 解除', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '這是被打斷的答案' })
    await handleBargeIn(session, { text: '等一下我有意見', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(session.isSpeaking).toBe(false)
    expect(session.bargeEpoch).toBe(1)
    // 讓路後進入喚醒靜默期：抑制插話引擎把打斷者的話當新問題重複回答
    expect(session.lastWakeAt).toBeGreaterThan(0)
    expect(mockBotProvider.sendChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('這是被打斷的答案'),
    )
  })

  // 模擬器 2026-08-03：語音答案唸完的**當下**就鏡像到聊天室了（speak 送出即返回），
  // 7 秒後有人插嘴，barge-in 又把同一段當成「漏送的內容」貼一次。
  it('語音答案已鏡像到聊天室 → 播放中被打斷不再重貼一次', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-barge-dup',
      text: '蜜塔，報名截止日是什麼時候？',
      speaker: 'A',
      start_time: 1,
      end_time: 3,
    })
    expect(session.currentSpeech).toBeNull() // 沒有「還沒送到的內容」
    const chatCallsBefore = mockBotProvider.sendChat.mock.calls.length

    session.isSpeaking = true // 估時未到，嘴巴還在播
    session.speechStartedAt = Date.now() - 7_000 // 註解說的「7 秒後」：越過開口寬限期
    await handleBargeIn(session, { text: '等一下我有意見', speaker: 'B' })

    expect(mockBotProvider.stopSpeaking).toHaveBeenCalledTimes(1) // 還是要停
    expect(mockBotProvider.sendChat.mock.calls.length).toBe(chatCallsBefore) // 但不重貼
  })

  it('STT 晚到事件：開口時間早於蜜塔開始說話 → 不算打斷', async () => {
    const base = Date.now() - 100_000
    const session = makeSession({
      isSpeaking: true,
      currentSpeech: '答案',
      sessionStartedAt: base,       // 會議 base 開始
      speechStartedAt: base + 60_000, // 蜜塔在第 60 秒開口
    })
    // 使用者在第 50 秒開口（蜜塔還沒說話），事件晚到
    await handleBargeIn(session, { text: '我想知道供應鏈狀況', speaker: 'A', startTime: 50 })

    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
    expect(session.isSpeaking).toBe(true)
  })

  it('明確停止指令（閉嘴）→ 即使很短也停止，且不轉貼被打斷內容', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '被打斷的答案' })
    await handleBargeIn(session, { text: '閉嘴', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(session.isSpeaking).toBe(false)
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled()
  })

  // 實測 2026-08-18：她開口 154 次被打斷 73 次，86% 是 6 字以下的碎片
  //（與會者彼此講話被 partial 切出來的半句），她講的話有近一半沒講完。
  it('旁人的短碎片（6 字以下）→ 不再打斷她', async () => {
    const session = makeSession({
      isSpeaking: true,
      currentSpeech: '答案',
      speechStartedAt: Date.now() - 10_000, // 早就過了寬限期，確保測到的是長度門檻
      speechGen: 1,
    })
    await handleBargeIn(session, { text: '可是女生', speaker: 'B' })
    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
    expect(session.isSpeaking).toBe(true)
  })

  it('開口寬限期內的旁人發言 → 不打斷（讓她至少講完一句）', async () => {
    const session = makeSession({
      isSpeaking: true,
      currentSpeech: '答案',
      speechStartedAt: Date.now() - 500, // 剛開口 0.5 秒
      speechGen: 1,
    })
    await handleBargeIn(session, { text: '我覺得這個方案應該要再討論一下比較好', speaker: 'B' })
    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
  })

  // 底線：叫停不受長度門檻與寬限期任何一項限制
  it('寬限期內喊「蜜塔閉嘴」→ 照樣立刻停', async () => {
    const session = makeSession({
      isSpeaking: true,
      currentSpeech: '答案',
      speechStartedAt: Date.now() - 200, // 才剛開口
      speechGen: 1,
    })
    await handleBargeIn(session, { text: '蜜塔閉嘴', speaker: 'A' })
    expect(mockBotProvider.stopSpeaking).toHaveBeenCalled()
    expect(session.isSpeaking).toBe(false)
  })

  it('短附和（嗯嗯）→ 不觸發讓路', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '答案' })
    await handleBargeIn(session, { text: '嗯嗯', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
    expect(session.isSpeaking).toBe(true)
  })

  it('蜜塔沒在說話 → 不動作', async () => {
    const session = makeSession({ isSpeaking: false })
    await handleBargeIn(session, { text: '這是一般發言內容', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
    expect(session.bargeEpoch).toBe(0)
  })

  it('重複打斷訊號 → 只讓路一次（isSpeaking 已翻false）', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '答案' })
    await handleBargeIn(session, { text: '等一下我有意見', speaker: 'A' })
    await handleBargeIn(session, { text: '等一下我有意見喔', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(session.bargeEpoch).toBe(1)
  })
})

describe('answerFromTranscript — 純文字會議的脈絡來源', () => {
  beforeEach(() => vi.clearAllMocks())

  it('無知識庫＋逐字稿為空：context 從 chatLog 取得（不再「內容不足」）', async () => {
    const session = makeSession({
      difyDatasetId: null,
      chatLog: [
        { speaker: '小明', text: '我們決定用 A 方案', at: Date.now() - 60_000 },
        { speaker: '小華', text: '好，預算抓 50 萬', at: Date.now() - 30_000 },
      ],
    })
    mockBotProvider.getTranscript.mockResolvedValueOnce([])
    await handleChatMessage(session, {
      sender: '小明',
      text: '蜜塔 我們剛剛的結論是什麼？',
      isFromBot: false,
    } as any)
    const texts = mockBotProvider.sendChat.mock.calls.map((c: any[]) => String(c[1]))
    expect(texts.some((t) => t.includes('Claude 回答'))).toBe(true)
    expect(texts.some((t) => t.includes('還沒有足夠'))).toBe(false)
  })

  // 註：「chatLog 完全為空」的防禦分支在聊天流程中實際到不了——
  // dispatchQuestion 會先把「收到你的問題…」ack 記進 chatLog，context 永遠至少有一句。
})

describe('handleChatMessage — 聊天室喚醒詞', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('聊天室輸入 isFromBot: true → 不處理', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'Bot',
      text: '蜜塔，Bot 自己說的',
      timestamp: Date.now(),
      isFromBot: true,
    })
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled()
  })

  it('聊天室正常觸發 → 呼叫 sendChat', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'User',
      text: '蜜塔，這份文件是什麼？',
      timestamp: Date.now(),
      isFromBot: false,
    })
    expect(mockBotProvider.sendChat).toHaveBeenCalled()
  })
})

// ── isSpeaking 世代鎖 ─────────────────────────────────────────────────────────
//
// speak() 送出即返回、播放結束沒有事件可等 → 解鎖全靠 setTimeout 估時。
// 這組測試釘住兩件事：
//   ① 查詢比安全網久時，答案播放期間仍持有嘴巴（安全網到期後要重新佔用）
//   ② 已作廢的語音，其解鎖計時器不能把新的一段語音解鎖
// 兩者失守的症狀都是「蜜塔講到一半就聽不見了」：barge-in 第一行檢查 isSpeaking
// 直接 return、新問題誤走語音分支疊在舊答案上。

describe('isSpeaking 世代鎖（嘴巴佔用的生命週期）', () => {
  beforeEach(() => vi.clearAllMocks())

  afterEach(() => {
    vi.useRealTimers()
    speechTiming.msPerChar = 0
    speechTiming.extraMs = 0
    speechTiming.floorMs = 0
  })

  it('查詢比安全網久 → 答案播放期間仍持有嘴巴', async () => {
    vi.useFakeTimers()
    speechTiming.floorMs = 5_000 // 給語音真實長度，才有「安全網先到期、答案後到」的時間差

    const session = makeSession()
    let releaseDify: (v: unknown) => void = () => {}
    vi.mocked(dify.askQuestion).mockReturnValueOnce(
      new Promise((resolve) => { releaseDify = resolve }) as any,
    )

    const pending = handleTranscriptSegment(session, {
      segment_id: 'seg-slow-query',
      text: '蜜塔，報名費是多少',
      speaker: 'B',
      start_time: 1,
      end_time: 2,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(session.isSpeaking).toBe(true)

    // 前進超過安全網（DIFY_CHATFLOW_TIMEOUT_MS 45s + 開場白 5s + 10s 餘裕）
    await vi.advanceTimersByTimeAsync(70_000)

    releaseDify({ answer: '報名費是 500 元', conversationId: 'conv-1' })
    await vi.advanceTimersByTimeAsync(0)
    await pending

    // 修正前：安全網已解鎖，且答案路徑沒有重新佔用 → 這裡會是 false
    expect(session.isSpeaking).toBe(true)
  })

  it('已作廢語音的解鎖計時器，不會解鎖新的一段語音', async () => {
    vi.useFakeTimers()
    speechTiming.msPerChar = 100

    const session = makeSession()

    await speakProactive(session, '第一段') // 3 字 → 解鎖排在 300ms
    expect(session.isSpeaking).toBe(true)

    session.speechStartedAt = Date.now() - 7_000 // 越過開口寬限期（本案要測的是世代鎖，不是打斷門檻）
    await handleBargeIn(session, { text: '等一下我有問題', speaker: 'B' })
    expect(session.isSpeaking).toBe(false)

    await speakProactive(session, '第二段'.padEnd(20, '啊')) // 20 字 → 解鎖排在 2000ms
    expect(session.isSpeaking).toBe(true)

    // 走到「第一段」原定的解鎖時刻：它已作廢，不該影響第二段
    await vi.advanceTimersByTimeAsync(500)
    expect(session.isSpeaking).toBe(true)

    await vi.advanceTimersByTimeAsync(1_600)
    expect(session.isSpeaking).toBe(false)
  })
})
