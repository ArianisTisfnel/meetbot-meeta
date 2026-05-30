import { prisma } from '../lib/prisma.js'
import * as vexaClient from '../lib/vexa.js'
import { AppError } from '../middleware/error-handler.js'
import { activeSessions } from '../sessions/session-store.js'

/**
 * 取得呼叫 Vexa transcription API 所需的 creatorVexaToken。
 * ACTIVE 時從記憶體取（O(1)）；ENDED/FAILED 時查 DB（Session 已清除）。
 */
async function resolveCreatorToken(
  meetingInstanceId: string,
  creatorApiTokenId: number,
): Promise<string | null> {
  // 優先從記憶體活躍 Session 取得
  const session = activeSessions.get(meetingInstanceId)
  if (session) return session.creatorVexaToken

  // Session 已消失：查 DB
  const rows = await prisma.$queryRaw<Array<{ token: string }>>`
    SELECT token FROM public.api_tokens
    WHERE id = ${creatorApiTokenId}
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `
  return rows[0]?.token ?? null
}

export type TranscriptionResult = {
  items: Array<{
    text: string
    speaker: string | null
    startTime: number
    endTime: number
    language: string | null
    segmentId: string | null
    createdAt: string | null
  }>
  total: number
  page: number
  perPage: number
}

export async function getTranscriptions(params: {
  meetingInstanceId: string
  creatorApiTokenId: number
  platform: string
  vexaNativeMeetingId: string
  sinceStartTime?: number
  page?: number
  perPage?: number
}): Promise<TranscriptionResult> {
  const token = await resolveCreatorToken(params.meetingInstanceId, params.creatorApiTokenId)
  if (!token) {
    throw new AppError(
      'CREATOR_TOKEN_UNAVAILABLE',
      503,
      '邀請者的 token 已過期，無法取得逐字稿',
    )
  }

  // 取全量逐字稿，在記憶體中 filter
  const all = await vexaClient.getTranscriptions(params.platform, params.vexaNativeMeetingId, token)

  // 使用 >= 確保邊界 segment 包含在內
  const filtered =
    params.sinceStartTime !== undefined
      ? all.filter((seg) => seg.start >= params.sinceStartTime!)
      : all

  // 依 startTime 排序
  const sorted = [...filtered].sort((a, b) => a.start - b.start)

  const page = params.page ?? 1
  const perPage = params.perPage ?? 50
  const sliced = sorted.slice((page - 1) * perPage, page * perPage)

  // 欄位映射：start/end → startTime/endTime（camelCase）
  const items = sliced.map((seg) => ({
    text: seg.text,
    speaker: seg.speaker ?? null,
    startTime: seg.start,
    endTime: seg.end,
    language: seg.language ?? null,
    segmentId: seg.segment_id ?? null,
    createdAt: (seg as any).created_at ?? null,
  }))

  return { items, total: filtered.length, page, perPage }
}
