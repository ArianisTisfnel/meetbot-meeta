'use client'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ActionItem } from '@/types/api'
import { meetingTranscriptQueryOptions } from '@/hooks/use-meeting'
import { DownloadIcon, ChevronDownIcon, DocIcon, ReportIcon } from '@/components/ui/icons'
import { cn, downloadTextFile, todayDateString } from '@/lib/utils'
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

function buildReportDocument(params: {
  summary: string
  actionItems: ActionItem[]
  keyTopics: string[]
  decisions: string[]
}): string {
  const sections: Array<{ title: string; body: string } | false> = [
    { title: '摘要', body: params.summary },
    params.actionItems.length > 0 && {
      title: '交辦事項',
      body: params.actionItems
        .map((item) => (item.owner ? `- ${item.task}（${item.owner}）` : `- ${item.task}`))
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
    .map((s) => `【${s.title}】\n${s.body}`)
    .join('\n\n')
}

/**
 * 下載按鈕：點擊彈出「逐字稿／會議報告」二選一選單，點選單以外處或按 Esc 關閉。
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
  const [downloading, setDownloading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const reportReady = typeof summary === 'string' && summary.length > 0

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const handlePickTranscript = async () => {
    setOpen(false)
    if (!hasTranscript || downloading) return
    setDownloading(true)
    // 逐字稿存在 Storage，冷快取時可能等上數秒——先給 loading toast，別讓畫面看起來沒反應
    const toastId = toast.loading('正在準備會議逐字稿…')
    try {
      const data = await queryClient.fetchQuery(
        meetingTranscriptQueryOptions(projectId, meetingId),
      )
      if (!data.markdown) {
        toast.error('此次會議無逐字稿內容', { id: toastId })
        return
      }
      downloadTextFile(`會議逐字稿-${todayDateString()}.txt`, stripLegacyMarkdown(data.markdown))
      toast.success('已下載會議逐字稿', { id: toastId })
    } catch {
      toast.error('逐字稿載入失敗，請稍後再試', { id: toastId })
    } finally {
      setDownloading(false)
    }
  }

  const handlePickReport = () => {
    setOpen(false)
    if (!reportReady || typeof summary !== 'string') return
    const doc = buildReportDocument({
      summary,
      actionItems,
      keyTopics: keyTopics ?? [],
      decisions: decisions ?? [],
    })
    downloadTextFile(`會議報告-${todayDateString()}.txt`, doc)
    toast.success('已下載會議報告')
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={downloading}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-transparent px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          open && 'border-honey-deep bg-accent',
        )}
      >
        <DownloadIcon className="size-3.5" />
        {downloading ? '下載中…' : '下載'}
        <ChevronDownIcon className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+8px)] z-20 w-72 rounded-lg border bg-popover p-1.5 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handlePickTranscript}
            disabled={!hasTranscript || downloading}
            className="flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-honey-deep">
              <DocIcon className="size-3.5" />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">下載會議逐字稿</span>
              <span className="text-xs text-muted-foreground">
                {hasTranscript ? '純文字檔，完整發言紀錄' : '此次會議無逐字稿'}
              </span>
            </span>
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            onClick={handlePickReport}
            disabled={!reportReady}
            className="flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-honey-deep">
              <ReportIcon className="size-3.5" />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">下載會議報告</span>
              <span className="text-xs text-muted-foreground">
                {/* summary sentinel：null = 還在生成（前端仍在輪詢）；'' = 已嘗試但無內容，不會再有 */}
                {reportReady
                  ? '摘要、交辦事項與決議整理'
                  : summary === null
                    ? '摘要生成中'
                    : '此次會議無摘要'}
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
