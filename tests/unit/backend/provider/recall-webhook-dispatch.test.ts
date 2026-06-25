import { describe, it, expect, vi, beforeEach } from 'vitest'

// recall-adapter 透過 env / logger，import 時會驗證環境變數 → mock 掉避免 process.exit。
vi.mock('../../../../backend/src/types/env', () => ({
  env: { RECALL_API_URL: 'http://recall.test', RECALL_API_KEY: 'k', RECALL_TRANSCRIBE_LANGUAGE: 'multi' },
}))

import {
  dispatchRecallEvent,
  registerRealtimeHandlers,
  unregisterRealtimeHandlers,
} from '../../../../backend/src/provider/recall-adapter'

const BOT_ID = 'bot-abc'
const BOT_NAME = '蜜塔'

function makeHandlers() {
  return { onSegment: vi.fn(), onChat: vi.fn(), onStatus: vi.fn() }
}

function transcriptEvent(participantName: string, text: string) {
  return {
    event: 'transcript.data',
    data: {
      bot: { id: BOT_ID },
      transcript: { id: 'tx-1' },
      data: {
        words: [{ text, start_timestamp: { relative: 1 }, end_timestamp: { relative: 2 } }],
        participant: { id: 1, name: participantName },
        language_code: 'zh',
      },
    },
  }
}

function chatEvent(participantName: string, text: string) {
  return {
    event: 'participant_events.chat_message',
    data: { bot: { id: BOT_ID }, data: { participant: { id: 1, name: participantName }, text } },
  }
}

describe('dispatchRecallEvent', () => {
  let handlers: ReturnType<typeof makeHandlers>

  beforeEach(() => {
    handlers = makeHandlers()
    registerRealtimeHandlers(BOT_ID, handlers, BOT_NAME)
  })

  it('transcript.data（使用者）→ onSegment 被呼叫，segment 已正規化', () => {
    dispatchRecallEvent(transcriptEvent('Wendy', '蜜塔請問'))
    expect(handlers.onSegment).toHaveBeenCalledTimes(1)
    const seg = handlers.onSegment.mock.calls[0][0]
    expect(seg.text).toBe('蜜塔請問')
    expect(seg.speaker).toBe('Wendy')
    expect(seg.segmentId).toBeTruthy()
  })

  it('chat_message（使用者）→ onChat 被呼叫', () => {
    dispatchRecallEvent(chatEvent('Wendy', '蜜塔 這是什麼'))
    expect(handlers.onChat).toHaveBeenCalledTimes(1)
    expect(handlers.onChat.mock.calls[0][0].text).toBe('蜜塔 這是什麼')
    expect(handlers.onChat.mock.calls[0][0].isFromBot).toBe(false)
  })

  it('bot 自己的發言（participant.name === botName）→ 被過濾，不觸發（防自迴圈）', () => {
    dispatchRecallEvent(transcriptEvent(BOT_NAME, '我是蜜塔'))
    dispatchRecallEvent(chatEvent(BOT_NAME, '嗨大家好我是蜜塔')) // 歡迎訊息含「蜜塔」
    expect(handlers.onSegment).not.toHaveBeenCalled()
    expect(handlers.onChat).not.toHaveBeenCalled()
  })

  it('未知 botId → 安全略過，不丟錯', () => {
    expect(() =>
      dispatchRecallEvent({ event: 'transcript.data', data: { bot: { id: 'unknown' }, data: {} } }),
    ).not.toThrow()
    expect(handlers.onSegment).not.toHaveBeenCalled()
  })

  it('unregister 後 → 後續事件不再分派', () => {
    unregisterRealtimeHandlers(BOT_ID)
    dispatchRecallEvent(transcriptEvent('Wendy', '蜜塔'))
    expect(handlers.onSegment).not.toHaveBeenCalled()
  })

  it('缺 event/bot.id → 安全略過', () => {
    expect(() => dispatchRecallEvent({})).not.toThrow()
    expect(() => dispatchRecallEvent({ event: 'transcript.data', data: {} })).not.toThrow()
  })
})
