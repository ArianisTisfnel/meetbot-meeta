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
import {
  registerAgentSession,
  unregisterAgentSession,
  type PageSocketLike,
} from '../../../../backend/src/agent/agent-registry'
import {
  resolveSpeakerAt,
  clearSpeakerTimeline,
} from '../../../../backend/src/agent/speaker-timeline'

const BOT_ID = 'bot-abc'
const BOT_NAME = '蜜塔'

function makeHandlers() {
  return { onSegment: vi.fn(), onPartialSegment: vi.fn(), onChat: vi.fn(), onStatus: vi.fn() }
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

  it('transcript.data → segment 累積到註冊的 segments array；bot 自己的發言也累積（逐字稿要含蜜塔回覆）但不觸發 handlers', () => {
    const segments: import('../../../../backend/src/provider/types').TranscriptSegment[] = []
    registerRealtimeHandlers(BOT_ID, handlers, BOT_NAME, segments)

    dispatchRecallEvent(transcriptEvent('Wendy', '蜜塔請問'))
    dispatchRecallEvent(transcriptEvent(BOT_NAME, '我是蜜塔')) // bot 自己 → 進逐字稿、不觸發喚醒
    dispatchRecallEvent(transcriptEvent('Wendy', '第二句'))

    expect(segments.map((s) => s.text)).toEqual(['蜜塔請問', '我是蜜塔', '第二句'])
    // handlers 只收到非 bot 的兩句（防自迴圈）
    expect(handlers.onSegment).toHaveBeenCalledTimes(2)
  })
})

describe('dispatchRecallEvent × 講者時間軸（A.4）', () => {
  let handlers: ReturnType<typeof makeHandlers>

  function speechEvent(type: 'speech_on' | 'speech_off', name: string, absolute?: string) {
    return {
      event: `participant_events.${type}`,
      data: {
        bot: { id: BOT_ID },
        data: {
          participant: { id: 1, name },
          timestamp: { relative: 12.5, ...(absolute ? { absolute } : {}) },
        },
      },
    }
  }

  beforeEach(() => {
    handlers = makeHandlers()
    registerRealtimeHandlers(BOT_ID, handlers, BOT_NAME)
    clearSpeakerTimeline(BOT_ID)
  })

  it('speech_on/off → 進時間軸，之後查得到講者', () => {
    const t0 = Date.parse('2026-07-28T10:00:00.000Z')
    dispatchRecallEvent(speechEvent('speech_on', 'Wendy', '2026-07-28T10:00:00.000Z'))
    dispatchRecallEvent(speechEvent('speech_off', 'Wendy', '2026-07-28T10:00:04.000Z'))
    expect(resolveSpeakerAt(BOT_ID, t0 + 6_000)).toBe('Wendy')
  })

  it('沒有 timestamp.absolute → 退回收到當下的時間（不用 relative，座標系不同）', () => {
    dispatchRecallEvent(speechEvent('speech_on', 'Wendy'))
    // relative=12.5 若被誤用成 epoch，查詢時刻會完全對不上而回 null
    expect(resolveSpeakerAt(BOT_ID, Date.now() + 1_000)).toBe('Wendy')
  })

  it('bot 自己的 speech_on → 不進時間軸（否則蜜塔會把自己的話歸給自己）', () => {
    dispatchRecallEvent(speechEvent('speech_on', BOT_NAME))
    expect(resolveSpeakerAt(BOT_ID, Date.now() + 1_000)).toBeNull()
  })

  it('未註冊的 botId → 安全略過', () => {
    unregisterRealtimeHandlers(BOT_ID)
    expect(() => dispatchRecallEvent(speechEvent('speech_on', 'Wendy'))).not.toThrow()
    expect(resolveSpeakerAt(BOT_ID, Date.now())).toBeNull()
  })
})

describe('dispatchRecallEvent × agent 模式（方案 A）', () => {
  const AGENT_ID = 'agent-for-dispatch-test'
  let handlers: ReturnType<typeof makeHandlers>

  function partialEvent(text: string) {
    return {
      event: 'transcript.partial_data',
      data: {
        bot: { id: BOT_ID },
        transcript: { id: 'tx-1' },
        data: {
          words: [{ text, start_timestamp: { relative: 1 }, end_timestamp: { relative: 2 } }],
          participant: { id: 1, name: 'Wendy' },
          language_code: 'zh',
        },
      },
    }
  }

  beforeEach(() => {
    handlers = makeHandlers()
    registerRealtimeHandlers(BOT_ID, handlers, BOT_NAME)
    unregisterAgentSession(AGENT_ID)
  })

  it('agent 網頁在線 ＋ 轉錄鏈就緒 → webhook 語音事件只寫逐字稿、不觸發喚醒（防分鐘級晚到重複回答）', () => {
    const session = registerAgentSession(AGENT_ID, BOT_ID, BOT_NAME, handlers)
    session.pageWs = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } satisfies PageSocketLike
    session.openaiReady = true // 轉錄鏈健康：抑制 webhook 喚醒的前提

    const segments: import('../../../../backend/src/provider/types').TranscriptSegment[] = []
    registerRealtimeHandlers(BOT_ID, handlers, BOT_NAME, segments)

    dispatchRecallEvent(transcriptEvent('Wendy', '蜜塔請問'))
    dispatchRecallEvent(partialEvent('蜜塔'))

    expect(segments.map((s) => s.text)).toEqual(['蜜塔請問']) // 逐字稿照寫
    expect(handlers.onSegment).not.toHaveBeenCalled() // 喚醒改由 relay 驅動
    expect(handlers.onPartialSegment).not.toHaveBeenCalled()

    // 聊天室事件不受 agent 模式影響（doc 16 §06）
    dispatchRecallEvent(chatEvent('Wendy', '蜜塔 這是什麼'))
    expect(handlers.onChat).toHaveBeenCalledTimes(1)
  })

  it('agent 網頁斷線 → webhook 喚醒 fallback 自動恢復', () => {
    const session = registerAgentSession(AGENT_ID, BOT_ID, BOT_NAME, handlers)
    session.pageWs = null // 網頁未連上 / 已斷線

    dispatchRecallEvent(transcriptEvent('Wendy', '蜜塔請問'))
    expect(handlers.onSegment).toHaveBeenCalledTimes(1)
  })

  it('網頁在線但轉錄鏈掛掉（openaiReady=false）→ webhook 喚醒 fallback 接手，不會全聾', () => {
    // 全聾邊界：OpenAI WS 持久連不上（401／額度／API 變動），但 bot 瀏覽器還開著。
    // 修復前 isAgentLive 只看網頁 → 喚醒被抑制、串流又聽不到 → 兩條耳朵都不通。
    const session = registerAgentSession(AGENT_ID, BOT_ID, BOT_NAME, handlers)
    session.pageWs = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } satisfies PageSocketLike
    session.openaiReady = false // 轉錄鏈未就緒

    dispatchRecallEvent(transcriptEvent('Wendy', '蜜塔請問'))
    expect(handlers.onSegment).toHaveBeenCalledTimes(1) // webhook 喚醒仍運作
  })
})
