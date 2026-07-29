'use client'
import { useRouter } from 'next/navigation'
import { useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { BotStatusIndicator, statusHint } from './bot-status-indicator'
import { EndMeetingButton } from './end-meeting-button'
import { CancelMeetingButton } from './cancel-meeting-button'
import { ReinviteBotButton } from './reinvite-bot-button'
import { DeleteMeetingButton } from './delete-meeting-button'
import { EditableMeetingName } from './editable-meeting-name'
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
  // 提示框跟著游標走：enter 時以 state 掛載，move 時直接寫 DOM style，避免每個 pixel 都 re-render。
  const hint = statusHint(meeting.status)
  const tipRef = useRef<HTMLSpanElement>(null)
  const [tipStyle, setTipStyle] = useState<CSSProperties | null>(null)

  const cursorTipStyle = (e: MouseEvent<HTMLTableRowElement>): CSSProperties => {
    const left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - TOOLTIP_WIDTH - 8))
    // 靠近視窗底部時翻到游標上方，避免被裁切
    if (window.innerHeight - e.clientY < 140) {
      return { position: 'fixed', left, top: e.clientY - 12, transform: 'translateY(-100%)' }
    }
    return { position: 'fixed', left, top: e.clientY + 18, transform: '' }
  }

  const showTip = (e: MouseEvent<HTMLTableRowElement>) => setTipStyle(cursorTipStyle(e))
  const moveTip = (e: MouseEvent<HTMLTableRowElement>) => {
    const el = tipRef.current
    if (!el) return
    const s = cursorTipStyle(e)
    el.style.left = `${s.left}px`
    el.style.top = `${s.top}px`
    el.style.transform = String(s.transform)
  }

  return (
    <tr
      onClick={() => router.push(href)}
      onMouseEnter={showTip}
      onMouseMove={moveTip}
      onMouseLeave={() => setTipStyle(null)}
      className="cursor-pointer border-b transition-colors hover:bg-muted/50"
    >
      <td className="py-3 px-4">
        <BotStatusIndicator status={meeting.status} href={href} showHint={false} />
      </td>
      <td className="py-3 px-4 font-medium">
        <EditableMeetingName
          meetingId={meeting.id}
          projectId={projectId ?? meeting.projectId}
          name={meeting.name}
        />
      </td>
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
              ref={tipRef}
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
