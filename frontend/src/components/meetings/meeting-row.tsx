'use client'
import { useRouter } from 'next/navigation'
import { useState, type CSSProperties, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { BotStatusIndicator, statusHint } from './bot-status-indicator'
import { EndMeetingButton } from './end-meeting-button'
import { CancelMeetingButton } from './cancel-meeting-button'
import { ReinviteBotButton } from './reinvite-bot-button'
import { DeleteMeetingButton } from './delete-meeting-button'
import { formatDate } from '@/lib/utils'
import type { MeetingListItem } from '@/types/api'

interface Props {
  meeting: MeetingListItem
  projectId?: string
  /** 是否顯示進行中會議的「結束」／FAILED、ENDED 的「重邀」快捷鍵（需 canMeeting 權限） */
  canEnd?: boolean
}

const TOOLTIP_WIDTH = 256 // = w-64

export function MeetingRow({ meeting, projectId, canEnd }: Props) {
  const router = useRouter()
  const href = projectId
    ? `/projects/${projectId}/meetings/${meeting.id}`
    : `/meetings/${meeting.id}`

  const isFinished = meeting.status === 'FAILED' || meeting.status === 'ENDED'

  // 整列 hover 顯示狀態提示（tooltip 用 portal 固定定位，不被表格 overflow 裁切）。
  const hint = statusHint(meeting.status)
  const [tipStyle, setTipStyle] = useState<CSSProperties | null>(null)
  const showTip = (e: MouseEvent<HTMLTableRowElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left + 16, window.innerWidth - TOOLTIP_WIDTH - 8))
    if (window.innerHeight - r.bottom < 120) {
      setTipStyle({ position: 'fixed', left, top: r.top - 6, transform: 'translateY(-100%)' })
    } else {
      setTipStyle({ position: 'fixed', left, top: r.bottom + 6 })
    }
  }

  return (
    <tr
      onClick={() => router.push(href)}
      onMouseEnter={showTip}
      onMouseLeave={() => setTipStyle(null)}
      className="cursor-pointer border-b transition-colors hover:bg-muted/50"
    >
      <td className="py-3 px-4">
        <BotStatusIndicator status={meeting.status} href={href} showHint={false} />
      </td>
      <td className="py-3 px-4 font-medium">{meeting.name}</td>
      {!projectId && (
        <td className="py-3 px-4 text-muted-foreground">
          {meeting.projectName ?? '（無關聯專案）'}
        </td>
      )}
      <td className="py-3 px-4 text-muted-foreground text-sm">
        {formatDate(meeting.startedAt ?? meeting.createdAt)}
        {meeting.endedAt && ` ~ ${formatDate(meeting.endedAt)}`}
      </td>
      <td className="py-3 px-4">
        <div className="flex items-center justify-end gap-3">
          {canEnd && meeting.status === 'ACTIVE' && (
            <EndMeetingButton
              projectId={projectId ?? null}
              meetingId={meeting.id}
              compact
            />
          )}
          {canEnd && meeting.status === 'PENDING' && (
            <CancelMeetingButton
              projectId={projectId ?? null}
              meetingId={meeting.id}
              compact
            />
          )}
          {canEnd && isFinished && (
            <ReinviteBotButton
              projectId={projectId ?? null}
              meetingId={meeting.id}
              compact
            />
          )}
          {meeting.canDelete && isFinished && (
            <DeleteMeetingButton
              projectId={projectId ?? null}
              meetingId={meeting.id}
              compact
            />
          )}
          {meeting.status !== 'ENDED' && meeting.googleMeetUrl && (
            <a
              href={meeting.googleMeetUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-primary hover:underline text-sm whitespace-nowrap"
              title="在新分頁開啟 Google Meet 通話"
            >
              加入會議 ↗
            </a>
          )}
        </div>
        {tipStyle &&
          hint &&
          createPortal(
            <span
              role="tooltip"
              style={tipStyle}
              className="pointer-events-none z-50 block w-64 rounded-md bg-hive px-3 py-2 text-xs leading-relaxed text-hive-fg shadow-lg"
            >
              {hint}
            </span>,
            document.body,
          )}
      </td>
    </tr>
  )
}
