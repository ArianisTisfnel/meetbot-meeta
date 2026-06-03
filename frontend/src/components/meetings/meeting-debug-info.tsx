import type { MeetingDetail } from '@/types/api'

/**
 * 會議除錯資訊框：顯示可對應到後端 / Vexa bot log 的識別碼。
 * - 會議 ID：app schema 的 UUID（前端路由用）
 * - Vexa Meeting ID：對應 vexa-lite 容器內 bot log 檔名 `meeting-<id>-*.log`
 * - Meet 連結：對應 bot log 的 `meeting_url`
 */
export function MeetingDebugInfo({
  meeting,
}: {
  meeting: Pick<MeetingDetail, 'id' | 'vexaMeetingId' | 'googleMeetUrl'>
}) {
  return (
    <div className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-1">
      <div className="font-medium text-foreground/70">除錯資訊</div>
      <div className="font-mono break-all">會議 ID：{meeting.id}</div>
      <div className="font-mono">
        Vexa Meeting ID：{meeting.vexaMeetingId ?? '—'}
        {meeting.vexaMeetingId != null && (
          <span className="ml-1 opacity-70">
            （bot log：meeting-{meeting.vexaMeetingId}-*.log）
          </span>
        )}
      </div>
      <div className="font-mono break-all">Meet 連結：{meeting.googleMeetUrl}</div>
    </div>
  )
}
