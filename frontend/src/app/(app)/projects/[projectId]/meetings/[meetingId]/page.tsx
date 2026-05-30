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
  params: Promise<{ projectId: string; meetingId: string }>
}

export default function MeetingDetailPage({ params }: Props) {
  const { projectId, meetingId } = use(params)
  const { data: meeting, isLoading } = useMeeting(projectId, meetingId)
  const botLeave = useBotLeave(projectId, meetingId)
  const { data: transcript } = useTranscriptions(
    meeting?.status === 'ENDED' ? projectId : null,
    meetingId
  )

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">載入中…</div>
  }

  if (!meeting) {
    return <div className="p-6 text-destructive">找不到此會議</div>
  }

  const handleLeave = async () => {
    if (!confirm('確定要讓蜜塔離開會議嗎？')) return
    botLeave.mutate(undefined, {
      onSuccess: () => toast.success('蜜塔已離開會議，摘要生成中…'),
      onError: () => toast.error('操作失敗'),
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link
              href={`/projects/${projectId}/meetings`}
              className="text-muted-foreground hover:text-foreground"
            >
              ← 返回
            </Link>
            <h2 className="text-xl font-semibold">{meeting.name}</h2>
            <BotStatusIndicator status={meeting.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {meeting.googleMeetUrl}
            <button
              className="ml-2 text-primary hover:underline"
              onClick={() => {
                navigator.clipboard.writeText(meeting.googleMeetUrl)
                toast.success('已複製連結')
              }}
            >
              📋 複製
            </button>
          </p>
          {meeting.startedAt && (
            <p className="text-sm text-muted-foreground mt-1">
              {formatDate(meeting.startedAt)}
              {meeting.endedAt && ` ~ ${formatDate(meeting.endedAt)}`}
            </p>
          )}
        </div>
        {meeting.status === 'ACTIVE' && (
          <Button
            variant="destructive"
            onClick={handleLeave}
            disabled={botLeave.isPending}
          >
            結束會議
          </Button>
        )}
      </div>

      {/* Content by status */}
      {meeting.status === 'FAILED' && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6">
          <h3 className="font-semibold text-destructive mb-2">⚠️ Bot 建立失敗</h3>
          <p className="text-sm text-muted-foreground">
            蜜塔未能成功加入此會議（可能原因：服務重啟、網路問題）。
            <br />請返回專案頁面，重新邀請 Bot 加入新會議。
          </p>
          <Button className="mt-4" asChild>
            <Link href={`/projects/${projectId}/meetings`}>← 返回專案</Link>
          </Button>
        </div>
      )}

      {meeting.status === 'ACTIVE' && (
        <LiveTranscript
          projectId={projectId}
          meetingId={meetingId}
          isActive
        />
      )}

      {meeting.status === 'ENDED' && (
        <>
          <MeetingSummary
            summary={meeting.summary}
            actionItems={meeting.actionItems}
          />
          {transcript && transcript.items.length > 0 && (
            <div className="rounded-lg border p-6">
              <h3 className="font-semibold mb-4">完整逐字稿</h3>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {transcript.items.map((seg, i) => (
                  <div key={i} className="text-sm">
                    <span className="text-muted-foreground mr-2">
                      {Math.floor(seg.startTime / 60)}:
                      {String(Math.floor(seg.startTime % 60)).padStart(2, '0')}
                    </span>
                    <span className="font-medium mr-2">
                      [{seg.speaker ?? '參與者'}]
                    </span>
                    <span>{seg.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
