'use client'
import Link from 'next/link'
import { BotStatusIndicator } from './bot-status-indicator'
import { formatDate } from '@/lib/utils'
import type { MeetingListItem } from '@/types/api'

interface Props {
  meeting: MeetingListItem
  projectId?: string
}

export function MeetingRow({ meeting, projectId }: Props) {
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
        <Link
          href={href}
          className="text-primary hover:underline text-sm"
        >
          進入 →
        </Link>
      </td>
    </tr>
  )
}
