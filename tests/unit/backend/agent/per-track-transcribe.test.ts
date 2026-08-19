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

import {
  handleTranscriptionEvent,
  routeTrackAudio,
  upsample16kTo24k,
} from '../../../../backend/src/agent/agent-relay'
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

// openaiReady 是「webhook 喚醒 fallback 要不要抑制」的唯一依據。17:03 那場它被探針連線
// 樂觀設成 true，但每條轉錄連線其實都在 session.update 就被拒 → 抑制了 fallback、
// 自己又一個字都沒轉出 → 全聾且無告警。現在它只認「真的轉出字」這一種證據。
describe('openaiReady — per-track 的就緒必須有實據', () => {
  const track = { participantId: '7', speaker: '小明' }

  beforeEach(() => {
    unregisterAgentSession(AGENT_ID)
    mockEnv.TRANSCRIBE_MODE = 'per-track'
    mockEnv.RECALL_SEPARATE_AUDIO = 'on'
    mockEnv.AGENT_MODE = 'on'
  })

  it('轉出第一段字 → ready（這是唯一的就緒證據）', () => {
    const { session } = makeSession()
    expect(session.openaiReady).toBe(false)
    handleTranscriptionEvent(
      session,
      new Map(),
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '今天天氣如何' },
      track,
    )
    expect(session.openaiReady).toBe(true)
  })

  it('session 被拒（error 事件）→ 降級成 false，webhook 喚醒 fallback 得以接手', () => {
    const { session } = makeSession()
    session.openaiReady = true
    handleTranscriptionEvent(
      session,
      new Map(),
      { type: 'error', error: { message: "Invalid 'session.audio.input.format.rate'" } },
      track,
    )
    expect(session.openaiReady).toBe(false)
    expect(isAgentLive(BOT_ID)).toBe(false)
  })

  it('降級後任一軌恢復轉錄 → 自動回到 ready（不需重開會議）', () => {
    const { session } = makeSession()
    handleTranscriptionEvent(session, new Map(), { type: 'error', error: {} }, track)
    expect(session.openaiReady).toBe(false)
    handleTranscriptionEvent(
      session,
      new Map(),
      { type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: '蜜' },
      track,
    )
    expect(session.openaiReady).toBe(true)
  })

  // mixed 的 ready 由 connectOpenAI 的 open/close 管；這裡插手會讓兩套狀態機打架。
  it('mixed（無 track）→ 不碰 openaiReady', () => {
    const { session } = makeSession()
    session.openaiReady = true
    handleTranscriptionEvent(session, new Map(), { type: 'error', error: {} })
    expect(session.openaiReady).toBe(true)
  })
})

// 實測 2026-08-19 17:03：直接送 Recall 的 16kHz 被 OpenAI 拒絕——
// "Invalid 'session.audio.input.format.rate': ... Expected a value >= 24000"
// 整場逐軌轉錄因此完全沒運作，卻只在 log 留一行 error，外表看起來一切正常。
describe('upsample16kTo24k — 送進 OpenAI 前的取樣率轉換', () => {
  /** 造一段 PCM16LE Buffer。 */
  function buf(samples: number[]): Buffer {
    const b = Buffer.alloc(samples.length * 2)
    samples.forEach((v, i) => b.writeInt16LE(v, i * 2))
    return b
  }

  it('樣本數變成 1.5 倍（16k → 24k）', () => {
    expect(upsample16kTo24k(buf([0, 0, 0, 0])).length / 2).toBe(6)
    expect(upsample16kTo24k(buf(new Array(160).fill(0))).length / 2).toBe(240)
  })

  it('空 buffer → 空 buffer（Recall 會送空封包，不可丟錯）', () => {
    expect(upsample16kTo24k(Buffer.alloc(0)).length).toBe(0)
  })

  it('定值訊號內插後仍是同一個定值（不引入直流偏移）', () => {
    const out = upsample16kTo24k(buf(new Array(12).fill(1000)))
    for (let i = 0; i < out.length / 2; i++) expect(out.readInt16LE(i * 2)).toBe(1000)
  })

  it('輸出不超出 int16 範圍（極值不得溢位變號）', () => {
    const out = upsample16kTo24k(buf([32767, -32768, 32767, -32768, 32767, -32768]))
    for (let i = 0; i < out.length / 2; i++) {
      const v = out.readInt16LE(i * 2)
      expect(v).toBeGreaterThanOrEqual(-32768)
      expect(v).toBeLessThanOrEqual(32767)
    }
  })

  it('第一個樣本保持原值（相位不偏移）', () => {
    const out = upsample16kTo24k(buf([500, 1500, 2500, 3500]))
    expect(out.readInt16LE(0)).toBe(500)
  })
})
