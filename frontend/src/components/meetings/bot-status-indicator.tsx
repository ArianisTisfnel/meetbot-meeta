import Link from 'next/link'
import { HoverHint } from '@/components/ui/hover-hint'
import type { MeetingStatus } from '@/types/api'

// 注意：此狀態代表「蜜塔（Bot）的加入狀態」，而非 Google Meet 會議本身的狀態。
// 系統只能透過蜜塔的 WebSocket 事件觀測會議，無法獨立得知會議真實狀態。
const STATUS_CONFIG: Record<
  MeetingStatus,
  { dot: string; label: string; color: string; hint: string }
> = {
  PENDING: {
    dot: 'bg-honey animate-pulse motion-reduce:animate-none',
    label: '蜜塔加入中',
    color: 'text-honey-deep',
    hint: '蜜塔正在嘗試加入會議。若遲遲沒進來，可在右側「取消」後重試。',
  },
  ACTIVE: {
    dot: 'bg-green-600',
    label: '蜜塔在會議中',
    color: 'text-green-700',
    hint: '蜜塔已在會議中，可用語音或聊天室呼叫它問答。',
  },
  ENDED: {
    dot: 'bg-muted-foreground/50',
    label: '蜜塔已離開',
    color: 'text-muted-foreground',
    hint: '會議已結束，點進去可查看摘要與完整逐字稿。',
  },
  FAILED: {
    dot: 'bg-destructive',
    label: '蜜塔加入失敗',
    color: 'text-destructive',
    hint: '蜜塔未能進入會議。常見原因：Google Meet 限制訪客加入、或候客室未放行。點進去可看詳情並重新邀請。',
  },
}

const FALLBACK = { dot: 'bg-muted-foreground/50', label: '未知狀態', color: 'text-muted-foreground', hint: '' }

interface Props {
  status: MeetingStatus
  /** 提供時，狀態文字變成可點擊的詳情頁入口 */
  href?: string
}

export function BotStatusIndicator({ status, href }: Props) {
  const { dot, label, color, hint } = STATUS_CONFIG[status] ?? FALLBACK
  const cls = `inline-flex items-center gap-1.5 text-sm ${color} ${
    href
      ? 'rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      : ''
  }`
  const dotEl = (
    <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
  )

  const labelEl = href ? (
    <Link href={href} className={cls}>
      {dotEl} {label}
    </Link>
  ) : (
    <span className={cls}>
      {dotEl} {label}
    </span>
  )

  return hint ? <HoverHint hint={hint}>{labelEl}</HoverHint> : labelEl
}
