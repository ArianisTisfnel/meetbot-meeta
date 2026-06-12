'use client'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EditableProjectName } from './editable-project-name'
import type { ProjectListItem } from '@/types/api'

interface Props {
  project: ProjectListItem
}

export function ProjectCard({ project }: Props) {
  const isOwner = project.role === 'owner'

  return (
    <Card className="relative transition-shadow hover:shadow-md">
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              {/* z-10 讓編輯名稱的互動浮在整卡連結之上 */}
              <span className="relative z-10 min-w-0">
                <EditableProjectName
                  projectId={project.id}
                  name={project.name}
                  canEdit={isOwner}
                  className="truncate text-lg font-semibold"
                />
              </span>
              <Badge variant={isOwner ? 'default' : 'secondary'}>
                {isOwner ? 'Owner' : '成員'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {project.memberCount} 成員 · {project.materialCount} 份資料
              {project.activeMeetingCount > 0 && (
                <span className="ml-2 font-medium text-honey-deep">
                  · {project.activeMeetingCount} 個進行中會議
                </span>
              )}
            </p>
          </div>
          {/* stretched link：整張卡都是「進入」的點擊範圍 */}
          <Link
            href={`/projects/${project.id}`}
            className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-roast-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background after:absolute after:inset-0 after:rounded-lg after:content-['']"
          >
            進入 →
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
