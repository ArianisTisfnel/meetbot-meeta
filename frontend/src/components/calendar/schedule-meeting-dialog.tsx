'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useScheduleMeeting } from '@/hooks/use-calendar'
import { formatTime, type CalendarMember, type TimeSlot } from '@/lib/calendar'
import { cn } from '@/lib/utils'

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

const DURATION_OPTIONS = [30, 60, 90, 120]

/** Date → <input type="date"> / <input type="time"> 需要的本地時間字串。 */
function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function toTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface Props {
  projectId: string
  members: CalendarMember[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 從「找共同空檔」點進來時帶入的時段與成員 */
  presetSlot?: TimeSlot | null
  presetMemberIds?: string[]
}

export function ScheduleMeetingDialog({
  projectId,
  members,
  open,
  onOpenChange,
  presetSlot,
  presetMemberIds,
}: Props) {
  const schedule = useScheduleMeeting(projectId)

  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [duration, setDuration] = useState(60)
  const [attendees, setAttendees] = useState<Set<string>>(new Set())
  const [botAutoJoin, setBotAutoJoin] = useState(false)

  // 每次開啟都重新帶入預設值：帶著上一次的殘留值開啟，比空白更容易讓人排錯時間
  useEffect(() => {
    if (!open) return
    const start = presetSlot?.start ?? new Date(Date.now() + 60 * 60 * 1000)
    setName('')
    setDate(toDateInput(start))
    setTime(toTimeInput(start))
    setDuration(
      presetSlot
        ? Math.min(
            120,
            Math.max(
              30,
              Math.round((presetSlot.end.getTime() - presetSlot.start.getTime()) / 60_000),
            ),
          )
        : 60,
    )
    setAttendees(new Set(presetMemberIds ?? members.map((m) => m.id)))
    // 預設不勾：蜜塔進會議是按分鐘計費的，該由排會議的人明確決定
    setBotAutoJoin(false)
  }, [open, presetSlot, presetMemberIds, members])

  const toggleAttendee = (id: string) =>
    setAttendees((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('請輸入會議名稱')
      return
    }
    const start = new Date(`${date}T${time}`)
    if (Number.isNaN(start.getTime())) {
      toast.error('日期或時間格式不正確')
      return
    }
    const end = new Date(start.getTime() + duration * 60_000)

    try {
      await schedule.mutateAsync({
        name: name.trim(),
        scheduledStartAt: start,
        scheduledEndAt: end,
        attendeeUserIds: [...attendees].map(Number),
        botAutoJoin,
      })
      toast.success('會議已排定', {
        description: `${start.getMonth() + 1}/${start.getDate()} ${formatTime(start)}–${formatTime(end)}`,
      })
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message ?? '排定會議失敗')
    }
  }

  const presetDuration = presetSlot
    ? Math.round((presetSlot.end.getTime() - presetSlot.start.getTime()) / 60_000)
    : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>排定會議</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {presetSlot && (
            <p className="rounded-md bg-honey/15 px-2.5 py-1.5 text-xs text-honey-deep">
              已帶入共同空檔 {formatTime(presetSlot.start)}–{formatTime(presetSlot.end)}
              （這段共 {presetDuration} 分鐘可用）
            </p>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="meeting-name">
              會議名稱
            </label>
            <Input
              id="meeting-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：Sprint 規劃會議"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="meeting-date">
                日期
              </label>
              <Input
                id="meeting-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="meeting-time">
                開始
              </label>
              <Input
                id="meeting-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs text-muted-foreground"
                htmlFor="meeting-duration"
              >
                時長
              </label>
              <select
                id="meeting-duration"
                className={SELECT_CLASS}
                value={String(duration)}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {DURATION_OPTIONS.map((min) => (
                  <option key={min} value={min}>
                    {min} 分鐘
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              與會成員（{attendees.size}/{members.length}）
            </p>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1">
              {members.map((member) => (
                <li key={member.id}>
                  <label
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent',
                    )}
                  >
                    <Checkbox
                      checked={attendees.has(member.id)}
                      onCheckedChange={() => toggleAttendee(member.id)}
                    />
                    <span className="min-w-0 flex-1 truncate">{member.name}</span>
                    {member.syncState !== 'synced' && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">未同步</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-md border bg-muted/40 p-2.5">
            <Checkbox
              checked={botAutoJoin}
              onCheckedChange={setBotAutoJoin}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">讓蜜塔加入這場會議</span>
              <span className="block text-[11px] leading-relaxed text-muted-foreground">
                會議開始前自動派蜜塔進去做逐字稿與摘要。之後仍可在會議詳情裡改。
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={schedule.isPending}>
            {schedule.isPending ? '排定中…' : '排定會議'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
