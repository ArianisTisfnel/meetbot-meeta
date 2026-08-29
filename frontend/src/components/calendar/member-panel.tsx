'use client'
import { Checkbox } from '@/components/ui/checkbox'
import { SERIES_COLOR_CAP } from '@/lib/calendar-colors'
import type { CalendarMember } from '@/lib/calendar'
import { cn } from '@/lib/utils'

const SYNC_LABEL: Record<CalendarMember['syncState'], string | null> = {
  synced: null,
  unsynced: '未同步',
  expired: '授權失效',
}

interface Props {
  members: CalendarMember[]
  /** 目前疊圖上顯示的成員 */
  visible: Set<string>
  onToggle: (memberId: string) => void
  onToggleAll: (next: boolean) => void
  colorOf: (memberId: string) => string
}

export function MemberPanel({ members, visible, onToggle, onToggleAll, colorOf }: Props) {
  const allVisible = members.every((m) => visible.has(m.id))
  const overflowed = members.length > SERIES_COLOR_CAP

  return (
    <section className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold">成員行程</h2>
        <button
          type="button"
          onClick={() => onToggleAll(!allVisible)}
          className="rounded text-xs text-honey-deep underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {allVisible ? '全部隱藏' : '全部顯示'}
        </button>
      </div>

      <ul className="space-y-0.5">
        {members.map((member) => {
          const syncLabel = SYNC_LABEL[member.syncState]
          const checked = visible.has(member.id)
          return (
            <li key={member.id}>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent',
                  !checked && 'opacity-55',
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onToggle(member.id)}
                  aria-label={`顯示 ${member.name} 的行程`}
                />
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: colorOf(member.id) }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{member.name}</span>
                {syncLabel && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                      member.syncState === 'expired'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {syncLabel}
                  </span>
                )}
              </label>
            </li>
          )
        })}
      </ul>

      {overflowed && (
        <p className="mt-2 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
          配色上限 {SERIES_COLOR_CAP} 人（再多顏色就會互相難以分辨），第 {SERIES_COLOR_CAP + 1}{' '}
          位起以灰色顯示，靠色塊上的姓名辨識。
        </p>
      )}
    </section>
  )
}
