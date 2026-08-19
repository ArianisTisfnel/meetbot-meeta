import { describe, it, expect } from 'vitest'
import {
  normalizeRecallTranscript,
  normalizeRecallRealtimeUtterance,
} from '../../../../backend/src/provider/normalize'
import type { TranscriptSegment } from '../../../../backend/src/provider/types'

function assertUnifiedShape(seg: TranscriptSegment) {
  expect(seg).toHaveProperty('segmentId')
  expect(seg).toHaveProperty('text')
  expect(seg).toHaveProperty('speaker')
  expect(typeof seg.startTime).toBe('number')
  expect(typeof seg.endTime).toBe('number')
  expect(seg).toHaveProperty('language')
}

describe('Recall normalization', () => {
  it('speaker + words[]（相對時間戳）→ 統一 schema', () => {
    const raw = [
      {
        id: 7,
        speaker: 'Carol',
        language: 'en',
        words: [
          { text: 'Hello', start_timestamp: { relative: 10.0 }, end_timestamp: { relative: 10.5 } },
          { text: 'world', start_timestamp: { relative: 10.5 }, end_timestamp: { relative: 11.0 } },
        ],
      },
    ]
    const segs = normalizeRecallTranscript(raw)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual<TranscriptSegment>({
      segmentId: '7',
      text: 'Hello world',
      speaker: 'Carol',
      startTime: 10.0,
      endTime: 11.0,
      language: 'en',
    })
    assertUnifiedShape(segs[0])
  })

  it('使用 entry.text 與 entry.start_time/end_time 變體 → 統一 schema', () => {
    const segs = normalizeRecallTranscript([
      { speaker: 'Dan', text: '直接給文字', start_time: 5, end_time: 8 },
    ])
    expect(segs[0].text).toBe('直接給文字')
    expect(segs[0].startTime).toBe(5)
    expect(segs[0].endTime).toBe(8)
  })

  it('空白 / 無文字的 entry 會被略過', () => {
    const segs = normalizeRecallTranscript([
      { speaker: 'X', words: [] },
      { speaker: 'Y', text: '   ' },
      { speaker: 'Z', text: '有效' },
    ])
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('有效')
  })

  it('非陣列輸入 → 空陣列', () => {
    expect(normalizeRecallTranscript(null as any)).toEqual([])
    expect(normalizeRecallTranscript(undefined as any)).toEqual([])
  })
})

describe('Recall realtime utterance normalization', () => {
  it('transcript.data utterance（words + participant）→ 統一 schema', () => {
    const seg = normalizeRecallRealtimeUtterance(
      {
        words: [
          { text: '蜜塔', start_timestamp: { relative: 3.0 }, end_timestamp: { relative: 3.4 } },
          { text: '你好', start_timestamp: { relative: 3.4 }, end_timestamp: { relative: 4.0 } },
        ],
        participant: { id: 5, name: 'Wendy' },
        language_code: 'zh',
      },
      'tx-123',
    )
    expect(seg).not.toBeNull()
    assertUnifiedShape(seg!)
    // CJK 之間不補空格（避免喚醒詞「蜜塔」因空格比對失敗）
    expect(seg!.text).toBe('蜜塔你好')
    expect(seg!.speaker).toBe('Wendy')
    expect(seg!.startTime).toBe(3.0)
    expect(seg!.endTime).toBe(4.0)
    expect(seg!.language).toBe('zh')
    // segmentId 須非空（wake-word handler 會略過無 segmentId 者）
    expect(seg!.segmentId).toBeTruthy()
    expect(seg!.segmentId).toContain('tx-123')
  })

  it('空 utterance → null', () => {
    expect(normalizeRecallRealtimeUtterance({ words: [] }, 'tx')).toBeNull()
    expect(normalizeRecallRealtimeUtterance({ words: [{ text: '  ' }] }, 'tx')).toBeNull()
  })

  it('STT 把「蜜塔」切成兩個 word → 中文相連無空格，喚醒詞仍可比對', () => {
    const seg = normalizeRecallRealtimeUtterance(
      { words: [{ text: '蜜' }, { text: '塔' }, { text: '請問' }] },
      'tx',
    )
    expect(seg!.text).toBe('蜜塔請問')
    expect(/[蜜密祕秘迷][塔搭]/.test(seg!.text)).toBe(true) // 與 wake-word regex 相容
  })

  it('英文詞之間仍補空格', () => {
    const seg = normalizeRecallRealtimeUtterance({ words: [{ text: 'hello' }, { text: 'world' }] }, 'tx')
    expect(seg!.text).toBe('hello world')
  })
})
