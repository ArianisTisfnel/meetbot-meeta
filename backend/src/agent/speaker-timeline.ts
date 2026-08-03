/**
 * 講者時間軸（回報 2026-07-28 A.4）——「這段話是誰講的？」
 *
 * 問題來源：AGENT_MODE 走 Output Media 網頁單軌**混音**轉錄，OpenAI Realtime 的
 * 轉錄事件沒有講者標記，agent-relay 一律送 `speaker: null`，於是蜜塔回覆時
 * 說不出「👂 收到 XXX 的問題」。這不是語意層的問題，是這條路徑拿不到人名。
 *
 * 解法：Recall 的 `participant_events.speech_on` / `speech_off` webhook 帶
 * `participant.name`，據此在記憶體維護「某段時間誰在講話」，轉錄定稿時反查。
 *
 * ── 兩個實作上的關鍵決定（都與原始構想不同，理由寫在這裡免得日後被「簡化」掉）──
 *
 * ① **用 epoch ms 當座標，不用 Recall 的 `timestamp.relative`。**
 *    relative 的原點是 Recall 的錄製起點，而 agent 的 `elapsedSec()` 原點是
 *    `anchorMs`（admitted 時刻）。兩者不保證同刻，對齊只能靠真會議實測。
 *    改用 epoch 就沒有對齊問題：寫入端用 `timestamp.absolute`（Recall 有給就用），
 *    沒有才退回收到 webhook 的當下時間；讀取端用 `anchorMs + startTime*1000` 換算回 epoch。
 *
 * ② **查詢是「回看一段窗取重疊最大者」，不是點查詢。**
 *    agent-relay 的 segment `startTime` 是**轉錄完成**時取的 `elapsedSec()`，
 *    不是開口時刻（見 handleTranscriptionEvent）。等定稿事件到達時，講者多半
 *    早已 speech_off，點查詢必然落空。故查 [at-lookback, at] 這段窗裡誰講最久。
 *
 * ⚠️ **未經真會議驗證**的部分：webhook 送達延遲、`timestamp.absolute` 是否真的存在、
 *    以及混音轉錄的完成時刻與真實開口時間的落差是否落在 lookback 窗內。
 *    單元測試只測得到本檔的查表邏輯本身。
 */
import { logger } from '../middleware/logger.js'

/** 一段「某人從何時講到何時」。endMs = null 代表還在講（speech_off 未到）。 */
interface SpeakingInterval {
  name: string
  startMs: number
  endMs: number | null
}

/**
 * 反查時往回看的窗長。要涵蓋「一句話的長度＋轉錄完成的延遲」：
 * 一般口語一句 3–8 秒，OpenAI 定稿再落後 1–3 秒，取 15 秒留餘裕。
 * 放太大會讓前一位講者的區間混進來（靠重疊比例擋掉，但不宜依賴）。
 */
export const SPEAKER_LOOKBACK_MS = 15_000

/**
 * 兩人重疊時的棄權門檻：次高重疊超過最高的這個比例 → 判定歧義、回 null。
 * 寧可不標名字，也不要標錯——標錯比不標更傷信任（蜜塔會對著錯的人回話）。
 */
const AMBIGUITY_RATIO = 0.5

/** 每個 bot 保留的區間上限（防無界成長；一場會議正常遠達不到）。 */
const MAX_INTERVALS_PER_BOT = 2_000
/** 早於「現在 - 此值」且已結束的區間直接丟棄。 */
const PRUNE_OLDER_THAN_MS = 10 * 60_000

const timelines = new Map<string, SpeakingInterval[]>()

function getTimeline(botId: string): SpeakingInterval[] {
  let t = timelines.get(botId)
  if (!t) {
    t = []
    timelines.set(botId, t)
  }
  return t
}

/** 某人開口。 */
export function recordSpeechOn(botId: string, name: string, atMs: number): void {
  if (!name) return
  const t = getTimeline(botId)
  // 同一人重複 speech_on 而中間沒有 off（事件重送／漏送）→ 不再開新區間，
  // 否則會累積出一堆同名的開放區間，重疊計算全部重複計數。
  if (t.some((i) => i.name === name && i.endMs === null)) return
  t.push({ name, startMs: atMs, endMs: null })
  prune(t, atMs)
}

/** 某人停口。找不到對應的開放區間就忽略（漏收 speech_on 時的自然情形）。 */
export function recordSpeechOff(botId: string, name: string, atMs: number): void {
  if (!name) return
  const t = timelines.get(botId)
  if (!t) return
  // 由後往前找該人最近的開放區間
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i].name === name && t[i].endMs === null) {
      t[i].endMs = atMs
      return
    }
  }
}

function prune(t: SpeakingInterval[], nowMs: number): void {
  const cutoff = nowMs - PRUNE_OLDER_THAN_MS
  // 只丟「已結束且夠舊」的：還開著的區間不能丟，講很久的人會被誤刪
  let removed = 0
  while (removed < t.length && t[removed].endMs !== null && t[removed].endMs! < cutoff) removed++
  if (removed) t.splice(0, removed)
  if (t.length > MAX_INTERVALS_PER_BOT) t.splice(0, t.length - MAX_INTERVALS_PER_BOT)
}

/**
 * 反查「截至 atMs 的這段窗裡，主要是誰在講話」。
 *
 * @returns 講者名字；無資料或同時發言難以歸屬時回 null（呼叫端維持原本的「未知講者」行為）。
 */
export function resolveSpeakerAt(
  botId: string,
  atMs: number,
  lookbackMs: number = SPEAKER_LOOKBACK_MS,
): string | null {
  const t = timelines.get(botId)
  if (!t?.length) return null

  const windowStart = atMs - lookbackMs
  // 同一人可能在窗內有多段（講講停停）→ 先依名字加總重疊，再比大小
  const overlapByName = new Map<string, number>()
  for (const iv of t) {
    const end = iv.endMs ?? atMs // 還在講 → 算到查詢時刻為止
    const overlap = Math.min(end, atMs) - Math.max(iv.startMs, windowStart)
    if (overlap <= 0) continue
    overlapByName.set(iv.name, (overlapByName.get(iv.name) ?? 0) + overlap)
  }
  if (!overlapByName.size) return null

  const ranked = [...overlapByName.entries()].sort((a, b) => b[1] - a[1])
  const [topName, topOverlap] = ranked[0]
  if (topOverlap <= 0) return null

  const runnerUp = ranked[1]?.[1] ?? 0
  if (runnerUp > topOverlap * AMBIGUITY_RATIO) {
    // 同時發言：硬猜會把問題掛到錯的人頭上
    logger.info(
      { botId, candidates: ranked.slice(0, 3).map(([n, ms]) => `${n}:${ms}ms`) },
      'speaker-timeline: overlapping speakers, attribution ambiguous → unknown',
    )
    return null
  }
  return topName
}

/**
 * 現在有沒有人正在講話？（= 有尚未 speech_off 的區間）
 *
 * 給插話／破冰用，與 {@link resolveSpeakerAt} 的問題不同：那個問「剛才那句是誰講的」，
 * 這個問「此刻可不可以開口」。插話原本靠「多久沒有新逐字稿」推論這輪講完了，
 * 但逐字稿是**落後且成批**到達的（要等 VAD 判定靜音才定稿），於是會在別人換氣、
 * 下一段定稿還沒到的空檔誤判成冷場 → 蜜塔就在人家講到一半時插話。
 * speech_on/off 是即時的，不受轉錄延遲影響。
 *
 * `maxOpenMs` 是保命上限：speech_off 掉了的話，開著的區間會讓蜜塔不敢開口。
 * **原本設 120 秒（理由是「一個人連續講兩分鐘很正常」）——實測 2026-08-03 證明這個
 * 推論站不住腳**：那場會議連續 45 秒沒有任何逐字稿（＝現場是靜的），這裡卻一路回 true，
 * 破冰與插話評估全被擋掉。真正在講話的人會持續產生定稿逐字稿，而逐字稿會重置
 * 破冰／turn 計時器——所以「講很久的人」根本走不到這個檢查；能走到這裡的長開區間，
 * 幾乎都是漏收 speech_off。壞掉的代價（蜜塔全啞）遠大於早放行的代價
 *（＝退回這個檢查存在之前的行為），故取 30 秒。
 * ponytail: 固定窗擋漏收，真要準得靠 Recall 補送或心跳。
 */
export const MAX_OPEN_SPEECH_MS = 30_000

export function isSpeakingNow(botId: string, nowMs: number = Date.now(), maxOpenMs = MAX_OPEN_SPEECH_MS): boolean {
  const t = timelines.get(botId)
  if (!t?.length) return false
  return t.some((iv) => iv.endMs === null && nowMs - iv.startMs < maxOpenMs)
}

/** session 結束時清理（recall-adapter 的 leave 呼叫）。 */
export function clearSpeakerTimeline(botId: string): void {
  timelines.delete(botId)
}

/** 測試用：檢視目前區間（唯讀複本）。 */
export function _peekTimeline(botId: string): SpeakingInterval[] {
  return (timelines.get(botId) ?? []).map((i) => ({ ...i }))
}
