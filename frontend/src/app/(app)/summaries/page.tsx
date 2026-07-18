'use client'
import { useState } from 'react'
import { useAllMeetings } from '@/hooks/use-all-meetings'
import { SummaryList } from '@/components/meetings/summary-list'
import { MeetingFilterBar } from '@/components/meetings/meeting-filter-bar'

/**
 * 會後摘要頁：跨專案列出所有已結束（ENDED）的會議，
 * 點列進入原本的會議詳情頁（摘要＋逐字稿）。
 */
export default function SummariesPage() {
  const [search, setSearch] = useState('')
  const [since, setSince] = useState<number | undefined>()
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')

  const { data, isLoading } = useAllMeetings({
    search,
    since,
    order,
    status: 'ENDED',
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold">會後摘要</h1>
      </div>

      <MeetingFilterBar
        search={search}
        onSearchChange={setSearch}
        since={since}
        onSinceChange={setSince}
        order={order}
        onOrderChange={setOrder}
      />

      {isLoading ? (
        <p className="text-muted-foreground">載入中…</p>
      ) : (
        <SummaryList meetings={data?.items ?? []} />
      )}
    </div>
  )
}
