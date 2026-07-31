import { logger } from '../middleware/logger.js'

/**
 * Recall `audio_separate_raw` 探針 —— 「耳朵與嘴巴分家」的可行性驗證。
 *
 * 目的不是要用這些音訊做轉錄，而是**開一場會就回答三個問題**：
 *   ① 每個與會者是不是真的分成獨立音軌（而不是又一條混音）
 *   ② 蜜塔自己有沒有一條音軌？如果有，她的 participant id / name 是什麼
 *      —— 這決定「濾掉自己」是靠身分（可靠）還是靠音訊內容（就是現在的靜音窗）
 *   ③ 沒在講話的人是不是送空封包（決定 server_vad 能不能在每條音軌上正常斷句）
 *
 * 只統計、只寫 log，**不轉錄、不影響任何現有路徑**。
 * 由 RECALL_SEPARATE_AUDIO=on 開啟；關閉時 join payload 完全不變。
 *
 * 音訊格式（Recall 文件）：mono 16-bit signed little-endian PCM @ 16kHz。
 * 注意與 Output Media 網頁那條（24kHz）不同——之後真的要接轉錄時要留意取樣率。
 */

/** 低於這個振幅的封包視為「靜音封包」（16-bit PCM 的絕對值平均）。 */
const SILENCE_RMS_THRESHOLD = 60
/** 統計摘要的輸出間隔。 */
const SUMMARY_INTERVAL_MS = 10_000

export interface ParticipantAudioStat {
  participantId: string
  name: string
  packets: number
  bytes: number
  /** 有實際聲音的封包數（非靜音）。 */
  voicedPackets: number
  firstAt: number
  lastAt: number
}

export interface ProbeState {
  botName: string
  stats: Map<string, ParticipantAudioStat>
  lastSummaryAt: number
  totalMessages: number
  /** 解析不出 participant 的訊息數（格式與預期不符的警訊）。 */
  malformed: number
}

export function createProbeState(botName: string): ProbeState {
  return { botName, stats: new Map(), lastSummaryAt: Date.now(), totalMessages: 0, malformed: 0 }
}

/** PCM16LE 的平均絕對振幅；用來分辨「空封包」與「有人在講話」。 */
export function averageAmplitude(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) return 0
  let total = 0
  for (let i = 0; i < samples; i++) total += Math.abs(pcm.readInt16LE(i * 2))
  return total / samples
}

/**
 * 吃一則 websocket 訊息，累積統計（純函式，匯出供測試）。
 * 回傳 true = 這則是我們要的 audio_separate_raw 資料。
 */
export function ingestProbeMessage(state: ProbeState, raw: string): boolean {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    state.malformed++
    return false
  }

  if (msg?.event !== 'audio_separate_raw.data') return false
  state.totalMessages++

  const payload = msg?.data?.data
  const participant = payload?.participant
  const id = participant?.id
  const name: string = participant?.name ?? ''
  if (id === undefined || id === null) {
    state.malformed++
    return false
  }

  const key = String(id)
  let stat = state.stats.get(key)
  if (!stat) {
    stat = {
      participantId: key,
      name: name || '(無名)',
      packets: 0,
      bytes: 0,
      voicedPackets: 0,
      firstAt: Date.now(),
      lastAt: Date.now(),
    }
    state.stats.set(key, stat)
    logger.info(
      { participantId: key, name, isBotName: name.trim() === state.botName.trim() },
      'audio probe: 首次收到此與會者的音訊（← 若 isBotName 為 true，代表蜜塔自己也有一條音軌）',
    )
  }

  const b64: string = payload?.buffer ?? ''
  const pcm = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0)
  stat.packets++
  stat.bytes += pcm.length
  if (pcm.length > 0 && averageAmplitude(pcm) > SILENCE_RMS_THRESHOLD) stat.voicedPackets++
  stat.lastAt = Date.now()
  if (name && stat.name === '(無名)') stat.name = name

  return true
}

/** 到時間就輸出一次摘要（呼叫端每則訊息後呼叫即可）。 */
export function maybeLogSummary(state: ProbeState, force = false): void {
  const now = Date.now()
  if (!force && now - state.lastSummaryAt < SUMMARY_INTERVAL_MS) return
  state.lastSummaryAt = now
  if (state.stats.size === 0) return

  const rows = [...state.stats.values()].map((s) => ({
    participantId: s.participantId,
    name: s.name,
    isBot: s.name.trim() === state.botName.trim(),
    packets: s.packets,
    kb: Math.round(s.bytes / 1024),
    voicedPackets: s.voicedPackets,
    // 靜音封包比例高 = 這條音軌在該人沒講話時是安靜的 → server_vad 可正常斷句
    silentRatio: s.packets ? Number(((s.packets - s.voicedPackets) / s.packets).toFixed(2)) : 0,
  }))

  logger.info(
    { participants: rows.length, malformed: state.malformed, rows },
    'audio probe: 每位與會者的獨立音軌統計',
  )
}
