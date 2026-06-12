'use client'
import { use } from 'react'
import { useHistory } from '@/hooks/use-history'
import { formatDate, displayName } from '@/lib/utils'
import {
  UploadIcon,
  TrashIcon,
  MailIcon,
  PlusIcon,
  MinusIcon,
  SlidersIcon,
  MeetingIcon,
  PencilIcon,
} from '@/components/ui/icons'
import type { ActivityAction } from '@/types/api'

interface Props {
  params: Promise<{ projectId: string }>
}

type IconComponent = (p: { className?: string }) => React.ReactNode

const ACTION_CONFIG: Record<ActivityAction, { Icon: IconComponent; label: string }> = {
  MATERIAL_UPLOAD:          { Icon: UploadIcon, label: '上傳資料' },
  MATERIAL_DELETE:          { Icon: TrashIcon, label: '刪除資料' },
  MEMBER_INVITE:            { Icon: MailIcon, label: '邀請成員' },
  MEMBER_ADD:               { Icon: PlusIcon, label: '加入成員' },
  MEMBER_REMOVE:            { Icon: MinusIcon, label: '移除成員' },
  MEMBER_PERMISSION_UPDATE: { Icon: SlidersIcon, label: '調整權限' },
  MEETING_CREATE:           { Icon: MeetingIcon, label: '建立會議' },
  PROJECT_RENAME:           { Icon: PencilIcon, label: '重新命名專案' },
}


export default function HistoryPage({ params }: Props) {
  const { projectId } = use(params)
  const { data, isLoading } = useHistory(projectId)

  return (
    <div>
      <h2 className="font-semibold mb-6">活動紀錄</h2>

      {isLoading ? (
        <p className="text-muted-foreground">載入中…</p>
      ) : data?.items.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">尚無活動紀錄</p>
      ) : (
        <div className="space-y-2">
          {data?.items.map((item) => {
            const cfg = ACTION_CONFIG[item.action]
            return (
              <div
                key={item.id}
                className="flex items-center gap-4 text-sm py-2 border-b"
              >
                <span className="text-muted-foreground w-40 shrink-0">
                  {formatDate(item.createdAt)}
                </span>
                <span className="w-28 shrink-0 truncate" title={displayName(item.actor.name, item.actor.email)}>
                  {displayName(item.actor.name, item.actor.email)}
                </span>
                <span className="flex w-28 shrink-0 items-center gap-1.5">
                  {cfg && (
                    <cfg.Icon className="size-3.5 text-muted-foreground" />
                  )}
                  {cfg?.label ?? item.action}
                </span>
                <span className="font-medium truncate">{item.targetLabel}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
