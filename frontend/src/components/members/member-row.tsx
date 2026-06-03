'use client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { displayName } from '@/lib/utils'
import type { ProjectMember } from '@/types/api'

type PermissionKey = 'canView' | 'canEdit' | 'canMeeting'

interface Props {
  member: ProjectMember
  canManage: boolean
  onRemove: (vexaUserId: number) => void
  onUpdate: (vexaUserId: number, permissions: Partial<Pick<ProjectMember, PermissionKey>>) => void
  isUpdating?: boolean
}

// 檢視權是成員基準權限，恆為 true、不可取消；編輯/會議是其上的加購能力，可自由切換。
const TOGGLEABLE: { key: PermissionKey; label: string }[] = [
  { key: 'canEdit', label: '編輯' },
  { key: 'canMeeting', label: '會議' },
]

export function MemberRow({ member, canManage, onRemove, onUpdate, isUpdating }: Props) {
  return (
    <tr className="border-b">
      <td className="py-3 px-4">
        <div className="font-medium">{displayName(member.name, member.email)}</div>
        <div className="text-xs text-muted-foreground">{member.email}</div>
      </td>
      <td className="py-3 px-4">
        {canManage ? (
          <div className="flex gap-4 flex-wrap items-center">
            <label
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              title="成員必定具備檢視權；若要移除存取請使用「移除成員」"
            >
              <Checkbox checked disabled />
              檢視
            </label>
            {TOGGLEABLE.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={member[key]}
                  disabled={isUpdating}
                  onCheckedChange={(v) => onUpdate(member.vexaUserId, { [key]: Boolean(v) })}
                />
                {label}
              </label>
            ))}
          </div>
        ) : (
          <div className="flex gap-1 flex-wrap">
            {member.canView && <Badge variant="secondary">檢視</Badge>}
            {member.canEdit && <Badge variant="secondary">編輯</Badge>}
            {member.canMeeting && <Badge variant="secondary">會議</Badge>}
          </div>
        )}
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
