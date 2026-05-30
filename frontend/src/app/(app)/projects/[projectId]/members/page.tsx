'use client'
import { use, useState } from 'react'
import { useMembers } from '@/hooks/use-members'
import { usePermissions } from '@/hooks/use-permissions'
import { MemberList } from '@/components/members/member-list'
import { InviteMemberDialog } from '@/components/members/invite-member-dialog'
import { Button } from '@/components/ui/button'
import { PermissionGuard } from '@/components/permission-guard'

interface Props {
  params: Promise<{ projectId: string }>
}

export default function MembersPage({ params }: Props) {
  const { projectId } = use(params)
  const { data, isLoading } = useMembers(projectId)
  const permissions = usePermissions(projectId)
  const [inviteOpen, setInviteOpen] = useState(false)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-semibold">
          成員（{data ? data.members.length + 1 : 0} 人）
        </h2>
        <PermissionGuard projectId={projectId} require="canManage">
          <Button onClick={() => setInviteOpen(true)}>+ 邀請成員</Button>
        </PermissionGuard>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">載入中…</p>
      ) : data ? (
        <MemberList
          data={data}
          projectId={projectId}
          canManage={permissions.canManage}
        />
      ) : null}

      <InviteMemberDialog
        projectId={projectId}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </div>
  )
}
