'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

interface Props {
  projectId: string
}

const TABS = [
  { href: 'materials', label: '資料', materialIcon: 'draft' },
  { href: 'meetings', label: '會議', materialIcon: 'video_call' },
  { href: 'members', label: '成員', materialIcon: 'group' },
  { href: 'history', label: '歷史', materialIcon: 'history' },
]

export function ProjectTabs({ projectId }: Props) {
  const pathname = usePathname()

  return (
    <div className="flex border-b">
      {TABS.map((tab) => {
        const href = `/projects/${projectId}/${tab.href}`
        const isActive = pathname.startsWith(href)
        return (
          <Link
            key={tab.href}
            href={href}
            className={cn(
              'flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
              isActive
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {'materialIcon' in tab ? (
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                {tab.materialIcon}
              </span>
            ) : (
              <span>{tab.emoji}</span>
            )}
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
