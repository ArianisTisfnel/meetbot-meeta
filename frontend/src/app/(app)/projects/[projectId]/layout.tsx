'use client'
import { use } from 'react'
import { useProject } from '@/hooks/use-projects'
import { usePermissions } from '@/hooks/use-permissions'
import { ProjectTabs } from '@/components/layout/project-tabs'
import { Button } from '@/components/ui/button'
import { PermissionGuard } from '@/components/permission-guard'

interface Props {
  children: React.ReactNode
  params: Promise<{ projectId: string }>
}

export default function ProjectLayout({ children, params }: Props) {
  const { projectId } = use(params)
  const { data: project, isLoading } = useProject(projectId)

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">載入中…</div>
  }

  if (!project) {
    return <div className="p-6 text-destructive">找不到此專案</div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <PermissionGuard projectId={projectId} require="canDelete">
          <Button variant="destructive" size="sm">
            ⚙ 設定
          </Button>
        </PermissionGuard>
      </div>
      <ProjectTabs projectId={projectId} />
      <div className="flex-1 overflow-auto p-6">{children}</div>
    </div>
  )
}
