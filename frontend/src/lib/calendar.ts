/**
 * 行事曆的型別與純函式：日期格線計算、共同空檔演算法、重疊佈局。
 *
 * 這一層之後接後端也留著（演算法不變），會被換掉的只有 calendar-mock.ts 的假資料。
 *
 * ⚠️ 時區：目前一律用瀏覽器本機時區的 Date 直接算。spec §5 要求「跨區成員各自顯示
 * 本地時間、所有計算以絕對時間為準」，接後端時這裡要改成 UTC 存 + 各自時區顯示
 * （屆時引入 date-fns-tz；現在為了骨架不先加相依）。
 */

// ── 型別 ──────────────────────────────────────────────────────────────────────

export type RsvpStatus = 'accepted' | 'tentative' | 'declined' | 'pending'

export type SyncState = 'synced' | 'unsynced' | 'expired'

export interface CalendarMember {
  id: string
  name: string
  email: string
  /** GCal 授權狀態：未連結者只看得到專案會議，疊圖上要標「未同步」 */
  syncState: SyncState
}

export interface EventAttendee {
  memberId: string
  rsvp: RsvpStatus
}

export interface CalendarEvent {
  id: string
  /** meeting = 本系統的會議；busy = 從成員 GCal 匯入的忙碌時段 */
  kind: 'meeting' | 'busy'
  title: string
  start: Date
  end: Date
  /** busy 專用：這段忙碌屬於誰 */
  memberId?: string
  /** meeting 專用：與會者與其 RSVP */
  attendees?: EventAttendee[]
  /** 全域層跨專案分色用 */
  projectId?: string
  projectName?: string
  /** 已取消的會議：畫成刪除線樣式，且不佔忙碌判斷 */
  canceled?: boolean
  /** 會議的 Google Meet 連結（GCal 寫回時由 Google 產生） */
  meetUrl?: string
  /** 時間到時自動派蜜塔進去 */
  botAutoJoin?: boolean
}

export interface TimeSlot {
  start: Date
  end: Date
}

// ── 日期工具 ──────────────────────────────────────────────────────────────────

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 一週的起點（週一 00:00）。 */
export function startOfWeek(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  // getDay(): 0=週日 → 位移到週一
  const shift = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - shift)
  return d
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

/** 以某天為基準，取當天的 hh:mm。 */
export function atTime(day: Date, hour: number, minute = 0): Date {
  const d = new Date(day)
  d.setHours(hour, minute, 0, 0)
  return d
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 從當天 00:00 起算的分鐘數（格線定位用）。 */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

export function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} 分鐘`
  if (m === 0) return `${h} 小時`
  return `${h} 小時 ${m} 分`
}

/** 「8月24日 – 8月30日」；跨月才重複月份。 */
export function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6)
  const head = `${weekStart.getMonth() + 1}月${weekStart.getDate()}日`
  const tail =
    weekStart.getMonth() === end.getMonth()
      ? `${end.getDate()}日`
      : `${end.getMonth() + 1}月${end.getDate()}日`
  return `${head} – ${tail}`
}

// ── 區間運算 ──────────────────────────────────────────────────────────────────

/** 合併重疊／相接的區間（輸入不需先排序）。 */
export function mergeIntervals(intervals: TimeSlot[]): TimeSlot[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime())
  const merged: TimeSlot[] = [{ ...sorted[0] }]
  for (const cur of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = cur.end
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

export function overlaps(a: TimeSlot, b: TimeSlot): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()
}

/**
 * 找出所有選定成員都有空的時段。
 *
 * 做法：把所有人的忙碌區間合併成一條「有人忙」的時間軸，再於每天的可排時段
 * （workStartHour~workEndHour）內取補集，最後濾掉短於所需時長的空隙。
 * 回傳的是完整空隙而非切成一格一格 —— UI 要表達的是「這整段都可以」。
 */
export function findCommonSlots(params: {
  busy: TimeSlot[]
  days: Date[]
  workStartHour: number
  workEndHour: number
  durationMin: number
}): TimeSlot[] {
  const { busy, days, workStartHour, workEndHour, durationMin } = params
  const merged = mergeIntervals(busy)
  const slots: TimeSlot[] = []

  for (const day of days) {
    const windowStart = atTime(day, workStartHour)
    const windowEnd = atTime(day, workEndHour)
    let cursor = windowStart

    for (const b of merged) {
      if (b.end <= windowStart || b.start >= windowEnd) continue
      const bStart = b.start < windowStart ? windowStart : b.start
      const bEnd = b.end > windowEnd ? windowEnd : b.end
      if (bStart.getTime() - cursor.getTime() >= durationMin * 60_000) {
        slots.push({ start: cursor, end: bStart })
      }
      if (bEnd > cursor) cursor = bEnd
    }

    if (windowEnd.getTime() - cursor.getTime() >= durationMin * 60_000) {
      slots.push({ start: cursor, end: windowEnd })
    }
  }

  return slots
}

/** 同一位成員自己的兩個事件重疊 → 衝突。回傳所有涉及衝突的 event id。 */
export function detectConflicts(events: CalendarEvent[]): Set<string> {
  const conflicted = new Set<string>()
  const byMember = new Map<string, CalendarEvent[]>()

  for (const e of events) {
    if (e.canceled) continue
    const owners = e.memberId ? [e.memberId] : (e.attendees?.map((a) => a.memberId) ?? [])
    for (const owner of owners) {
      const list = byMember.get(owner) ?? []
      list.push(e)
      byMember.set(owner, list)
    }
  }

  for (const list of byMember.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(list[i], list[j])) {
          conflicted.add(list[i].id)
          conflicted.add(list[j].id)
        }
      }
    }
  }
  return conflicted
}

// ── 同一天內的重疊佈局 ────────────────────────────────────────────────────────

export interface LaidOut<T> {
  item: T
  /** 第幾條並排軌道（0-based） */
  lane: number
  /** 這個重疊叢集共有幾條軌道 */
  laneCount: number
}

/**
 * 把同一天的事件排進並排軌道：先切出互相重疊的叢集，叢集內貪婪配軌道，
 * 同叢集共用同一個 laneCount，寬度才會一致。
 */
export function assignLanes<T extends TimeSlot>(items: T[]): LaidOut<T>[] {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime())
  const result: LaidOut<T>[] = []

  let cluster: LaidOut<T>[] = []
  let clusterEnd = -Infinity
  let laneEnds: number[] = []

  const flush = () => {
    const count = laneEnds.length || 1
    for (const entry of cluster) result.push({ ...entry, laneCount: count })
    cluster = []
    laneEnds = []
    clusterEnd = -Infinity
  }

  for (const item of sorted) {
    if (item.start.getTime() >= clusterEnd) flush()

    let lane = laneEnds.findIndex((end) => end <= item.start.getTime())
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(item.end.getTime())
    } else {
      laneEnds[lane] = item.end.getTime()
    }

    cluster.push({ item, lane, laneCount: 1 })
    clusterEnd = Math.max(clusterEnd, item.end.getTime())
  }
  flush()

  return result
}
