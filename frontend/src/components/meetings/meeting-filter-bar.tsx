'use client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface Props {
  search: string
  onSearchChange: (v: string) => void
  since?: 1 | 3 | 7 | undefined
  onSinceChange: (v: 1 | 3 | 7 | undefined) => void
  order: 'asc' | 'desc'
  onOrderChange: (v: 'asc' | 'desc') => void
}

const SINCE_OPTIONS: Array<{ label: string; value: 1 | 3 | 7 | undefined }> = [
  { label: '全部', value: undefined },
  { label: '近 1 天', value: 1 },
  { label: '近 3 天', value: 3 },
  { label: '近 7 天', value: 7 },
]

export function MeetingFilterBar({
  search, onSearchChange,
  since, onSinceChange,
  order, onOrderChange,
}: Props) {
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      <Input
        placeholder="搜尋會議…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="max-w-xs"
      />
      <div className="flex gap-1">
        {SINCE_OPTIONS.map((opt) => (
          <Button
            key={String(opt.value)}
            variant={since === opt.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSinceChange(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onOrderChange(order === 'desc' ? 'asc' : 'desc')}
      >
        {order === 'desc' ? '↓ 倒序' : '↑ 正序'}
      </Button>
    </div>
  )
}
