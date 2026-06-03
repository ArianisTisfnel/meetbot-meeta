'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { ChevronDown, ChevronRight, FolderOpen, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CreateMeetingDialog } from '@/components/meetings/create-meeting-dialog'
import { cn } from '@/lib/utils'
import { useProjects } from '@/hooks/use-projects'

export function Sidebar() {
  const pathname = usePathname()
  const [meetingDialogOpen, setMeetingDialogOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const { data: session } = useSession()
  const { data: projectsData } = useProjects()
  const projects = projectsData?.items ?? []

  return (
    <>
      <aside className="w-64 h-screen border-r bg-background flex flex-col shrink-0">
        <div className="p-4 border-b">
          <h1 className="font-bold text-xl">🤖 MeetBot</h1>
        </div>

        <div className="p-3">
          <Button
            className="w-full"
            onClick={() => setMeetingDialogOpen(true)}
          >
            + 建立會議
          </Button>
        </div>

        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          {/* Projects 可折疊區塊 */}
          <button
            onClick={() => setProjectsOpen(o => !o)}
            className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
          >
            {projectsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Projects
          </button>

          {projectsOpen && (
            <div className="space-y-0.5">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent',
                    pathname.startsWith(`/projects/${project.id}`) && 'bg-accent font-medium'
                  )}
                >
                  <FolderOpen className="w-4 h-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{project.name}</span>
                </Link>
              ))}

              <Link
                href="/projects"
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent text-muted-foreground',
                  pathname === '/projects' && 'bg-accent text-foreground font-medium'
                )}
              >
                <Plus className="w-4 h-4 shrink-0" />
                <span>新增專案</span>
              </Link>
            </div>
          )}

          {/* Meetings */}
          <Link
            href="/meetings"
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent mt-1',
              pathname.startsWith('/meetings') && 'bg-accent font-medium'
            )}
          >
            <span className="material-symbols-outlined text-muted-foreground" style={{ fontSize: '18px' }}>
              video_call
            </span>
            Meetings
          </Link>
        </nav>

        <div className="p-4 border-t">
          <div className="text-xs text-muted-foreground truncate mb-2">
            {session?.user?.email ?? ''}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => signOut({ callbackUrl: '/login' })}
          >
            登出
          </Button>
        </div>
      </aside>

      <CreateMeetingDialog
        mode="global"
        open={meetingDialogOpen}
        onOpenChange={setMeetingDialogOpen}
      />
    </>
  )
}
