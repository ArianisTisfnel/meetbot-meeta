'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { CreateMeetingDialog } from '@/components/meetings/create-meeting-dialog'
import { InboxButton } from '@/components/inbox/inbox-button'
import { MeetaMark } from '@/components/landing/meeta-mark'
import {
  FolderIcon,
  MeetingIcon,
  PanelLeftIcon,
  LogoutIcon,
  PlusIcon,
} from '@/components/ui/icons'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/projects', label: '專案', icon: FolderIcon },
  { href: '/meetings', label: '會議', icon: MeetingIcon },
]

const COLLAPSED_KEY = 'mb-sidebar-collapsed'

export function Sidebar() {
  const pathname = usePathname()
  const [meetingDialogOpen, setMeetingDialogOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const { data: session } = useSession()

  // 收合狀態存在本機；初始展開，掛載後讀回上次的選擇
  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1')
  }, [])

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      localStorage.setItem(COLLAPSED_KEY, prev ? '0' : '1')
      return !prev
    })
  }

  return (
    <>
      <aside
        className={cn(
          'flex h-dvh shrink-0 flex-col border-r bg-background',
          collapsed ? 'w-16' : 'w-64'
        )}
      >
        <div
          className={cn(
            'flex items-center border-b p-3',
            collapsed ? 'flex-col gap-2' : 'justify-between gap-2'
          )}
        >
          <Link
            href="/projects"
            aria-label="蜜塔 MeetBot 首頁"
            className="flex min-w-0 items-center gap-2.5 rounded-md p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <MeetaMark className="size-7" />
            {!collapsed && (
              <span className="truncate font-display text-lg font-bold">
                蜜塔 MeetBot
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展開側欄' : '收合側欄'}
            title={collapsed ? '展開側欄' : '收合側欄'}
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelLeftIcon />
          </button>
        </div>

        <div className={cn('p-3', collapsed && 'px-2.5')}>
          <Button
            className="w-full font-bold"
            size={collapsed ? 'icon' : 'default'}
            aria-label="建立會議"
            title={collapsed ? '建立會議' : undefined}
            onClick={() => setMeetingDialogOpen(true)}
          >
            {collapsed ? <PlusIcon /> : '+ 建立會議'}
          </Button>
        </div>

        <nav className={cn('flex-1 space-y-1 px-3', collapsed && 'px-2.5')}>
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? label : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon />
                <span className={cn(collapsed && 'sr-only')}>{label}</span>
              </Link>
            )
          })}
        </nav>

        <div className={cn('px-3 pb-1', collapsed && 'px-2.5')}>
          <InboxButton collapsed={collapsed} />
        </div>

        <div className={cn('border-t p-3', collapsed && 'p-2.5')}>
          {!collapsed && (
            <p className="mb-2 truncate px-1 text-xs text-muted-foreground">
              {session?.user?.email ?? ''}
            </p>
          )}
          <Button
            variant="outline"
            size={collapsed ? 'icon' : 'sm'}
            className="w-full"
            aria-label="登出"
            title={collapsed ? '登出' : undefined}
            onClick={() => signOut({ callbackUrl: '/login' })}
          >
            {collapsed ? <LogoutIcon /> : '登出'}
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
