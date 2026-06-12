import Link from 'next/link'
import { HoverHint } from '@/components/ui/hover-hint'
import type { MeetingStatus } from '@/types/api'

// 注意：此狀態代表「蜜塔（Bot）的加入狀態」，而非 Google Meet 會議本身的狀態。
// 系統只能透過蜜塔的 WebSocket 事件觀測會議，無法獨立得知會議真實狀態。
const STATUS_CONFIG: Record<
  MeetingStatus,
  { icon: string; label: string; color: string; hint: string }
> = {
  PENDING: {
    icon: '⏳',
    label: '蜜塔加入中',
    color: 'text-yellow-600',
    hint: '蜜塔正在嘗試加入會議。若遲遲沒進來，可在右側「取消」後重試。',
  },
  ACTIVE: {
    icon: '🟢',
    label: '蜜塔在會議中',
    color: 'text-green-600',
    hint: '蜜塔已在會議中，可用語音或聊天室呼叫它問答。',
  },
  ENDED: {
    icon: '⚪',
    label: '蜜塔已離開',
    color: 'text-muted-foreground',
    hint: '會議已結束，點進去可查看摘要與完整逐字稿。',
  },
  FAILED: {
    icon: '❌',
    label: '蜜塔加入失敗',
    color: 'text-red-600',
    hint: '蜜塔未能進入會議。常見原因：Google Meet 限制訪客加入、或候客室未放行。點進去可看詳情並重新邀請。',
  },
}

const FALLBACK = { icon: '❔', label: '未知狀態', color: 'text-muted-foreground', hint: '' }

interface Props {
  status: MeetingStatus
  /** 提供時，狀態文字變成可點擊的詳情頁入口 */
  href?: string
}

export function BotStatusIndicator({ status, href }: Props) {
  const { icon, label, color, hint } = STATUS_CONFIG[status] ?? FALLBACK
  const cls = `inline-flex items-center gap-1 text-sm ${color} ${href ? 'hover:underline' : ''}`

  const labelEl = href ? (
    <Link href={href} className={cls}>
      {icon} {label}
    </Link>
  ) : (
    <span className={cls}>
      {icon} {label}
    </span>
  )

  return hint ? <HoverHint hint={hint}>{labelEl}</HoverHint> : labelEl
}
