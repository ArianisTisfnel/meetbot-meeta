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
 * 可就地編輯的專案名稱。canEdit 時，名稱左側顯示非 emoji 鉛筆符號 ✎ 提示可編輯，
 * 點擊名稱或鉛筆即進入編輯。所有互動都 stopPropagation，可安全用於可點擊的卡片內。
 */
export function EditableProjectName({ projectId, name, canEdit, className }: Props) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const update = useUpdateProject(projectId)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
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

  return (
    <span className="inline-flex items-center gap-1">
      {canEdit && (
        <button
          type="button"
          onClick={startEdit}
          aria-label="重新命名專案"
          title="重新命名"
          className="text-muted-foreground hover:text-foreground font-serif leading-none"
        >
          {'✎'}
        </button>
      )}
      <span
        className={
          (className ?? '') + (canEdit ? ' cursor-text hover:underline decoration-dotted' : '')
        }
        title={canEdit ? '點擊以重新命名' : undefined}
        onClick={startEdit}
      >
        {name}
      </span>
    </span>
  )
}
