import { prisma } from '../lib/prisma.js'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import * as dify from '../lib/dify.js'
import * as whisper from '../lib/whisper.js'
import { upsertFile, downloadTextFile } from '../lib/storage.js'
import { fetchRecallAudioUrl } from '../provider/recall-adapter.js'
import { normalizeWhisperSegments } from '../provider/normalize.js'
import {
  mergeConsecutiveSegments,
  formatTranscriptAsMarkdown,
} from '../sessions/summary.service.js'
import { syncMeetingRecordToKb } from '../sessions/meeting-kb.js'
import type { TranscriptSegment } from '../provider/types.js'

// ── 會後重轉錄（P3）───────────────────────────────────────────────────────────
//
// 會議結束、第一輪摘要落定後，抓 Recall 錄音交給 whisper-service（Breeze-ASR-25）
// 重轉高品質繁中逐字稿，產 transcript-v2.md 並重跑 Dify 摘要覆寫 DB。
// 狀態機在 MeetingInstance.retranscriptionStatus（PENDING/PROCESSING 為活動態，
// COMPLETED/SKIPPED/FAILED 為終態）；whisperJobId 落 DB 使流程可跨後端重啟續接。

/** 每輪最多處理的會議數（一筆 = 至多一次 Recall API + 一次 whisper 呼叫）。 */
const BATCH_LIMIT = 2

/** 暫時性失敗：attempts+1，耗盡則轉 FAILED 終態。 */
async function bumpAttempts(meetingId: string, attempts: number, reason: string): Promise<void> {
  if (attempts + 1 >= env.RETRANSCRIBE_MAX_ATTEMPTS) {
    await prisma.meetingInstance.update({
      where: { id: meetingId },
      data: {
        retranscriptionStatus: 'FAILED',
        retranscriptionAttempts: attempts + 1,
        retranscriptionError: `retries exhausted: ${reason}`,
      },
    })
    logger.warn({ meetingId, reason }, 'Retranscription: retries exhausted → FAILED')
    return
  }
  await prisma.meetingInstance.update({
    where: { id: meetingId },
    data: { retranscriptionAttempts: attempts + 1 },
  })
}

async function markSkipped(meetingId: string, reason: string): Promise<void> {
  await prisma.meetingInstance.update({
    where: { id: meetingId },
    data: { retranscriptionStatus: 'SKIPPED', retranscriptionError: reason },
  })
  logger.info({ meetingId, reason }, 'Retranscription: not applicable → SKIPPED')
}

/**
 * whisper 轉錄完成 → 併回聊天段落 → 產 transcript-v2.md → 重跑 Dify 摘要覆寫 DB。
 */
async function finalize(
  meetingId: string,
  whisperSegments: Array<{ text: string; start: number; end: number }>,
): Promise<void> {
  const voiceSegments = normalizeWhisperSegments(whisperSegments)

  // 聊天/蜜塔語音鏡像：generateSummaryAsync 會後存的 chatlog.json（已是會議相對秒數）。
  // 不存在（舊會議 / 當時上傳失敗 / 無聊天）→ 純語音照常進行。
  let chatSegments: TranscriptSegment[] = []
  const chatlogRaw = await downloadTextFile(`transcripts/${meetingId}/chatlog.json`).catch(
    () => null,
  )
  if (chatlogRaw) {
    try {
      chatSegments = JSON.parse(chatlogRaw) as TranscriptSegment[]
    } catch {
      logger.warn({ meetingId }, 'Retranscription: chatlog.json parse failed, proceeding without chat')
    }
  }

  const merged = [...voiceSegments, ...chatSegments].sort((a, b) => a.startTime - b.startTime)
  if (!merged.length) {
    await markSkipped(meetingId, 'whisper returned empty transcript')
    return
  }

  const transcriptMd = formatTranscriptAsMarkdown(await mergeConsecutiveSegments(merged))

  // v1（transcript.md）保留供比對稽核；DB 指標改指 v2。
  const storagePath = `transcripts/${meetingId}/transcript-v2.md`
  await upsertFile(storagePath, Buffer.from(transcriptMd, 'utf-8'), 'text/markdown')

  const difyFileId = await dify.uploadTranscriptFile(meetingId, transcriptMd)
  const { summary, actionItems, keyTopics, decisions } = await dify.generateSummary({
    difyFileId,
    meetingInstanceId: meetingId,
  })

  await prisma.meetingInstance.update({
    where: { id: meetingId },
    data: {
      summary,
      actionItems,
      keyTopics,
      decisions,
      transcriptStoragePath: storagePath,
      retranscriptionStatus: 'COMPLETED',
      retranscriptionError: null,
    },
  })
  logger.info(
    { meetingId, segmentCount: voiceSegments.length },
    'Retranscription: v2 transcript + summary completed',
  )

  // 用 v2 高品質版替換知識庫裡的會議記錄（刪舊傳新，best-effort）
  await syncMeetingRecordToKb(meetingId, transcriptMd)
}

/** 處理單筆會議的狀態機一步（暫時性失敗只 bump attempts，下輪重來）。 */
async function processMeeting(meeting: {
  id: string
  provider: string | null
  providerMeetingId: string | null
  whisperJobId: string | null
  retranscriptionAttempts: number
}): Promise<void> {
  // 只支援 Recall（Vexa 進不了 Meet 已退居二線，且無錄音 API）；舊資料無 provider 一併跳過。
  if (meeting.provider !== 'recall' || !meeting.providerMeetingId) {
    await markSkipped(meeting.id, `provider not eligible: ${meeting.provider ?? 'null'}`)
    return
  }

  // 已有 job → 輪詢結果（含後端重啟後的續接：jobId 在 DB）。
  if (meeting.whisperJobId) {
    const result = await whisper.getTranscriptionJob(meeting.whisperJobId)
    switch (result.status) {
      case 'done':
        await finalize(meeting.id, result.segments)
        return
      case 'error':
      case 'gone': {
        // whisper 轉錄失敗或服務重啟（job 蒸發）→ 清 jobId，下輪重送
        const reason = result.status === 'error' ? result.error : 'whisper job gone (service restarted)'
        logger.warn({ meetingId: meeting.id, reason }, 'Retranscription: whisper job lost, will resubmit')
        await prisma.meetingInstance.update({
          where: { id: meeting.id },
          data: { whisperJobId: null, retranscriptionStatus: 'PENDING' },
        })
        await bumpAttempts(meeting.id, meeting.retranscriptionAttempts, reason)
        return
      }
      default:
        return // queued / processing → 等下一輪（CPU 轉一小時會議可能數十分鐘）
    }
  }

  // 無 job → 解析錄音 URL 並送轉錄。
  const recording = await fetchRecallAudioUrl(meeting.providerMeetingId)
  if (recording.kind === 'none') {
    await markSkipped(meeting.id, 'no recording on Recall bot')
    return
  }
  if (recording.kind === 'pending') {
    await bumpAttempts(meeting.id, meeting.retranscriptionAttempts, 'recall media still processing')
    return
  }

  const jobId = await whisper.submitTranscriptionJob(recording.url)
  await prisma.meetingInstance.update({
    where: { id: meeting.id },
    data: { whisperJobId: jobId, retranscriptionStatus: 'PROCESSING' },
  })
  logger.info({ meetingId: meeting.id, jobId }, 'Retranscription: whisper job submitted')
}

export async function pollOnce(): Promise<void> {
  if (!whisper.isWhisperConfigured()) return

  // summary != null 是關鍵閘門：等第一輪 generateSummaryAsync 落定（成功或 sentinel ''）
  // 才啟動，避免與其賽跑；summary=''（realtime 逐字稿失敗）照樣重轉錄——救援加值。
  const candidates = await prisma.meetingInstance.findMany({
    where: {
      status: 'ENDED',
      retranscriptionStatus: { in: ['PENDING', 'PROCESSING'] },
      summary: { not: null },
    },
    select: {
      id: true,
      provider: true,
      providerMeetingId: true,
      whisperJobId: true,
      retranscriptionAttempts: true,
    },
    orderBy: { endedAt: 'asc' },
    take: BATCH_LIMIT,
  })

  for (const meeting of candidates) {
    try {
      await processMeeting(meeting)
    } catch (err) {
      // 網路/Recall/whisper 暫時性錯誤：bump attempts 後留給下一輪
      logger.warn({ err, meetingId: meeting.id }, 'Retranscription: transient error, will retry')
      await bumpAttempts(meeting.id, meeting.retranscriptionAttempts, String(err)).catch(
        (updateErr) =>
          logger.error({ updateErr, meetingId: meeting.id }, 'Retranscription: failed to bump attempts'),
      )
    }
  }
}

export function startRetranscriptionPoller(): void {
  setInterval(() => {
    pollOnce().catch((err: unknown) =>
      logger.error({ err }, 'Retranscription poller: unexpected error in poll cycle'),
    )
  }, env.RETRANSCRIBE_POLL_INTERVAL_MS)

  logger.info(
    { serviceUrl: env.WHISPER_SERVICE_URL, intervalMs: env.RETRANSCRIBE_POLL_INTERVAL_MS },
    'Retranscription poller started',
  )
}
