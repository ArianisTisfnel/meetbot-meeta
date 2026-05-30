'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CreateMeetingDialog } from '@/components/meetings/create-meeting-dialog'
import { cn } from '@/lib/utils'

export function Sidebar() {
  const pathname = usePathname()
  const [meetingDialogOpen, setMeetingDialogOpen] = useState(false)

  const navItems = [
    { href: '/projects', label: '📁 Projects' },
    { href: '/meetings', label: '🗂 Meetings' },
  ]

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

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent',
                pathname.startsWith(item.href) && 'bg-accent font-medium'
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t text-xs text-muted-foreground truncate">
          meetbot
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
