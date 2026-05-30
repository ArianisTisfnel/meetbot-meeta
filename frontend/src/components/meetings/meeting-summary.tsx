'use client'
import type { ActionItem } from '@/types/api'

interface Props {
  summary: string | null
  actionItems: ActionItem[]
}

export function MeetingSummary({ summary, actionItems }: Props) {
  if (summary === null) {
    return (
      <div className="rounded-lg border p-6 text-center text-muted-foreground">
        <p className="animate-pulse">⏳ 蜜塔正在生成會議摘要…（通常需要 10-30 秒）</p>
      </div>
    )
  }

  if (summary === '') {
    return (
      <div className="rounded-lg border p-6 text-center text-muted-foreground">
        <p>此次會議無摘要可顯示</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="rounded-lg border p-6">
        <h3 className="font-semibold mb-3">📋 摘要</h3>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>
      </div>
      {actionItems.length > 0 && (
        <div className="rounded-lg border p-6">
          <h3 className="font-semibold mb-3">🔖 交辦事項</h3>
          <ul className="space-y-2">
            {actionItems.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span>☐</span>
                <span>
                  {item.task}
                  {item.owner && (
                    <span className="text-muted-foreground ml-1">
                      （{item.owner}）
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
