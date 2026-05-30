'use client'
import { use } from 'react'
import { useHistory } from '@/hooks/use-history'
import { formatDate } from '@/lib/utils'

interface Props {
  params: Promise<{ projectId: string }>
}

const ACTION_ICONS: Record<string, string> = {
  UPLOAD: '📤 上傳',
  DELETE: '🗑 刪除',
}

export default function HistoryPage({ params }: Props) {
  const { projectId } = use(params)
  const { data, isLoading } = useHistory(projectId)

  return (
    <div>
      <h2 className="font-semibold mb-6">編輯歷史</h2>

      {isLoading ? (
        <p className="text-muted-foreground">載入中…</p>
      ) : data?.items.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">尚無歷史紀錄</p>
      ) : (
        <div className="space-y-2">
          {data?.items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-4 text-sm py-2 border-b"
            >
              <span className="text-muted-foreground w-40 shrink-0">
                {formatDate(item.performedAt)}
              </span>
              <span className="w-24 shrink-0">
                {item.performedBy.name ?? item.performedBy.email}
              </span>
              <span className="text-muted-foreground w-20 shrink-0">
                {ACTION_ICONS[item.action] ?? item.action}
              </span>
              <span className="font-medium">{item.filenameSnapshot}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
