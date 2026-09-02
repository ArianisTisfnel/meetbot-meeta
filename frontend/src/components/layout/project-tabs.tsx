'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  CalendarIcon,
  DocIcon,
  MeetingIcon,
  PeopleIcon,
  ClockIcon,
} from '@/components/ui/icons'
import { cn } from '@/lib/utils'
import type { ProjectUnread, SectionKey } from '@/types/api'

interface Props {
  projectId: string
  /** 各分頁的未讀數；哪裡有變動就在哪個分頁亮紅點 */
  unread?: ProjectUnread
}

const TABS: { href: SectionKey; label: string; icon: typeof DocIcon }[] = [
  { href: 'materials', label: '資料', icon: DocIcon },
  { href: 'meetings', label: '會議', icon: MeetingIcon },
  { href: 'calendar', label: '行事曆', icon: CalendarIcon },
  { href: 'members', label: '成員', icon: PeopleIcon },
  { href: 'history', label: '歷史', icon: ClockIcon },
]

export function ProjectTabs({ projectId, unread }: Props) {
  const pathname = usePathname()

  return (
    <div className="flex border-b px-2">
      {TABS.map(({ href: slug, label, icon: Icon }) => {
        const href = `/projects/${projectId}/${slug}`
        const isActive = pathname.startsWith(href)
        const count = unread?.sections?.[slug] ?? 0
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
            {count > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
                >
                  {count > 99 ? '99+' : count}
                </span>
                <span className="sr-only">，{count} 則未讀</span>
              </>
            )}
          </Link>
        )
      })}
    </div>
  )
}
