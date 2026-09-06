'use client'
import { useState, useRef, useEffect, type ReactNode } from 'react'
import type { ActionItem } from '@/types/api'
import { CopyIcon, PencilIcon, PlusIcon } from '@/components/ui/icons'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { useUpdateMeeting } from '@/hooks/use-meeting'
import { toast } from 'sonner'

interface Props {
  meetingId: string
  projectId?: string | null
  summary: string | null
  actionItems: ActionItem[]
  keyTopics?: string[] | null
  decisions?: string[] | null
}

/** 摘要卡可以送出的 patch（欄位名與後端 PATCH /meetings/:id 一致）。 */
type SummaryPatch = {
  summary?: string
  actionItems?: ActionItem[]
  keyTopics?: string[]
  decisions?: string[]
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

/**
 * 可就地編輯的卡片。四張卡（摘要／交辦事項／重點主題／會議決議）共用這一個殼，
 * 差別只在 toText / fromText 怎麼把內容跟純文字互轉。
 *
 * 為什麼四張都要能改：內容全是 LLM 生成的、會出錯（實測有把「精品」聽成「競品」
 * 的例子），而且主管在會後常常想自己補一條交辦事項——那不是 AI 漏抓，是會議當下
 * 沒講出口的事。
 *
 * 為什麼空的卡片也要顯示：原本空陣列整張卡直接消失，使用者分不出「這場沒有決議」
 * 和「功能壞了」，也就沒有地方可以動手補。現在改成一個看起來就能點的虛線框，
 * 文案講明是「AI 沒偵測到」而不是「系統沒有」——前者請人接手，後者像故障。
 *
 * 互動刻意與會議改名（EditableMeetingName）不同：那邊是單行、blur 就送出；
 * 這裡是多行，blur 送出會讓「點儲存按鈕」先觸發 blur，行為變得莫名其妙。
 * 所以用明確的儲存／取消按鈕，Escape 取消，Ctrl/⌘+Enter 送出。
 */
function EditableCard({
  meetingId,
  projectId,
  title,
  copyText,
  emptyText,
  isEmpty,
  toText,
  fromText,
  placeholder,
  rows = 8,
  children,
}: {
  meetingId: string
  projectId?: string | null
  title: string
  copyText: string
  emptyText: string
  isEmpty: boolean
  toText: () => string
  fromText: (text: string) => SummaryPatch
  placeholder: string
  rows?: number
  children: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const update = useUpdateMeeting(projectId ?? null, meetingId)

  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  const startEditing = () => {
    setValue(toText())
    setEditing(true)
  }

  const cancel = () => setEditing(false)

  const submit = async () => {
    // 原值比對用 toText()：內容沒動就不要打 API，也不要跳成功 toast
    if (value === toText()) {
      setEditing(false)
      return
    }
    try {
      await update.mutateAsync(fromText(value))
      setEditing(false)
      toast.success(`已更新${title}`)
    } catch (err: any) {
      toast.error(err?.message ?? '更新失敗')
    }
  }

  if (editing) {
    return (
      <div className="rounded-lg border p-6">
        <h3 className="mb-3 font-semibold">{title}</h3>
        <Textarea
          ref={ref}
          aria-label={title}
          value={value}
          rows={rows}
          placeholder={placeholder}
          disabled={update.isPending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          className="text-sm leading-relaxed"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={update.isPending}
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          >
            {update.isPending ? '儲存中…' : '儲存'}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={update.isPending}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            取消
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border p-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        {/* 空的時候不放這兩個按鈕：沒東西可複製，而「新增」的入口是底下那個虛線框 */}
        {!isEmpty && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={startEditing}
              className="inline-flex items-center gap-1 rounded text-sm text-honey-deep hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PencilIcon className="size-3.5" />
              編輯
            </button>
            <CopyButton text={copyText} label={title} />
          </div>
        )}
      </div>
      {isEmpty ? (
        // 空狀態做成看起來就能點的虛線框：只印一句灰字的話，使用者分不出
        // 「這場沒有」與「功能壞了」，也看不出這裡可以自己補。
        <button
          type="button"
          onClick={startEditing}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-line px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-honey-deep hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PlusIcon className="size-3.5 shrink-0" />
          {emptyText}
        </button>
      ) : (
        children
      )}
    </div>
  )
}

/** 一行一項，去掉空行與前後空白。 */
function textToLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * 交辦事項的文字形態：`任務（負責人）`，沒有負責人就只寫任務。
 * 全形與半形括號都收——使用者手打時兩種都會出現。
 */
const ACTION_ITEM_OWNER_REGEX = /^(.*?)[（(]([^（()）]*)[）)]\s*$/

/**
 * 文字轉回交辦事項。`previous` 是編輯前的清單——已完成狀態不在文字裡，
 * 要靠任務文字比對帶回來，否則使用者改個錯字就把所有勾勾清光。
 */
function textToActionItems(text: string, previous: ActionItem[]): ActionItem[] {
  const doneByTask = new Map(previous.filter((i) => i.done).map((i) => [i.task, true]))
  return textToLines(text).map((line) => {
    const m = ACTION_ITEM_OWNER_REGEX.exec(line)
    const task = m && m[1].trim() ? m[1].trim() : line
    const owner = m && m[1].trim() ? m[2].trim() : ''
    return doneByTask.has(task) ? { task, owner, done: true } : { task, owner }
  })
}

/**
 * 交辦事項清單。方框做成**真的可以勾**的核取方塊——原本那個空心方框長得像核取方塊
 * 卻點了沒反應，等於騙使用者。交辦事項本來就是拿來追蹤的，勾完要留得住。
 *
 * done 存在 actionItems 這個 JSON 陣列裡（舊資料沒有這個欄位＝未完成），
 * 勾一下就把整份陣列 PATCH 回去，不需要額外的端點。
 */
function ActionItemList({
  meetingId,
  projectId,
  items,
}: {
  meetingId: string
  projectId?: string | null
  items: ActionItem[]
}) {
  const update = useUpdateMeeting(projectId ?? null, meetingId)

  const toggle = async (index: number) => {
    const next = items.map((item, i) => (i === index ? { ...item, done: !item.done } : item))
    try {
      await update.mutateAsync({ actionItems: next })
    } catch (err: any) {
      toast.error(err?.message ?? '更新失敗')
    }
  }

  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={Boolean(item.done)}
            disabled={update.isPending}
            aria-label={`標記「${item.task}」為${item.done ? '未完成' : '已完成'}`}
            onCheckedChange={() => toggle(i)}
            className="mt-0.5 shrink-0 accent-honey-deep"
          />
          <span className={item.done ? 'text-muted-foreground line-through' : undefined}>
            {item.task}
            {item.owner && <span className="ml-1 text-muted-foreground">（{item.owner}）</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function actionItemsToText(items: ActionItem[]): string {
  return items.map((i) => (i.owner ? `${i.task}（${i.owner}）` : i.task)).join('\n')
}

export function MeetingSummary({
  meetingId,
  projectId,
  summary,
  actionItems,
  keyTopics,
  decisions,
}: Props) {
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

  const topics = keyTopics ?? []
  const decisionList = decisions ?? []

  const actionItemsText = actionItemsToText(actionItems)
  const topicsText = topics.map((t) => `- ${t}`).join('\n')
  const decisionsText = decisionList.map((d) => `- ${d}`).join('\n')

  const cardProps = { meetingId, projectId }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <EditableCard
        {...cardProps}
        title="摘要"
        copyText={summary}
        emptyText="未產出本次會議摘要，點擊此處手動撰寫"
        isEmpty={summary === ''}
        toText={() => summary}
        fromText={(text) => ({ summary: text.trim() })}
        placeholder="這場會議討論了什麼、結論是什麼"
      >
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>
      </EditableCard>

      <EditableCard
        {...cardProps}
        title="交辦事項"
        copyText={actionItemsText}
        emptyText="未擷取到明確交辦事項，點擊此處手動新增"
        isEmpty={actionItems.length === 0}
        toText={() => actionItemsToText(actionItems)}
        fromText={(text) => ({ actionItems: textToActionItems(text, actionItems) })}
        placeholder="例如：週五前把中秋禮盒報價單寄給三家廠商（小蜜）"
        rows={6}
      >
        <ActionItemList meetingId={meetingId} projectId={projectId} items={actionItems} />
      </EditableCard>

      <EditableCard
        {...cardProps}
        title="重點主題"
        copyText={topicsText}
        emptyText="未整理出重點主題，點擊此處手動新增"
        isEmpty={topics.length === 0}
        toText={() => topics.join('\n')}
        fromText={(text) => ({ keyTopics: textToLines(text) })}
        placeholder="例如：暑假檔期人力調度"
        rows={6}
      >
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
      </EditableCard>

      <EditableCard
        {...cardProps}
        title="會議決議"
        copyText={decisionsText}
        emptyText="未擷取到明確決議，點擊此處手動新增"
        isEmpty={decisionList.length === 0}
        toText={() => decisionList.join('\n')}
        fromText={(text) => ({ decisions: textToLines(text) })}
        placeholder="例如：這季廣告預算全押短影音，關鍵字廣告先停"
        rows={6}
      >
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
      </EditableCard>
    </div>
  )
}
