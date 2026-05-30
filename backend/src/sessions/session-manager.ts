import WebSocket from 'ws'
import { prisma } from '../lib/prisma.js'
import { logger } from '../middleware/logger.js'
import * as vexaClient from '../lib/vexa.js'
import { activeSessions } from './session-store.js'
import { handleTranscriptSegment, handleChatMessage } from './wake-word-detector.js'
import { generateSummaryAsync } from './summary.service.js'
import { env } from '../types/env.js'
import type { MeetingSession } from '../types/session.js'

// ── createSession ─────────────────────────────────────────────────────────────

export async function createSession(
  meetingInstanceId: string,
  params: {
    vexaMeetingId: number
    platform: string
    nativeMeetingId: string
    difyDatasetId: string | null
    creatorVexaToken: string
  },
  initialProcessedIds: Set<string> = new Set(),
): Promise<void> {
  const ws = new WebSocket(`${env.VEXA_WS_URL}/ws`, {
    headers: { 'X-API-Key': params.creatorVexaToken },
  })

  const session: MeetingSession = {
    meetingInstanceId,
    vexaMeetingId: params.vexaMeetingId,
    platform: params.platform,
    nativeMeetingId: params.nativeMeetingId,
    difyDatasetId: params.difyDatasetId,
    creatorVexaToken: params.creatorVexaToken,
    isSpeaking: false,
    lastWakeAt: 0,
    processedSegmentIds: initialProcessedIds,
    wsConnection: ws,
    difyConversationId: null,
    lastQuestionAt: 0,
  }
  activeSessions.set(meetingInstanceId, session)

  // 等待連線建立後訂閱 channel
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          meetings: [{ platform: params.platform, native_id: params.nativeMeetingId }],
        }),
      )
      resolve()
    })
    ws.once('error', (err) => reject(err))
  })

  // 掛載訊息處理器
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      const s = activeSessions.get(meetingInstanceId)
      if (!s) return
      handleVexaWsMessage(s, msg)
    } catch (err) {
      logger.warn({ err, meetingInstanceId }, 'failed to parse vexa ws message')
    }
  })

  // 非主動關閉時自動重連
  ws.on('close', () => {
    logger.warn({ meetingInstanceId }, 'Per-session WS disconnected')
    const existing = activeSessions.get(meetingInstanceId)
    if (existing) {
      setTimeout(
        () => createSession(meetingInstanceId, params, existing.processedSegmentIds),
        3000,
      )
    }
  })

  ws.on('error', (err) =>
    logger.error({ err, meetingInstanceId }, 'Per-session WS error'),
  )
}

// ── closeSession ──────────────────────────────────────────────────────────────

export async function closeSession(meetingInstanceId: string): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  if (!session) return

  activeSessions.delete(meetingInstanceId)

  try {
    session.wsConnection?.send(
      JSON.stringify({
        action: 'unsubscribe',
        meetings: [{ platform: session.platform, native_id: session.nativeMeetingId }],
      }),
    )
    session.wsConnection?.close()
  } catch {
    logger.warn({ meetingInstanceId }, 'closeSession: WS already closed, skipping unsubscribe')
  }
}

// ── handleVexaWsMessage ───────────────────────────────────────────────────────

function handleVexaWsMessage(session: MeetingSession, msg: any): void {
  switch (msg.type) {
    case 'transcript.bundle':
    case 'transcript': {
      const confirmedSegs: any[] = msg.confirmed ?? []
      for (const seg of confirmedSegs) {
        if (!seg.text?.trim() || !seg.segment_id) continue
        handleTranscriptSegment(session, {
          segment_id: seg.segment_id,
          text: seg.text,
          speaker: seg.speaker || msg.speaker || '',
          start_time: seg.start ?? seg.start_time ?? 0,
          end_time: seg.end ?? seg.end_time ?? 0,
        }).catch((err) =>
          logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'handleTranscriptSegment error'),
        )
      }
      break
    }
    case 'meeting.status': {
      const status = msg.payload?.status
      if (status) {
        handleBotStatusChange(session, status).catch((err) =>
          logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'handleBotStatusChange error'),
        )
      }
      break
    }
    case 'chat.new_message': {
      if (!msg.payload?.is_from_bot) {
        handleChatMessage(session, msg.payload).catch((err) =>
          logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'handleChatMessage error'),
        )
      }
      break
    }
    default:
      logger.debug(
        { type: msg.type, meetingInstanceId: session.meetingInstanceId },
        'unhandled vexa ws message type',
      )
  }
}

// ── handleBotStatusChange ─────────────────────────────────────────────────────

export async function handleBotStatusChange(session: MeetingSession, status: string): Promise<void> {
  if (status === 'active') {
    logger.info({ meetingInstanceId: session.meetingInstanceId }, 'Bot entered meeting → marking ACTIVE')
    await prisma.meetingInstance.update({
      where: { id: session.meetingInstanceId },
      data: { status: 'ACTIVE', startedAt: new Date() },
    })

    const welcomeMsg = session.difyDatasetId
      ? '嗨大家好！我是蜜塔（Meeta），你們今天的會議小幫手 🎉\n\n你可以用語音或聊天室呼叫我：\n  語音：說「蜜塔」或「小幫手」，再接上你的問題\n  聊天室：輸入「蜜塔」或「小幫手」，再接上你的問題\n\n我會根據此專案上傳的資料來回答問題，例如：\n「蜜塔，請問去年 Q3 目標是什麼？」\n\n有問題就找我！'
      : '嗨大家好！我是蜜塔（Meeta），你們今天的會議小幫手 🎉\n\n你可以用語音或聊天室呼叫我：\n  語音：說「蜜塔」或「小幫手」，再接上你的問題\n  聊天室：輸入「蜜塔」或「小幫手」，再接上你的問題\n\n我會根據本次會議的逐字稿記錄來回答問題，例如：\n「蜜塔，剛才提到的時程安排是什麼？」\n\n有問題就找我！'

    vexaClient
      .chatSend(session.platform, session.nativeMeetingId, session.creatorVexaToken, {
        text: welcomeMsg,
      })
      .catch((err) =>
        logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'welcome chat failed'),
      )

    return
  }

  const isTerminal = ['completed', 'failed', 'needs_help', 'needs_human_help'].includes(status)
  if (!isTerminal) return

  logger.info({ meetingInstanceId: session.meetingInstanceId, vexaStatus: status }, 'Bot left meeting')

  const isLobbyFail = status === 'needs_help' || status === 'needs_human_help'
  const normalizedStatus = isLobbyFail ? 'failed' : status
  await handleSessionClose(session.meetingInstanceId, normalizedStatus)
}

// ── handleSessionClose ────────────────────────────────────────────────────────

export async function handleSessionClose(
  meetingInstanceId: string,
  vexaStatus?: string,
): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  if (!session) return

  // 原子鎖：先從 Map 移除，防止雙重觸發
  activeSessions.delete(meetingInstanceId)

  const meetbotFinalStatus = vexaStatus === 'failed' ? 'FAILED' : 'ENDED'

  await prisma.meetingInstance.update({
    where: { id: meetingInstanceId },
    data: { status: meetbotFinalStatus, endedAt: new Date() },
  })

  // P6: 觸發摘要工作流
  if (meetbotFinalStatus === 'ENDED') {
    generateSummaryAsync({
      meetingInstanceId,
      platform: session.platform,
      nativeMeetingId: session.nativeMeetingId,
      creatorVexaToken: session.creatorVexaToken,
      difyDatasetId: session.difyDatasetId,
    })
  }

  try {
    session.wsConnection?.send(
      JSON.stringify({
        action: 'unsubscribe',
        meetings: [{ platform: session.platform, native_id: session.nativeMeetingId }],
      }),
    )
    session.wsConnection?.close()
  } catch {
    logger.warn({ meetingInstanceId }, 'handleSessionClose: WS already closed, skipping unsubscribe')
  }
}

// ── restoreActiveSessions ─────────────────────────────────────────────────────

export async function restoreActiveSessions(): Promise<void> {
  // 階段一：清理 zombie PENDING（超過 5 分鐘仍 PENDING 者標為 FAILED）
  const PENDING_STALE_MINUTES = 5
  const staleThreshold = new Date(Date.now() - PENDING_STALE_MINUTES * 60 * 1000)

  const staleResult = await prisma.meetingInstance.updateMany({
    where: { status: 'PENDING', createdAt: { lt: staleThreshold } },
    data: { status: 'FAILED', endedAt: new Date() },
  })
  if (staleResult.count > 0) {
    logger.warn({ count: staleResult.count }, 'startup: cleaned up zombie PENDING meetings')
  }

  // 階段二：恢復 ACTIVE sessions
  const activeMeetings = await prisma.meetingInstance.findMany({
    where: { status: 'ACTIVE' },
    include: { project: { select: { difyDatasetId: true } } },
  })

  let restored = 0
  for (const meeting of activeMeetings) {
    if (!meeting.vexaMeetingId || !meeting.vexaNativeMeetingId) {
      logger.warn({ meetingInstanceId: meeting.id }, 'missing vexa IDs, skipping restore')
      continue
    }

    const tokenRows = await prisma.$queryRaw<Array<{ token: string }>>`
      SELECT token FROM public.api_tokens
      WHERE id = ${meeting.creatorApiTokenId}
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `

    if (!tokenRows.length) {
      logger.warn({ meetingInstanceId: meeting.id }, 'creator token expired, marking meeting as ENDED')
      await prisma.meetingInstance.update({
        where: { id: meeting.id },
        data: { status: 'ENDED', endedAt: new Date(), summary: '' },
      })
      continue
    }

    // 殭屍 session 偵測：確認 Vexa 側的 meeting 是否仍 active
    const vexaMeetingRows = await (
      prisma.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM public.meetings WHERE id = ${meeting.vexaMeetingId} LIMIT 1
      `.catch(() => [] as Array<{ status: string }>)
    )

    const vexaStatus = vexaMeetingRows[0]?.status
    if (vexaStatus && vexaStatus !== 'active') {
      logger.warn(
        { meetingInstanceId: meeting.id, vexaStatus },
        'startup: Vexa meeting no longer active, running end-of-meeting cleanup',
      )
      const finalStatus = ['failed', 'needs_help', 'needs_human_help'].includes(vexaStatus)
        ? 'FAILED'
        : 'ENDED'
      await prisma.meetingInstance.update({
        where: { id: meeting.id },
        data: { status: finalStatus, endedAt: new Date() },
      })
      if (finalStatus === 'ENDED') {
        generateSummaryAsync({
          meetingInstanceId: meeting.id,
          platform: 'google_meet',
          nativeMeetingId: meeting.vexaNativeMeetingId!,
          creatorVexaToken: tokenRows[0].token,
          difyDatasetId: meeting.project?.difyDatasetId ?? null,
        })
      }
      continue
    }

    try {
      await createSession(meeting.id, {
        vexaMeetingId: meeting.vexaMeetingId,
        platform: 'google_meet',
        nativeMeetingId: meeting.vexaNativeMeetingId,
        difyDatasetId: meeting.project?.difyDatasetId ?? null,
        creatorVexaToken: tokenRows[0].token,
      })
      restored++
    } catch (err) {
      logger.warn({ err, meetingInstanceId: meeting.id }, 'startup: failed to restore WS session')
    }
  }

  // 階段三：修復 ENDED + summary=null 懸掛
  const SUMMARY_STALE_MINUTES = 10
  const summaryStaleThreshold = new Date(Date.now() - SUMMARY_STALE_MINUTES * 60 * 1000)

  const staleSummaryMeetings = await prisma.meetingInstance.findMany({
    where: { status: 'ENDED', summary: null, endedAt: { lt: summaryStaleThreshold } },
    include: { project: { select: { difyDatasetId: true } } },
  })

  let summaryRetried = 0
  for (const meeting of staleSummaryMeetings) {
    if (!meeting.vexaNativeMeetingId) {
      await prisma.meetingInstance.update({ where: { id: meeting.id }, data: { summary: '' } })
      continue
    }
    const tokenRows = await prisma.$queryRaw<Array<{ token: string }>>`
      SELECT token FROM public.api_tokens
      WHERE id = ${meeting.creatorApiTokenId}
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `
    if (!tokenRows.length) {
      await prisma.meetingInstance.update({ where: { id: meeting.id }, data: { summary: '' } })
      continue
    }
    generateSummaryAsync({
      meetingInstanceId: meeting.id,
      platform: 'google_meet',
      nativeMeetingId: meeting.vexaNativeMeetingId,
      creatorVexaToken: tokenRows[0].token,
      difyDatasetId: meeting.project?.difyDatasetId ?? null,
    })
    summaryRetried++
  }

  logger.info(
    { staleCleaned: staleResult.count, activeRestored: restored, summaryRetried },
    'startup restore completed',
  )
}

