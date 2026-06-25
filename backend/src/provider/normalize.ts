/**
 * 純逐字稿正規化函式（無任何環境變數 / 網路依賴，方便單元測試）。
 *
 * 各 provider 的原始 segment 格式都在這裡被 map 成統一的 {@link TranscriptSegment}。
 * 這是整個 failover 任務最容易出 bug 的地方，務必維持純函式並以測試覆蓋。
 */
import type { TranscriptSegment } from './types.js'

/**
 * Vexa WS 推送的 segment → 統一 schema。
 * Vexa WS 欄位為 start/end（或舊版 start_time/end_time），speaker 可能在 seg 或外層 msg。
 */
export function normalizeVexaWsSegment(seg: any, msgSpeaker?: string): TranscriptSegment {
  return {
    segmentId: seg.segment_id ?? null,
    text: seg.text ?? '',
    speaker: seg.speaker || msgSpeaker || null,
    startTime: seg.start ?? seg.start_time ?? 0,
    endTime: seg.end ?? seg.end_time ?? 0,
    language: seg.language ?? null,
  }
}

/**
 * Vexa REST API 的 segment → 統一 schema。
 * REST 欄位為 start/end（Pydantic alias），非 start_time/end_time。
 */
export function normalizeVexaRestSegment(seg: any): TranscriptSegment {
  return {
    segmentId: seg.segment_id ?? null,
    text: seg.text ?? '',
    speaker: seg.speaker ?? null,
    startTime: seg.start ?? 0,
    endTime: seg.end ?? 0,
    language: seg.language ?? null,
  }
}

function firstNum(candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && !Number.isNaN(c)) return c
  }
  return undefined
}

/**
 * Recall realtime webhook 的單一 `transcript.data` utterance → 統一 schema。
 * payload 形狀：{ words:[{text,start_timestamp:{relative},end_timestamp:{relative}}], participant:{id,name}, language_code }
 * `transcriptId` 用於合成 segmentId（wake-word handler 會略過無 segmentId 者）。
 */
export function normalizeRecallRealtimeUtterance(
  data: any,
  transcriptId?: string,
): TranscriptSegment | null {
  const words: any[] = data?.words ?? []
  const text = (data?.text ?? words.map((w) => w?.text ?? '').join(' ')).trim()
  if (!text) return null

  const startTime = firstNum([words[0]?.start_timestamp?.relative, words[0]?.start_time, data?.start_time]) ?? 0
  const endTime =
    firstNum([
      words[words.length - 1]?.end_timestamp?.relative,
      words[words.length - 1]?.end_time,
      data?.end_time,
    ]) ?? startTime

  return {
    segmentId: `${transcriptId ?? 'rt'}-${startTime}-${endTime}`,
    text,
    speaker: data?.participant?.name ?? data?.speaker ?? null,
    startTime,
    endTime,
    language: data?.language_code ?? data?.language ?? null,
  }
}

/**
 * Recall transcript（speaker + words[]）→ 統一 schema。
 * 每個 speaker 區塊（含 words[]）成為一個 segment：text = words 串接、
 * startTime/endTime 取 words 的首/尾相對時間戳。
 */
export function normalizeRecallTranscript(raw: any[]): TranscriptSegment[] {
  if (!Array.isArray(raw)) return []
  const out: TranscriptSegment[] = []

  raw.forEach((entry, idx) => {
    const words: any[] = entry?.words ?? []
    const text = (entry?.text ?? words.map((w) => w?.text ?? '').join(' ')).trim()
    if (!text) return

    const startTime =
      firstNum([
        entry?.start_timestamp?.relative,
        entry?.start_time,
        words[0]?.start_timestamp?.relative,
        words[0]?.start_time,
      ]) ?? 0
    const endTime =
      firstNum([
        entry?.end_timestamp?.relative,
        entry?.end_time,
        words[words.length - 1]?.end_timestamp?.relative,
        words[words.length - 1]?.end_time,
      ]) ?? startTime

    out.push({
      segmentId: entry?.id != null ? String(entry.id) : `recall-${idx}-${startTime}`,
      text,
      speaker: entry?.speaker ?? entry?.participant?.name ?? null,
      startTime,
      endTime,
      language: entry?.language ?? null,
    })
  })

  return out
}
