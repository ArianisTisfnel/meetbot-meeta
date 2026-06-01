'use client'
import { useBotLeave } from '@/hooks/use-meeting'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface Props {
  projectId: string | null
  meetingId: string
  /** 緊湊模式：用於列表列 */
  compact?: boolean
}

export function EndMeetingButton({ projectId, meetingId, compact }: Props) {
  const botLeave = useBotLeave(projectId, meetingId)

  const handleEnd = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('確定要讓蜜塔離開並結束此會議嗎？結束後會自動生成摘要。')) return
    botLeave.mutate(undefined, {
      onSuccess: () => toast.success('蜜塔已離開，摘要生成中…'),
      onError: (err: any) => toast.error(err?.message ?? '操作失敗'),
    })
  }

  return (
    <Button
      variant="destructive"
      size="sm"
      onClick={handleEnd}
      disabled={botLeave.isPending}
      className={compact ? 'h-7 px-2 text-xs' : undefined}
    >
      {botLeave.isPending ? '結束中…' : '結束會議'}
    </Button>
  )
}
