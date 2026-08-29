/**
 * 共同空檔計算：純函式，不碰 DB，好測。
 *
 * 所有輸入輸出一律是 UTC 的 Date（絕對時間）——spec §5 要求「跨區成員各自顯示本地
 * 時間、所有計算以絕對時間為準」，所以這裡不做任何「當地幾點」的推測。
 *
 * 「可排時段是每天 09:00–18:00」這種說法本身帶時區，因此由呼叫端傳入
 * tzOffsetMinutes（瀏覽器的 Date.getTimezoneOffset() 反號）把它換算成絕對時間。
 *
 * ⚠️ 已知限制：用單一固定偏移量代表一個時區，跨日光節約時間切換的那一週會偏一小時。
 * 台灣沒有 DST 所以現階段無感；要支援有 DST 的地區得改用 IANA 時區函式庫
 * （luxon / date-fns-tz），屆時只需要換掉 dayWindows() 這一個函式。
 */

export interface Interval {
  start: Date
  end: Date
}

/** 合併重疊或相接的區間。輸入不需先排序；不修改輸入。 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime())
  const merged: Interval[] = [{ start: sorted[0].start, end: sorted[0].end }]

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const last = merged[merged.length - 1]
    if (cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = cur.end
    } else {
      merged.push({ start: cur.start, end: cur.end })
    }
  }
  return merged
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()
}

export interface FreeSlotParams {
  /** 所有選定成員的忙碌區間（UTC，不需先合併） */
  busy: Interval[]
  /** 搜尋範圍（UTC） */
  from: Date
  to: Date
  /** 所需會議時長（分鐘） */
  durationMin: number
  /** 使用者時區相對 UTC 的偏移分鐘數（東八區 = +480） */
  tzOffsetMinutes: number
  /** 每天可排會議的起訖「當地小時」 */
  workStartHour: number
  workEndHour: number
  /** 是否納入週六日（依當地日期判斷） */
  includeWeekends: boolean
}

/**
 * 把搜尋範圍切成「每天的可排視窗」，回傳 UTC 區間。
 *
 * 做法：把 UTC 時刻加上偏移量得到「當地時鐘」，在當地時鐘上取整天與時分，
 * 再減回偏移量還原成 UTC。這樣不必依賴伺服器本機時區（伺服器可能跑在 UTC）。
 */
function dayWindows(params: {
  from: Date
  to: Date
  tzOffsetMinutes: number
  workStartHour: number
  workEndHour: number
  includeWeekends: boolean
}): Interval[] {
  const { from, to, tzOffsetMinutes, workStartHour, workEndHour, includeWeekends } = params
  const offsetMs = tzOffsetMinutes * 60_000
  const DAY_MS = 86_400_000

  // 當地時鐘上的第一天 00:00（以 UTC 紀元毫秒表示的「當地日」起點）
  const localFrom = from.getTime() + offsetMs
  let localDayStart = Math.floor(localFrom / DAY_MS) * DAY_MS

  const windows: Interval[] = []
  const localTo = to.getTime() + offsetMs

  while (localDayStart < localTo) {
    // 1970-01-01 是週四 → 換算成 0=週日 的星期值
    const weekday = (Math.floor(localDayStart / DAY_MS) + 4) % 7
    const isWeekend = weekday === 0 || weekday === 6

    if (includeWeekends || !isWeekend) {
      const localStart = localDayStart + workStartHour * 3_600_000
      const localEnd = localDayStart + workEndHour * 3_600_000
      // 夾回搜尋範圍，再還原成 UTC
      const start = Math.max(localStart, localFrom) - offsetMs
      const end = Math.min(localEnd, localTo) - offsetMs
      if (end > start) windows.push({ start: new Date(start), end: new Date(end) })
    }
    localDayStart += DAY_MS
  }
  return windows
}

/**
 * 找出所有人都有空、且長度足夠的時段。
 *
 * 回傳完整空隙而不是切成一格一格的候選——UI 要表達的是「這整段都可以」，
 * 使用者自己決定要用其中哪一段。
 */
export function findFreeSlots(params: FreeSlotParams): Interval[] {
  const { busy, durationMin } = params
  const durationMs = durationMin * 60_000
  const merged = mergeIntervals(busy)
  const slots: Interval[] = []

  for (const window of dayWindows(params)) {
    let cursor = window.start.getTime()
    const windowEnd = window.end.getTime()

    for (const block of merged) {
      const blockStart = block.start.getTime()
      const blockEnd = block.end.getTime()
      if (blockEnd <= cursor || blockStart >= windowEnd) continue

      if (blockStart - cursor >= durationMs) {
        slots.push({ start: new Date(cursor), end: new Date(blockStart) })
      }
      if (blockEnd > cursor) cursor = blockEnd
    }

    if (windowEnd - cursor >= durationMs) {
      slots.push({ start: new Date(cursor), end: new Date(windowEnd) })
    }
  }

  return slots
}

/** 同一個人的兩個事件重疊 → 衝突。回傳涉及衝突的事件 id。 */
export function detectConflicts<T extends Interval & { id: string }>(
  eventsByUser: Map<number, T[]>,
): Set<string> {
  const conflicted = new Set<string>()
  for (const events of eventsByUser.values()) {
    const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime())
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        // 已排序：後者起點若不早於前者終點，後面的更不可能重疊
        if (sorted[j].start.getTime() >= sorted[i].end.getTime()) break
        conflicted.add(sorted[i].id)
        conflicted.add(sorted[j].id)
      }
    }
  }
  return conflicted
}
