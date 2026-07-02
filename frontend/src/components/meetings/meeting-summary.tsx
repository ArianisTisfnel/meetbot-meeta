'use client'
import type { ActionItem } from '@/types/api'

interface Props {
  summary: string | null
  actionItems: ActionItem[]
  keyTopics?: string[] | null
  decisions?: string[] | null
}

export function MeetingSummary({ summary, actionItems, keyTopics, decisions }: Props) {
  if (summary === null) {
    return (
      <div
        role="status"
        className="rounded-lg border p-6 text-center text-muted-foreground"
      >
        <p className="flex items-center justify-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-line border-t-honey-deep motion-reduce:animate-none"
          />
          蜜塔正在生成會議摘要…（通常需要 10-30 秒）
        </p>
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

  const topics = keyTopics ?? []
  const decisionList = decisions ?? []

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="rounded-lg border p-6">
        <h3 className="font-semibold mb-3">摘要</h3>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>
      </div>
      {actionItems.length > 0 && (
        <div className="rounded-lg border p-6">
          <h3 className="font-semibold mb-3">交辦事項</h3>
          <ul className="space-y-2">
            {actionItems.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className="mt-1 size-3.5 shrink-0 rounded-sm border-2 border-line"
                />
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
      {topics.length > 0 && (
        <div className="rounded-lg border p-6">
          <h3 className="font-semibold mb-3">重點主題</h3>
          <div className="flex flex-wrap gap-2">
            {topics.map((topic, i) => (
              <span
                key={i}
                className="rounded-full border border-line bg-muted/40 px-3 py-1 text-sm"
              >
                {topic}
              </span>
            ))}
          </div>
        </div>
      )}
      {decisionList.length > 0 && (
        <div className="rounded-lg border p-6">
          <h3 className="font-semibold mb-3">會議決議</h3>
          <ul className="space-y-2">
            {decisionList.map((decision, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className="mt-1 shrink-0 text-honey-deep">
                  ✓
                </span>
                <span>{decision}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
