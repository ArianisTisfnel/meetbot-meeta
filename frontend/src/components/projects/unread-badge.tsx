'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useProjectNotifications } from '@/hooks/use-notifications'
import { formatDate, displayName } from '@/lib/utils'
import type { ActivityAction, ProjectUnread, SectionKey } from '@/types/api'

interface Props {
  projectId: string
  projectName: string
  unread: ProjectUnread
}

const ACTION_LABEL: Record<ActivityAction, string> = {
  MATERIAL_UPLOAD: '上傳了資料',
  MATERIAL_DELETE: '刪除了資料',
  MEMBER_INVITE: '邀請了成員',
  MEMBER_ADD: '加入了成員',
  MEMBER_REMOVE: '移除了成員',
  MEMBER_PERMISSION_UPDATE: '調整了權限',
  MEETING_CREATE: '開了一場會議',
  MEETING_SCHEDULE: '排定了會議',
  MEETING_DELETE: '刪除了會議',
  PROJECT_RENAME: '把專案改名為',
}

const SECTION_LABEL: Record<SectionKey, string> = {
  materials: '資料',
  meetings: '會議',
  calendar: '行事曆',
  members: '成員',
  history: '歷史',
}

/** 一句話講清楚圓點裡的數字是什麼，滑過去或用讀屏都看得到 */
function summarize(unread: ProjectUnread) {
  const parts: string[] = []
  if (unread.rsvpCount > 0) parts.push(`${unread.rsvpCount} 場會議待回覆出席`)
  for (const key of Object.keys(SECTION_LABEL) as SectionKey[]) {
    // 行事曆的數字含待回覆，上面已經單獨講過，這裡只補動態的部分
    const n =
      key === 'calendar'
        ? unread.sections.calendar - unread.rsvpCount
        : unread.sections[key]
    if (n > 0) parts.push(`${SECTION_LABEL[key]} ${n} 則`)
  }
  return parts.join('、')
}

/**
 * 專案卡右上角的未讀圓點。
 *
 * 數字是各分頁相加，滿 100 顯示 99+（再多也沒有意義，圓點會被撐爛）。
 * 卡片本身是 stretched link（整張卡可點進專案），所以這顆按鈕要 z-10 才點得到。
 */
export function UnreadBadge({ projectId, projectName, unread }: Props) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { data, isLoading } = useProjectNotifications(projectId, open)

  const count = unread?.total ?? 0
  if (count <= 0) return null

  const summary = summarize(unread)

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // 不要順便觸發整卡連結
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        title={summary}
        className="absolute -right-2 -top-2 z-10 flex size-6 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold leading-none text-destructive-foreground shadow-sm ring-2 ring-background transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
        <span className="sr-only">
          {projectName} 有更新：{summary}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{projectName} · 更新</DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">載入中…</p>
          ) : (
            <ol className="max-h-96 space-y-2 overflow-y-auto text-sm">
              {data?.rsvpItems.map((m, i) => (
                <li
                  key={m.meetingId}
                  className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
                >
                  <span className="shrink-0 text-muted-foreground">{i + 1}.</span>
                  <div className="min-w-0">
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {m.scheduledStartAt ? formatDate(m.scheduledStartAt) : '未排定時間'}
                      {' · '}
                      <span className="font-medium text-destructive">待回覆出席</span>
                      {' · 行事曆'}
                    </div>
                  </div>
                </li>
              ))}

              {data?.activityItems.map((a, i) => (
                <li key={a.id} className="flex gap-2 rounded-md border p-3">
                  <span className="shrink-0 text-muted-foreground">
                    {(data?.rsvpItems.length ?? 0) + i + 1}.
                  </span>
                  <div className="min-w-0">
                    <div>
                      <span className="font-medium">
                        {displayName(a.actor.name, a.actor.email)}
                      </span>{' '}
                      {ACTION_LABEL[a.action] ?? a.action}{' '}
                      <span className="font-medium">{a.targetLabel}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(a.createdAt)} · {SECTION_LABEL[a.section]}
                    </div>
                  </div>
                </li>
              ))}

              {data && data.rsvpItems.length === 0 && data.activityItems.length === 0 && (
                <li className="py-6 text-center text-muted-foreground">
                  沒有新的更新
                </li>
              )}
            </ol>
          )}

          {unread.rsvpCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                router.push(`/projects/${projectId}/calendar`)
              }}
              className="mt-1 inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-ink-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              去行事曆回覆出席 →
            </button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
