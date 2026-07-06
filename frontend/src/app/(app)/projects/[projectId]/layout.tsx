'use client'
import { use, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useProject, useDeleteProject } from '@/hooks/use-projects'
import { ProjectTabs } from '@/components/layout/project-tabs'
import { EditableProjectName } from '@/components/projects/editable-project-name'
import { Button } from '@/components/ui/button'
import { PermissionGuard } from '@/components/permission-guard'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { ArrowLeftIcon, TrashIcon } from '@/components/ui/icons'
import { toast } from 'sonner'

interface Props {
  children: React.ReactNode
  params: Promise<{ projectId: string }>
}

export default function ProjectLayout({ children, params }: Props) {
  const { projectId } = use(params)
  const router = useRouter()
  const { data: project, isLoading } = useProject(projectId)
  const deleteProject = useDeleteProject()
  const [confirmOpen, setConfirmOpen] = useState(false)

  if (isLoading) {
    return (
      <div role="status" className="space-y-4 p-6">
        <span className="sr-only">載入專案中…</span>
        <div
          aria-hidden="true"
          className="h-8 w-56 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
        <div
          aria-hidden="true"
          className="h-10 w-full max-w-md animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="p-6">
        <p className="text-destructive">
          找不到此專案，它可能已被刪除或你沒有存取權限。
        </p>
        <Link
          href="/projects"
          className="mt-2 inline-flex items-center gap-1.5 rounded text-sm font-medium text-honey-deep underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftIcon className="size-3.5" />
          回到專案列表
        </Link>
      </div>
    )
  }

  const handleDelete = async () => {
    try {
      await deleteProject.mutateAsync(projectId)
      toast.success('專案已刪除')
      router.push('/projects')
    } catch (err: any) {
      toast.error(err?.message ?? '刪除失敗')
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/projects"
            className="flex shrink-0 items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeftIcon className="size-3.5" />
            返回
          </Link>
          <EditableProjectName
            projectId={projectId}
            name={project.name}
            canEdit={project.role === 'owner'}
            className="truncate font-display text-xl font-bold"
          />
        </div>
        <PermissionGuard projectId={projectId} require="canDelete">
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            onClick={() => setConfirmOpen(true)}
          >
            <TrashIcon className="size-3.5" />
            刪除專案
          </Button>
        </PermissionGuard>
      </div>
      <ProjectTabs projectId={projectId} />
      <div className="flex-1 overflow-auto p-6">{children}</div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>刪除專案「{project.name}」？</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>此操作會永久刪除此專案，包含：</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>所有上傳的資料檔案（含雲端儲存與知識庫索引）</li>
              <li>專案成員與權限設定</li>
            </ul>
            <p className="text-destructive font-medium">此操作無法復原。</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={deleteProject.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteProject.isPending}
            >
              {deleteProject.isPending ? '刪除中…' : '確認刪除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
