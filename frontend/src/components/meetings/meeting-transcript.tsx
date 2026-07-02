'use client'
import { useState } from 'react'
import { useMeetingTranscript } from '@/hooks/use-meeting'

interface Props {
  projectId: string | null
  meetingId: string
  /** meeting.hasTranscript：false 時不顯示此區塊（連請求都不發）。 */
  hasTranscript: boolean
}

/**
 * 會後完整逐字稿（可折疊）。
 * 內容為後端存進 Storage 的 Markdown（`**[mm:ss] speaker**: text` 逐行），
 * 這裡以等寬、保留換行的方式原樣呈現，不做複雜 Markdown 解析。
 */
export function MeetingTranscript({ projectId, meetingId, hasTranscript }: Props) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, isError } = useMeetingTranscript(projectId, meetingId, open && hasTranscript)

  if (!hasTranscript) return null

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-6 py-4 text-left font-semibold"
      >
        <span>會議逐字稿</span>
        <span aria-hidden="true" className="text-muted-foreground">
          {open ? '收合 ▲' : '展開 ▼'}
        </span>
      </button>

      {open && (
        <div className="border-t px-6 py-4">
          {isLoading && <p className="text-sm text-muted-foreground">載入逐字稿中…</p>}
          {isError && <p className="text-sm text-destructive">逐字稿載入失敗，請稍後再試。</p>}
          {!isLoading && !isError && !data?.markdown && (
            <p className="text-sm text-muted-foreground">此次會議無逐字稿內容。</p>
          )}
          {data?.markdown && (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">
              {data.markdown}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
