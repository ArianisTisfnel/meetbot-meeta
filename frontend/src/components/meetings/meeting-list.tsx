'use client'
import { MeetingRow } from './meeting-row'
import type { MeetingListItem } from '@/types/api'

interface Props {
  meetings: MeetingListItem[]
  projectId?: string
}

export function MeetingList({ meetings, projectId }: Props) {
  if (meetings.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-12">
        尚無會議記錄
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-3 px-4">狀態</th>
            <th className="py-3 px-4">名稱</th>
            {!projectId && <th className="py-3 px-4">專案</th>}
            <th className="py-3 px-4">時間</th>
            <th className="py-3 px-4"></th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((m) => (
            <MeetingRow key={m.id} meeting={m} projectId={projectId} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
