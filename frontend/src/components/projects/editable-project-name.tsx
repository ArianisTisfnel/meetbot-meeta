'use client'
import { useState, useRef, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { useUpdateProject } from '@/hooks/use-projects'
import { toast } from 'sonner'

interface Props {
  projectId: string
  name: string
  canEdit: boolean
  /** 名稱文字的樣式（讓呼叫端決定大小 / 粗細） */
  className?: string
}

/**
 * 可就地編輯的專案名稱。canEdit 時，整個「✎ + 名稱」是單一按鈕，
 * 點擊或鍵盤啟動皆進入編輯。輸入框的鍵盤事件 stopPropagation，
 * 避免 Enter/Escape 觸發外層卡片的行為。
 */
export function EditableProjectName({ projectId, name, canEdit, className }: Props) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const update = useUpdateProject(projectId)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const startEdit = () => {
    if (!canEdit) return
    setValue(name)
    setEditing(true)
  }

  const submit = async () => {
    const trimmed = value.trim()
    setEditing(false)
    if (!trimmed || trimmed === name) return
    try {
      await update.mutateAsync(trimmed)
      toast.success('已更新專案名稱')
    } catch (err: any) {
      toast.error(err?.message ?? '更新失敗')
      setValue(name)
    }
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        aria-label="專案名稱"
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
        disabled={update.isPending}
      />
    )
  }

  if (!canEdit) {
    return <span className={className}>{name}</span>
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      aria-label={`重新命名專案「${name}」`}
      title="重新命名"
      className="group inline-flex min-w-0 items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className="font-serif leading-none text-muted-foreground transition-colors group-hover:text-foreground"
      >
        {'✎'}
      </span>
      <span
        className={
          (className ?? '') + ' hover:underline decoration-dotted'
        }
      >
        {name}
      </span>
    </button>
  )
}
