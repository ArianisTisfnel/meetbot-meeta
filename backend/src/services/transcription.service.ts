import { botProvider, type TranscriptSegment } from '../provider/index.js'
import { activeSessions } from '../sessions/session-store.js'

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
  sinceStartTime?: number
  page?: number
  perPage?: number
}): Promise<TranscriptionResult> {
  let all: TranscriptSegment[] = []
  const session = activeSessions.get(params.meetingInstanceId)
  if (session?.botSession) {
    all = await botProvider.getTranscript(session.botSession)
  }

  const filtered =
    params.sinceStartTime !== undefined
      ? all.filter((seg) => seg.startTime >= params.sinceStartTime!)
      : all

  const sorted = [...filtered].sort((a, b) => a.startTime - b.startTime)

  const page = params.page ?? 1
  const perPage = params.perPage ?? 50
  const sliced = sorted.slice((page - 1) * perPage, page * perPage)

  const items = sliced.map((seg) => ({
    text: seg.text,
    speaker: seg.speaker ?? null,
    startTime: seg.startTime,
    endTime: seg.endTime,
    language: seg.language ?? null,
    segmentId: seg.segmentId ?? null,
    createdAt: null,
  }))

  return { items, total: filtered.length, page, perPage }
}
