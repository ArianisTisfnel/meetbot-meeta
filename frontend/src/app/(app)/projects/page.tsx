'use client'
import { useState } from 'react'
import { useProjects } from '@/hooks/use-projects'
import { ProjectCard } from '@/components/projects/project-card'
import { ProjectFilterBar } from '@/components/projects/project-filter-bar'
import { CreateProjectDialog } from '@/components/projects/create-project-dialog'
import { Button } from '@/components/ui/button'

export default function ProjectsPage() {
  const [search, setSearch] = useState('')
  const [type, setType] = useState<'all' | 'owned' | 'shared'>('all')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading, error } = useProjects({ search, type, order })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">我的專案</h1>
        <Button onClick={() => setCreateOpen(true)}>+ 建立專案</Button>
      </div>

      <ProjectFilterBar
        search={search}
        onSearchChange={setSearch}
        type={type}
        onTypeChange={setType}
        order={order}
        onOrderChange={setOrder}
      />

      {isLoading && <p className="text-muted-foreground">載入中…</p>}
      {error && <p className="text-destructive">載入失敗</p>}

      <div className="space-y-3">
        {data?.items.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
        {data?.items.length === 0 && (
          <p className="text-center text-muted-foreground py-12">
            尚無專案，點擊「建立專案」開始使用
          </p>
        )}
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
