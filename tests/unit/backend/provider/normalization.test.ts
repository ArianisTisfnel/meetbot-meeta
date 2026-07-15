import { describe, it, expect } from 'vitest'
import {
  normalizeVexaRestSegment as normalizeRestSegment,
  normalizeVexaWsSegment as normalizeWsSegment,
  normalizeRecallTranscript,
  normalizeRecallRealtimeUtterance,
  normalizeWhisperSegments,
} from '../../../../backend/src/provider/normalize'
import type { TranscriptSegment } from '../../../../backend/src/provider/types'

// 驗收標準：兩個 adapter 的 transcript 都正規化成同一個 schema（TranscriptSegment）。
// 統一 schema 的「事實來源」：startTime/endTime（秒）、speaker、text、segmentId、language。

function assertUnifiedShape(seg: TranscriptSegment) {
  expect(seg).toHaveProperty('segmentId')
  expect(seg).toHaveProperty('text')
  expect(seg).toHaveProperty('speaker')
  expect(typeof seg.startTime).toBe('number')
  expect(typeof seg.endTime).toBe('number')
  expect(seg).toHaveProperty('language')
}

describe('Vexa normalization', () => {
  it('REST segment（start/end alias）→ 統一 schema', () => {
    const seg = normalizeRestSegment({
      segment_id: 'v-1',
      text: '大家好',
      speaker: 'Alice',
      start: 12.5,
      end: 15.0,
      language: 'zh',
    })
    expect(seg).toEqual<TranscriptSegment>({
      segmentId: 'v-1',
      text: '大家好',
      speaker: 'Alice',
      startTime: 12.5,
      endTime: 15.0,
      language: 'zh',
    })
    assertUnifiedShape(seg)
  })

  it('REST segment 缺欄位 → 安全預設（0 / null）', () => {
    const seg = normalizeRestSegment({ segment_id: null, text: 'x', speaker: null, start: undefined, end: undefined, language: null })
    expect(seg.startTime).toBe(0)
    expect(seg.endTime).toBe(0)
    expect(seg.speaker).toBeNull()
    expect(seg.language).toBeNull()
  })

  it('WS segment（start_time/end_time 或 start/end）→ 統一 schema，speaker 回退到外層', () => {
    const a = normalizeWsSegment({ segment_id: 'w-1', text: 'hi', start: 1, end: 2, language: 'en' })
    expect(a.startTime).toBe(1)
    expect(a.endTime).toBe(2)

    const b = normalizeWsSegment({ segment_id: 'w-2', text: 'yo', start_time: 3, end_time: 4 }, 'Bob')
    expect(b.startTime).toBe(3)
    expect(b.endTime).toBe(4)
    expect(b.speaker).toBe('Bob') // seg.speaker 缺 → 用外層 msg.speaker
    assertUnifiedShape(b)
  })
})

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

describe('normalizeWhisperSegments（會後重轉錄）', () => {
  it('whisper segment → 統一 schema：speaker=null、segmentId=whisper-{i}', () => {
    const out = normalizeWhisperSegments([
      { text: '大家好。', start: 0.0, end: 2.5 },
      { text: '開始開會。', start: 2.8, end: 4.1 },
    ])

    expect(out).toHaveLength(2)
    out.forEach(assertUnifiedShape)
    expect(out[0]).toEqual({
      segmentId: 'whisper-0',
      text: '大家好。',
      speaker: null,
      startTime: 0.0,
      endTime: 2.5,
      language: null,
    })
    expect(out[1].segmentId).toBe('whisper-1')
  })

  it('簡體字轉繁體（Breeze 原生繁體，但照慣例過 toTraditional 保險）', () => {
    const out = normalizeWhisperSegments([{ text: '会议纪要', start: 0, end: 1 }])
    expect(out[0].text).toBe('會議紀要')
  })

  it('空白 text 的 segment 被過濾', () => {
    const out = normalizeWhisperSegments([
      { text: '  ', start: 0, end: 1 },
      { text: '有內容', start: 1, end: 2 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('有內容')
  })

  it('timestamp 非數字（NaN）→ start 補 0、end 補 start', () => {
    const out = normalizeWhisperSegments([{ text: '句子', start: NaN, end: NaN }])
    expect(out[0].startTime).toBe(0)
    expect(out[0].endTime).toBe(0)
  })

  it('非陣列輸入回空陣列', () => {
    expect(normalizeWhisperSegments(undefined as any)).toEqual([])
  })
})

describe('cross-provider schema parity', () => {
  it('Vexa 與 Recall 正規化後的 segment 鍵集合一致', () => {
    const vexa = normalizeRestSegment({ segment_id: 'a', text: 't', speaker: 's', start: 1, end: 2, language: 'zh' })
    const recall = normalizeRecallTranscript([
      { id: 1, speaker: 's', text: 't', start_time: 1, end_time: 2, language: 'zh' },
    ])[0]
    expect(Object.keys(vexa).sort()).toEqual(Object.keys(recall).sort())
  })

  it('Whisper 正規化後的 segment 鍵集合與 Vexa 一致', () => {
    const vexa = normalizeRestSegment({ segment_id: 'a', text: 't', speaker: 's', start: 1, end: 2, language: 'zh' })
    const whisper = normalizeWhisperSegments([{ text: 't', start: 1, end: 2 }])[0]
    expect(Object.keys(vexa).sort()).toEqual(Object.keys(whisper).sort())
  })
})
