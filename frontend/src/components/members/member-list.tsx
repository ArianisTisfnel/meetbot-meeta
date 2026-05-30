'use client'
import { MemberRow } from './member-row'
import { useRemoveMember } from '@/hooks/use-members'
import { toast } from 'sonner'
import type { MembersResponse } from '@/types/api'

interface Props {
  data: MembersResponse
  projectId: string
  canManage: boolean
}

export function MemberList({ data, projectId, canManage }: Props) {
  const removeMutation = useRemoveMember(projectId)

  const handleRemove = (vexaUserId: number) => {
    if (!confirm('確定要移除此成員嗎？')) return
    removeMutation.mutate(vexaUserId, {
      onSuccess: () => toast.success('已移除成員'),
      onError: () => toast.error('移除失敗'),
    })
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-3 px-4">成員</th>
            <th className="py-3 px-4">權限</th>
            <th className="py-3 px-4"></th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b bg-muted/30">
            <td className="py-3 px-4">
              <div className="font-medium">👑 {data.owner.name ?? data.owner.email}</div>
              <div className="text-xs text-muted-foreground">{data.owner.email}</div>
            </td>
            <td className="py-3 px-4 text-muted-foreground text-sm">擁有者</td>
            <td />
          </tr>
          {data.members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              canManage={canManage}
              onRemove={handleRemove}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
