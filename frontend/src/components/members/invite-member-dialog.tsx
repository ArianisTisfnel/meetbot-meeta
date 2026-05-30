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

  const inviteMutation = useInviteMember(projectId)

  const handleSubmit = async () => {
    if (!email.trim()) {
      toast.error('請填入 Email')
      return
    }
    try {
      await inviteMutation.mutateAsync({ email, canView, canEdit, canMeeting })
      toast.success('成員邀請成功')
      setEmail('')
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message ?? '邀請失敗')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={inviteMutation.isPending}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={inviteMutation.isPending}>
            {inviteMutation.isPending ? '邀請中…' : '邀請'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
