'use client'
import { useRouter } from 'next/navigation'
import { EditableMeetingName } from './editable-meeting-name'
import { formatDate } from '@/lib/utils'
import type { MeetingListItem } from '@/types/api'

interface Props {
  meetings: MeetingListItem[]
}

/**
 * 會後摘要列表：只列已結束的會議，點整列進入會議詳情（含摘要）。
 * 名稱欄可就地改名，專案欄顯示所屬專案。
 */
export function SummaryList({ meetings }: Props) {
  const router = useRouter()

  if (meetings.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-12">
        尚無會後摘要，會議結束後會自動出現在這裡
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-3 px-4">會議名稱</th>
            <th className="py-3 px-4">專案</th>
            <th className="py-3 px-4">時間</th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((m) => (
            <tr
              key={m.id}
              onClick={() => router.push(`/meetings/${m.id}`)}
              className="cursor-pointer border-b transition-colors hover:bg-muted/50"
            >
              <td className="py-3 px-4 font-medium">
                <EditableMeetingName
                  meetingId={m.id}
                  projectId={m.projectId}
                  name={m.name}
                />
              </td>
              <td className="py-3 px-4 text-muted-foreground">
                {m.projectName ?? '（無關聯專案）'}
              </td>
              <td className="py-3 px-4 text-muted-foreground text-sm">
                {formatDate(m.startedAt ?? m.createdAt)}
                {m.endedAt && ` ~ ${formatDate(m.endedAt)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
