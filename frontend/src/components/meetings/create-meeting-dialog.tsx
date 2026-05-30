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
import { useCreateMeeting } from '@/hooks/use-meetings'
import { useCreateGlobalMeeting } from '@/hooks/use-all-meetings'
import { toast } from 'sonner'

interface ProjectScopedProps {
  mode: 'project'
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

interface GlobalProps {
  mode: 'global'
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

type Props = ProjectScopedProps | GlobalProps

export function CreateMeetingDialog(props: Props) {
  const [name, setName] = useState('')
  const [meetUrl, setMeetUrl] = useState('')
  const [projectId, setProjectId] = useState('')

  const createProjectMeeting = useCreateMeeting(
    props.mode === 'project' ? props.projectId : ''
  )
  const createGlobalMeeting = useCreateGlobalMeeting()

  const handleSubmit = async () => {
    if (!meetUrl.trim()) {
      toast.error('請填入 Google Meet URL')
      return
    }
    try {
      if (props.mode === 'project') {
        await createProjectMeeting.mutateAsync({
          googleMeetUrl: meetUrl,
          name: name || undefined,
        })
      } else {
        await createGlobalMeeting.mutateAsync({
          googleMeetUrl: meetUrl,
          name: name || undefined,
          projectId: projectId || undefined,
        })
      }
      toast.success('會議已建立，蜜塔加入中…')
      setName('')
      setMeetUrl('')
      setProjectId('')
      props.onOpenChange(false)
      props.onSuccess?.()
    } catch (err: any) {
      toast.error(err?.message ?? '建立失敗')
    }
  }

  const isPending = createProjectMeeting.isPending || createGlobalMeeting.isPending

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>建立新會議</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">會議名稱（選填）</label>
            <Input
              placeholder="例：每週同步會議"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
            />
          </div>
          {props.mode === 'global' && (
            <div>
              <label className="text-sm font-medium">關聯專案（選填）</label>
              <Input
                placeholder="輸入專案 ID（留空建立獨立會議）"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="mt-1"
              />
            </div>
          )}
          <div>
            <label className="text-sm font-medium">Google Meet URL</label>
            <div className="flex gap-2 mt-1">
              <Input
                placeholder="meet.google.com/... 連結"
                value={meetUrl}
                onChange={(e) => setMeetUrl(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open('https://meet.new', '_blank')}
              >
                建立 Meet ↗
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={isPending}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? '建立中…' : '建立並邀請蜜塔'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
