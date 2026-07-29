'use client'
import { useRouter } from 'next/navigation'
import { useBotReinvite } from '@/hooks/use-meeting'
import { Button } from '@/components/ui/button'
import { RefreshIcon } from '@/components/ui/icons'
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
  const router = useRouter()
  const reinvite = useBotReinvite(projectId, meetingId)

  const handleReinvite = (e: React.MouseEvent) => {
    e.stopPropagation()
    reinvite.mutate(undefined, {
      onSuccess: (data) => {
        toast.success('已重新邀請蜜塔，加入中…')
        // ENDED 會議重邀會另建新會議實例（原紀錄保留），導向新會議頁
        if (data.id !== meetingId) {
          router.push(
            projectId
              ? `/projects/${projectId}/meetings/${data.id}`
              : `/meetings/${data.id}`
          )
        }
      },
      onError: (err: any) => toast.error(err?.message ?? '重新邀請失敗'),
    })
  }

  return (
    <Button
      variant={compact ? 'outline' : variant}
      size={compact ? 'sm' : undefined}
      onClick={handleReinvite}
      disabled={reinvite.isPending}
      className={compact ? 'h-7 gap-1 px-2 text-xs' : 'gap-1.5'}
    >
      <RefreshIcon className={compact ? 'size-3.5' : 'size-4'} />
      {reinvite.isPending ? '邀請中…' : compact ? '重邀' : label}
    </Button>
  )
}
