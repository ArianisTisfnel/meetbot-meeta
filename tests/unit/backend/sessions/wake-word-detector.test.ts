import { vi, describe, it, expect, beforeEach } from 'vitest'

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
}))
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DIFY_API_BASE: 'http://dify.test',
    DIFY_WORKFLOW_API_KEY: 'app-test',
    DIFY_CHATFLOW_TIMEOUT_MS: 45000,
  },
}))
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
} from '../../../../backend/src/sessions/wake-word-detector'
import type { MeetingSession } from '../../../../backend/src/types/session'
import type { BotSession } from '../../../../backend/src/provider/types'

const fakeBotSession: BotSession = {
  provider: 'vexa',
  platform: 'google_meet',
  nativeMeetingId: 'abc-defg-hij',
  providerMeetingId: 42,
  adapter: mockBotProvider as any,
  state: {},
}

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    meetingInstanceId: 'meet-1',
    vexaMeetingId: 1,
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    difyDatasetId: 'dataset-abc',
    creatorVexaToken: 'tok-123',
    isSpeaking: false,
    lastWakeAt: 0,
    wakePendingUntil: 0,
    wakePendingSpeaker: null,
    partialAckAt: 0,
    currentSpeech: null,
    speechStartedAt: 0,
    bargeEpoch: 0,
    chatLog: [],
    sessionStartedAt: 0,
    processedSegmentIds: new Set<string>(),
    botSession: fakeBotSession,
    difyConversationId: null,
    lastQuestionAt: 0,
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
})

describe('parseIntent — 問答意圖分流', () => {
  it('factual / context / hybrid 關鍵字正確解析', () => {
    expect(parseIntent('factual')).toBe('factual')
    expect(parseIntent('context')).toBe('context')
    expect(parseIntent('hybrid')).toBe('hybrid')
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

describe('handleChatMessage — 聊天室喚醒詞', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('聊天室輸入 is_from_bot: true → 不處理', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'Bot',
      text: '蜜塔，Bot 自己說的',
      timestamp: Date.now(),
      is_from_bot: true,
    })
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled()
  })

  it('聊天室正常觸發 → 呼叫 sendChat', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'User',
      text: '蜜塔，這份文件是什麼？',
      timestamp: Date.now(),
      is_from_bot: false,
    })
    expect(mockBotProvider.sendChat).toHaveBeenCalled()
  })
})
