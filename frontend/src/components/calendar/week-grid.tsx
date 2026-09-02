'use client'
import { useEffect, useState } from 'react'
import {
  WEEKDAY_LABELS,
  addDays,
  assignLanes,
  formatDuration,
  formatTime,
  isSameDay,
  minutesOfDay,
  type CalendarEvent,
  type TimeSlot,
} from '@/lib/calendar'
import { CONFLICT_COLOR, tint } from '@/lib/calendar-colors'
import { cn } from '@/lib/utils'

/** 顯示的時間範圍與一小時的高度（px）。 */
const DAY_START_HOUR = 8
const DAY_END_HOUR = 21
const HOUR_HEIGHT = 56
const GUTTER_WIDTH = 52

const BODY_HEIGHT = (DAY_END_HOUR - DAY_START_HOUR) * HOUR_HEIGHT
const HOURS = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i)
const GRID_COLUMNS = `${GUTTER_WIDTH}px repeat(7, minmax(0, 1fr))`

/** 事件在格線上的位置；超出顯示範圍的部分直接裁掉。 */
function place(slot: TimeSlot) {
  const startMin = Math.max(minutesOfDay(slot.start), DAY_START_HOUR * 60)
  const rawEnd = minutesOfDay(slot.end)
  const endMin = Math.min(rawEnd === 0 ? DAY_END_HOUR * 60 : rawEnd, DAY_END_HOUR * 60)
  const top = ((startMin - DAY_START_HOUR * 60) / 60) * HOUR_HEIGHT
  const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 18)
  return { top, height }
}

interface Props {
  weekStart: Date
  events: CalendarEvent[]
  /** busy 事件的成員色、或全域層的專案色；回傳 null → 用預設的深褐會議卡 */
  accentOf?: (event: CalendarEvent) => string | null
  /** 色塊上的第二行小字（通常是成員名字），顏色以外的辨識線索 */
  captionOf?: (event: CalendarEvent) => string | undefined
  /** 找共同空檔的反白結果 */
  freeSlots?: TimeSlot[]
  /** 需要打衝突標記的 event id */
  conflicts?: Set<string>
  onEventClick?: (event: CalendarEvent) => void
  onSlotClick?: (slot: TimeSlot) => void
}

export function WeekGrid({
  weekStart,
  events,
  accentOf,
  captionOf,
  freeSlots = [],
  conflicts,
  onEventClick,
  onSlotClick,
}: Props) {
  // 「現在」只在掛載後才取，避免 SSR 與瀏覽器時區不同造成 hydration 不一致
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      {/* 表頭：星期與日期 */}
      <div className="grid shrink-0 border-b bg-card" style={{ gridTemplateColumns: GRID_COLUMNS }}>
        <div />
        {days.map((day, i) => {
          const today = now ? isSameDay(day, now) : false
          return (
            <div key={i} className="border-l px-2 py-2 text-center">
              <div className="text-[11px] text-muted-foreground">週{WEEKDAY_LABELS[i]}</div>
              <div
                className={cn(
                  'mx-auto mt-1 flex size-7 items-center justify-center rounded-full font-display text-sm font-bold tabular-nums',
                  today ? 'bg-honey text-ink' : 'text-foreground',
                )}
              >
                {day.getDate()}
              </div>
            </div>
          )
        })}
      </div>

      {/* 格線本體 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: GRID_COLUMNS }}>
          {/* 左側時間刻度 */}
          <div className="relative" style={{ height: BODY_HEIGHT }}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="absolute right-2 text-[11px] tabular-nums text-muted-foreground"
                style={{ top: (hour - DAY_START_HOUR) * HOUR_HEIGHT + 2 }}
              >
                {String(hour).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {/* 七個日期欄 */}
          {days.map((day, dayIndex) => {
            const dayEvents = events.filter((e) => isSameDay(e.start, day))
            const daySlots = freeSlots.filter((s) => isSameDay(s.start, day))
            const isToday = now ? isSameDay(day, now) : false
            const nowMinutes = now ? minutesOfDay(now) : 0
            const showNowLine =
              isToday && nowMinutes >= DAY_START_HOUR * 60 && nowMinutes <= DAY_END_HOUR * 60

            return (
              <div
                key={dayIndex}
                className={cn('relative border-l', isToday && 'bg-pollen/25')}
                style={{
                  height: BODY_HEIGHT,
                  backgroundImage: [
                    // 整點線
                    `repeating-linear-gradient(to bottom, hsl(var(--border)) 0 1px, transparent 1px ${HOUR_HEIGHT}px)`,
                    // 半點線：更淡，排會議常用 30 分粒度
                    `repeating-linear-gradient(to bottom, transparent 0 ${HOUR_HEIGHT / 2}px, hsl(var(--border) / 0.45) ${HOUR_HEIGHT / 2}px ${HOUR_HEIGHT / 2 + 1}px, transparent ${HOUR_HEIGHT / 2 + 1}px ${HOUR_HEIGHT}px)`,
                  ].join(','),
                }}
              >
                {/* 共同空檔反白：畫在事件底下，可直接點擊建立會議 */}
                {daySlots.map((slot, i) => {
                  const { top, height } = place(slot)
                  const minutes = Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000)
                  const label = height >= 34 && (
                    <>
                      <span className="text-[11px] font-medium text-honey-deep">可排</span>
                      <span className="text-[10px] text-honey-deep/80">
                        {formatDuration(minutes)}
                      </span>
                    </>
                  )
                  const base =
                    'absolute inset-x-1 z-0 flex flex-col items-center justify-center rounded-md border border-dashed border-honey-deep bg-honey/20 text-center'

                  // 沒有建立會議的權限時仍然顯示空檔（知道大家什麼時候有空本身就有用），
                  // 但畫成靜態區塊而不是按鈕——一顆按了沒反應的按鈕比沒有按鈕更糟。
                  if (!onSlotClick) {
                    return (
                      <div key={`slot-${i}`} style={{ top, height }} className={base}>
                        {label}
                      </div>
                    )
                  }
                  return (
                    <button
                      key={`slot-${i}`}
                      type="button"
                      onClick={() => onSlotClick(slot)}
                      style={{ top, height }}
                      className={cn(
                        base,
                        'transition-colors hover:bg-honey/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}

                {/* 事件 */}
                {assignLanes(dayEvents).map(({ item: event, lane, laneCount }) => {
                  const { top, height } = place(event)
                  const accent = accentOf?.(event) ?? null
                  const caption = captionOf?.(event)
                  const conflicted = conflicts?.has(event.id) ?? false
                  const compact = height < 34
                  // 我被列為與會者但還沒回覆出席。已取消的會議就別再催了。
                  const needsReply =
                    event.kind === 'meeting' && event.myRsvp === 'pending' && !event.canceled

                  return (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => onEventClick?.(event)}
                      title={`${event.title}　${formatTime(event.start)}–${formatTime(event.end)}${
                        needsReply ? '（尚未回覆出席）' : ''
                      }`}
                      style={{
                        top,
                        height,
                        left: `calc(${(lane / laneCount) * 100}% + 2px)`,
                        width: `calc(${(1 / laneCount) * 100}% - 4px)`,
                        ...(accent
                          ? { backgroundColor: tint(accent), borderColor: accent }
                          : undefined),
                        ...(conflicted ? { boxShadow: `0 0 0 2px ${CONFLICT_COLOR}` } : undefined),
                      }}
                      className={cn(
                        'absolute z-10 overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        accent
                          ? 'text-ink'
                          : 'border-honey bg-ink text-hive-fg shadow-sm hover:bg-ink-light',
                        event.canceled && 'border-dashed opacity-55',
                      )}
                    >
                      {needsReply && (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute right-1 top-1 flex size-3.5 items-center justify-center rounded-full border text-[9px] font-bold leading-none',
                            accent
                              ? 'border-ink bg-ink text-paper'
                              : 'border-hive-fg bg-hive-fg text-ink',
                          )}
                        >
                          ?
                        </span>
                      )}
                      <div
                        className={cn(
                          'truncate pr-4 text-[11px] font-medium leading-tight',
                          event.canceled && 'line-through',
                        )}
                      >
                        {event.title}
                        {needsReply && <span className="sr-only">（尚未回覆出席）</span>}
                      </div>
                      {!compact && (
                        <div
                          className={cn(
                            'truncate text-[10px] leading-tight',
                            accent ? 'text-ink-soft' : 'text-hive-muted',
                          )}
                        >
                          {caption ? `${caption}・` : ''}
                          {formatTime(event.start)}
                        </div>
                      )}
                    </button>
                  )
                })}

                {/* 現在時間線 */}
                {showNowLine && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 z-20 h-px bg-honey"
                    style={{ top: ((nowMinutes - DAY_START_HOUR * 60) / 60) * HOUR_HEIGHT }}
                  >
                    <span className="absolute -left-1 -top-1 size-2 rounded-full bg-honey" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
