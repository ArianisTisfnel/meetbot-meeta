/**
 * 純逐字稿正規化函式（無任何環境變數 / 網路依賴，方便單元測試）。
 *
 * 各 provider 的原始 segment 格式都在這裡被 map 成統一的 {@link TranscriptSegment}。
 * 這是整個 failover 任務最容易出 bug 的地方，務必維持純函式並以測試覆蓋。
 */
import type { TranscriptSegment } from './types.js'
import { toTraditional } from '../lib/zh.js'

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

/** CJK（中日韓 + 假名 + 諺文）字元：相鄰時不補空格。 */
function isCJK(ch: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/.test(ch)
}

/**
 * 把 Recall 的 words[] 串成文字。
 * recallai_streaming 會逐詞用空格切開（「蜜 塔 我 想」）；中文字之間補空格會害喚醒詞「蜜塔」
 * 比對失敗，因此：兩側皆非 CJK（純英文詞）才補空格，只要有一側是 CJK 就直接相連。
 */
export function joinRecallWords(words: any[]): string {
  let out = ''
  for (const w of words) {
    const t = (w?.text ?? '').trim()
    if (!t) continue
    if (out.length) {
      const a = out[out.length - 1]
      const b = t[0]
      if (!isCJK(a) && !isCJK(b)) out += ' '
    }
    out += t
  }
  return out
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
  // recallai_streaming 只有通用 zh（無 zh-TW），輸出常混簡體 → 統一轉繁體（台灣用語）。
  const text = toTraditional((data?.text ?? joinRecallWords(words)).trim())
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
 * whisper-service（Breeze-ASR-25 會後重轉錄）的 segment → 統一 schema。
 * Whisper 無 diarization → speaker 一律 null（formatTranscriptAsMarkdown 會顯示「參與者」）。
 * Breeze 原生輸出繁體，但照專案慣例仍過一次 toTraditional（對繁體是 no-op，保險）。
 */
export function normalizeWhisperSegments(
  raw: Array<{ text: string; start: number; end: number }>,
): TranscriptSegment[] {
  if (!Array.isArray(raw)) return []
  const out: TranscriptSegment[] = []
  raw.forEach((seg, idx) => {
    const text = toTraditional((seg?.text ?? '').trim())
    if (!text) return
    const startTime = typeof seg.start === 'number' && !Number.isNaN(seg.start) ? seg.start : 0
    const endTime = typeof seg.end === 'number' && !Number.isNaN(seg.end) ? seg.end : startTime
    out.push({
      segmentId: `whisper-${idx}`,
      text,
      speaker: null,
      startTime,
      endTime,
      language: null,
    })
  })
  return out
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
    const text = toTraditional((entry?.text ?? joinRecallWords(words)).trim())
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
