'use client'
import { useRouter } from 'next/navigation'
import { useDeleteMeeting } from '@/hooks/use-meeting'
import { Button } from '@/components/ui/button'
import { TrashIcon } from '@/components/ui/icons'
import { toast } from 'sonner'

interface Props {
  projectId: string | null
  meetingId: string
  /** 緊湊模式：用於列表列 */
  compact?: boolean
  /** 刪除成功後導向此路徑（詳情頁用；列表列不傳，僅刷新列表）。 */
  redirectTo?: string
}

export function DeleteMeetingButton({ projectId, meetingId, compact, redirectTo }: Props) {
  const router = useRouter()
  const del = useDeleteMeeting(projectId, meetingId)

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('確定要刪除這筆會議記錄嗎？摘要與逐字稿將一併移除，且無法復原。')) return
    del.mutate(undefined, {
      onSuccess: () => {
        toast.success('已刪除會議記錄')
        if (redirectTo) router.push(redirectTo)
      },
      onError: (err: any) => toast.error(err?.message ?? '刪除失敗'),
    })
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleDelete}
      disabled={del.isPending}
      className={
        compact
          ? 'h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive'
          : 'gap-1.5 text-destructive hover:text-destructive'
      }
    >
      <TrashIcon className={compact ? 'size-3.5' : 'size-4'} />
      {del.isPending ? '刪除中…' : '刪除'}
    </Button>
  )
}
