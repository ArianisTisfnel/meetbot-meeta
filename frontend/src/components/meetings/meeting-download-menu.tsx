'use client'
import { useEffect, useRef, useState } from 'react'
import type { ActionItem } from '@/types/api'
import { useMeetingTranscript } from '@/hooks/use-meeting'
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
 * 下載按鈕：點擊彈出「逐字稿／會議報告」二選一選單，點選單以外處關閉。
 * 逐字稿是懶載入——選了才發請求，避免每次進頁面都拉一份用不到的逐字稿。
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
  const [wantTranscript, setWantTranscript] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const reportReady = typeof summary === 'string' && summary.length > 0

  const { data: transcriptData, isError: transcriptError } = useMeetingTranscript(
    projectId,
    meetingId,
    wantTranscript,
  )

  useEffect(() => {
    if (!wantTranscript || !transcriptData) return
    setWantTranscript(false)
    if (!transcriptData.markdown) {
      toast.error('此次會議無逐字稿內容')
      return
    }
    downloadTextFile(`會議逐字稿-${todayDateString()}.txt`, stripLegacyMarkdown(transcriptData.markdown))
    toast.success('已下載會議逐字稿')
  }, [wantTranscript, transcriptData])

  useEffect(() => {
    if (!wantTranscript || !transcriptError) return
    setWantTranscript(false)
    toast.error('逐字稿載入失敗，請稍後再試')
  }, [wantTranscript, transcriptError])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handlePickTranscript = () => {
    setOpen(false)
    if (!hasTranscript) return
    setWantTranscript(true)
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
        aria-expanded={open}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-transparent px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'border-honey-deep bg-accent',
        )}
      >
        <DownloadIcon className="size-3.5" />
        下載
        <ChevronDownIcon className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+8px)] z-20 w-72 rounded-lg border bg-popover p-1.5 shadow-lg">
          <button
            type="button"
            onClick={handlePickTranscript}
            disabled={!hasTranscript}
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
                {reportReady ? '摘要、交辦事項與決議整理' : '摘要尚未生成'}
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
