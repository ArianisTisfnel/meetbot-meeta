'use client'
import { useBotReinvite } from '@/hooks/use-meeting'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface Props {
  projectId: string | null
  meetingId: string
  variant?: 'default' | 'outline'
  label?: string
}

export function ReinviteBotButton({
  projectId,
  meetingId,
  variant = 'default',
  label = '重新邀請蜜塔',
}: Props) {
  const reinvite = useBotReinvite(projectId, meetingId)

  const handleReinvite = () => {
    reinvite.mutate(undefined, {
      onSuccess: () => toast.success('已重新邀請蜜塔，加入中…'),
      onError: (err: any) => toast.error(err?.message ?? '重新邀請失敗'),
    })
  }

  return (
    <Button variant={variant} onClick={handleReinvite} disabled={reinvite.isPending}>
      {reinvite.isPending ? '邀請中…' : `🔄 ${label}`}
    </Button>
  )
}
