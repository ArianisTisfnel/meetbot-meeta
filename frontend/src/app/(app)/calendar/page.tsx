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
import { useGlobalCalendar, useRespondRsvp } from '@/hooks/use-calendar'
import { useMe } from '@/hooks/use-me'
import {
  WEEKDAY_LABELS,
  addDays,
  detectConflicts,
  formatTime,
  startOfWeek,
  type CalendarEvent,
} from '@/lib/calendar'
import { toBusyEvent, toMeetingEvent } from '@/lib/calendar-adapt'
import { seriesColorAt, SERIES_COLOR_OVERFLOW } from '@/lib/calendar-colors'
import type { RsvpStatus as RsvpDto } from '@/types/api'
import { cn } from '@/lib/utils'

const RSVP_BUTTONS: Array<{ dto: RsvpDto; label: string }> = [
  { dto: 'ACCEPTED', label: '出席' },
  { dto: 'TENTATIVE', label: '待定' },
  { dto: 'DECLINED', label: '拒絕' },
]

export default function GlobalCalendarPage() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => new Set())
  const [openEvent, setOpenEvent] = useState<CalendarEvent | null>(null)

  const weekEnd = addDays(weekStart, 7)
  const { data, isLoading, error } = useGlobalCalendar(weekStart, weekEnd)
  const { data: me } = useMe()
  const respond = useRespondRsvp()

  // 專案清單從這一週的會議推導：全域層的分色只需要「這週出現過的專案」
  const projects = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of data?.meetings ?? []) {
      if (m.projectId) seen.set(m.projectId, m.projectName ?? '未命名專案')
    }
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [data])

  const projectColorOf = (projectId?: string | null) => {
    if (!projectId) return SERIES_COLOR_OVERFLOW
    return seriesColorAt(projects.findIndex((p) => p.id === projectId))
  }

  const events = useMemo<CalendarEvent[]>(() => {
    if (!data) return []
    const meetings = data.meetings
      .map(toMeetingEvent)
      .filter((e): e is CalendarEvent => e !== null)
      // 無專案的會議（全局建立）沒有分色開關，一律顯示
      .filter((e) => !e.projectId || !hiddenProjects.has(e.projectId))
    const busy = data.busyBlocks.map((b) => toBusyEvent(b))
    return [...meetings, ...busy]
  }, [data, hiddenProjects])

  const conflicts = useMemo(() => detectConflicts(events), [events])

  // 會議詳情要顯示與會者姓名；全域層的名字對照由後端一起回
  const people = useMemo(
    () =>
      (data?.people ?? []).map((p) => ({
        id: String(p.userId),
        name: p.name ?? p.email,
        email: p.email,
        syncState: 'synced' as const,
      })),
    [data],
  )

  // 待辦：我還沒回覆的會議
  const awaitingRsvp = useMemo(() => {
    if (!me) return []
    return (data?.meetings ?? []).filter(
      (m) =>
        m.status !== 'CANCELED' &&
        m.attendees.some((a) => a.userId === me.userId && a.rsvp === 'PENDING'),
    )
  }, [data, me])

  const handleRespond = async (meetingId: string, rsvp: RsvpDto, label: string) => {
    try {
      await respond.mutateAsync({ meetingId, rsvp })
      toast.success(`已回覆「${label}」`)
    } catch (err: any) {
      toast.error(err?.message ?? '回覆失敗')
    }
  }

  const toggleProject = (projectId: string) =>
    setHiddenProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })

  if (!mounted || isLoading) {
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

      {error && (
        <p className="text-destructive">
          載入行事曆失敗：{(error as any)?.message ?? '未知錯誤'}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="w-60 shrink-0 space-y-3 overflow-y-auto">
          <section className="rounded-lg border bg-card p-3">
            <h2 className="mb-2 text-sm font-bold">專案</h2>
            {projects.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">這一週沒有專案會議。</p>
            ) : (
              <ul className="space-y-0.5">
                {projects.map((project) => {
                  const checked = !hiddenProjects.has(project.id)
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
            )}
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
                {awaitingRsvp.map((meeting) => {
                  const start = meeting.scheduledStartAt ? new Date(meeting.scheduledStartAt) : null
                  const end = meeting.scheduledEndAt ? new Date(meeting.scheduledEndAt) : null
                  return (
                    <li key={meeting.id}>
                      <p className="truncate text-xs font-medium">{meeting.name}</p>
                      {start && end && (
                        <p className="mb-1.5 text-[11px] tabular-nums text-muted-foreground">
                          週{WEEKDAY_LABELS[(start.getDay() + 6) % 7]} {formatTime(start)}–
                          {formatTime(end)}
                        </p>
                      )}
                      <div className="flex gap-1">
                        {RSVP_BUTTONS.map(({ dto, label }) => (
                          <Button
                            key={dto}
                            size="sm"
                            variant="outline"
                            className="h-7 flex-1 px-0 text-[11px]"
                            disabled={respond.isPending}
                            onClick={() => handleRespond(meeting.id, dto, label)}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <CalendarToolbar weekStart={weekStart} onWeekStartChange={setWeekStart} />

          <CalendarLegend>
            {projects.map((project, i) => (
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
              swatch={
                <span
                  className="size-3 rounded-[3px] border-l-[3px]"
                  style={{
                    borderColor: SERIES_COLOR_OVERFLOW,
                    backgroundColor: `${SERIES_COLOR_OVERFLOW}22`,
                  }}
                />
              }
              label="個人 Google Calendar 事件"
            />
          </CalendarLegend>

          {events.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed bg-card p-8 text-center">
              <p className="mb-1 font-medium">這一週沒有行程</p>
              <p className="text-sm text-muted-foreground">
                進入專案排定會議，它會自動出現在這裡。
              </p>
            </div>
          ) : (
            <WeekGrid
              weekStart={weekStart}
              events={events}
              conflicts={conflicts}
              accentOf={(e) => projectColorOf(e.projectId)}
              captionOf={(e) => e.projectName ?? '個人行程'}
              onEventClick={setOpenEvent}
            />
          )}
        </div>
      </div>

      <EventDialog
        event={openEvent}
        members={people}
        currentUserId={me?.userId}
        onOpenChange={(open) => !open && setOpenEvent(null)}
        onRespond={(meetingId, rsvp) => {
          const label = RSVP_BUTTONS.find((b) => b.dto === rsvp)?.label ?? ''
          handleRespond(meetingId, rsvp, label)
        }}
        isPending={respond.isPending}
      />
    </div>
  )
}
