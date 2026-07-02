'use client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { BotStatusIndicator } from './bot-status-indicator'
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

export function MeetingRow({ meeting, projectId, canEnd }: Props) {
  const router = useRouter()
  const href = projectId
    ? `/projects/${projectId}/meetings/${meeting.id}`
    : `/meetings/${meeting.id}`

  const isFinished = meeting.status === 'FAILED' || meeting.status === 'ENDED'

  return (
    <tr
      onClick={() => router.push(href)}
      className="cursor-pointer border-b transition-colors hover:bg-muted/50"
    >
      <td className="py-3 px-4">
        <BotStatusIndicator status={meeting.status} href={href} />
      </td>
      <td className="py-3 px-4 font-medium">
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="rounded hover:text-honey-deep hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {meeting.name}
        </Link>
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
      </td>
    </tr>
  )
}
