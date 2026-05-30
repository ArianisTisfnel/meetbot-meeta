import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockVexa } from '../../../mocks/vexa.mock'

vi.mock('../../../../backend/src/lib/vexa', () => mockVexa)
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

import { handleTranscriptSegment, handleChatMessage } from '../../../../backend/src/sessions/wake-word-detector'
import type { MeetingSession } from '../../../../backend/src/types/session'

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
    processedSegmentIds: new Set<string>(),
    wsConnection: null as any,
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
    expect(mockVexa.speak).toHaveBeenCalled()
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
    expect(mockVexa.speak).toHaveBeenCalled()
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
    expect(mockVexa.speak).toHaveBeenCalled()
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
    expect(mockVexa.speak).toHaveBeenCalled()
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
    expect(mockVexa.speak).not.toHaveBeenCalled()
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
    expect(mockVexa.speak).not.toHaveBeenCalled()
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
    expect(mockVexa.speak).not.toHaveBeenCalled()
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
    expect(mockVexa.speak).not.toHaveBeenCalled()
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
    expect(mockVexa.chatSend).not.toHaveBeenCalled()
  })

  it('聊天室正常觸發 → 呼叫 chatSend', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'User',
      text: '蜜塔，這份文件是什麼？',
      timestamp: Date.now(),
      is_from_bot: false,
    })
    expect(mockVexa.chatSend).toHaveBeenCalled()
  })
})
