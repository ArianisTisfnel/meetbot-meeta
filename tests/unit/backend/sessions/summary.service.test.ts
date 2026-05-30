import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockVexa } from '../../../mocks/vexa.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/vexa', () => mockVexa)
vi.mock('../../../../backend/src/lib/dify', () => ({
  uploadTranscriptFile: vi.fn().mockResolvedValue('dify-file-id'),
  generateSummary: vi.fn().mockResolvedValue({
    summary: '這是會議摘要',
    actionItems: [{ task: '準備報告', owner: 'Alice' }],
    keyTopics: ['主題一'],
    decisions: ['決定一'],
  }),
}))
vi.mock('../../../../backend/src/lib/supabase', () => ({
  upsertFile: vi.fn().mockResolvedValue(undefined),
}))

import {
  formatTranscriptAsMarkdown,
  formatSeconds,
  waitForTranscriptStable,
  generateSummaryAsync,
  SUMMARY_INITIAL_WAIT_MS,
  SUMMARY_POLL_INTERVAL_MS,
  SUMMARY_TIMEOUT_MS,
} from '../../../../backend/src/sessions/summary.service'
import * as difyMod from '../../../../backend/src/lib/dify'
import * as supabaseMod from '../../../../backend/src/lib/supabase'
import type { VexaRestSegment } from '../../../../backend/src/types/session'

function makeSeg(
  start: number,
  text = `seg-text-${start}`,
  speaker: string | null = 'Alice',
): VexaRestSegment {
  return {
    segment_id: `seg-${start}`,
    text,
    speaker,
    start,
    end: start + 5,
    language: 'zh',
    completed: true,
  }
}

const baseParams = {
  meetingInstanceId: 'meet-uuid-1',
  platform: 'google_meet',
  nativeMeetingId: 'abc-defg-hij',
  creatorVexaToken: 'tok-123',
  difyDatasetId: null,
}

// ── Case 2: formatSeconds ─────────────────────────────────────────────────────

describe('formatSeconds', () => {
  it('< 1 小時 → M:SS 格式', () => {
    expect(formatSeconds(0)).toBe('0:00')
    expect(formatSeconds(65)).toBe('1:05')
    expect(formatSeconds(3599)).toBe('59:59')
  })

  it('>= 1 小時 → H:MM:SS 格式', () => {
    expect(formatSeconds(3600)).toBe('1:00:00')
    expect(formatSeconds(3661)).toBe('1:01:01')
    expect(formatSeconds(7325)).toBe('2:02:05')
  })
})

// ── Case 1: formatTranscriptAsMarkdown ────────────────────────────────────────

describe('formatTranscriptAsMarkdown', () => {
  it('正常格式化：含 speaker 與時間戳', () => {
    const segs = [
      makeSeg(0, '大家好', 'Alice'),
      makeSeg(10, '今天議程如下', 'Bob'),
    ]
    const md = formatTranscriptAsMarkdown(segs)

    expect(md).toContain('# 會議逐字稿')
    expect(md).toContain('**[0:00] Alice**: 大家好')
    expect(md).toContain('**[0:10] Bob**: 今天議程如下')
  })

  it('speaker 為 null → fallback 顯示「參與者」', () => {
    const segs = [makeSeg(5, '我說的話', null)]
    const md = formatTranscriptAsMarkdown(segs)

    expect(md).toContain('**[0:05] 參與者**: 我說的話')
  })
})

// ── Case 7 & 8: waitForTranscriptStable ──────────────────────────────────────

describe('waitForTranscriptStable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('連續 2 次 segment count 相同 → 提早回傳（穩定偵測）', async () => {
    const segs = [makeSeg(1), makeSeg(2)]
    mockVexa.getTranscriptions.mockResolvedValue(segs)

    const promise = waitForTranscriptStable('google_meet', 'abc-defg-hij', 'tok')

    // 初始等待（5 s）
    await vi.advanceTimersByTimeAsync(SUMMARY_INITIAL_WAIT_MS)
    // Poll 1: count=2, prevCount=-1 → prevCount=2, stableCount=0
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS)
    // Poll 2: count=2, prevCount=2 → stableCount=1（< 2，不回傳）
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS)
    // Poll 3: count=2, prevCount=2 → stableCount=2 ≥ 2 → 回傳
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS)

    const result = await promise
    expect(result).toEqual(segs)
    expect(mockVexa.getTranscriptions).toHaveBeenCalledTimes(3)
  })

  it('超過 30 秒仍未穩定 → 回傳目前最後取得的 segments', async () => {
    let callCount = 0
    mockVexa.getTranscriptions.mockImplementation(async () => {
      callCount++
      // 交替回傳不同長度，確保 stableCount 永遠重設
      return callCount % 2 === 0 ? [makeSeg(1)] : [makeSeg(1), makeSeg(2)]
    })

    const promise = waitForTranscriptStable('google_meet', 'abc-defg-hij', 'tok')

    // 初始等待（5 s），之後每 3 s 一次輪詢
    // deadline = Date.now() + 30000（5000ms 後）
    // 需要 10 次 poll 讓 Date.now() 到達 deadline
    await vi.advanceTimersByTimeAsync(SUMMARY_INITIAL_WAIT_MS)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS)
    }

    const result = await promise
    // 函式應回傳最後一次取得的 segments（不是空陣列）
    expect(Array.isArray(result)).toBe(true)
    // 共呼叫 10 次（第 10 次 poll timer 到達 deadline，while 條件不成立後 exit）
    expect(mockVexa.getTranscriptions).toHaveBeenCalledTimes(10)
  })
})

// ── Cases 3–6: generateSummaryAsync ──────────────────────────────────────────

describe('generateSummaryAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 預設：有 2 段逐字稿，且每次回傳相同（穩定偵測在 3 次 poll 後完成）
    mockVexa.getTranscriptions.mockResolvedValue([makeSeg(1), makeSeg(2)])
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 推進假時鐘直到 waitForTranscriptStable 完成（3 次 poll） */
  async function advanceUntilStable() {
    await vi.advanceTimersByTimeAsync(SUMMARY_INITIAL_WAIT_MS)
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS)
  }

  it('正常流程：Storage 上傳、Dify file upload、Dify workflow 均被呼叫，DB 更新摘要', async () => {
    const promise = generateSummaryAsync(baseParams)
    await advanceUntilStable()
    await promise

    expect(vi.mocked(supabaseMod.upsertFile)).toHaveBeenCalledWith(
      `transcripts/${baseParams.meetingInstanceId}/transcript.md`,
      expect.any(Buffer),
      'text/markdown',
    )
    expect(vi.mocked(difyMod.uploadTranscriptFile)).toHaveBeenCalledWith(
      baseParams.meetingInstanceId,
      expect.stringContaining('# 會議逐字稿'),
    )
    expect(vi.mocked(difyMod.generateSummary)).toHaveBeenCalledWith(
      expect.objectContaining({ difyFileId: 'dify-file-id' }),
    )
    expect(mockPrisma.meetingInstance.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ summary: '這是會議摘要' }),
      }),
    )
  })

  it('逐字稿為空 → 不呼叫 Dify，summary 更新為空字串 sentinel', async () => {
    mockVexa.getTranscriptions.mockResolvedValue([])

    const promise = generateSummaryAsync(baseParams)
    await advanceUntilStable()
    await promise

    expect(vi.mocked(difyMod.uploadTranscriptFile)).not.toHaveBeenCalled()
    expect(vi.mocked(difyMod.generateSummary)).not.toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { summary: '' } }),
    )
  })

  it('Dify workflow 拋錯 → catch 後 summary 更新為空字串 sentinel', async () => {
    vi.mocked(difyMod.generateSummary).mockRejectedValueOnce(new Error('Dify workflow failed'))

    const promise = generateSummaryAsync(baseParams)
    await advanceUntilStable()
    await promise

    expect(mockPrisma.meetingInstance.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { summary: '' } }),
    )
  })

  it('Storage 上傳失敗 → warn log，繼續執行 Dify 摘要不中斷', async () => {
    vi.mocked(supabaseMod.upsertFile).mockRejectedValueOnce(new Error('Storage error'))

    const promise = generateSummaryAsync(baseParams)
    await advanceUntilStable()
    await promise

    // Storage 失敗後仍繼續呼叫 Dify
    expect(vi.mocked(difyMod.uploadTranscriptFile)).toHaveBeenCalled()
    expect(vi.mocked(difyMod.generateSummary)).toHaveBeenCalled()
    // 最終仍以摘要內容更新 DB（非空字串）
    expect(mockPrisma.meetingInstance.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ summary: '這是會議摘要' }),
      }),
    )
  })
})
