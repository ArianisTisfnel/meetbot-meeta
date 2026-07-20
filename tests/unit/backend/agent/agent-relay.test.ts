import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    AGENT_MODE: 'on',
    AGENT_PAGE_URL: 'https://front.test/agent',
    OPENAI_API_KEY: 'sk-test',
    RECALL_WEBHOOK_URL: 'https://hook.test',
    RECALL_WEBHOOK_TOKEN: 'secret',
  },
}))

import { handleTranscriptionEvent } from '../../../../backend/src/agent/agent-relay'
import {
  registerAgentSession,
  unregisterAgentSession,
  type AgentSession,
} from '../../../../backend/src/agent/agent-registry'

const AGENT_ID = 'agent-uuid-relay'
const BOT_ID = 'bot-relay'

function makeSession(): { session: AgentSession; onPartialSegment: ReturnType<typeof vi.fn>; onSegment: ReturnType<typeof vi.fn> } {
  const onPartialSegment = vi.fn()
  const onSegment = vi.fn()
  const session = registerAgentSession(AGENT_ID, BOT_ID, '蜜塔', { onPartialSegment, onSegment })
  return { session, onPartialSegment, onSegment }
}

describe('handleTranscriptionEvent（OpenAI 轉錄事件 → 既有 LiveHandlers）', () => {
  let ctx: ReturnType<typeof makeSession>
  let itemTexts: Map<string, string>

  beforeEach(() => {
    unregisterAgentSession(AGENT_ID)
    ctx = makeSession()
    itemTexts = new Map()
  })

  it('delta 依 item_id 累積成完整前綴 → onPartialSegment（喚醒 regex 要能命中「蜜塔」）', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: '蜜',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: '塔今天',
    })

    expect(ctx.onPartialSegment).toHaveBeenCalledTimes(2)
    const second = ctx.onPartialSegment.mock.calls[1][0]
    expect(second.text).toBe('蜜塔今天')
    expect(second.segmentId).toBe('agent-partial:item-1')
    expect(typeof second.startTime).toBe('number')
  })

  it('不同 item_id 各自累積，互不汙染', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: '第一句',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'b',
      delta: '第二句',
    })
    expect(ctx.onPartialSegment.mock.calls[0][0].text).toBe('第一句')
    expect(ctx.onPartialSegment.mock.calls[1][0].text).toBe('第二句')
  })

  it('completed → onSegment（定稿），並清掉該 item 的累積', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: '蜜塔今天議程',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: '蜜塔，今天議程是什麼？',
    })

    expect(ctx.onSegment).toHaveBeenCalledTimes(1)
    const seg = ctx.onSegment.mock.calls[0][0]
    expect(seg.text).toBe('蜜塔，今天議程是什麼？')
    expect(seg.segmentId).toBe('agent:item-1')
    expect(itemTexts.has('item-1')).toBe(false)
  })

  it('空白 delta / 空白 transcript → 不觸發 handlers', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'x',
      delta: '  ',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'x',
      transcript: '',
    })
    expect(ctx.onPartialSegment).not.toHaveBeenCalled()
    expect(ctx.onSegment).not.toHaveBeenCalled()
  })

  it('未知事件型別 / error 事件 → 安全略過不丟錯', () => {
    expect(() => {
      handleTranscriptionEvent(ctx.session, itemTexts, { type: 'session.updated' })
      handleTranscriptionEvent(ctx.session, itemTexts, { type: 'error', error: { message: 'x' } })
      handleTranscriptionEvent(ctx.session, itemTexts, {})
    }).not.toThrow()
    expect(ctx.onSegment).not.toHaveBeenCalled()
  })

  it('startTime 以 anchor 換算（barge-in 晚到防護依賴 sessionStartedAt + startTime ≈ 現在）', () => {
    ctx.session.anchorMs = Date.now() - 10_000 // admitted 於 10 秒前
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'y',
      delta: '插話內容',
    })
    const seg = ctx.onPartialSegment.mock.calls[0][0]
    expect(seg.startTime).toBeGreaterThanOrEqual(9.9)
    expect(seg.startTime).toBeLessThan(11)
  })
})
