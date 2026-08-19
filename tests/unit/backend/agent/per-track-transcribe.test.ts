import { describe, it, expect, vi, beforeEach } from 'vitest'

// env 必須在所有 import 之前 mock：真 env.ts 會 process.exit(1)。
const mockEnv = vi.hoisted(() => ({
  AGENT_MODE: 'on',
  AGENT_PAGE_URL: 'https://front.test/agent',
  OPENAI_API_KEY: 'sk-test',
  RECALL_WEBHOOK_URL: 'https://hook.test',
  RECALL_WEBHOOK_TOKEN: 'secret',
  RECALL_SEPARATE_AUDIO: 'on' as 'on' | 'off',
  TRANSCRIBE_MODE: 'per-track' as 'mixed' | 'per-track',
  STT_SILENCE_DURATION_MS: 500,
}))
vi.mock('../../../../backend/src/types/env', () => ({ env: mockEnv }))

import { handleTranscriptionEvent, routeTrackAudio } from '../../../../backend/src/agent/agent-relay'
import { isPerTrackMode, isAgentLive } from '../../../../backend/src/agent/agent-registry'
import {
  registerAgentSession,
  unregisterAgentSession,
  type AgentSession,
} from '../../../../backend/src/agent/agent-registry'

const AGENT_ID = 'agent-per-track'
const BOT_ID = 'bot-per-track'
const BOT_NAME = '蜜塔'

/** 造一段 PCM16LE 的 base64（與 recall-audio-probe.test.ts 同一套 helper）。 */
function pcm(amplitude: number, samples = 160): string {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2)
  return buf.toString('base64')
}

function audioMsg(participant: { id: number | string; name?: string }, buffer: string) {
  return JSON.stringify({
    event: 'audio_separate_raw.data',
    data: { data: { buffer, participant }, realtime_endpoint: {}, recording: {}, bot: {} },
  })
}

function makeSession(): { session: AgentSession; onSegment: ReturnType<typeof vi.fn> } {
  const onSegment = vi.fn()
  const onPartialSegment = vi.fn()
  const session = registerAgentSession(AGENT_ID, BOT_ID, BOT_NAME, { onSegment, onPartialSegment })
  return { session, onSegment }
}

describe('isPerTrackMode — 開關與前置條件', () => {
  beforeEach(() => {
    mockEnv.TRANSCRIBE_MODE = 'per-track'
    mockEnv.RECALL_SEPARATE_AUDIO = 'on'
    mockEnv.AGENT_MODE = 'on'
  })

  it('三個條件齊全 → true', () => {
    expect(isPerTrackMode()).toBe(true)
  })

  it('TRANSCRIBE_MODE=mixed → false（預設行為，不影響現有使用者）', () => {
    mockEnv.TRANSCRIBE_MODE = 'mixed'
    expect(isPerTrackMode()).toBe(false)
  })

  // 沒有 audio_separate_raw，Recall 根本不會送 per-participant 音軌 → 開了也是聾的
  it('RECALL_SEPARATE_AUDIO=off → false（自動退回 mixed，不會失聰）', () => {
    mockEnv.RECALL_SEPARATE_AUDIO = 'off'
    expect(isPerTrackMode()).toBe(false)
  })

  it('agent 模式沒開 → false（探針的 WS 認證沿用 agentId／簽章）', () => {
    mockEnv.AGENT_MODE = 'off'
    expect(isPerTrackMode()).toBe(false)
  })
})

describe('handleTranscriptionEvent — per-track 的講者與 segmentId', () => {
  let ctx: ReturnType<typeof makeSession>

  beforeEach(() => {
    unregisterAgentSession(AGENT_ID)
    ctx = makeSession()
  })

  // per-track 的全部價值就在這裡：講者是 Recall 給的，不是 speaker-timeline 猜的。
  it('帶 track → 用已知講者名，不回退去猜', () => {
    handleTranscriptionEvent(
      ctx.session,
      new Map(),
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: '這句是誰講的',
      },
      { participantId: '100', speaker: 'WENDY HSU' },
    )
    expect(ctx.onSegment).toHaveBeenCalledTimes(1)
    expect(ctx.onSegment.mock.calls[0][0].speaker).toBe('WENDY HSU')
  })

  // 每條 OpenAI 連線各自從頭編 item_id → 兩軌會撞號；撞號會被下游 processedSegmentIds
  // 當成重複段整段丟掉（＝有人講的話憑空消失）。
  it('不同軌的相同 item_id → segmentId 不得相同', () => {
    handleTranscriptionEvent(
      ctx.session,
      new Map(),
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_0', transcript: 'A 說的' },
      { participantId: '100', speaker: 'A' },
    )
    handleTranscriptionEvent(
      ctx.session,
      new Map(),
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_0', transcript: 'B 說的' },
      { participantId: '200', speaker: 'B' },
    )
    const ids = ctx.onSegment.mock.calls.map((c: any[]) => c[0].segmentId)
    expect(ids[0]).not.toBe(ids[1])
    expect(new Set(ids).size).toBe(2)
  })

  it('不帶 track（mixed 模式）→ 行為與改動前相同，segmentId 無命名空間', () => {
    handleTranscriptionEvent(ctx.session, new Map(), {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-9',
      transcript: '混音那條',
    })
    expect(ctx.onSegment.mock.calls[0][0].segmentId).toBe('agent:item-9')
  })
})

describe('routeTrackAudio — 探針訊息分流', () => {
  let ctx: ReturnType<typeof makeSession>

  beforeEach(() => {
    unregisterAgentSession(AGENT_ID)
    ctx = makeSession()
  })

  it('壞掉的 JSON / 非音訊事件 / 缺 participant id → 安全略過不丟錯', () => {
    expect(() => {
      routeTrackAudio(ctx.session, 'not json')
      routeTrackAudio(ctx.session, JSON.stringify({ event: 'something.else' }))
      routeTrackAudio(ctx.session, audioMsg({ id: undefined as any }, pcm(1000)))
      routeTrackAudio(ctx.session, audioMsg({ id: 1 }, ''))
    }).not.toThrow()
  })

  // 蜜塔自己若也有一條軌，轉錄自己會造成自迴圈（她聽見自己說「蜜塔」）。
  it('蜜塔自己的音軌 → 跳過', () => {
    expect(() => routeTrackAudio(ctx.session, audioMsg({ id: 9, name: BOT_NAME }, pcm(1000)))).not.toThrow()
  })
})

// 耳朵與嘴巴分家之後，「聽不聽得到」就不該再綁在網頁（嘴巴）上。
describe('isAgentLive — per-track 下耳朵與嘴巴解耦', () => {
  beforeEach(() => {
    unregisterAgentSession(AGENT_ID)
    mockEnv.TRANSCRIBE_MODE = 'per-track'
    mockEnv.RECALL_SEPARATE_AUDIO = 'on'
    mockEnv.AGENT_MODE = 'on'
  })

  // 這是分家的重點：網頁掛了但探針還在轉錄，若這裡回 false，
  // webhook 喚醒 fallback 會復活，與逐軌轉錄同時觸發 → 同一句被答兩次。
  it('per-track：網頁斷線但探針耳朵還在 → 仍算 live（不可讓 webhook 喚醒復活）', () => {
    const { session } = makeSession()
    session.pageWs = null // 嘴巴掛了
    session.openaiReady = true // 耳朵（探針）還在
    expect(isAgentLive(BOT_ID)).toBe(true)
  })

  it('per-track：探針也斷了 → false（真的聾了，才讓 webhook 接手）', () => {
    const { session } = makeSession()
    session.pageWs = null
    session.openaiReady = false
    expect(isAgentLive(BOT_ID)).toBe(false)
  })

  it('mixed：維持原本判準——網頁斷線就算不 live', () => {
    mockEnv.TRANSCRIBE_MODE = 'mixed'
    const { session } = makeSession()
    session.pageWs = null
    session.openaiReady = true
    expect(isAgentLive(BOT_ID)).toBe(false)
  })
})
