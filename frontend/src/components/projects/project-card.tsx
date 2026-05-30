import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ProjectListItem } from '@/types/api'

interface Props {
  project: ProjectListItem
}

export function ProjectCard({ project }: Props) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-lg">{project.name}</h3>
              <Badge variant={project.role === 'owner' ? 'default' : 'secondary'}>
                {project.role === 'owner' ? 'Owner' : '成員'}
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
          <Button asChild size="sm">
            <Link href={`/projects/${project.id}`}>進入 →</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
