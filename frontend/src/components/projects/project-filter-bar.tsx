'use client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface Props {
  search: string
  onSearchChange: (v: string) => void
  type: 'all' | 'owned' | 'shared'
  onTypeChange: (v: 'all' | 'owned' | 'shared') => void
  order: 'asc' | 'desc'
  onOrderChange: (v: 'asc' | 'desc') => void
}

const TYPE_OPTIONS: Array<{ label: string; value: 'all' | 'owned' | 'shared' }> = [
  { label: '全部', value: 'all' },
  { label: '我建立的', value: 'owned' },
  { label: '共享的', value: 'shared' },
]

export function ProjectFilterBar({
  search, onSearchChange,
  type, onTypeChange,
  order, onOrderChange,
}: Props) {
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      <Input
        placeholder="搜尋專案…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="max-w-xs"
      />
      <div className="flex gap-1">
        {TYPE_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            variant={type === opt.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => onTypeChange(opt.value)}
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
        {order === 'desc' ? '↓ 最新' : '↑ 最舊'}
      </Button>
    </div>
  )
}
