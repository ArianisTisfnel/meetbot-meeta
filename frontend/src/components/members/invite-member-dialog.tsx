'use client'
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useInviteMember } from '@/hooks/use-members'
import { toast } from 'sonner'

interface Props {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InviteMemberDialog({ projectId, open, onOpenChange }: Props) {
  const [email, setEmail] = useState('')
  const [canView, setCanView] = useState(true)
  const [canEdit, setCanEdit] = useState(false)
  const [canMeeting, setCanMeeting] = useState(false)
  // 未設定寄信時，後端會回傳可手動轉交的接受連結
  const [manualLink, setManualLink] = useState<string | null>(null)

  const inviteMutation = useInviteMember(projectId)

  const reset = () => {
    setEmail('')
    setManualLink(null)
  }

  const handleSubmit = async () => {
    if (!email.trim()) {
      toast.error('請填入 Email')
      return
    }
    setManualLink(null)
    try {
      const result = await inviteMutation.mutateAsync({ email, canView, canEdit, canMeeting })
      if (result.emailSent) {
        toast.success(`已寄出邀請信至 ${result.email}`)
        reset()
        onOpenChange(false)
      } else {
        // 未設定 SMTP：保留 dialog，顯示連結讓擁有者自行轉交
        toast.info('已建立邀請（尚未設定寄信），請複製下方連結轉交對方')
        setManualLink(result.acceptUrl)
      }
    } catch (err: unknown) {
      const message = (err as { message?: string })?.message ?? '邀請失敗'
      toast.error(message)
    }
  }

  const copyLink = async () => {
    if (!manualLink) return
    try {
      await navigator.clipboard.writeText(manualLink)
      toast.success('已複製連結')
    } catch {
      toast.error('複製失敗，請手動選取連結')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>邀請成員</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Email</label>
            <Input
              type="email"
              placeholder="member@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              對方不需事先註冊；登入後會在「📬 信箱」看到此邀請並接受。
            </p>
          </div>
          <div>
            <label className="text-sm font-medium">初始權限</label>
            <div className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={canView}
                  onCheckedChange={(v) => setCanView(Boolean(v))}
                />
                檢視權
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={canEdit}
                  onCheckedChange={(v) => setCanEdit(Boolean(v))}
                />
                編輯權
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={canMeeting}
                  onCheckedChange={(v) => setCanMeeting(Boolean(v))}
                />
                會議權
              </label>
            </div>
          </div>

          {manualLink && (
            <div className="rounded-md border bg-muted/40 p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                尚未設定寄信，請把以下接受連結轉交對方（連結僅顯示這一次）：
              </p>
              <div className="flex gap-2">
                <Input readOnly value={manualLink} className="text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={copyLink}>
                  複製
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={inviteMutation.isPending}
          >
            {manualLink ? '完成' : '取消'}
          </Button>
          <Button onClick={handleSubmit} disabled={inviteMutation.isPending}>
            {inviteMutation.isPending ? '邀請中…' : manualLink ? '再邀請一位' : '邀請'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
