'use client'
import { Input } from '@/components/ui/input'

interface Props {
  search: string
  onSearchChange: (v: string) => void
  since?: number
  onSinceChange: (v: number | undefined) => void
  order: 'asc' | 'desc'
  onOrderChange: (v: 'asc' | 'desc') => void
}

const SINCE_OPTIONS: Array<{ label: string; value: number | undefined }> = [
  { label: '全部時間', value: undefined },
  { label: '近 1 天', value: 1 },
  { label: '近 3 天', value: 3 },
  { label: '近 7 天', value: 7 },
  { label: '近 14 天', value: 14 },
  { label: '近 30 天', value: 30 },
]

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function MeetingFilterBar({
  search, onSearchChange,
  since, onSinceChange,
  order, onOrderChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <Input
        placeholder="搜尋會議…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="max-w-xs"
      />
      <select
        className={SELECT_CLASS}
        value={since === undefined ? '' : String(since)}
        onChange={(e) =>
          onSinceChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
        aria-label="時間範圍"
      >
        {SINCE_OPTIONS.map((opt) => (
          <option key={String(opt.value)} value={opt.value === undefined ? '' : String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
      <select
        className={SELECT_CLASS}
        value={order}
        onChange={(e) => onOrderChange(e.target.value as 'asc' | 'desc')}
        aria-label="排序"
      >
        <option value="desc">↓ 由新到舊</option>
        <option value="asc">↑ 由舊到新</option>
      </select>
    </div>
  )
}
