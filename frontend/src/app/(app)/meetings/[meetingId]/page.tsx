'use client'
import { use } from 'react'
import Link from 'next/link'
import { useMeeting, useBotLeave } from '@/hooks/use-meeting'
import { useTranscriptions } from '@/hooks/use-transcriptions'
import { LiveTranscript } from '@/components/meetings/live-transcript'
import { MeetingSummary } from '@/components/meetings/meeting-summary'
import { BotStatusIndicator } from '@/components/meetings/bot-status-indicator'
import { CancelMeetingButton } from '@/components/meetings/cancel-meeting-button'
import { ReinviteBotButton } from '@/components/meetings/reinvite-bot-button'
import { MeetingDebugInfo } from '@/components/meetings/meeting-debug-info'
import { Button } from '@/components/ui/button'
import { WarningIcon } from '@/components/ui/icons'
import { formatDate } from '@/lib/utils'
import { toast } from 'sonner'

interface Props {
  params: Promise<{ meetingId: string }>
}

export default function GlobalMeetingDetailPage({ params }: Props) {
  const { meetingId } = use(params)
  const { data: meeting, isLoading } = useMeeting(null, meetingId)
  const botLeave = useBotLeave(null, meetingId)
  const { data: transcript } = useTranscriptions(
    meeting?.status === 'ENDED' ? null : null,
    meetingId
  )

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">載入中…</div>
  }

  if (!meeting) {
    return <div className="p-6 text-destructive">找不到此會議</div>
  }

  const handleLeave = () => {
    if (!confirm('確定要讓蜜塔離開會議嗎？')) return
    botLeave.mutate(undefined, {
      onSuccess: () => toast.success('蜜塔已離開會議，摘要生成中…'),
      onError: () => toast.error('操作失敗'),
    })
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/meetings" className="text-muted-foreground hover:text-foreground">
              ← 返回
            </Link>
            <h2 className="text-xl font-semibold">{meeting.name}</h2>
            <BotStatusIndicator status={meeting.status} />
          </div>
          {meeting.startedAt && (
            <p className="text-sm text-muted-foreground">
              {formatDate(meeting.startedAt)}
              {meeting.endedAt && ` ~ ${formatDate(meeting.endedAt)}`}
            </p>
          )}
        </div>
        {meeting.status === 'ACTIVE' && (
          <Button variant="destructive" onClick={handleLeave} disabled={botLeave.isPending}>
            結束會議
          </Button>
        )}
        {meeting.status === 'PENDING' && (
          <CancelMeetingButton projectId={null} meetingId={meetingId} />
        )}
        {(meeting.status === 'FAILED' || meeting.status === 'ENDED') && (
          <ReinviteBotButton projectId={null} meetingId={meetingId} />
        )}
      </div>

      <MeetingDebugInfo meeting={meeting} />

      {meeting.status === 'FAILED' && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6">
          <h3 className="mb-2 flex items-center gap-2 font-semibold text-destructive">
            <WarningIcon className="size-4" />
            蜜塔加入失敗
          </h3>
          <p className="text-sm text-muted-foreground">
            蜜塔未能成功加入此會議。常見原因與處理方式：
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground space-y-1">
            <li>
              <span className="font-medium">候客室未放行</span>：主持人需在 Google Meet 中開啟「快速存取（Quick Access）」，或手動允許蜜塔進入。
            </li>
            <li>
              <span className="font-medium">會議設定限制訪客</span>：部分 Google 帳號會封鎖非 Google 帳號的訪客請求，請改用允許訪客的會議。
            </li>
            <li>
              <span className="font-medium">服務暫時性問題</span>：服務重啟或網路問題，可直接重試。
            </li>
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            調整後可直接按右上角「重新邀請蜜塔」，無需重新建立會議。
          </p>
          <Button className="mt-4" variant="outline" asChild>
            <Link href="/meetings">← 返回 Meetings</Link>
          </Button>
        </div>
      )}

      {meeting.status === 'ACTIVE' && (
        <LiveTranscript projectId={null} meetingId={meetingId} isActive />
      )}

      {meeting.status === 'ENDED' && (
        <MeetingSummary
          summary={meeting.summary}
          actionItems={meeting.actionItems}
        />
      )}
    </div>
  )
}
