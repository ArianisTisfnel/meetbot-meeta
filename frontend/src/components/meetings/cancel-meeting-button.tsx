'use client'
import { useCancelMeeting } from '@/hooks/use-meeting'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface Props {
  projectId: string | null
  meetingId: string
  /** 緊湊模式：用於列表列 */
  compact?: boolean
}

export function CancelMeetingButton({ projectId, meetingId, compact }: Props) {
  const cancel = useCancelMeeting(projectId, meetingId)

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('確定要取消這場等待中的會議嗎？蜜塔會停止加入。')) return
    cancel.mutate(undefined, {
      onSuccess: () => toast.success('已取消會議'),
      onError: (err: any) => toast.error(err?.message ?? '取消失敗'),
    })
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCancel}
      disabled={cancel.isPending}
      className={compact ? 'h-7 px-2 text-xs' : undefined}
    >
      {cancel.isPending ? '取消中…' : '取消'}
    </Button>
  )
}
