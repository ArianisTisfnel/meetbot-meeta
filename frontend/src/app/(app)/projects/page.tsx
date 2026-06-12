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

  // 沒結果時，分辨是「被篩掉」還是「真的還沒有專案」
  const filtered = search !== '' || type !== 'all'

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold">我的專案</h1>
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

      {isLoading && (
        <div role="status" className="space-y-3">
          <span className="sr-only">載入專案中…</span>
          {[0, 1].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="h-24 animate-pulse rounded-lg border bg-card motion-reduce:animate-none"
            />
          ))}
        </div>
      )}
      {error && (
        <p className="text-destructive">
          專案清單載入失敗，請重新整理頁面再試一次。
        </p>
      )}

      <div className="space-y-3">
        {data?.items.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
        {data?.items.length === 0 &&
          (filtered ? (
            <p className="py-12 text-center text-muted-foreground">
              沒有符合條件的專案，試試其他關鍵字或範圍。
            </p>
          ) : (
            <div className="rounded-xl border border-dashed px-6 py-12 text-center">
              <p className="font-display text-lg font-bold">
                建立第一個專案
              </p>
              <p className="mx-auto mt-2 max-w-sm text-pretty text-sm text-muted-foreground">
                專案是蜜塔工作的地方：上傳資料、邀請成員，再請她進你的
                Google Meet。
              </p>
              <Button className="mt-5" onClick={() => setCreateOpen(true)}>
                + 建立專案
              </Button>
            </div>
          ))}
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
