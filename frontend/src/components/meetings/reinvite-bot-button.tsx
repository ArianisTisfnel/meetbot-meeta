'use client'
import { useBotReinvite } from '@/hooks/use-meeting'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface Props {
  projectId: string | null
  meetingId: string
  variant?: 'default' | 'outline'
  label?: string
  /** 緊湊模式：用於列表列 */
  compact?: boolean
}

export function ReinviteBotButton({
  projectId,
  meetingId,
  variant = 'default',
  label = '重新邀請蜜塔',
  compact,
}: Props) {
  const reinvite = useBotReinvite(projectId, meetingId)

  const handleReinvite = (e: React.MouseEvent) => {
    e.stopPropagation()
    reinvite.mutate(undefined, {
      onSuccess: () => toast.success('已重新邀請蜜塔，加入中…'),
      onError: (err: any) => toast.error(err?.message ?? '重新邀請失敗'),
    })
  }

  return (
    <Button
      variant={compact ? 'outline' : variant}
      size={compact ? 'sm' : undefined}
      onClick={handleReinvite}
      disabled={reinvite.isPending}
      className={compact ? 'h-7 px-2 text-xs' : undefined}
    >
      {reinvite.isPending ? '邀請中…' : compact ? '🔄 重邀' : `🔄 ${label}`}
    </Button>
  )
}
