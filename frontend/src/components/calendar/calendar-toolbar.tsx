'use client'
import { Button } from '@/components/ui/button'
import { addDays, formatWeekRange, startOfWeek } from '@/lib/calendar'

interface Props {
  weekStart: Date
  onWeekStartChange: (next: Date) => void
  /** 右側動作區（各層自己放「建立會議」之類的按鈕） */
  actions?: React.ReactNode
}

export function CalendarToolbar({ weekStart, onWeekStartChange, actions }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          aria-label="上一週"
          onClick={() => onWeekStartChange(addDays(weekStart, -7))}
        >
          ‹
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          aria-label="下一週"
          onClick={() => onWeekStartChange(addDays(weekStart, 7))}
        >
          ›
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="ml-1"
          onClick={() => onWeekStartChange(startOfWeek(new Date()))}
        >
          今天
        </Button>
      </div>

      <h2 className="font-display text-lg font-bold tabular-nums">{formatWeekRange(weekStart)}</h2>

      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  )
}

/** 色彩對照：顏色在這個畫面裡各有職責，不是裝飾，所以要標出來。 */
export function CalendarLegend({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
      {children}
    </div>
  )
}

export function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  )
}
