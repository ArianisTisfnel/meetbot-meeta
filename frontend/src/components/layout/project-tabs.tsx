'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  DocIcon,
  MeetingIcon,
  PeopleIcon,
  ClockIcon,
} from '@/components/ui/icons'
import { cn } from '@/lib/utils'

interface Props {
  projectId: string
}

const TABS = [
  { href: 'materials', label: '資料', icon: DocIcon },
  { href: 'meetings', label: '會議', icon: MeetingIcon },
  { href: 'members', label: '成員', icon: PeopleIcon },
  { href: 'history', label: '歷史', icon: ClockIcon },
]

export function ProjectTabs({ projectId }: Props) {
  const pathname = usePathname()

  return (
    <div className="flex border-b px-2">
      {TABS.map(({ href: slug, label, icon: Icon }) => {
        const href = `/projects/${projectId}/${slug}`
        const isActive = pathname.startsWith(href)
        return (
          <Link
            key={slug}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              isActive
                ? 'border-honey text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className={cn(isActive && 'text-honey-deep')} />
            {label}
          </Link>
        )
      })}
    </div>
  )
}
