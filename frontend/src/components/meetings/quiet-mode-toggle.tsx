'use client'
import { useSetQuietMode } from '@/hooks/use-meeting'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface Props {
  projectId: string | null
  meetingId: string
  quietMode: boolean
}

/**
 * 安靜模式切換：開啟後蜜塔不主動插話/破冰，只在被點名時回應。
 * 會議進行中即時生效（後端同步更新 in-memory session 並在聊天室通知）。
 */
export function QuietModeToggle({ projectId, meetingId, quietMode }: Props) {
  const setQuietMode = useSetQuietMode(projectId, meetingId)

  const handleToggle = () => {
    const next = !quietMode
    setQuietMode.mutate(next, {
      onSuccess: () =>
        toast.success(
          next ? '安靜模式已開啟：蜜塔只在被點名時回應' : '安靜模式已解除：蜜塔會適時主動補充'
        ),
      onError: (err: any) => toast.error(err?.message ?? '切換失敗'),
    })
  }

  return (
    <Button
      variant="outline"
      onClick={handleToggle}
      disabled={setQuietMode.isPending}
      className="gap-1.5"
      title={
        quietMode
          ? '蜜塔目前為安靜模式：不主動插話，只在被點名時回應'
          : '開啟後蜜塔不主動插話/破冰，只在被點名時回應'
      }
    >
      {quietMode ? '🔊 解除安靜模式' : '🔇 開啟安靜模式'}
    </Button>
  )
}
