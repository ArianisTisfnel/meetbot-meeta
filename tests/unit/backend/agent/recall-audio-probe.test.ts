import { describe, it, expect } from 'vitest'
import {
  createProbeState,
  ingestProbeMessage,
  averageAmplitude,
} from '../../../../backend/src/agent/recall-audio-probe'

/** 造一段 PCM16LE：amplitude 0 = 靜音封包。 */
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

describe('averageAmplitude — 靜音封包偵測', () => {
  it('全零封包 → 0', () => {
    expect(averageAmplitude(Buffer.alloc(320))) .toBe(0)
  })
  it('有聲封包 → 接近該振幅', () => {
    expect(averageAmplitude(Buffer.from(pcm(5000), 'base64'))).toBeCloseTo(5000, -2)
  })
  it('空 buffer 不會除以零', () => {
    expect(averageAmplitude(Buffer.alloc(0))).toBe(0)
  })
})

describe('ingestProbeMessage — 每位與會者獨立統計', () => {
  it('依 participant id 分開累積，記錄有聲/靜音封包', () => {
    const state = createProbeState('蜜塔')
    ingestProbeMessage(state, audioMsg({ id: 1, name: '小明' }, pcm(8000)))
    ingestProbeMessage(state, audioMsg({ id: 1, name: '小明' }, pcm(0)))
    ingestProbeMessage(state, audioMsg({ id: 2, name: '小華' }, pcm(9000)))

    expect(state.stats.size).toBe(2)
    const ming = state.stats.get('1')!
    expect(ming.name).toBe('小明')
    expect(ming.packets).toBe(2)
    expect(ming.voicedPackets).toBe(1) // 一有聲、一靜音
    expect(state.stats.get('2')!.voicedPackets).toBe(1)
  })

  // 這是探針要回答的關鍵問題：蜜塔自己有沒有一條音軌？
  // 有的話就能用 participant id 濾掉（可靠），而不必再靠靜音窗（現行做法）。
  it('蜜塔自己的音軌也會被記錄下來（供人工判讀 isBot）', () => {
    const state = createProbeState('蜜塔')
    ingestProbeMessage(state, audioMsg({ id: 99, name: '蜜塔' }, pcm(7000)))
    expect(state.stats.get('99')!.name).toBe('蜜塔')
  })

  it('非 audio_separate_raw 事件 → 忽略', () => {
    const state = createProbeState('蜜塔')
    const ok = ingestProbeMessage(state, JSON.stringify({ event: 'transcript.data', data: {} }))
    expect(ok).toBe(false)
    expect(state.totalMessages).toBe(0)
  })

  it('壞掉的 JSON / 缺 participant → 計入 malformed，不丟錯', () => {
    const state = createProbeState('蜜塔')
    expect(ingestProbeMessage(state, '{壞掉的')).toBe(false)
    expect(ingestProbeMessage(state, audioMsg({ id: undefined as any }, pcm(100)))).toBe(false)
    expect(state.malformed).toBe(2)
  })

  it('空 buffer（靜音封包）也算一筆封包，但不算有聲', () => {
    const state = createProbeState('蜜塔')
    ingestProbeMessage(state, audioMsg({ id: 3, name: '教授' }, ''))
    const stat = state.stats.get('3')!
    expect(stat.packets).toBe(1)
    expect(stat.bytes).toBe(0)
    expect(stat.voicedPackets).toBe(0)
  })
})
