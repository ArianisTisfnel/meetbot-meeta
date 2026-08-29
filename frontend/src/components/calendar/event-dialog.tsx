'use client'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatTime, type CalendarEvent, type CalendarMember, type RsvpStatus } from '@/lib/calendar'
import { cn } from '@/lib/utils'

const RSVP_META: Record<RsvpStatus, { label: string; className: string }> = {
  accepted: { label: '出席', className: 'bg-green-100 text-green-800' },
  tentative: { label: '待定', className: 'bg-muted text-muted-foreground' },
  declined: { label: '拒絕', className: 'bg-destructive/10 text-destructive' },
  pending: { label: '未回覆', className: 'border border-dashed border-border text-muted-foreground' },
}

interface Props {
  event: CalendarEvent | null
  members: CalendarMember[]
  onOpenChange: (open: boolean) => void
  onNudge?: (event: CalendarEvent, pendingMemberIds: string[]) => void
}

export function EventDialog({ event, members, onOpenChange, onNudge }: Props) {
  if (!event) return null

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id
  const attendees = event.attendees ?? []
  const pending = attendees.filter((a) => a.rsvp === 'pending')
  const accepted = attendees.filter((a) => a.rsvp === 'accepted')

  const dateLabel = `${event.start.getMonth() + 1}月${event.start.getDate()}日 ${formatTime(event.start)}–${formatTime(event.end)}`

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span className={cn(event.canceled && 'line-through')}>{event.title}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="tabular-nums text-muted-foreground">{dateLabel}</p>

          {event.canceled && (
            <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
              此會議已取消，不列入忙碌判斷。
            </p>
          )}

          {event.kind === 'busy' ? (
            <p className="text-xs text-muted-foreground">
              來自 {nameOf(event.memberId ?? '')} 的 Google Calendar 忙碌時段，僅供排程參考。
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between border-t pt-3">
                <span className="text-xs text-muted-foreground">
                  出席回覆 {accepted.length}/{attendees.length}
                </span>
                {event.location && (
                  <span className="text-xs text-muted-foreground">{event.location}</span>
                )}
              </div>

              <ul className="space-y-1">
                {attendees.map((a) => {
                  const meta = RSVP_META[a.rsvp]
                  return (
                    <li key={a.memberId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{nameOf(a.memberId)}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                          meta.className,
                        )}
                      >
                        {meta.label}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>

        {event.kind === 'meeting' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              關閉
            </Button>
            <Button
              disabled={pending.length === 0}
              onClick={() => onNudge?.(event, pending.map((a) => a.memberId))}
            >
              {pending.length === 0 ? '全員已回覆' : `催未回覆（${pending.length} 人）`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
