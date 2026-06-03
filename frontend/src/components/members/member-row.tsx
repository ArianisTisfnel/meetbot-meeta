'use client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { displayName } from '@/lib/utils'
import { toast } from 'sonner'
import type { ProjectMember } from '@/types/api'

type PermissionKey = 'canView' | 'canEdit' | 'canMeeting'

interface Props {
  member: ProjectMember
  canManage: boolean
  onRemove: (vexaUserId: number) => void
  onUpdate: (vexaUserId: number, permissions: Partial<Pick<ProjectMember, PermissionKey>>) => void
  isUpdating?: boolean
}

const PERMISSIONS: { key: PermissionKey; label: string }[] = [
  { key: 'canView', label: '檢視' },
  { key: 'canEdit', label: '編輯' },
  { key: 'canMeeting', label: '會議' },
]

/**
 * 套用某次權限切換後，成員是否會變成「完全沒有任何權限」。
 * 全空權限的成員會被後端 requireViewAccess 擋下，等同看不到專案，因此 UI 不允許切到全空。
 */
export function leavesNoPermission(
  current: Pick<ProjectMember, PermissionKey>,
  key: PermissionKey,
  value: boolean,
): boolean {
  const next = {
    canView: current.canView,
    canEdit: current.canEdit,
    canMeeting: current.canMeeting,
    [key]: value,
  }
  return !next.canView && !next.canEdit && !next.canMeeting
}

export function MemberRow({ member, canManage, onRemove, onUpdate, isUpdating }: Props) {
  const toggle = (key: PermissionKey, value: boolean) => {
    if (leavesNoPermission(member, key, value)) {
      toast.error('成員至少需保留一項權限；若要移除請用「移除成員」')
      return
    }
    onUpdate(member.vexaUserId, { [key]: value })
  }

  return (
    <tr className="border-b">
      <td className="py-3 px-4">
        <div className="font-medium">{displayName(member.name, member.email)}</div>
        <div className="text-xs text-muted-foreground">{member.email}</div>
      </td>
      <td className="py-3 px-4">
        {canManage ? (
          <div className="flex gap-4 flex-wrap">
            {PERMISSIONS.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={member[key]}
                  disabled={isUpdating}
                  onCheckedChange={(v) => toggle(key, Boolean(v))}
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
