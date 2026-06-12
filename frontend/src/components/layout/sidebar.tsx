'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { CreateMeetingDialog } from '@/components/meetings/create-meeting-dialog'
import { InboxButton } from '@/components/inbox/inbox-button'
import { MeetaMark } from '@/components/landing/meeta-mark'
import { cn } from '@/lib/utils'

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
    </svg>
  )
}

function MeetingIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <rect x="1.5" y="4" width="9" height="8" rx="1" />
      <path d="m10.5 7 4-2v6l-4-2" />
    </svg>
  )
}

const NAV_ITEMS = [
  { href: '/projects', label: '專案', icon: FolderIcon },
  { href: '/meetings', label: '會議', icon: MeetingIcon },
]

export function Sidebar() {
  const pathname = usePathname()
  const [meetingDialogOpen, setMeetingDialogOpen] = useState(false)
  const { data: session } = useSession()

  return (
    <>
      <aside className="flex h-dvh w-64 shrink-0 flex-col border-r bg-background">
        <div className="border-b p-4">
          <Link
            href="/projects"
            className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <MeetaMark className="size-7" />
            <span className="font-display text-lg font-bold">蜜塔 MeetBot</span>
          </Link>
        </div>

        <div className="p-3">
          <Button
            className="w-full font-bold"
            onClick={() => setMeetingDialogOpen(true)}
          >
            + 建立會議
          </Button>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon />
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="px-3 pb-1">
          <InboxButton />
        </div>

        <div className="border-t p-4">
          <p className="mb-2 truncate text-xs text-muted-foreground">
            {session?.user?.email ?? ''}
          </p>
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
