'use client'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { WeekGrid } from '@/components/calendar/week-grid'
import { MemberPanel } from '@/components/calendar/member-panel'
import { FindSlotPanel } from '@/components/calendar/find-slot-panel'
import { EventDialog } from '@/components/calendar/event-dialog'
import {
  CalendarLegend,
  CalendarToolbar,
  LegendItem,
} from '@/components/calendar/calendar-toolbar'
import {
  addDays,
  detectConflicts,
  findCommonSlots,
  formatTime,
  startOfWeek,
  type CalendarEvent,
  type TimeSlot,
} from '@/lib/calendar'
import { CONFLICT_COLOR, seriesColorAt } from '@/lib/calendar-colors'
import { MOCK_MEMBERS, MOCK_PROJECT_EVENTS } from '@/lib/calendar-mock'

/** 找空檔時視為「可排會議」的時段（週一~週日的這個區間內）。 */
const WORK_START_HOUR = 9
const WORK_END_HOUR = 18

export default function ProjectCalendarPage() {
  // 整頁等掛載後才畫：週次與「今天」都取自 new Date()，SSR 與瀏覽器時區可能不同
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(MOCK_MEMBERS.map((m) => m.id)),
  )
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<TimeSlot[] | null>(null)
  const [openEvent, setOpenEvent] = useState<CalendarEvent | null>(null)

  const colorOf = (memberId: string) =>
    seriesColorAt(MOCK_MEMBERS.findIndex((m) => m.id === memberId))
  const nameOf = (memberId: string) => MOCK_MEMBERS.find((m) => m.id === memberId)?.name

  // 專案會議一律顯示；成員的 GCal 忙碌時段跟著疊圖開關走
  const shownEvents = useMemo(
    () =>
      MOCK_PROJECT_EVENTS.filter(
        (e) => e.kind === 'meeting' || (e.memberId ? visible.has(e.memberId) : false),
      ),
    [visible],
  )

  const conflicts = useMemo(() => detectConflicts(shownEvents), [shownEvents])

  const participants = MOCK_MEMBERS.filter((m) => visible.has(m.id))

  const handleSearch = () => {
    const busy = shownEvents
      .filter((e) => !e.canceled)
      .map(({ start, end }) => ({ start, end }))
    const found = findCommonSlots({
      busy,
      days: Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
      workStartHour: WORK_START_HOUR,
      workEndHour: WORK_END_HOUR,
      durationMin: duration,
    })
    setSlots(found)
    toast.success(`找到 ${found.length} 個共同空檔`)
  }

  const handlePick = (slot: TimeSlot) => {
    toast.success('已帶入建立會議', {
      description: `${slot.start.getMonth() + 1}/${slot.start.getDate()} ${formatTime(slot.start)}－${formatTime(slot.end)}，與會者 ${participants.length} 人`,
    })
  }

  const toggleMember = (memberId: string) =>
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(memberId)) next.delete(memberId)
      else next.add(memberId)
      return next
    })

  if (!mounted) {
    return (
      <div role="status" className="h-full">
        <span className="sr-only">載入行事曆中…</span>
        <div
          aria-hidden="true"
          className="h-full min-h-[24rem] animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* 左欄：疊圖開關 + 找空檔 */}
      <aside className="w-64 shrink-0 space-y-3 overflow-y-auto">
        <MemberPanel
          members={MOCK_MEMBERS}
          visible={visible}
          onToggle={toggleMember}
          onToggleAll={(next) =>
            setVisible(next ? new Set(MOCK_MEMBERS.map((m) => m.id)) : new Set())
          }
          colorOf={colorOf}
        />
        <FindSlotPanel
          participants={participants}
          duration={duration}
          onDurationChange={setDuration}
          onSearch={handleSearch}
          onClear={() => setSlots(null)}
          results={slots}
          onPick={handlePick}
        />
      </aside>

      {/* 右側：週曆 */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <CalendarToolbar
          weekStart={weekStart}
          onWeekStartChange={setWeekStart}
          actions={<Button size="sm">+ 建立會議</Button>}
        />

        <CalendarLegend>
          <LegendItem
            swatch={<span className="size-3 rounded-[3px] border-l-[3px] border-honey bg-ink" />}
            label="專案會議"
          />
          <LegendItem
            swatch={
              <span className="size-3 rounded-[3px] border-l-[3px] border-[#2a78d6] bg-[#2a78d622]" />
            }
            label="成員忙碌（依成員分色）"
          />
          <LegendItem
            swatch={
              <span className="size-3 rounded-[3px] border border-dashed border-honey-deep bg-honey/25" />
            }
            label="共同空檔（可點擊建立）"
          />
          <LegendItem
            swatch={
              <span
                className="size-3 rounded-[3px] bg-card"
                style={{ boxShadow: `0 0 0 2px ${CONFLICT_COLOR}` }}
              />
            }
            label="同一人時段衝突"
          />
        </CalendarLegend>

        <WeekGrid
          weekStart={weekStart}
          events={shownEvents}
          freeSlots={slots ?? []}
          conflicts={conflicts}
          accentOf={(e) => (e.kind === 'busy' && e.memberId ? colorOf(e.memberId) : null)}
          captionOf={(e) =>
            e.kind === 'busy'
              ? nameOf(e.memberId ?? '')
              : `${e.attendees?.length ?? 0} 人`
          }
          onEventClick={setOpenEvent}
          onSlotClick={handlePick}
        />
      </div>

      <EventDialog
        event={openEvent}
        members={MOCK_MEMBERS}
        onOpenChange={(open) => !open && setOpenEvent(null)}
        onNudge={(event, pendingIds) => {
          toast.success(`已送出提醒給 ${pendingIds.length} 位未回覆成員`, {
            description: `${event.title}・以主辦人名義發送`,
          })
          setOpenEvent(null)
        }}
      />
    </div>
  )
}
