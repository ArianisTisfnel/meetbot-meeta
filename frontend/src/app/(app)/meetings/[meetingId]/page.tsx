'use client'
import { use } from 'react'
import Link from 'next/link'
import { useMeeting, useBotLeave } from '@/hooks/use-meeting'
import { useTranscriptions } from '@/hooks/use-transcriptions'
import { LiveTranscript } from '@/components/meetings/live-transcript'
import { MeetingSummary } from '@/components/meetings/meeting-summary'
import { BotStatusIndicator } from '@/components/meetings/bot-status-indicator'
import { Button } from '@/components/ui/button'
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
      </div>

      {meeting.status === 'FAILED' && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6">
          <h3 className="font-semibold text-destructive mb-2">⚠️ Bot 建立失敗</h3>
          <p className="text-sm text-muted-foreground">
            蜜塔未能成功加入此會議。請返回重新建立會議。
          </p>
          <Button className="mt-4" asChild>
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
