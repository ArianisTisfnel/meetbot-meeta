'use client'
import { signIn } from 'next-auth/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { RefreshIcon } from '@/components/ui/icons'
import {
  useCalendarConnection,
  useDisconnectCalendar,
  useSyncCalendar,
} from '@/hooks/use-calendar'

/** 「3 分鐘前」這種相對時間；同步狀態看的是新鮮度，不是精確時刻。 */
function relativeTime(iso: string): string {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (diffMin < 1) return '剛剛'
  if (diffMin < 60) return `${diffMin} 分鐘前`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小時前`
  return `${Math.round(diffHour / 24)} 天前`
}

/**
 * Google Calendar 連結狀態卡。
 *
 * 四種狀態各自對應一個明確的下一步（spec §4.4）：
 *   後端未設定 → 什麼都不能做，說清楚是設定問題而非使用者的錯
 *   未連結     → 重新登入以授權
 *   授權失效   → 重新連結
 *   已連結     → 立即同步／中斷連結
 */
export function CalendarConnectionCard() {
  const { data, isLoading } = useCalendarConnection()
  const sync = useSyncCalendar()
  const disconnect = useDisconnectCalendar()

  if (isLoading || !data) return null

  if (!data.configured) {
    return (
      <section className="rounded-lg border border-dashed bg-card p-3">
        <h2 className="mb-1 text-sm font-bold">Google Calendar</h2>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          後端尚未設定 Google OAuth 憑證，行事曆同步功能停用。疊圖與找空檔只會用到本系統的會議。
        </p>
      </section>
    )
  }

  const handleSync = async () => {
    try {
      const result = await sync.mutateAsync()
      if (result.synced) {
        toast.success(`已同步 ${result.blockCount} 筆忙碌時段`)
      } else {
        toast.error(result.error ?? '同步失敗')
      }
    } catch (err: any) {
      toast.error(err?.message ?? '同步失敗')
    }
  }

  const handleDisconnect = async () => {
    try {
      await disconnect.mutateAsync()
      toast.success('已中斷連結，快取的忙碌時段也一併清除')
    } catch (err: any) {
      toast.error(err?.message ?? '中斷連結失敗')
    }
  }

  // 重新授權走的是登入流程本身（NextAuth 已帶 offline access 與同意畫面）
  const reconnect = () => signIn('google')

  if (!data.connected) {
    return (
      <section className="rounded-lg border bg-card p-3">
        <h2 className="mb-1 text-sm font-bold">Google Calendar</h2>
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          連結後，你的忙碌時段會出現在疊圖上，找空檔也會把它算進去。
        </p>
        <Button size="sm" className="w-full" onClick={reconnect}>
          連結 Google Calendar
        </Button>
      </section>
    )
  }

  if (data.status === 'EXPIRED') {
    return (
      <section className="rounded-lg border border-destructive/40 bg-card p-3">
        <h2 className="mb-1 text-sm font-bold">Google Calendar</h2>
        <p className="mb-2 text-[11px] leading-relaxed text-destructive">
          授權已失效，目前只使用本系統的會議資料。重新連結後忙碌時段才會恢復。
        </p>
        <Button size="sm" className="w-full" onClick={reconnect}>
          重新連結
        </Button>
      </section>
    )
  }

  return (
    <section className="rounded-lg border bg-card p-3">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-bold">Google Calendar</h2>
        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800">
          已連結
        </span>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {data.lastSyncedAt ? `上次同步 ${relativeTime(data.lastSyncedAt)}` : '尚未同步過'}
      </p>
      {data.lastSyncError && (
        <p className="mb-2 rounded-md bg-destructive/10 px-2 py-1 text-[11px] leading-relaxed text-destructive">
          {data.lastSyncError}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5"
          onClick={handleSync}
          disabled={sync.isPending}
        >
          <RefreshIcon className="size-3.5" />
          {sync.isPending ? '同步中…' : '立即同步'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={handleDisconnect}
          disabled={disconnect.isPending}
        >
          中斷
        </Button>
      </div>
    </section>
  )
}
