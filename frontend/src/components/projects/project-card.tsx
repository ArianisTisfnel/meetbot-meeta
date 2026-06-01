'use client'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EditableProjectName } from './editable-project-name'
import type { ProjectListItem } from '@/types/api'

interface Props {
  project: ProjectListItem
}

export function ProjectCard({ project }: Props) {
  const router = useRouter()
  const isOwner = project.role === 'owner'

  const enter = () => router.push(`/projects/${project.id}`)

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={enter}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          enter()
        }
      }}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <EditableProjectName
                projectId={project.id}
                name={project.name}
                canEdit={isOwner}
                className="font-semibold text-lg truncate"
              />
              <Badge variant={isOwner ? 'default' : 'secondary'}>
                {isOwner ? 'Owner' : '成員'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {project.memberCount} 成員 · {project.materialCount} 份資料
              {project.activeMeetingCount > 0 && (
                <span className="ml-2 text-green-600 font-medium">
                  · {project.activeMeetingCount} 個進行中會議
                </span>
              )}
            </p>
          </div>
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              enter()
            }}
          >
            進入 →
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
