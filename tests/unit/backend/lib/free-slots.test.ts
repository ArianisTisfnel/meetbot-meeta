import { describe, it, expect } from 'vitest'
import {
  mergeIntervals,
  overlaps,
  findFreeSlots,
  detectConflicts,
} from '../../../../backend/src/lib/free-slots'

/**
 * 測試一律用 UTC 明寫時間，並把時區偏移當參數傳。
 * 這樣測試不會因為跑測試的機器在哪一區而改變結果——這正是 free-slots
 * 刻意不讀伺服器本機時區的原因。
 */
const TAIPEI = 480 // 東八區，+480 分鐘

/** 台北時間 → UTC Date。 */
function tpe(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, day, hour - 8, minute))
}

describe('mergeIntervals', () => {
  it('合併重疊的區間', () => {
    const merged = mergeIntervals([
      { start: tpe(1, 9), end: tpe(1, 11) },
      { start: tpe(1, 10), end: tpe(1, 12) },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].start).toEqual(tpe(1, 9))
    expect(merged[0].end).toEqual(tpe(1, 12))
  })

  it('合併剛好相接的區間（10:00 結束、10:00 開始）', () => {
    const merged = mergeIntervals([
      { start: tpe(1, 9), end: tpe(1, 10) },
      { start: tpe(1, 10), end: tpe(1, 11) },
    ])
    expect(merged).toHaveLength(1)
  })

  it('不合併有間隔的區間，且不因輸入順序而異', () => {
    const merged = mergeIntervals([
      { start: tpe(1, 14), end: tpe(1, 15) },
      { start: tpe(1, 9), end: tpe(1, 10) },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0].start).toEqual(tpe(1, 9))
  })

  it('不修改輸入陣列', () => {
    const input = [
      { start: tpe(1, 9), end: tpe(1, 11) },
      { start: tpe(1, 10), end: tpe(1, 12) },
    ]
    const snapshot = input.map((i) => ({ start: i.start, end: i.end }))
    mergeIntervals(input)
    expect(input).toEqual(snapshot)
  })

  it('空輸入回空陣列', () => {
    expect(mergeIntervals([])).toEqual([])
  })
})

describe('overlaps', () => {
  it('相接不算重疊', () => {
    expect(
      overlaps({ start: tpe(1, 9), end: tpe(1, 10) }, { start: tpe(1, 10), end: tpe(1, 11) }),
    ).toBe(false)
  })

  it('部分重疊算重疊', () => {
    expect(
      overlaps({ start: tpe(1, 9), end: tpe(1, 11) }, { start: tpe(1, 10), end: tpe(1, 12) }),
    ).toBe(true)
  })
})

describe('findFreeSlots', () => {
  // 2026-09-01 是週二
  const baseParams = {
    from: tpe(1, 0),
    to: tpe(2, 0),
    tzOffsetMinutes: TAIPEI,
    workStartHour: 9,
    workEndHour: 18,
    includeWeekends: false,
  }

  it('沒有任何忙碌時，整個可排時段就是一個空檔', () => {
    const slots = findFreeSlots({ ...baseParams, busy: [], durationMin: 60 })
    expect(slots).toHaveLength(1)
    expect(slots[0].start).toEqual(tpe(1, 9))
    expect(slots[0].end).toEqual(tpe(1, 18))
  })

  it('忙碌時段會把可排區間切開', () => {
    const slots = findFreeSlots({
      ...baseParams,
      busy: [{ start: tpe(1, 12), end: tpe(1, 13) }],
      durationMin: 60,
    })
    expect(slots).toHaveLength(2)
    expect(slots[0]).toEqual({ start: tpe(1, 9), end: tpe(1, 12) })
    expect(slots[1]).toEqual({ start: tpe(1, 13), end: tpe(1, 18) })
  })

  it('短於所需時長的空隙不列入', () => {
    const slots = findFreeSlots({
      ...baseParams,
      busy: [
        { start: tpe(1, 9), end: tpe(1, 12) },
        // 只留 30 分鐘
        { start: tpe(1, 12, 30), end: tpe(1, 18) },
      ],
      durationMin: 60,
    })
    expect(slots).toHaveLength(0)
  })

  it('剛好等於所需時長的空隙要列入（邊界含等號）', () => {
    const slots = findFreeSlots({
      ...baseParams,
      busy: [
        { start: tpe(1, 9), end: tpe(1, 12) },
        { start: tpe(1, 13), end: tpe(1, 18) },
      ],
      durationMin: 60,
    })
    expect(slots).toEqual([{ start: tpe(1, 12), end: tpe(1, 13) }])
  })

  it('至少一人忙碌的時段不會被列為共同空檔（spec §4.3 驗收）', () => {
    // A 忙 10–11，B 忙 14–15：兩段都不能出現在結果裡
    const slots = findFreeSlots({
      ...baseParams,
      busy: [
        { start: tpe(1, 10), end: tpe(1, 11) },
        { start: tpe(1, 14), end: tpe(1, 15) },
      ],
      durationMin: 30,
    })
    for (const slot of slots) {
      expect(overlaps(slot, { start: tpe(1, 10), end: tpe(1, 11) })).toBe(false)
      expect(overlaps(slot, { start: tpe(1, 14), end: tpe(1, 15) })).toBe(false)
    }
    expect(slots).toHaveLength(3)
  })

  it('重疊的忙碌區間只會被扣掉一次', () => {
    const slots = findFreeSlots({
      ...baseParams,
      busy: [
        { start: tpe(1, 10), end: tpe(1, 12) },
        { start: tpe(1, 11), end: tpe(1, 13) },
      ],
      durationMin: 30,
    })
    expect(slots).toEqual([
      { start: tpe(1, 9), end: tpe(1, 10) },
      { start: tpe(1, 13), end: tpe(1, 18) },
    ])
  })

  it('可排時段外的忙碌（下班後）不影響結果', () => {
    const slots = findFreeSlots({
      ...baseParams,
      busy: [{ start: tpe(1, 20), end: tpe(1, 22) }],
      durationMin: 60,
    })
    expect(slots).toEqual([{ start: tpe(1, 9), end: tpe(1, 18) }])
  })

  it('跨越上班時間邊界的忙碌只扣掉落在可排時段內的部分', () => {
    const slots = findFreeSlots({
      ...baseParams,
      busy: [{ start: tpe(1, 7), end: tpe(1, 10) }],
      durationMin: 60,
    })
    expect(slots).toEqual([{ start: tpe(1, 10), end: tpe(1, 18) }])
  })

  it('多天查詢會逐日切出可排視窗，不會跨夜連在一起', () => {
    const slots = findFreeSlots({
      ...baseParams,
      to: tpe(3, 0), // 週二 + 週三
      busy: [],
      durationMin: 60,
    })
    expect(slots).toEqual([
      { start: tpe(1, 9), end: tpe(1, 18) },
      { start: tpe(2, 9), end: tpe(2, 18) },
    ])
  })

  it('預設跳過週六日', () => {
    // 2026-09-05 是週六、09-06 是週日
    const slots = findFreeSlots({
      ...baseParams,
      from: tpe(5, 0),
      to: tpe(7, 0),
      busy: [],
      durationMin: 60,
    })
    expect(slots).toHaveLength(0)
  })

  it('includeWeekends 開啟時才納入週末', () => {
    const slots = findFreeSlots({
      ...baseParams,
      from: tpe(5, 0),
      to: tpe(7, 0),
      busy: [],
      durationMin: 60,
      includeWeekends: true,
    })
    expect(slots).toHaveLength(2)
  })

  it('可排視窗會被搜尋範圍夾住（從中午開始查就不會回到早上九點）', () => {
    const slots = findFreeSlots({
      ...baseParams,
      from: tpe(1, 12),
      busy: [],
      durationMin: 60,
    })
    expect(slots).toEqual([{ start: tpe(1, 12), end: tpe(1, 18) }])
  })

  it('時區偏移決定「上班時間」落在哪一段絕對時間', () => {
    // 同一段搜尋範圍（整個 2026-09-01 UTC 日），只換時區偏移
    const range = {
      from: new Date(Date.UTC(2026, 8, 1, 0)),
      to: new Date(Date.UTC(2026, 8, 2, 0)),
    }

    const utc = findFreeSlots({
      ...baseParams,
      ...range,
      tzOffsetMinutes: 0,
      busy: [],
      durationMin: 60,
    })
    expect(utc).toEqual([
      { start: new Date(Date.UTC(2026, 8, 1, 9)), end: new Date(Date.UTC(2026, 8, 1, 18)) },
    ])

    // 台北的 09:00–18:00 就是 UTC 的 01:00–10:00
    const taipei = findFreeSlots({
      ...baseParams,
      ...range,
      tzOffsetMinutes: TAIPEI,
      busy: [],
      durationMin: 60,
    })
    expect(taipei).toEqual([
      { start: new Date(Date.UTC(2026, 8, 1, 1)), end: new Date(Date.UTC(2026, 8, 1, 10)) },
    ])
  })
})

describe('detectConflicts', () => {
  it('同一人兩事件重疊 → 兩者都標為衝突', () => {
    const conflicts = detectConflicts(
      new Map([
        [
          1,
          [
            { id: 'a', start: tpe(1, 9, 30), end: tpe(1, 10, 30) },
            { id: 'b', start: tpe(1, 10), end: tpe(1, 11) },
          ],
        ],
      ]),
    )
    expect(conflicts).toEqual(new Set(['a', 'b']))
  })

  it('不同人的事件重疊不算衝突', () => {
    const conflicts = detectConflicts(
      new Map([
        [1, [{ id: 'a', start: tpe(1, 9), end: tpe(1, 11) }]],
        [2, [{ id: 'b', start: tpe(1, 10), end: tpe(1, 12) }]],
      ]),
    )
    expect(conflicts.size).toBe(0)
  })

  it('同一人相接但不重疊的事件不算衝突', () => {
    const conflicts = detectConflicts(
      new Map([
        [
          1,
          [
            { id: 'a', start: tpe(1, 9), end: tpe(1, 10) },
            { id: 'b', start: tpe(1, 10), end: tpe(1, 11) },
          ],
        ],
      ]),
    )
    expect(conflicts.size).toBe(0)
  })

  it('三個事件互相重疊時全部標記', () => {
    const conflicts = detectConflicts(
      new Map([
        [
          1,
          [
            { id: 'a', start: tpe(1, 9), end: tpe(1, 12) },
            { id: 'b', start: tpe(1, 10), end: tpe(1, 11) },
            { id: 'c', start: tpe(1, 11, 30), end: tpe(1, 13) },
          ],
        ],
      ]),
    )
    expect(conflicts).toEqual(new Set(['a', 'b', 'c']))
  })
})
