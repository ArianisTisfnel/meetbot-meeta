'use client'
import { Input } from '@/components/ui/input'

interface Props {
  search: string
  onSearchChange: (v: string) => void
  type: 'all' | 'owned' | 'shared'
  onTypeChange: (v: 'all' | 'owned' | 'shared') => void
  order: 'asc' | 'desc'
  onOrderChange: (v: 'asc' | 'desc') => void
}

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function ProjectFilterBar({
  search, onSearchChange,
  type, onTypeChange,
  order, onOrderChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <Input
        placeholder="搜尋專案…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="max-w-xs"
      />
      <select
        className={SELECT_CLASS}
        value={type}
        onChange={(e) => onTypeChange(e.target.value as 'all' | 'owned' | 'shared')}
        aria-label="專案範圍"
      >
        <option value="all">全部專案</option>
        <option value="owned">我建立的</option>
        <option value="shared">共享給我的</option>
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
