import { prisma } from '../lib/prisma.js'
import { logger } from '../middleware/logger.js'
import * as vexaClient from '../lib/vexa.js'
import * as dify from '../lib/dify.js'
import { upsertFile } from '../lib/supabase.js'
import { botProvider, type BotSession, type TranscriptSegment } from '../provider/index.js'
import { normalizeRestSegment } from '../provider/vexa-adapter.js'

export const SUMMARY_INITIAL_WAIT_MS = 5_000
export const SUMMARY_POLL_INTERVAL_MS = 3_000
export const SUMMARY_STABLE_POLLS = 2
export const SUMMARY_TIMEOUT_MS = 30_000

export function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export interface ChatLogEntry {
  speaker: string
  text: string
  /** epoch ms */
  at: number
}

/**
 * 聊天室訊息併入語音 segments：epoch ms 以 sessionStartedAt 為錨點換算成
 * 會議相對秒數，speaker 加「（聊天室）」標註，與語音依時間排序。
 * 錨點缺失（0）時聊天訊息一律排 0 秒（仍保留內容，只是順序不精確）。
 */
export function mergeChatIntoSegments(
  segments: TranscriptSegment[],
  chatLog: ChatLogEntry[],
  sessionStartedAt: number,
): TranscriptSegment[] {
  const chatSegments: TranscriptSegment[] = chatLog.map((m) => {
    const startTime = sessionStartedAt > 0 ? Math.max(0, (m.at - sessionStartedAt) / 1000) : 0
    return {
      segmentId: null,
      text: m.text,
      speaker: `${m.speaker}（聊天室）`,
      startTime,
      endTime: startTime,
      language: null,
    }
  })
  return [...segments, ...chatSegments].sort((a, b) => a.startTime - b.startTime)
}

/** 逐字稿轉純文字（無 markdown 標記；前端原樣顯示、Dify 當摘要輸入）。 */
export function formatTranscriptAsMarkdown(segments: TranscriptSegment[]): string {
  const lines = segments.map((seg) => {
    const ts = formatSeconds(seg.startTime)
    const speaker = seg.speaker || '參與者'
    return `[${ts}] ${speaker}: ${seg.text}`
  })
  return lines.join('\n\n')
}

export async function waitForTranscriptStable(
  fetchSegments: () => Promise<TranscriptSegment[]>,
): Promise<TranscriptSegment[]> {
  await new Promise((r) => setTimeout(r, SUMMARY_INITIAL_WAIT_MS))

  const deadline = Date.now() + SUMMARY_TIMEOUT_MS
  let prevCount = -1
  let stableCount = 0
  let lastSegments: TranscriptSegment[] = []

  while (Date.now() < deadline) {
    lastSegments = await fetchSegments()
    const count = lastSegments.length

    if (count === prevCount) {
      if (++stableCount >= SUMMARY_STABLE_POLLS) return lastSegments
    } else {
      stableCount = 0
      prevCount = count
    }

    await new Promise((r) => setTimeout(r, SUMMARY_POLL_INTERVAL_MS))
  }

  logger.warn(
    { segmentCount: lastSegments.length },
    'transcript stabilization timeout, proceeding with available segments',
  )
  return lastSegments
}

export async function generateSummaryAsync(params: {
  meetingInstanceId: string
  platform: string
  nativeMeetingId: string
  creatorVexaToken: string
  difyDatasetId: string | null
  /** 會議結束時仍在記憶體的 bot session；有則用 provider 抽象層取逐字稿（provider-agnostic）。 */
  session?: BotSession
  /** 聊天室訊息（含蜜塔回覆），併入逐字稿。 */
  chatLog?: ChatLogEntry[]
  /** 聊天訊息時間換算錨點（bot admitted 的 epoch ms）。 */
  sessionStartedAt?: number
}): Promise<void> {
  try {
    // 正常結束路徑：用 provider 抽象層取逐字稿（涵蓋 Vexa / Recall）。
    // 重啟復原路徑（無 session）：退回 Vexa REST（DB 只持久化 Vexa 識別碼，見 session-manager 限制說明）。
    const fetchSegments: () => Promise<TranscriptSegment[]> = params.session
      ? () => botProvider.getTranscript(params.session!)
      : () =>
          vexaClient
            .getTranscriptions(params.platform, params.nativeMeetingId, params.creatorVexaToken)
            .then((raw) => raw.map(normalizeRestSegment))

    const segments = await waitForTranscriptStable(fetchSegments)

    // 聊天室訊息（含蜜塔的插話/回覆）按時間併入——純打字的會議也因此有逐字稿與摘要
    const merged = mergeChatIntoSegments(segments, params.chatLog ?? [], params.sessionStartedAt ?? 0)

    if (!merged.length) {
      logger.info({ meetingInstanceId: params.meetingInstanceId }, 'no transcript, skipping summary')
      await prisma.meetingInstance.update({
        where: { id: params.meetingInstanceId },
        data: { summary: '' },
      })
      return
    }

    const transcriptMd = formatTranscriptAsMarkdown(merged)

    const storagePath = `transcripts/${params.meetingInstanceId}/transcript.md`
    try {
      await upsertFile(storagePath, Buffer.from(transcriptMd, 'utf-8'), 'text/markdown')
      await prisma.meetingInstance.update({
        where: { id: params.meetingInstanceId },
        data: { transcriptStoragePath: storagePath },
      })
    } catch (uploadErr) {
      logger.warn(
        { err: uploadErr, meetingInstanceId: params.meetingInstanceId },
        'transcript storage upload failed, proceeding anyway',
      )
    }

    const difyFileId = await dify.uploadTranscriptFile(params.meetingInstanceId, transcriptMd)

    const { summary, actionItems, keyTopics, decisions } = await dify.generateSummary({
      difyFileId,
      meetingInstanceId: params.meetingInstanceId,
    })

    await prisma.meetingInstance.update({
      where: { id: params.meetingInstanceId },
      data: { summary, actionItems, keyTopics, decisions },
    })

    logger.info(
      { meetingInstanceId: params.meetingInstanceId, actionItemCount: actionItems.length },
      'meeting summary generated',
    )
  } catch (err) {
    logger.error({ err, meetingInstanceId: params.meetingInstanceId }, 'generateSummaryAsync failed')
    try {
      await prisma.meetingInstance.update({
        where: { id: params.meetingInstanceId },
        data: { summary: '' },
      })
    } catch (updateErr) {
      logger.error(
        { updateErr, meetingInstanceId: params.meetingInstanceId },
        'failed to set summary sentinel',
      )
    }
  }
}
