'use client'
import { use } from 'react'
import { useHistory } from '@/hooks/use-history'
import { formatDate, displayName } from '@/lib/utils'
import type { ActivityAction } from '@/types/api'

interface Props {
  params: Promise<{ projectId: string }>
}

const ACTION_CONFIG: Record<ActivityAction, { icon: string; label: string }> = {
  MATERIAL_UPLOAD:          { icon: '📤', label: '上傳資料' },
  MATERIAL_DELETE:          { icon: '🗑', label: '刪除資料' },
  MEMBER_ADD:               { icon: '➕', label: '加入成員' },
  MEMBER_REMOVE:            { icon: '➖', label: '移除成員' },
  MEMBER_PERMISSION_UPDATE: { icon: '🔧', label: '調整權限' },
  MEETING_CREATE:           { icon: '📹', label: '建立會議' },
  PROJECT_RENAME:           { icon: '✏️', label: '重新命名專案' },
}

export default function HistoryPage({ params }: Props) {
  const { projectId } = use(params)
  const { data, isLoading } = useHistory(projectId)

  return (
    <div>
      <h2 className="font-semibold mb-6">活動紀錄</h2>

      {isLoading ? (
        <p className="text-muted-foreground">載入中…</p>
      ) : data?.items.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">尚無活動紀錄</p>
      ) : (
        <div className="space-y-2">
          {data?.items.map((item) => {
            const cfg = ACTION_CONFIG[item.action] ?? { icon: '•', label: item.action }
            return (
              <div
                key={item.id}
                className="flex items-center gap-4 text-sm py-2 border-b"
              >
                <span className="text-muted-foreground w-40 shrink-0">
                  {formatDate(item.createdAt)}
                </span>
                <span className="w-28 shrink-0 truncate" title={displayName(item.actor.name, item.actor.email)}>
                  {displayName(item.actor.name, item.actor.email)}
                </span>
                <span className="w-28 shrink-0">
                  {cfg.icon} {cfg.label}
                </span>
                <span className="font-medium truncate">{item.targetLabel}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
