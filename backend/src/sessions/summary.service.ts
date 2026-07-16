import { prisma } from '../lib/prisma.js'
import { logger } from '../middleware/logger.js'
import * as vexaClient from '../lib/vexa.js'
import * as dify from '../lib/dify.js'
import { upsertFile } from '../lib/storage.js'
import { botProvider, type BotSession, type TranscriptSegment } from '../provider/index.js'
import { normalizeRestSegment } from '../provider/vexa-adapter.js'
import { isEndOfTurn } from '../lib/eou.js'
import { syncMeetingRecordToKb } from './meeting-kb.js'

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
  /** 'voice' = 蜜塔語音發言的文字鏡像（bot 聲音不進 STT，靠這裡留痕）。預設 'chat'。 */
  channel?: 'chat' | 'voice'
}

/**
 * 聊天室訊息併入語音 segments：epoch ms 以 sessionStartedAt 為錨點換算成
 * 會議相對秒數，speaker 加「（聊天室）」或「（語音）」標註，與語音依時間排序。
 * 錨點缺失（0）時聊天訊息一律排 0 秒（仍保留內容，只是順序不精確）。
 */
export function buildChatSegments(
  chatLog: ChatLogEntry[],
  sessionStartedAt: number,
): TranscriptSegment[] {
  return chatLog.map((m) => {
    const startTime = sessionStartedAt > 0 ? Math.max(0, (m.at - sessionStartedAt) / 1000) : 0
    return {
      segmentId: null,
      text: m.text,
      speaker: `${m.speaker}（${m.channel === 'voice' ? '語音' : '聊天室'}）`,
      startTime,
      endTime: startTime,
      language: null,
    }
  })
}

export function mergeChatIntoSegments(
  segments: TranscriptSegment[],
  chatLog: ChatLogEntry[],
  sessionStartedAt: number,
): TranscriptSegment[] {
  return [...segments, ...buildChatSegments(chatLog, sessionStartedAt)].sort(
    (a, b) => a.startTime - b.startTime,
  )
}

/**
 * 合併「同一說話者、間隔 ≤ MERGE_GAP_SECONDS」的連續 segments。
 * STT 常把一句話切成多個細碎片段，每片各佔一行（各帶時間+名字前綴）→ 逐字稿擠成一團；
 * 合併後一人一段連續發言只佔一行，時間取第一片的 startTime。
 *
 * 斷句輔助：間隔 ≤ MERGE_HARD_GAP_SECONDS 視為 STT 切碎、無條件合併；
 * 更長的停頓先問 LiveKit EOU 模型「上一段語意講完了嗎」——講完就斷句不合併
 * （同一人兩個獨立發言各佔一行）。模型不可用（回 null）退回照舊合併，只是增強不是依賴。
 */
const MERGE_GAP_SECONDS = 8
const MERGE_HARD_GAP_SECONDS = 2

export async function mergeConsecutiveSegments(
  segments: TranscriptSegment[],
): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    const gap = prev ? seg.startTime - prev.endTime : Infinity
    if (prev && (prev.speaker ?? '') === (seg.speaker ?? '') && gap <= MERGE_GAP_SECONDS) {
      let shouldMerge = true
      if (gap > MERGE_HARD_GAP_SECONDS) {
        const ended = await isEndOfTurn([{ role: 'user', content: prev.text }], 'zh').catch(
          () => null,
        )
        if (ended === true) shouldMerge = false
      }
      if (shouldMerge) {
        prev.text = `${prev.text} ${seg.text}`.trim()
        prev.endTime = Math.max(prev.endTime, seg.endTime)
        continue
      }
    }
    out.push({ ...seg })
  }
  return out
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

    // 細碎 STT 片段合併成段（同說話者、間隔近，EOU 模型輔助斷句）→ 逐字稿不再一句話拆好幾行
    const transcriptMd = formatTranscriptAsMarkdown(await mergeConsecutiveSegments(merged))

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

    // 聊天段落另存 JSON（已換算會議相對秒數）：會後重轉錄跑在數分鐘後、可能跨後端重啟，
    // 屆時 in-memory chatLog 已消失，poller 靠這份檔案把聊天/蜜塔語音鏡像併回 v2 逐字稿。
    if (params.chatLog?.length) {
      const chatSegments = buildChatSegments(params.chatLog, params.sessionStartedAt ?? 0)
      await upsertFile(
        `transcripts/${params.meetingInstanceId}/chatlog.json`,
        Buffer.from(JSON.stringify(chatSegments), 'utf-8'),
        'application/json',
      ).catch((err) =>
        logger.warn(
          { err, meetingInstanceId: params.meetingInstanceId },
          'chatlog.json upload failed, retranscription will proceed without chat',
        ),
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

    // 會議記錄回灌專案知識庫（best-effort）：下一場會議可問「上次決定了什麼」。
    // v2 重轉錄完成時會刪舊傳新替換成高品質版。
    await syncMeetingRecordToKb(params.meetingInstanceId, transcriptMd)
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
