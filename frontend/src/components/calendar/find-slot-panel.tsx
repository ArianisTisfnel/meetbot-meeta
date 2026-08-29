'use client'
import { Button } from '@/components/ui/button'
import { WEEKDAY_LABELS, formatTime, type CalendarMember, type TimeSlot } from '@/lib/calendar'
import { cn } from '@/lib/utils'

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

const DURATION_OPTIONS = [30, 60, 90, 120]

interface Props {
  /** 參與者 = 目前疊圖上顯示的成員，不另外做一套勾選 */
  participants: CalendarMember[]
  duration: number
  onDurationChange: (minutes: number) => void
  onSearch: () => void
  onClear: () => void
  /** null = 還沒搜尋過；[] = 搜尋過但查無空檔 */
  results: TimeSlot[] | null
  onPick: (slot: TimeSlot) => void
}

export function FindSlotPanel({
  participants,
  duration,
  onDurationChange,
  onSearch,
  onClear,
  results,
  onPick,
}: Props) {
  const unsynced = participants.filter((m) => m.syncState !== 'synced')

  return (
    <section className="rounded-lg border bg-card p-3">
      <h2 className="mb-1 text-sm font-bold">找共同空檔</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        以上方「顯示中」的 {participants.length} 位成員計算。
      </p>

      <label className="mb-1 block text-xs text-muted-foreground" htmlFor="slot-duration">
        會議時長
      </label>
      <select
        id="slot-duration"
        className={SELECT_CLASS}
        value={String(duration)}
        onChange={(e) => onDurationChange(Number(e.target.value))}
      >
        {DURATION_OPTIONS.map((min) => (
          <option key={min} value={min}>
            {min} 分鐘
          </option>
        ))}
      </select>

      <div className="mt-3 flex gap-2">
        <Button size="sm" className="flex-1" onClick={onSearch} disabled={participants.length === 0}>
          搜尋空檔
        </Button>
        {results !== null && (
          <Button size="sm" variant="outline" onClick={onClear}>
            清除
          </Button>
        )}
      </div>

      {unsynced.length > 0 && (
        <p className="mt-3 rounded-md bg-muted px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {unsynced.map((m) => m.name).join('、')} 尚未同步 Google
          Calendar，結果僅依目前已知的忙碌時段計算。
        </p>
      )}

      {results !== null && (
        <div className="mt-3 border-t pt-3">
          {results.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              這週找不到 {duration} 分鐘的共同空檔。試試縮短時長、換一週，或先隱藏部分成員。
            </p>
          ) : (
            <>
              <p className="mb-1.5 text-xs text-muted-foreground">
                共 {results.length} 個時段，點選即可建立會議
              </p>
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {results.map((slot, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => onPick(slot)}
                      className={cn(
                        'flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        'hover:bg-honey/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      <span className="font-medium">
                        週{WEEKDAY_LABELS[(slot.start.getDay() + 6) % 7]}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatTime(slot.start)}–{formatTime(slot.end)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  )
}
