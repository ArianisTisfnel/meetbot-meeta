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
import { useProjects } from '@/hooks/use-projects'
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

  // 全局建立時，列出「我有會議權限」的專案供選擇
  const { data: projectList } = useProjects()
  const meetingProjects =
    projectList?.items.filter((p) => p.permissions.canMeeting) ?? []

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
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">不關聯專案（建立獨立會議）</option>
                {meetingProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                關聯後，蜜塔會以該專案的資料回答問題。僅顯示你有會議權限的專案。
              </p>
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
