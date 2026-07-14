import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockVexa } from '../../../mocks/vexa.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/vexa', () => mockVexa)
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    VEXA_API_URL: 'http://vexa.test',
    VEXA_WS_URL: 'ws://vexa.test',
    DIFY_API_BASE: 'http://dify.test',
    BOT_ADMISSION_TIMEOUT_MS: 30000,
  },
}))
vi.mock('../../../../backend/src/lib/dify', () => ({
  uploadTranscriptFile: vi.fn().mockResolvedValue('dify-file-id'),
  generateSummary: vi.fn().mockResolvedValue({
    summary: '這是會議摘要',
    actionItems: [{ task: '準備報告', owner: 'Alice' }],
    keyTopics: ['主題一'],
    decisions: ['決定一'],
  }),
}))
vi.mock('../../../../backend/src/lib/storage', () => ({
  upsertFile: vi.fn().mockResolvedValue(undefined),
}))

// EOU 模型（斷句輔助）：預設回 null（模型不可用 → 照舊合併），個別測試再覆寫
const mockIsEndOfTurn = vi.hoisted(() => vi.fn().mockResolvedValue(null))
vi.mock('../../../../backend/src/lib/eou', () => ({ isEndOfTurn: mockIsEndOfTurn }))

import {
  formatTranscriptAsMarkdown,
  formatSeconds,
  mergeConsecutiveSegments,
  waitForTranscriptStable,
  generateSummaryAsync,
  SUMMARY_INITIAL_WAIT_MS,
  SUMMARY_POLL_INTERVAL_MS,
} from '../../../../backend/src/sessions/summary.service'
import * as difyMod from '../../../../backend/src/lib/dify'
import * as storageMod from '../../../../backend/src/lib/storage'
import type { TranscriptSegment } from '../../../../backend/src/provider/types'

/** 統一 schema 的 segment（formatTranscriptAsMarkdown / waitForTranscriptStable 用）。 */
function makeSeg(
  start: number,
  text = `seg-text-${start}`,
  speaker: string | null = 'Alice',
): TranscriptSegment {
  return {
    segmentId: `seg-${start}`,
    text,
    speaker,
    startTime: start,
    endTime: start + 5,
    language: 'zh',
  }
}

/** Vexa REST 原始 segment（generateSummaryAsync 無 session 時的 REST fallback 用）。 */
function makeRestSeg(start: number, text = `seg-text-${start}`, speaker: string | null = 'Alice') {
  return { segment_id: `seg-${start}`, text, speaker, start, end: start + 5, language: 'zh', completed: true }
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

    expect(md).not.toContain('#')
    expect(md).not.toContain('**')
    expect(md).toContain('[0:00] Alice: 大家好')
    expect(md).toContain('[0:10] Bob: 今天議程如下')
  })

  it('speaker 為 null → fallback 顯示「參與者」', () => {
    const segs = [makeSeg(5, '我說的話', null)]
    const md = formatTranscriptAsMarkdown(segs)

    expect(md).toContain('[0:05] 參與者: 我說的話')
  })
})

describe('mergeConsecutiveSegments', () => {
  beforeEach(() => mockIsEndOfTurn.mockClear())

  it('同說話者、間隔 ≤ 8 秒 → 合併成一段（時間取第一片、endTime 取最後片）', async () => {
    const segs = [
      makeSeg(0, '我們今天', 'Alice'),   // 0-5
      makeSeg(6, '要討論的是', 'Alice'), // 6-11，距上片 endTime 1 秒
      makeSeg(13, '期末報告', 'Alice'),  // 13-18，距上片 endTime 2 秒
    ]
    const out = await mergeConsecutiveSegments(segs)

    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('我們今天 要討論的是 期末報告')
    expect(out[0].startTime).toBe(0)
    expect(out[0].endTime).toBe(18)
    // 間隔皆 ≤ 2 秒（硬合併門檻）→ 不需要問 EOU
    expect(mockIsEndOfTurn).not.toHaveBeenCalled()
  })

  it('不同說話者 → 不合併', async () => {
    const segs = [makeSeg(0, 'A 的話', 'Alice'), makeSeg(6, 'B 的話', 'Bob')]
    expect(await mergeConsecutiveSegments(segs)).toHaveLength(2)
  })

  it('同說話者但間隔 > 8 秒 → 不合併', async () => {
    const segs = [makeSeg(0, '第一段', 'Alice'), makeSeg(20, '第二段', 'Alice')] // gap = 20-5 = 15s
    expect(await mergeConsecutiveSegments(segs)).toHaveLength(2)
  })

  it('間隔 2~8 秒、EOU 判斷上一段講完 → 斷句不合併', async () => {
    mockIsEndOfTurn.mockResolvedValueOnce(true)
    const segs = [makeSeg(0, '第一個想法說完了。', 'Alice'), makeSeg(9, '另外一件事', 'Alice')] // gap = 4s
    const out = await mergeConsecutiveSegments(segs)

    expect(mockIsEndOfTurn).toHaveBeenCalledOnce()
    expect(out).toHaveLength(2)
  })

  it('間隔 2~8 秒、EOU 不可用（null）→ 照舊合併', async () => {
    const segs = [makeSeg(0, '講到一半', 'Alice'), makeSeg(9, '接著說', 'Alice')] // gap = 4s
    const out = await mergeConsecutiveSegments(segs)

    expect(mockIsEndOfTurn).toHaveBeenCalledOnce()
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('講到一半 接著說')
  })

  it('不改動原始輸入（copy-on-merge）', async () => {
    const segs = [makeSeg(0, '一', 'Alice'), makeSeg(6, '二', 'Alice')]
    await mergeConsecutiveSegments(segs)
    expect(segs[0].text).toBe('一')
    expect(segs[0].endTime).toBe(5)
  })
})

describe('mergeChatIntoSegments', () => {
  it('聊天訊息換算相對秒數、標註（聊天室）、與語音依時間排序', async () => {
    const { mergeChatIntoSegments } = await import('../../../../backend/src/sessions/summary.service')
    const startedAt = 1_000_000
    const segs = [makeSeg(10, '語音第一句', 'Alice'), makeSeg(40, '語音第二句', 'Bob')]
    const chat = [
      { speaker: 'Wendy', text: '打字的問題', at: startedAt + 20_000 },
      { speaker: '蜜塔', text: '💡 打字的回答', at: startedAt + 25_000 },
    ]

    const merged = mergeChatIntoSegments(segs, chat, startedAt)

    expect(merged.map((s) => s.text)).toEqual(['語音第一句', '打字的問題', '💡 打字的回答', '語音第二句'])
    expect(merged[1].speaker).toBe('Wendy（聊天室）')
    expect(merged[1].startTime).toBe(20)
  })

  it('無錨點（sessionStartedAt=0）→ 聊天訊息仍保留（排 0 秒）', async () => {
    const { mergeChatIntoSegments } = await import('../../../../backend/src/sessions/summary.service')
    const merged = mergeChatIntoSegments([], [{ speaker: 'W', text: 'hi', at: 123 }], 0)
    expect(merged).toHaveLength(1)
    expect(merged[0].startTime).toBe(0)
  })

  it("channel='voice' → 標註（語音）而非（聊天室）", async () => {
    const { mergeChatIntoSegments } = await import('../../../../backend/src/sessions/summary.service')
    const merged = mergeChatIntoSegments(
      [],
      [{ speaker: '蜜塔', text: '報名截止是 6/30。', at: 5_000, channel: 'voice' as const }],
      1_000,
    )
    expect(merged[0].speaker).toBe('蜜塔（語音）')
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
    const fetchSegments = vi.fn().mockResolvedValue(segs)

    const promise = waitForTranscriptStable(fetchSegments)

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
    expect(fetchSegments).toHaveBeenCalledTimes(3)
  })

  it('超過 30 秒仍未穩定 → 回傳目前最後取得的 segments', async () => {
    let callCount = 0
    const fetchSegments = vi.fn().mockImplementation(async () => {
      callCount++
      // 交替回傳不同長度，確保 stableCount 永遠重設
      return callCount % 2 === 0 ? [makeSeg(1)] : [makeSeg(1), makeSeg(2)]
    })

    const promise = waitForTranscriptStable(fetchSegments)

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
    expect(fetchSegments).toHaveBeenCalledTimes(10)
  })
})

// ── Cases 3–6: generateSummaryAsync ──────────────────────────────────────────

describe('generateSummaryAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 預設：有 2 段逐字稿，且每次回傳相同（穩定偵測在 3 次 poll 後完成）。
    // generateSummaryAsync 無 session → 走 Vexa REST fallback，故 mock 回傳 REST 原始 segment。
    mockVexa.getTranscriptions.mockResolvedValue([makeRestSeg(1), makeRestSeg(2)])
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

    expect(vi.mocked(storageMod.upsertFile)).toHaveBeenCalledWith(
      `transcripts/${baseParams.meetingInstanceId}/transcript.md`,
      expect.any(Buffer),
      'text/markdown',
    )
    expect(vi.mocked(difyMod.uploadTranscriptFile)).toHaveBeenCalledWith(
      baseParams.meetingInstanceId,
      expect.stringContaining('] '),
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
    vi.mocked(storageMod.upsertFile).mockRejectedValueOnce(new Error('Storage error'))

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
