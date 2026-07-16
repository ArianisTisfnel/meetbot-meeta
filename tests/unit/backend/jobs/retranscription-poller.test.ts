import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockWhisper } from '../../../mocks/whisper.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/whisper', () => mockWhisper)
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    // summary.service（poller 依賴其純函式）的傳遞依賴需要的最小 env
    VEXA_API_URL: 'http://vexa.test',
    VEXA_WS_URL: 'ws://vexa.test',
    DIFY_API_BASE: 'http://dify.test',
    BOT_ADMISSION_TIMEOUT_MS: 30000,
    // poller 本體
    WHISPER_SERVICE_URL: 'http://whisper.test',
    RETRANSCRIBE_POLL_INTERVAL_MS: 60000,
    RETRANSCRIBE_MAX_ATTEMPTS: 60,
  },
}))
vi.mock('../../../../backend/src/lib/dify', () => ({
  uploadTranscriptFile: vi.fn().mockResolvedValue('dify-file-v2'),
  generateSummary: vi.fn().mockResolvedValue({
    summary: 'v2 高品質摘要',
    actionItems: [{ task: '準備報告', owner: 'Alice' }],
    keyTopics: ['主題一'],
    decisions: ['決定一'],
  }),
}))
vi.mock('../../../../backend/src/lib/storage', () => ({
  upsertFile: vi.fn().mockResolvedValue(undefined),
  downloadTextFile: vi.fn().mockResolvedValue(null),
}))
// recall-adapter：poller 只用 fetchRecallAudioUrl；RecallAdapter 塞空 class
// 讓 provider/index（summary.service 的傳遞依賴）import 不炸。
const mockFetchRecallAudioUrl = vi.hoisted(() => vi.fn())
vi.mock('../../../../backend/src/provider/recall-adapter', () => ({
  fetchRecallAudioUrl: mockFetchRecallAudioUrl,
  RecallAdapter: class {},
}))
// EOU（mergeConsecutiveSegments 斷句輔助）：回 null = 模型不可用，照舊合併
vi.mock('../../../../backend/src/lib/eou', () => ({ isEndOfTurn: vi.fn().mockResolvedValue(null) }))
vi.mock('../../../../backend/src/lib/vexa', () => ({ getTranscriptions: vi.fn() }))
// 會議記錄回灌知識庫（finalize 的 best-effort hook）
const mockSyncMeetingRecordToKb = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../../../backend/src/sessions/meeting-kb', () => ({
  syncMeetingRecordToKb: mockSyncMeetingRecordToKb,
}))

import { pollOnce } from '../../../../backend/src/jobs/retranscription-poller'
import * as difyMod from '../../../../backend/src/lib/dify'
import * as storageMod from '../../../../backend/src/lib/storage'

const baseMeeting = {
  id: 'meet-1',
  provider: 'recall',
  providerMeetingId: 'bot-uuid-1',
  whisperJobId: null,
  retranscriptionAttempts: 0,
}

describe('retranscription-poller: 資格檢查（SKIPPED 分支）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('provider=vexa → SKIPPED，不打 whisper 也不打 Recall', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([
      { ...baseMeeting, provider: 'vexa' },
    ])

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'meet-1' },
        data: expect.objectContaining({ retranscriptionStatus: 'SKIPPED' }),
      }),
    )
    expect(mockFetchRecallAudioUrl).not.toHaveBeenCalled()
    expect(mockWhisper.submitTranscriptionJob).not.toHaveBeenCalled()
  })

  it('providerMeetingId=null（舊資料）→ SKIPPED', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([
      { ...baseMeeting, providerMeetingId: null },
    ])

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ retranscriptionStatus: 'SKIPPED' }),
      }),
    )
  })

  it('Recall 無錄音（recordings 空）→ SKIPPED', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...baseMeeting }])
    mockFetchRecallAudioUrl.mockResolvedValueOnce({ kind: 'none' })

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ retranscriptionStatus: 'SKIPPED' }),
      }),
    )
    expect(mockWhisper.submitTranscriptionJob).not.toHaveBeenCalled()
  })
})

describe('retranscription-poller: 送件與暫時性失敗', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('錄音就緒 → submit whisper job，寫 whisperJobId + PROCESSING', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...baseMeeting }])
    mockFetchRecallAudioUrl.mockResolvedValueOnce({ kind: 'ready', url: 'https://s3/audio.mp3' })
    mockWhisper.submitTranscriptionJob.mockResolvedValueOnce('job-42')

    await pollOnce()

    expect(mockWhisper.submitTranscriptionJob).toHaveBeenCalledWith('https://s3/audio.mp3')
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'meet-1' },
        data: { whisperJobId: 'job-42', retranscriptionStatus: 'PROCESSING' },
      }),
    )
  })

  it('Recall 媒體仍在處理（pending）→ attempts+1，狀態保持（下輪重試）', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...baseMeeting }])
    mockFetchRecallAudioUrl.mockResolvedValueOnce({ kind: 'pending' })

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { retranscriptionAttempts: 1 },
      }),
    )
    expect(mockWhisper.submitTranscriptionJob).not.toHaveBeenCalled()
  })

  it('whisper 服務不可達（submit 拋錯）→ 吞錯 + attempts+1，不中斷本輪', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...baseMeeting }])
    mockFetchRecallAudioUrl.mockResolvedValueOnce({ kind: 'ready', url: 'https://s3/a.mp3' })
    mockWhisper.submitTranscriptionJob.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(pollOnce()).resolves.toBeUndefined()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { retranscriptionAttempts: 1 },
      }),
    )
  })

  it('attempts 達上限 → FAILED 終態 + retranscriptionError', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([
      { ...baseMeeting, retranscriptionAttempts: 59 }, // RETRANSCRIBE_MAX_ATTEMPTS=60
    ])
    mockFetchRecallAudioUrl.mockResolvedValueOnce({ kind: 'pending' })

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retranscriptionStatus: 'FAILED',
          retranscriptionAttempts: 60,
          retranscriptionError: expect.stringContaining('retries exhausted'),
        }),
      }),
    )
  })
})

describe('retranscription-poller: job 輪詢與 finalize', () => {
  const processingMeeting = { ...baseMeeting, whisperJobId: 'job-42' }
  const whisperSegments = [
    { text: '大家好，我們開始開會。', start: 0.0, end: 3.2 },
    { text: '今天討論 Q3 目標。', start: 3.5, end: 6.8 },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('job queued/processing → 什麼都不做（等下輪）', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...processingMeeting }])
    mockWhisper.getTranscriptionJob.mockResolvedValueOnce({ status: 'processing' })

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).not.toHaveBeenCalled()
  })

  it('job 404（whisper 重啟，gone）→ 清 whisperJobId + attempts+1，下輪重送', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...processingMeeting }])
    mockWhisper.getTranscriptionJob.mockResolvedValueOnce({ status: 'gone' })

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { whisperJobId: null, retranscriptionStatus: 'PENDING' },
      }),
    )
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { retranscriptionAttempts: 1 },
      }),
    )
  })

  it('job done → v2 上傳、Dify 重跑、覆寫摘要 + COMPLETED（無 chatlog.json）', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...processingMeeting }])
    mockWhisper.getTranscriptionJob.mockResolvedValueOnce({
      status: 'done',
      segments: whisperSegments,
    })
    vi.mocked(storageMod.downloadTextFile).mockResolvedValueOnce(null) // 無 chatlog

    await pollOnce()

    // v2 逐字稿上傳（無說話者 → formatTranscriptAsMarkdown 顯示「參與者」）
    expect(vi.mocked(storageMod.upsertFile)).toHaveBeenCalledWith(
      'transcripts/meet-1/transcript-v2.md',
      expect.any(Buffer),
      'text/markdown',
    )
    const uploaded = vi.mocked(storageMod.upsertFile).mock.calls[0][1].toString('utf-8')
    expect(uploaded).toContain('參與者')
    expect(uploaded).toContain('Q3 目標')

    expect(vi.mocked(difyMod.uploadTranscriptFile)).toHaveBeenCalledWith(
      'meet-1',
      expect.stringContaining('Q3 目標'),
    )
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'meet-1' },
        data: expect.objectContaining({
          summary: 'v2 高品質摘要',
          transcriptStoragePath: 'transcripts/meet-1/transcript-v2.md',
          retranscriptionStatus: 'COMPLETED',
        }),
      }),
    )

    // v2 完成後用高品質版替換知識庫的會議記錄
    expect(mockSyncMeetingRecordToKb).toHaveBeenCalledWith(
      'meet-1',
      expect.stringContaining('Q3 目標'),
    )
  })

  it('job done + 有 chatlog.json → 聊天段落按時間併入 v2 逐字稿', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...processingMeeting }])
    mockWhisper.getTranscriptionJob.mockResolvedValueOnce({
      status: 'done',
      segments: whisperSegments,
    })
    const chatSegments = [
      {
        segmentId: null,
        text: '打字補充一句',
        speaker: 'Wendy（聊天室）',
        startTime: 3.3,
        endTime: 3.3,
        language: null,
      },
    ]
    vi.mocked(storageMod.downloadTextFile).mockResolvedValueOnce(JSON.stringify(chatSegments))

    await pollOnce()

    expect(vi.mocked(storageMod.downloadTextFile)).toHaveBeenCalledWith(
      'transcripts/meet-1/chatlog.json',
    )
    const uploaded = vi.mocked(storageMod.upsertFile).mock.calls[0][1].toString('utf-8')
    expect(uploaded).toContain('Wendy（聊天室）')
    // 時間排序：chat（3.3s）介於兩段語音之間
    const chatPos = uploaded.indexOf('打字補充一句')
    const seg2Pos = uploaded.indexOf('Q3 目標')
    expect(chatPos).toBeGreaterThan(-1)
    expect(chatPos).toBeLessThan(seg2Pos)
  })

  it('job done 但 whisper 回空 segments → SKIPPED（不打 Dify）', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...processingMeeting }])
    mockWhisper.getTranscriptionJob.mockResolvedValueOnce({ status: 'done', segments: [] })
    vi.mocked(storageMod.downloadTextFile).mockResolvedValueOnce(null)

    await pollOnce()

    expect(vi.mocked(difyMod.generateSummary)).not.toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ retranscriptionStatus: 'SKIPPED' }),
      }),
    )
  })

  it('job error → 清 jobId 重送 + attempts+1', async () => {
    mockPrisma.meetingInstance.findMany.mockResolvedValueOnce([{ ...processingMeeting }])
    mockWhisper.getTranscriptionJob.mockResolvedValueOnce({
      status: 'error',
      error: 'ffmpeg decode failed',
    })

    await pollOnce()

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { whisperJobId: null, retranscriptionStatus: 'PENDING' },
      }),
    )
  })
})
