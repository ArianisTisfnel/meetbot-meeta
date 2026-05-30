import type { MeetingStatus } from '@/types/api'

interface Props {
  status: MeetingStatus
}

const STATUS_CONFIG: Record<MeetingStatus, { icon: string; label: string; color: string }> = {
  PENDING:  { icon: '⏳', label: '邀請中',   color: 'text-yellow-600' },
  ACTIVE:   { icon: '🟢', label: '進行中',   color: 'text-green-600' },
  ENDED:    { icon: '✅', label: '已結束',   color: 'text-gray-500' },
  FAILED:   { icon: '❌', label: '建立失敗', color: 'text-red-600' },
}

export function BotStatusIndicator({ status }: Props) {
  const { icon, label, color } = STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1 text-sm ${color}`}>
      {icon} {label}
    </span>
  )
}
