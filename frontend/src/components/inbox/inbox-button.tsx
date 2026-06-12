'use client'
import { useState } from 'react'
import { useSession } from 'next-auth/react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  useMyInvitations,
  useAcceptInvitation,
  useDeclineInvitation,
} from '@/hooks/use-invitations'
import { MailIcon } from '@/components/ui/icons'
import { toast } from 'sonner'

interface Props {
  /** 側欄收合時只顯示圖示，未讀數改為小圓點 */
  collapsed?: boolean
}

export function InboxButton({ collapsed = false }: Props) {
  const { status } = useSession()
  const [open, setOpen] = useState(false)
  const { data } = useMyInvitations({ enabled: status === 'authenticated' })
  const acceptMutation = useAcceptInvitation()
  const declineMutation = useDeclineInvitation()

  const items = data?.items ?? []
  const count = items.length

  const handleAccept = (id: string, projectName: string | null) => {
    acceptMutation.mutate(id, {
      onSuccess: () => toast.success(`已加入專案${projectName ? `「${projectName}」` : ''}`),
      onError: (e: unknown) =>
        toast.error((e as { message?: string })?.message ?? '接受失敗'),
    })
  }

  const handleDecline = (id: string) => {
    declineMutation.mutate(id, {
      onSuccess: () => toast.success('已拒絕邀請'),
      onError: (e: unknown) =>
        toast.error((e as { message?: string })?.message ?? '拒絕失敗'),
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={collapsed ? `信箱${count > 0 ? `（${count} 則邀請）` : ''}` : undefined}
        className={`relative flex w-full items-center rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          collapsed ? 'justify-center px-0' : 'justify-between'
        }`}
      >
        <span className="relative flex items-center gap-2.5">
          <MailIcon />
          <span className={collapsed ? 'sr-only' : undefined}>
            信箱
            {count > 0 && (
              <span className="sr-only">，{count} 則待處理邀請</span>
            )}
          </span>
          {collapsed && count > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 size-2 rounded-full bg-honey"
            />
          )}
        </span>
        {!collapsed && count > 0 && (
          <Badge
            aria-hidden="true"
            variant="default"
            className="h-5 min-w-5 justify-center px-1.5"
          >
            {count}
          </Badge>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>信箱 · 專案邀請</DialogTitle>
          </DialogHeader>
          {items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              目前沒有待處理的邀請
            </p>
          ) : (
            <div className="space-y-3">
              {items.map((inv) => (
                <div key={inv.id} className="rounded-md border p-3 space-y-2">
                  <div>
                    <div className="font-medium">
                      {inv.projectName ?? '（未知專案）'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {inv.inviterName ?? '某人'} 邀請你加入 ·{' '}
                      {new Date(inv.expiresAt).toLocaleDateString('zh-TW')} 前有效
                    </div>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {inv.canView && <Badge variant="secondary">檢視</Badge>}
                    {inv.canEdit && <Badge variant="secondary">編輯</Badge>}
                    {inv.canMeeting && <Badge variant="secondary">會議</Badge>}
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={declineMutation.isPending}
                      onClick={() => handleDecline(inv.id)}
                    >
                      拒絕
                    </Button>
                    <Button
                      size="sm"
                      disabled={acceptMutation.isPending}
                      onClick={() => handleAccept(inv.id, inv.projectName)}
                    >
                      接受
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
