import { botProvider, type TranscriptSegment } from '../provider/index.js'
import { activeSessions } from '../sessions/session-store.js'
import { logger } from '../middleware/logger.js'

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
  // 逐字稿只存在於記憶體中的 bot session（Recall 不提供會後重抓的 REST 路徑，
  // 我們自己也還沒把 segment 落 DB）。session 不在＝會議已結束或後端重啟過，
  // 此時只能回空陣列——但**不要靜默**：呼叫端與前端無從分辨「這場沒人講話」
  // 和「逐字稿已經拿不到了」，沒有這行 log 就只剩「畫面空白、無人知道為什麼」。
  // 根治要讓 segment 落 DB，見 docs/13-系統現況與路線圖.md。
  let all: TranscriptSegment[] = []
  const session = activeSessions.get(params.meetingInstanceId)
  if (session?.botSession) {
    all = await botProvider.getTranscript(session.botSession)
  } else {
    logger.warn(
      { meetingInstanceId: params.meetingInstanceId },
      'getTranscriptions: no live bot session (meeting ended or backend restarted) → returning empty transcript',
    )
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
