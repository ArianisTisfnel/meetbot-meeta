'use client'
import { useState, useRef, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { useRenameMeeting } from '@/hooks/use-meeting'
import { toast } from 'sonner'

interface Props {
  meetingId: string
  projectId?: string | null
  name: string
  /** 名稱文字的樣式（讓呼叫端決定大小 / 粗細） */
  className?: string
}

/**
 * 可就地編輯的會議名稱（用於會後摘要列表）。
 * 「✎ + 名稱」是單一按鈕，點擊或鍵盤啟動皆進入編輯；
 * 所有互動事件 stopPropagation，避免觸發外層列的導頁。
 * 權限由後端把關（專案會議需 canMeeting、全局會議限建立者），失敗時 toast 顯示原因。
 */
export function EditableMeetingName({ meetingId, projectId, name, className }: Props) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const rename = useRenameMeeting(projectId ?? null, meetingId)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const submit = async () => {
    const trimmed = value.trim()
    setEditing(false)
    if (!trimmed || trimmed === name) return
    try {
      await rename.mutateAsync(trimmed)
      toast.success('已更新會議名稱')
    } catch (err: any) {
      toast.error(err?.message ?? '更新失敗')
      setValue(name)
    }
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        aria-label="會議名稱"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            setValue(name)
            setEditing(false)
          }
        }}
        onBlur={submit}
        className="h-8 max-w-xs"
        disabled={rename.isPending}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        setValue(name)
        setEditing(true)
      }}
      aria-label={`重新命名會議「${name}」`}
      title="重新命名"
      className="group inline-flex min-w-0 items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className="font-serif leading-none text-muted-foreground transition-colors group-hover:text-foreground"
      >
        {'✎'}
      </span>
      <span className={(className ?? '') + ' hover:underline decoration-dotted'}>
        {name}
      </span>
    </button>
  )
}
