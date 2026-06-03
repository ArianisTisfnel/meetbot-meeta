'use client'
import { MemberRow } from './member-row'
import {
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
} from '@/hooks/use-members'
import { displayName } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import type { MembersResponse } from '@/types/api'

interface Props {
  data: MembersResponse
  projectId: string
  canManage: boolean
}

export function MemberList({ data, projectId, canManage }: Props) {
  const removeMutation = useRemoveMember(projectId)
  const resendMutation = useResendInvitation(projectId)
  const revokeMutation = useRevokeInvitation(projectId)

  const handleRemove = (vexaUserId: number) => {
    if (!confirm('確定要移除此成員嗎？')) return
    removeMutation.mutate(vexaUserId, {
      onSuccess: () => toast.success('已移除成員'),
      onError: () => toast.error('移除失敗'),
    })
  }

  const handleResend = (invitationId: string) => {
    resendMutation.mutate(invitationId, {
      onSuccess: (r) =>
        toast.success(r.emailSent ? '已重寄邀請信' : '已重新產生邀請連結（未設定寄信）'),
      onError: (e: unknown) =>
        toast.error((e as { message?: string })?.message ?? '重寄失敗'),
    })
  }

  const handleRevoke = (invitationId: string) => {
    if (!confirm('確定要撤銷此邀請嗎？')) return
    revokeMutation.mutate(invitationId, {
      onSuccess: () => toast.success('已撤銷邀請'),
      onError: (e: unknown) =>
        toast.error((e as { message?: string })?.message ?? '撤銷失敗'),
    })
  }

  const pending = data.pendingInvitations ?? []

  return (
    <div className="space-y-6">
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
                <div className="font-medium">👑 {displayName(data.owner.name, data.owner.email)}</div>
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

      {pending.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            邀請中（尚未接受）
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {pending.map((inv) => (
                  <tr key={inv.id} className="border-b">
                    <td className="py-3 px-4">
                      <div className="font-medium">{inv.email}</div>
                      <div className="text-xs text-muted-foreground">
                        待接受 · {new Date(inv.expiresAt).toLocaleDateString('zh-TW')} 前有效
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex gap-1 flex-wrap">
                        {inv.canView && <Badge variant="secondary">檢視</Badge>}
                        {inv.canEdit && <Badge variant="secondary">編輯</Badge>}
                        {inv.canMeeting && <Badge variant="secondary">會議</Badge>}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {canManage && (
                        <div className="flex gap-1 justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={resendMutation.isPending}
                            onClick={() => handleResend(inv.id)}
                          >
                            重寄
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={revokeMutation.isPending}
                            onClick={() => handleRevoke(inv.id)}
                          >
                            撤銷
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
