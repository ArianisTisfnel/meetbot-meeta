'use client'
import { use, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { WeekGrid } from '@/components/calendar/week-grid'
import { MemberPanel } from '@/components/calendar/member-panel'
import { FindSlotPanel } from '@/components/calendar/find-slot-panel'
import { EventDialog } from '@/components/calendar/event-dialog'
import { ScheduleMeetingDialog } from '@/components/calendar/schedule-meeting-dialog'
import { CalendarConnectionCard } from '@/components/calendar/connection-card'
import {
  CalendarLegend,
  CalendarToolbar,
  LegendItem,
} from '@/components/calendar/calendar-toolbar'
import {
  useCancelScheduledMeeting,
  useFindFreeSlots,
  useProjectCalendar,
  useRespondRsvp,
  useUpdateMeetingSchedule,
} from '@/hooks/use-calendar'
import { useMe } from '@/hooks/use-me'
import { usePermissions } from '@/hooks/use-permissions'
import {
  addDays,
  detectConflicts,
  startOfWeek,
  type CalendarEvent,
  type TimeSlot,
} from '@/lib/calendar'
import { toBusyEvent, toMeetingEvent, toMember, toSlot } from '@/lib/calendar-adapt'
import { CONFLICT_COLOR, seriesColorAt } from '@/lib/calendar-colors'

interface Props {
  params: Promise<{ projectId: string }>
}

export default function ProjectCalendarPage({ params }: Props) {
  const { projectId } = use(params)

  // 整頁等掛載後才畫：週次與「今天」都取自 new Date()，SSR 與瀏覽器時區可能不同
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<TimeSlot[] | null>(null)
  const [openEvent, setOpenEvent] = useState<CalendarEvent | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [presetSlot, setPresetSlot] = useState<TimeSlot | null>(null)

  const weekEnd = addDays(weekStart, 7)
  const { data, isLoading, error } = useProjectCalendar(projectId, weekStart, weekEnd)
  const findSlots = useFindFreeSlots(projectId)
  const respond = useRespondRsvp()
  const cancelMeeting = useCancelScheduledMeeting()
  const updateSchedule = useUpdateMeetingSchedule()
  const { data: me } = useMe()
  // 沒有會議權的成員只能看：後端本來就會擋（requireProjectMeetingAccess 回 403），
  // 但畫面上不該給一顆按了才發現沒權限的按鈕。
  const { canMeeting } = usePermissions(projectId)

  const members = useMemo(() => (data?.members ?? []).map(toMember), [data])

  const colorOf = (memberId: string) => seriesColorAt(members.findIndex((m) => m.id === memberId))
  const nameOf = (memberId: string) => members.find((m) => m.id === memberId)?.name

  // 用「隱藏集合」而非「顯示集合」存狀態：成員清單是非同步載入的，
  // 若存顯示集合，資料回來前集合是空的，畫面會先閃一次「全部隱藏」。
  const visible = useMemo(
    () => new Set(members.filter((m) => !hidden.has(m.id)).map((m) => m.id)),
    [members, hidden],
  )

  const events = useMemo<CalendarEvent[]>(() => {
    if (!data) return []
    const meetings = data.meetings
      .map(toMeetingEvent)
      .filter((e): e is CalendarEvent => e !== null)
    const busy = data.busyBlocks
      .filter((b) => visible.has(String(b.userId)))
      .map((b) => toBusyEvent(b, members.find((m) => m.id === String(b.userId))?.name))
    return [...meetings, ...busy]
  }, [data, visible, members])

  const conflicts = useMemo(() => detectConflicts(events), [events])
  const participants = members.filter((m) => visible.has(m.id))

  const handleSearch = async () => {
    try {
      const result = await findSlots.mutateAsync({
        memberUserIds: participants.map((m) => Number(m.id)),
        durationMin: duration,
        from: weekStart,
        to: weekEnd,
      })
      setSlots(result.slots.map(toSlot))
      toast.success(`找到 ${result.slots.length} 個共同空檔`)
    } catch (err: any) {
      toast.error(err?.message ?? '搜尋空檔失敗')
    }
  }

  const openScheduleWithSlot = (slot: TimeSlot | null) => {
    setPresetSlot(slot)
    setScheduleOpen(true)
  }

  const toggleMember = (memberId: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(memberId)) next.delete(memberId)
      else next.add(memberId)
      return next
    })

  if (!mounted || isLoading) {
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

  if (error) {
    return (
      <p className="text-destructive">
        載入行事曆失敗：{(error as any)?.message ?? '未知錯誤'}
      </p>
    )
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* 左欄：疊圖開關 + 找空檔 */}
      <aside className="w-64 shrink-0 space-y-3 overflow-y-auto">
        <CalendarConnectionCard />
        <MemberPanel
          members={members}
          visible={visible}
          onToggle={toggleMember}
          onToggleAll={(next) => setHidden(next ? new Set() : new Set(members.map((m) => m.id)))}
          colorOf={colorOf}
        />
        <FindSlotPanel
          participants={participants}
          duration={duration}
          onDurationChange={setDuration}
          onSearch={handleSearch}
          onClear={() => setSlots(null)}
          isSearching={findSlots.isPending}
          results={slots}
          canSchedule={canMeeting}
          onPick={openScheduleWithSlot}
        />
      </aside>

      {/* 右側：週曆 */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <CalendarToolbar
          weekStart={weekStart}
          onWeekStartChange={setWeekStart}
          actions={
            canMeeting ? (
              <Button size="sm" onClick={() => openScheduleWithSlot(null)}>
                + 排定會議
              </Button>
            ) : null
          }
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

        {events.length === 0 && slots === null ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed bg-card p-8 text-center">
            <p className="mb-1 font-medium">這一週還沒有會議</p>
            {canMeeting ? (
              <>
                <p className="mb-4 text-sm text-muted-foreground">
                  排定第一場會議，它會自動出現在行事曆上。
                </p>
                <Button onClick={() => openScheduleWithSlot(null)}>+ 排定會議</Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                你沒有在此專案建立會議的權限。有人排了會議就會出現在這裡。
              </p>
            )}
          </div>
        ) : (
          <WeekGrid
            weekStart={weekStart}
            events={events}
            freeSlots={slots ?? []}
            conflicts={conflicts}
            accentOf={(e) => (e.kind === 'busy' && e.memberId ? colorOf(e.memberId) : null)}
            captionOf={(e) =>
              e.kind === 'busy' ? nameOf(e.memberId ?? '') : `${e.attendees?.length ?? 0} 人`
            }
            onEventClick={setOpenEvent}
            onSlotClick={canMeeting ? openScheduleWithSlot : undefined}
          />
        )}
      </div>

      <EventDialog
        event={openEvent}
        members={members}
        currentUserId={me?.userId}
        canManage={canMeeting}
        isPending={respond.isPending || cancelMeeting.isPending || updateSchedule.isPending}
        onOpenChange={(open) => !open && setOpenEvent(null)}
        onRespond={async (meetingId, rsvp) => {
          try {
            await respond.mutateAsync({ meetingId, rsvp })
            toast.success('已更新出席回覆')
            setOpenEvent(null)
          } catch (err: any) {
            toast.error(err?.message ?? '回覆失敗')
          }
        }}
        onToggleBot={async (meetingId, botAutoJoin) => {
          try {
            await updateSchedule.mutateAsync({ meetingId, botAutoJoin })
            toast.success(botAutoJoin ? '時間到時蜜塔會自動加入' : '已取消蜜塔自動加入')
            setOpenEvent(null)
          } catch (err: any) {
            toast.error(err?.message ?? '更新失敗')
          }
        }}
        onCancel={async (meetingId) => {
          try {
            await cancelMeeting.mutateAsync(meetingId)
            toast.success('會議已取消')
            setOpenEvent(null)
          } catch (err: any) {
            toast.error(err?.message ?? '取消失敗')
          }
        }}
      />

      <ScheduleMeetingDialog
        projectId={projectId}
        members={members}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        presetSlot={presetSlot}
        presetMemberIds={participants.map((m) => m.id)}
      />
    </div>
  )
}
