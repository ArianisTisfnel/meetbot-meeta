'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ActionItem } from '@/types/api'
import { meetingTranscriptQueryOptions } from '@/hooks/use-meeting'
import { DownloadIcon, ChevronDownIcon, DocIcon, ReportIcon } from '@/components/ui/icons'
import { apiClient } from '@/lib/api-client'
import { cn, downloadBlob, downloadTextFile, todayDateString } from '@/lib/utils'
import { stripLegacyMarkdown } from './meeting-transcript'
import { toast } from 'sonner'

interface Props {
  projectId: string | null
  meetingId: string
  hasTranscript: boolean
  summary: string | null
  actionItems: ActionItem[]
  keyTopics?: string[] | null
  decisions?: string[] | null
}

/** 要下載什麼內容。full = 報告 + 逐字稿合成一份。 */
type Kind = 'full' | 'report' | 'transcript'
const FORMATS = [
  { id: 'pdf', label: 'PDF' },
  { id: 'md', label: 'Markdown' },
  { id: 'txt', label: 'TXT' },
] as const
type Format = (typeof FORMATS)[number]['id']

/**
 * 會議報告的內容組裝。三種格式共用同一份，差別只在標題怎麼寫：
 * 純文字用「【摘要】」，Markdown 用「## 摘要」。空的區塊一律略過（沒有決議就不要
 * 印一個空標題）。交辦事項帶上完成狀態，會後追蹤才看得出哪些做完了。
 */
function buildReportDocument(params: {
  summary: string
  actionItems: ActionItem[]
  keyTopics: string[]
  decisions: string[]
  markdown?: boolean
}): string {
  const sections: Array<{ title: string; body: string } | false> = [
    { title: '摘要', body: params.summary },
    params.actionItems.length > 0 && {
      title: '交辦事項',
      body: params.actionItems
        .map((item) => {
          const mark = item.done ? '[x]' : '[ ]'
          return item.owner ? `${mark} ${item.task}（${item.owner}）` : `${mark} ${item.task}`
        })
        .join('\n'),
    },
    params.keyTopics.length > 0 && {
      title: '重點主題',
      body: params.keyTopics.map((t) => `- ${t}`).join('\n'),
    },
    params.decisions.length > 0 && {
      title: '會議決議',
      body: params.decisions.map((d) => `- ${d}`).join('\n'),
    },
  ]
  return sections
    .filter((s): s is { title: string; body: string } => s !== false)
    .map((s) => (params.markdown ? `## ${s.title}\n\n${s.body}` : `【${s.title}】\n${s.body}`))
    .join('\n\n')
}

/** 完整會議紀錄＝報告在前、逐字稿在後，中間補一個標題分隔。 */
function joinFullRecord(report: string, transcript: string, markdown: boolean): string {
  const heading = markdown ? '## 會議逐字稿' : '【會議逐字稿】'
  return `${report}\n\n${heading}\n\n${transcript}`
}

/**
 * 把一段文字依格式送出去。
 *
 * PDF 走後端 POST /pdf（PDFKit + 伺服器端的思源黑體，執行期自動子集化）。
 * 為什麼不在前端產：PDF 標準 14 字型完全不含中文，前端方案一律要使用者多下載
 * 1.5–6 MB 字型，而 jsPDF 還不做子集化（每份 PDF 都 3 MB+）。放後端的話前端
 * bundle 增加 0 KB，每份 PDF 只帶「這份用到的字」，約 70–450 KB。
 */
async function emitDocument(baseName: string, text: string, format: Format): Promise<void> {
  const stamp = todayDateString()
  if (format === 'pdf') {
    // title 不串日期：後端會另外印一行台灣時間的日期，串了會出現兩次
    const blob = await apiClient.postBlob('/pdf', { title: baseName, text })
    downloadBlob(`${baseName}-${stamp}.pdf`, blob)
    return
  }
  downloadTextFile(
    `${baseName}-${stamp}.${format}`,
    text,
    format === 'md' ? 'text/markdown;charset=utf-8' : undefined,
  )
}

/**
 * 一列＝一種內容，格式按鈕直接攤在它下面。
 *
 * 刻意不做子選單／對話框：下載是一次性動作，多一層就多一次點擊與一次記憶負擔。
 * 三列全部攤開，使用者一眼看得到所有選項，兩下點擊就拿到檔案。
 */
function DownloadRow({
  icon,
  label,
  hint,
  disabled,
  busy,
  onPick,
}: {
  icon: ReactNode
  label: string
  hint: string
  disabled: boolean
  busy: boolean
  onPick: (format: Format) => void
}) {
  return (
    <div className={cn('rounded-md p-2', disabled && 'opacity-50')}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-honey-deep">
          {icon}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">{hint}</span>
        </span>
      </div>
      <div className="mt-2 flex gap-1.5 pl-[38px]">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="menuitem"
            disabled={disabled || busy}
            onClick={() => onPick(f.id)}
            className="flex-1 rounded-md border border-border py-1.5 text-xs font-medium transition-colors hover:border-honey-deep hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 下載選單：三種內容 × 三種格式，全部攤在同一個面板上。
 *
 * 逐字稿是懶載入——選了才發請求（走 fetchQuery，與畫面上的逐字稿共用同一份快取），
 * 避免每次進頁面都拉一份用不到的逐字稿。
 */
export function MeetingDownloadMenu({
  projectId,
  meetingId,
  hasTranscript,
  summary,
  actionItems,
  keyTopics,
  decisions,
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const reportReady = typeof summary === 'string' && summary.length > 0
  // summary sentinel：null = 還在生成（前端仍在輪詢）；'' = 已嘗試但無內容，不會再有
  const reportHint = reportReady
    ? '摘要、交辦事項與決議整理'
    : summary === null
      ? '摘要生成中'
      : '此次會議無摘要'

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, close])

  const composeReport = (markdown: boolean): string =>
    buildReportDocument({
      summary: summary ?? '',
      actionItems,
      keyTopics: keyTopics ?? [],
      decisions: decisions ?? [],
      markdown,
    })

  /** 逐字稿內容：懶載入，取不到就丟錯讓呼叫端統一處理。 */
  const fetchTranscript = async (): Promise<string> => {
    const data = await queryClient.fetchQuery(meetingTranscriptQueryOptions(projectId, meetingId))
    if (!data.markdown) throw new Error('此次會議無逐字稿內容')
    // 後端 formatTranscriptAsMarkdown 產出的其實是純文字（[00:12] 說話者: 內容），
    // 沒有 markdown 語法，所以逐字稿的 Markdown 版目前只是換副檔名與 mime type。
    return stripLegacyMarkdown(data.markdown)
  }

  const handlePick = async (kind: Kind, format: Format) => {
    close()
    if (busy) return
    setBusy(true)
    // 逐字稿要打 Storage、PDF 要打後端，兩者都可能等上數秒 → 一律先給 loading
    const toastId = toast.loading('正在準備檔案…')
    try {
      const markdown = format === 'md'
      let baseName: string
      let text: string
      if (kind === 'report') {
        baseName = '會議報告'
        text = composeReport(markdown)
      } else if (kind === 'transcript') {
        baseName = '會議逐字稿'
        text = await fetchTranscript()
      } else {
        baseName = '完整會議紀錄'
        text = joinFullRecord(composeReport(markdown), await fetchTranscript(), markdown)
      }
      await emitDocument(baseName, text, format)
      toast.success(`已下載${baseName}`, { id: toastId })
    } catch (err: any) {
      toast.error(err?.message ?? '下載失敗，請稍後再試', { id: toastId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-transparent px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          open && 'border-honey-deep bg-accent',
        )}
      >
        <DownloadIcon className="size-3.5" />
        {busy ? '準備中…' : '下載'}
        <ChevronDownIcon className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="下載選項"
          className="absolute left-0 top-[calc(100%+8px)] z-20 w-80 rounded-lg border bg-popover p-1.5 shadow-lg"
        >
          <DownloadRow
            icon={<ReportIcon className="size-3.5" />}
            label="完整會議紀錄"
            hint={
              reportReady && hasTranscript
                ? '報告 + 逐字稿，寄給沒參加的人最省事'
                : '需要報告與逐字稿都齊全'
            }
            disabled={!reportReady || !hasTranscript}
            busy={busy}
            onPick={(f) => handlePick('full', f)}
          />
          <div className="my-1 h-px bg-border" />
          <DownloadRow
            icon={<ReportIcon className="size-3.5" />}
            label="會議報告"
            hint={reportHint}
            disabled={!reportReady}
            busy={busy}
            onPick={(f) => handlePick('report', f)}
          />
          <div className="my-1 h-px bg-border" />
          <DownloadRow
            icon={<DocIcon className="size-3.5" />}
            label="會議逐字稿"
            hint={hasTranscript ? '完整發言紀錄' : '此次會議無逐字稿'}
            disabled={!hasTranscript}
            busy={busy}
            onPick={(f) => handlePick('transcript', f)}
          />
        </div>
      )}
    </div>
  )
}
