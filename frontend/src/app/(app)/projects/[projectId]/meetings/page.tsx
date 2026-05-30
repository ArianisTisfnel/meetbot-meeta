'use client'
import { use, useState } from 'react'
import { useMeetings } from '@/hooks/use-meetings'
import { usePermissions } from '@/hooks/use-permissions'
import { MeetingList } from '@/components/meetings/meeting-list'
import { MeetingFilterBar } from '@/components/meetings/meeting-filter-bar'
import { CreateMeetingDialog } from '@/components/meetings/create-meeting-dialog'
import { Button } from '@/components/ui/button'

interface Props {
  params: Promise<{ projectId: string }>
}

export default function ProjectMeetingsPage({ params }: Props) {
  const { projectId } = use(params)
  const [search, setSearch] = useState('')
  const [since, setSince] = useState<1 | 3 | 7 | undefined>()
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading } = useMeetings(projectId, { search, since, order })
  const permissions = usePermissions(projectId)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">會議紀錄</h2>
        {permissions.canMeeting && (
          <Button onClick={() => setCreateOpen(true)}>+ 建立會議</Button>
        )}
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
        <MeetingList meetings={data?.items ?? []} projectId={projectId} />
      )}

      {permissions.canMeeting && (
        <CreateMeetingDialog
          mode="project"
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}
    </div>
  )
}
