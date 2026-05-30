'use client'
import { useState } from 'react'
import { useAllMeetings } from '@/hooks/use-all-meetings'
import { MeetingList } from '@/components/meetings/meeting-list'
import { MeetingFilterBar } from '@/components/meetings/meeting-filter-bar'
import { CreateMeetingDialog } from '@/components/meetings/create-meeting-dialog'
import { Button } from '@/components/ui/button'

export default function AllMeetingsPage() {
  const [search, setSearch] = useState('')
  const [since, setSince] = useState<1 | 3 | 7 | undefined>()
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading } = useAllMeetings({ search, since, order })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Meetings</h1>
        <Button onClick={() => setCreateOpen(true)}>+ 建立會議</Button>
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
        <MeetingList meetings={data?.items ?? []} />
      )}

      <CreateMeetingDialog
        mode="global"
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  )
}
