import { describe, it, expect } from 'vitest'
import {
  buildTranscriptUrl,
  applySegmentsToMap,
  getNextCursor,
} from '../../../../frontend/src/hooks/use-transcriptions'
import type { TranscriptSegment } from '../../../../frontend/src/types/api'

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    text: '測試文字',
    speaker: 'Speaker 1',
    startTime: 10.5,
    endTime: 15.2,
    language: 'zh',
    segmentId: 'seg-001',
    createdAt: '2026-05-30T00:00:00Z',
    ...overrides,
  }
}

describe('buildTranscriptUrl', () => {
  const BASE = '/projects/p1/meetings/m1/transcriptions'

  it('首次呼叫（cursor 為 null）→ URL 無 since_start_time', () => {
    expect(buildTranscriptUrl(BASE, null)).toBe(BASE)
  })

  it('有 cursor 時 → URL 附加 since_start_time', () => {
    expect(buildTranscriptUrl(BASE, 123.45)).toBe(`${BASE}?since_start_time=123.45`)
  })
})

describe('getNextCursor', () => {
  it('收到 segments 後 cursor 更新為 at(-1).startTime', () => {
    const segments = [
      makeSegment({ startTime: 10.0 }),
      makeSegment({ startTime: 20.5 }),
      makeSegment({ startTime: 35.0 }),
    ]
    expect(getNextCursor(segments)).toBe(35.0)
  })

  it('空陣列回傳 null', () => {
    expect(getNextCursor([])).toBeNull()
  })
})

describe('applySegmentsToMap', () => {
  it('相同 segmentId 的 segment 被 upsert（去重）', () => {
    const seg1 = makeSegment({ segmentId: 'seg-001', text: '原始文字' })
    const seg2 = makeSegment({ segmentId: 'seg-001', text: '更新文字' })

    const initial = new Map<string, TranscriptSegment>()
    const after1 = applySegmentsToMap(initial, [seg1])
    expect(after1.size).toBe(1)
    expect(after1.get('seg-001')?.text).toBe('原始文字')

    const after2 = applySegmentsToMap(after1, [seg2])
    expect(after2.size).toBe(1)
    expect(after2.get('seg-001')?.text).toBe('更新文字')
  })

  it('segmentId 為 null 時退而用 `${startTime}-${text}` 作 key', () => {
    const seg = makeSegment({
      segmentId: null,
      startTime: 42.0,
      text: '沒有 segmentId',
    })

    const result = applySegmentsToMap(new Map(), [seg])
    expect(result.size).toBe(1)
    expect(result.has('42-沒有 segmentId')).toBe(true)
  })

  it('不同 segmentId 的 segments 都保留（不互相覆蓋）', () => {
    const seg1 = makeSegment({ segmentId: 'seg-001', text: '第一句' })
    const seg2 = makeSegment({ segmentId: 'seg-002', text: '第二句' })

    const result = applySegmentsToMap(new Map(), [seg1, seg2])
    expect(result.size).toBe(2)
  })
})
