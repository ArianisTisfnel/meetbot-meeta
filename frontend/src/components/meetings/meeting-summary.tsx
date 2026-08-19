'use client'
import type { ActionItem } from '@/types/api'
import { CopyIcon } from '@/components/ui/icons'
import { toast } from 'sonner'

interface Props {
  summary: string | null
  actionItems: ActionItem[]
  keyTopics?: string[] | null
  decisions?: string[] | null
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`已複製${label}`)
    } catch {
      toast.error('複製失敗，請手動選取文字')
    }
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded text-sm text-honey-deep hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CopyIcon className="size-3.5" />
      複製
    </button>
  )
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

  const summaryText = summary
  const actionItemsText = actionItems
    .map((item) => (item.owner ? `- ${item.task}（${item.owner}）` : `- ${item.task}`))
    .join('\n')
  const topicsText = topics.map((t) => `- ${t}`).join('\n')
  const decisionsText = decisionList.map((d) => `- ${d}`).join('\n')

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="rounded-lg border p-6">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-semibold">摘要</h3>
          <CopyButton text={summaryText} label="摘要" />
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>
      </div>
      {actionItems.length > 0 && (
        <div className="rounded-lg border p-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-semibold">交辦事項</h3>
            <CopyButton text={actionItemsText} label="交辦事項" />
          </div>
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
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-semibold">重點主題</h3>
            <CopyButton text={topicsText} label="重點主題" />
          </div>
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
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-semibold">會議決議</h3>
            <CopyButton text={decisionsText} label="會議決議" />
          </div>
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
