'use client'
import { MeetingRow } from './meeting-row'
import type { MeetingListItem } from '@/types/api'

interface Props {
  meetings: MeetingListItem[]
  projectId?: string
  /** 是否顯示進行中會議的「結束」快捷鍵（需 canMeeting 權限） */
  canEnd?: boolean
}

export function MeetingList({ meetings, projectId, canEnd }: Props) {
  if (meetings.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-12">
        尚無會議記錄
      </p>
    )
  }

  // 進行中（PENDING 加入中／ACTIVE 在會議中）的會議浮到最上方，方便使用者快速進入；其餘維持原本（伺服器）排序
  const isOngoing = (s: MeetingListItem['status']) => s === 'ACTIVE' || s === 'PENDING'
  const sorted = [...meetings].sort((a, b) => Number(isOngoing(b.status)) - Number(isOngoing(a.status)))

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-3 px-4">蜜塔狀態</th>
            <th className="py-3 px-4">名稱</th>
            {!projectId && <th className="py-3 px-4">專案</th>}
            <th className="py-3 px-4">時間</th>
            <th className="py-3 px-4"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <MeetingRow key={m.id} meeting={m} projectId={projectId} canEnd={canEnd} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
