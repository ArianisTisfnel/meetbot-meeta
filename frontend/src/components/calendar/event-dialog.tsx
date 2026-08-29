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
import type { RsvpStatus as RsvpDto } from '@/types/api'
import { cn } from '@/lib/utils'

const RSVP_META: Record<RsvpStatus, { label: string; className: string }> = {
  accepted: { label: '出席', className: 'bg-green-100 text-green-800' },
  tentative: { label: '待定', className: 'bg-muted text-muted-foreground' },
  declined: { label: '拒絕', className: 'bg-destructive/10 text-destructive' },
  pending: { label: '未回覆', className: 'border border-dashed border-border text-muted-foreground' },
}

/** 我可以按的三個回覆，對應後端 enum。 */
const MY_RSVP_CHOICES: Array<{ dto: RsvpDto; local: RsvpStatus; label: string }> = [
  { dto: 'ACCEPTED', local: 'accepted', label: '出席' },
  { dto: 'TENTATIVE', local: 'tentative', label: '待定' },
  { dto: 'DECLINED', local: 'declined', label: '拒絕' },
]

interface Props {
  event: CalendarEvent | null
  members: CalendarMember[]
  onOpenChange: (open: boolean) => void
  /** 登入者的 userId；有值才會顯示「我的回覆」那一排按鈕 */
  currentUserId?: number
  onRespond?: (meetingId: string, rsvp: RsvpDto) => void
  /** 有權管理這場會議（主辦／具 canMeeting）才給取消 */
  canManage?: boolean
  onCancel?: (meetingId: string) => void
  isPending?: boolean
}

export function EventDialog({
  event,
  members,
  onOpenChange,
  currentUserId,
  onRespond,
  canManage,
  onCancel,
  isPending,
}: Props) {
  if (!event) return null

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id
  const attendees = event.attendees ?? []
  const accepted = attendees.filter((a) => a.rsvp === 'accepted')
  const pending = attendees.filter((a) => a.rsvp === 'pending')
  const myAttendance =
    currentUserId !== undefined
      ? attendees.find((a) => a.memberId === String(currentUserId))
      : undefined

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
                  {pending.length > 0 && `・${pending.length} 人未回覆`}
                </span>
              </div>

              <ul className="space-y-1">
                {attendees.map((a) => {
                  const meta = RSVP_META[a.rsvp]
                  return (
                    <li key={a.memberId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {nameOf(a.memberId)}
                        {a.memberId === String(currentUserId) && (
                          <span className="ml-1 text-xs text-muted-foreground">（我）</span>
                        )}
                      </span>
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

              {myAttendance && !event.canceled && onRespond && (
                <div className="border-t pt-3">
                  <p className="mb-1.5 text-xs text-muted-foreground">我的回覆</p>
                  <div className="flex gap-1.5">
                    {MY_RSVP_CHOICES.map((choice) => (
                      <Button
                        key={choice.dto}
                        size="sm"
                        variant={myAttendance.rsvp === choice.local ? 'default' : 'outline'}
                        className="flex-1"
                        disabled={isPending}
                        onClick={() => onRespond(event.id, choice.dto)}
                      >
                        {choice.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {event.kind === 'meeting' && (
          <DialogFooter>
            {canManage && !event.canceled && onCancel && (
              <Button
                variant="destructive"
                disabled={isPending}
                onClick={() => onCancel(event.id)}
              >
                取消會議
              </Button>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              關閉
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
