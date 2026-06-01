'use client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { displayName } from '@/lib/utils'
import type { ProjectMember } from '@/types/api'

interface Props {
  member: ProjectMember
  canManage: boolean
  onRemove: (vexaUserId: number) => void
}

export function MemberRow({ member, canManage, onRemove }: Props) {
  return (
    <tr className="border-b">
      <td className="py-3 px-4">
        <div className="font-medium">{displayName(member.name, member.email)}</div>
        <div className="text-xs text-muted-foreground">{member.email}</div>
      </td>
      <td className="py-3 px-4">
        <div className="flex gap-1 flex-wrap">
          {member.canView && <Badge variant="secondary">檢視</Badge>}
          {member.canEdit && <Badge variant="secondary">編輯</Badge>}
          {member.canMeeting && <Badge variant="secondary">會議</Badge>}
        </div>
      </td>
      <td className="py-3 px-4">
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRemove(member.vexaUserId)}
            aria-label="移除成員"
          >
            🗑
          </Button>
        )}
      </td>
    </tr>
  )
}
