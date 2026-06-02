'use client'
import Link from 'next/link'
import { BotStatusIndicator } from './bot-status-indicator'
import { EndMeetingButton } from './end-meeting-button'
import { ReinviteBotButton } from './reinvite-bot-button'
import { formatDate } from '@/lib/utils'
import type { MeetingListItem } from '@/types/api'

interface Props {
  meeting: MeetingListItem
  projectId?: string
  /** 是否顯示進行中會議的「結束」快捷鍵 */
  canEnd?: boolean
}

export function MeetingRow({ meeting, projectId, canEnd }: Props) {
  const href = projectId
    ? `/projects/${projectId}/meetings/${meeting.id}`
    : `/meetings/${meeting.id}`

  return (
    <tr className="border-b hover:bg-muted/50">
      <td className="py-3 px-4">
        <BotStatusIndicator status={meeting.status} />
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
          {canEnd && (meeting.status === 'FAILED' || meeting.status === 'ENDED') && (
            <ReinviteBotButton
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
              className="text-primary hover:underline text-sm whitespace-nowrap"
              title="在新分頁開啟 Google Meet 通話"
            >
              加入會議 ↗
            </a>
          )}
          <Link href={href} className="text-primary hover:underline text-sm">
            進入 →
          </Link>
        </div>
      </td>
    </tr>
  )
}
