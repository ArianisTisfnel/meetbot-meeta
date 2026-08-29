'use client'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { WeekGrid } from '@/components/calendar/week-grid'
import { EventDialog } from '@/components/calendar/event-dialog'
import {
  CalendarLegend,
  CalendarToolbar,
  LegendItem,
} from '@/components/calendar/calendar-toolbar'
import {
  WEEKDAY_LABELS,
  detectConflicts,
  formatTime,
  startOfWeek,
  type CalendarEvent,
} from '@/lib/calendar'
import { seriesColorAt } from '@/lib/calendar-colors'
import { MOCK_GLOBAL_EVENTS, MOCK_MEMBERS, MOCK_PROJECTS } from '@/lib/calendar-mock'
import { cn } from '@/lib/utils'

/** 全域層代表「我」的成員 id（之後改成登入者本人）。 */
const ME = 'm1'

export default function GlobalCalendarPage() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [visibleProjects, setVisibleProjects] = useState<Set<string>>(
    () => new Set(MOCK_PROJECTS.map((p) => p.id)),
  )
  const [openEvent, setOpenEvent] = useState<CalendarEvent | null>(null)

  const projectColorOf = (projectId?: string) =>
    seriesColorAt(MOCK_PROJECTS.findIndex((p) => p.id === projectId))

  // 個人 GCal 事件（無 projectId）不受專案篩選影響
  const shownEvents = useMemo(
    () =>
      MOCK_GLOBAL_EVENTS.filter((e) => !e.projectId || visibleProjects.has(e.projectId)),
    [visibleProjects],
  )

  const conflicts = useMemo(() => detectConflicts(shownEvents), [shownEvents])

  // 待辦：我還沒回覆的會議
  const awaitingRsvp = MOCK_GLOBAL_EVENTS.filter(
    (e) =>
      e.kind === 'meeting' &&
      !e.canceled &&
      e.attendees?.some((a) => a.memberId === ME && a.rsvp === 'pending'),
  )

  const toggleProject = (projectId: string) =>
    setVisibleProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })

  if (!mounted) {
    return (
      <div role="status" className="p-6">
        <span className="sr-only">載入行事曆中…</span>
        <div
          aria-hidden="true"
          className="h-96 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold">行事曆</h1>
        <p className="text-xs text-muted-foreground">
          我的所有會議合併檢視・成員疊圖與找空檔請進專案
        </p>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="w-60 shrink-0 space-y-3 overflow-y-auto">
          <section className="rounded-lg border bg-card p-3">
            <h2 className="mb-2 text-sm font-bold">專案</h2>
            <ul className="space-y-0.5">
              {MOCK_PROJECTS.map((project) => {
                const checked = visibleProjects.has(project.id)
                return (
                  <li key={project.id}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent',
                        !checked && 'opacity-55',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleProject(project.id)}
                        aria-label={`顯示 ${project.name} 的會議`}
                      />
                      <span
                        aria-hidden="true"
                        className="size-3 shrink-0 rounded-[3px]"
                        style={{ backgroundColor: projectColorOf(project.id) }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="rounded-lg border bg-card p-3">
            <h2 className="mb-2 text-sm font-bold">
              待回覆
              {awaitingRsvp.length > 0 && (
                <span className="ml-1.5 rounded-full bg-honey px-1.5 py-0.5 text-[10px] text-ink">
                  {awaitingRsvp.length}
                </span>
              )}
            </h2>
            {awaitingRsvp.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">沒有待回覆的邀請。</p>
            ) : (
              <ul className="space-y-3">
                {awaitingRsvp.map((event) => (
                  <li key={event.id}>
                    <p className="truncate text-xs font-medium">{event.title}</p>
                    <p className="mb-1.5 text-[11px] tabular-nums text-muted-foreground">
                      週{WEEKDAY_LABELS[(event.start.getDay() + 6) % 7]}{' '}
                      {formatTime(event.start)}–{formatTime(event.end)}
                    </p>
                    <div className="flex gap-1">
                      {(['出席', '待定', '拒絕'] as const).map((label) => (
                        <Button
                          key={label}
                          size="sm"
                          variant="outline"
                          className="h-7 flex-1 px-0 text-[11px]"
                          onClick={() => toast.success(`已回覆「${label}」：${event.title}`)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <CalendarToolbar
            weekStart={weekStart}
            onWeekStartChange={setWeekStart}
            actions={<Button size="sm">+ 建立會議</Button>}
          />

          <CalendarLegend>
            {MOCK_PROJECTS.map((project, i) => (
              <LegendItem
                key={project.id}
                swatch={
                  <span
                    className="size-3 rounded-[3px] border-l-[3px]"
                    style={{
                      borderColor: seriesColorAt(i),
                      backgroundColor: `${seriesColorAt(i)}22`,
                    }}
                  />
                }
                label={project.name}
              />
            ))}
            <LegendItem
              swatch={<span className="size-3 rounded-[3px] bg-[#8987811f] border-l-[3px] border-[#898781]" />}
              label="個人 Google Calendar 事件"
            />
          </CalendarLegend>

          <WeekGrid
            weekStart={weekStart}
            events={shownEvents}
            conflicts={conflicts}
            accentOf={(e) => (e.projectId ? projectColorOf(e.projectId) : '#898781')}
            captionOf={(e) => e.projectName ?? '個人行程'}
            onEventClick={setOpenEvent}
          />
        </div>
      </div>

      <EventDialog
        event={openEvent}
        members={MOCK_MEMBERS}
        onOpenChange={(open) => !open && setOpenEvent(null)}
        onNudge={(event, pendingIds) => {
          toast.success(`已送出提醒給 ${pendingIds.length} 位未回覆成員`)
          setOpenEvent(null)
        }}
      />
    </div>
  )
}
