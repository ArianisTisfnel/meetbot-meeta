/**
 * 行事曆骨架的假資料 —— 這整個檔案在接上後端後會刪掉。
 *
 * 資料以「本週週一」為基準動態生成，所以不管哪天打開都看得到內容。
 * 刻意鋪了幾個 spec 點名要處理的狀態：未同步成員、授權失效、已取消會議、
 * 同一人時段衝突、RSVP 未回覆，讓這些樣式在畫面上真的看得到。
 */

import {
  addDays,
  atTime,
  startOfWeek,
  type CalendarEvent,
  type CalendarMember,
} from './calendar'

export interface MockProject {
  id: string
  name: string
}

/** 全域層跨專案分色用；顏色順序與成員色共用同一套規則（見 calendar-colors.ts）。 */
export const MOCK_PROJECTS: MockProject[] = [
  { id: 'p1', name: '蜜塔改版' },
  { id: 'p2', name: '客戶 A 導入' },
  { id: 'p3', name: '年度營運計畫' },
]

export const MOCK_MEMBERS: CalendarMember[] = [
  { id: 'm1', name: '陳彥廷', email: 'yanting@example.com', syncState: 'synced' },
  { id: 'm2', name: '林郁婷', email: 'yuting@example.com', syncState: 'synced' },
  { id: 'm3', name: 'Kevin Wu', email: 'kevin@example.com', syncState: 'synced' },
  { id: 'm4', name: '蘇怡安', email: 'yian@example.com', syncState: 'unsynced' },
  { id: 'm5', name: '張哲瑋', email: 'chewei@example.com', syncState: 'expired' },
]

/** 相對本週週一的第 n 天、hh:mm ~ hh:mm。 */
function span(dayOffset: number, from: [number, number], to: [number, number]) {
  const day = addDays(startOfWeek(new Date()), dayOffset)
  return { start: atTime(day, from[0], from[1]), end: atTime(day, to[0], to[1]) }
}

let seq = 0
function busy(
  memberId: string,
  title: string,
  dayOffset: number,
  from: [number, number],
  to: [number, number],
): CalendarEvent {
  return { id: `b${++seq}`, kind: 'busy', memberId, title, ...span(dayOffset, from, to) }
}

function meeting(
  title: string,
  dayOffset: number,
  from: [number, number],
  to: [number, number],
  attendees: CalendarEvent['attendees'],
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id: `e${++seq}`,
    kind: 'meeting',
    title,
    attendees,
    projectId: 'p1',
    projectName: '蜜塔改版',
    ...span(dayOffset, from, to),
    ...extra,
  }
}

/** 專案層：專案會議 + 各成員的 GCal 忙碌時段疊圖。 */
export const MOCK_PROJECT_EVENTS: CalendarEvent[] = [
  // ── 週一 ──
  busy('m2', '1:1 與主管', 0, [9, 0], [10, 30]),
  busy('m3', 'Focus time', 0, [11, 0], [12, 0]),
  busy('m1', '產品需求討論', 0, [14, 0], [15, 0]),

  // ── 週二：本週主要的專案會議，RSVP 尚未收齊 ──
  meeting('Sprint 規劃會議', 1, [10, 0], [11, 30], [
    { memberId: 'm1', rsvp: 'accepted' },
    { memberId: 'm2', rsvp: 'accepted' },
    { memberId: 'm3', rsvp: 'tentative' },
    { memberId: 'm4', rsvp: 'pending' },
    { memberId: 'm5', rsvp: 'declined' },
  ], { location: 'Google Meet' }),
  busy('m5', '外部訪談', 1, [15, 0], [16, 0]),

  // ── 週三：同一人兩個事件重疊 → 衝突標記 ──
  busy('m1', '技術評估', 2, [9, 30], [10, 30]),
  busy('m1', '面試（重疊）', 2, [10, 0], [11, 0]),
  busy('m2', '客戶電話', 2, [9, 0], [11, 0]),
  busy('m3', '文件撰寫', 2, [13, 0], [14, 30]),

  // ── 週四 ──
  meeting('設計評審', 3, [15, 0], [16, 0], [
    { memberId: 'm1', rsvp: 'accepted' },
    { memberId: 'm2', rsvp: 'pending' },
    { memberId: 'm3', rsvp: 'accepted' },
  ]),
  busy('m3', '客戶 A 專案', 3, [9, 0], [12, 0]),

  // ── 週五：已取消的會議不佔忙碌判斷 ──
  meeting('每週同步（已取消）', 4, [10, 0], [11, 0], [
    { memberId: 'm1', rsvp: 'accepted' },
    { memberId: 'm2', rsvp: 'accepted' },
  ], { canceled: true }),
  busy('m2', '外部拜訪', 4, [13, 0], [17, 0]),
]

/** 全域層：跨專案的個人行程總覽（只有「我」參與的會議，不含別人的忙碌）。 */
export const MOCK_GLOBAL_EVENTS: CalendarEvent[] = [
  meeting('Sprint 規劃會議', 1, [10, 0], [11, 30], [{ memberId: 'm1', rsvp: 'accepted' }]),
  meeting('設計評審', 3, [15, 0], [16, 0], [{ memberId: 'm1', rsvp: 'accepted' }]),
  {
    ...meeting('客戶 A 週會', 0, [16, 0], [17, 0], [{ memberId: 'm1', rsvp: 'pending' }]),
    projectId: 'p2',
    projectName: '客戶 A 導入',
  },
  {
    ...meeting('導入教育訓練', 2, [14, 0], [16, 0], [{ memberId: 'm1', rsvp: 'accepted' }]),
    projectId: 'p2',
    projectName: '客戶 A 導入',
  },
  {
    ...meeting('年度預算審查', 4, [9, 30], [11, 0], [{ memberId: 'm1', rsvp: 'tentative' }]),
    projectId: 'p3',
    projectName: '年度營運計畫',
  },
  // 個人 GCal 事件（全域層才有）
  busy('m1', '牙醫（個人行程）', 3, [11, 0], [12, 0]),
]
