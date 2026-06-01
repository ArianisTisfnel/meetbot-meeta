import type { MeetingStatus } from '@/types/api'

interface Props {
  status: MeetingStatus
}

// 注意：此狀態代表「蜜塔（Bot）的加入狀態」，而非 Google Meet 會議本身的狀態。
// 系統只能透過蜜塔的 WebSocket 事件觀測會議，無法獨立得知會議真實狀態。
const STATUS_CONFIG: Record<MeetingStatus, { icon: string; label: string; color: string }> = {
  PENDING: { icon: '⏳', label: '蜜塔加入中', color: 'text-yellow-600' },
  ACTIVE:  { icon: '🟢', label: '蜜塔在會議中', color: 'text-green-600' },
  ENDED:   { icon: '⚪', label: '蜜塔已離開', color: 'text-gray-500' },
  FAILED:  { icon: '❌', label: '蜜塔加入失敗', color: 'text-red-600' },
}

const FALLBACK = { icon: '❔', label: '未知狀態', color: 'text-muted-foreground' }

export function BotStatusIndicator({ status }: Props) {
  const { icon, label, color } = STATUS_CONFIG[status] ?? FALLBACK
  return (
    <span className={`inline-flex items-center gap-1 text-sm ${color}`} title="蜜塔（Bot）狀態">
      {icon} {label}
    </span>
  )
}
