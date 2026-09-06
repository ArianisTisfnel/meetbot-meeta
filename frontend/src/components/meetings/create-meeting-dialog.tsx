'use client'
import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCreateMeeting } from '@/hooks/use-meetings'
import { useCreateGlobalMeeting } from '@/hooks/use-all-meetings'
import { useProjects } from '@/hooks/use-projects'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'

interface ProjectScopedProps {
  mode: 'project'
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

interface GlobalProps {
  mode: 'global'
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

type Props = ProjectScopedProps | GlobalProps

/** 從任意文字抽出 Google Meet 連結（容忍前後雜訊與 query string）。 */
function extractMeetUrl(text: string): string | null {
  const m = text.match(/https?:\/\/meet\.google\.com\/[a-z]{3}-?[a-z]{4}-?[a-z]{3}\b/i)
  return m ? m[0] : null
}

export function CreateMeetingDialog(props: Props) {
  const [name, setName] = useState('')
  const [meetUrl, setMeetUrl] = useState('')
  const [projectId, setProjectId] = useState('')
  const [creatingMeet, setCreatingMeet] = useState(false)
  const { data: session } = useSession()

  const createProjectMeeting = useCreateMeeting(
    props.mode === 'project' ? props.projectId : ''
  )
  const createGlobalMeeting = useCreateGlobalMeeting()

  // 全局建立時，列出「我有會議權限」的專案供選擇
  const { data: projectList } = useProjects()
  const meetingProjects =
    projectList?.items.filter((p) => p.permissions.canMeeting) ?? []

  const handleSubmit = async (urlOverride?: string) => {
    const url = (urlOverride ?? meetUrl).trim()
    if (!url) {
      toast.error('請填入 Google Meet URL')
      return
    }
    try {
      if (props.mode === 'project') {
        await createProjectMeeting.mutateAsync({
          googleMeetUrl: url,
          name: name || undefined,
        })
      } else {
        await createGlobalMeeting.mutateAsync({
          googleMeetUrl: url,
          name: name || undefined,
          projectId: projectId || undefined,
        })
      }
      toast.success('會議已建立，蜜塔加入中…')
      setName('')
      setMeetUrl('')
      setProjectId('')
      props.onOpenChange(false)
      props.onSuccess?.()
    } catch (err: any) {
      toast.error(err?.message ?? '建立失敗')
      throw err
    }
  }

  /**
   * 真・一鍵：以使用者的 Google 授權直接在 Calendar 建立含 Meet 的事件 →
   * 拿到連結 → 建會議＋派蜜塔 → 把使用者帶進會議室。全程不需手動碰連結。
   */
  const handleOneClick = async () => {
    const accessToken = (session as any)?.googleAccessToken as string | undefined
    if (!accessToken) {
      toast.error('需要 Google 日曆授權：請登出後重新登入一次（同意畫面勾選日曆權限）')
      return
    }
    // 在使用者手勢內同步開視窗，避免彈窗攔截；失敗再收掉
    const win = window.open('about:blank', '_blank')
    setCreatingMeet(true)
    try {
      const now = new Date()
      const end = new Date(now.getTime() + 60 * 60 * 1000)
      const res = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            summary: name || '蜜塔會議',
            start: { dateTime: now.toISOString() },
            end: { dateTime: end.toISOString() },
            conferenceData: {
              createRequest: {
                requestId: crypto.randomUUID(),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          }),
        }
      )
      if (res.status === 401) {
        throw new Error('Google 授權已過期，請登出後重新登入')
      }
      if (res.status === 403) {
        throw new Error('Calendar API 未啟用或未授權日曆權限（見 GCP 設定步驟）')
      }
      if (!res.ok) {
        throw new Error(`Calendar API 錯誤（${res.status}）`)
      }
      const event = await res.json()
      const eventId: string | undefined = event.id
      const link: string | undefined =
        event.hangoutLink ??
        event.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === 'video')?.uri

      // Meet 連結一旦生成即獨立於日曆事件存活 → 用完就刪事件，日曆零殘留
      //（成功與失敗路徑都刪；fire-and-forget，刪失敗不影響開會）
      const deleteEvent = () => {
        if (!eventId) return
        void fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
        ).catch(() => {})
      }

      if (!link) {
        deleteEvent()
        throw new Error('Google 未回傳 Meet 連結')
      }

      setMeetUrl(link)
      try {
        await handleSubmit(link) // 建會議＋派蜜塔（失敗會 throw，不會開空會議室）
      } catch (err) {
        deleteEvent()
        throw err
      }
      if (win) win.location.replace(link)
      else toast.info(`彈出視窗被攔截，請手動開啟：${link}`, { duration: 10000 })
      deleteEvent()
    } catch (err: any) {
      win?.close()
      toast.error(err?.message ?? '一鍵建立失敗，可改用手動貼連結')
    } finally {
      setCreatingMeet(false)
    }
  }

  const isPending =
    createProjectMeeting.isPending || createGlobalMeeting.isPending || creatingMeet

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>建立新會議</DialogTitle>
        </DialogHeader>
        <div
          className="space-y-4"
          onPaste={(e: React.ClipboardEvent) => {
            // 貼上含 Meet 連結的雜訊文字 → 自動抽出乾淨連結填入
            const link = extractMeetUrl(e.clipboardData.getData('text'))
            if (link) {
              e.preventDefault()
              setMeetUrl(link)
            }
          }}
        >
          <div>
            <label className="text-sm font-medium">會議名稱（選填）</label>
            <Input
              placeholder="例：每週同步會議"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
            />
          </div>
          {props.mode === 'global' && (
            <div>
              <label className="text-sm font-medium">關聯專案（選填）</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">不關聯專案（建立獨立會議）</option>
                {meetingProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                關聯後，蜜塔會以該專案的資料回答問題。僅顯示你有會議權限的專案。
              </p>
            </div>
          )}
          <div>
            <label className="text-sm font-medium">Google Meet URL（選填）</label>
            <Input
              className="mt-1"
              placeholder="留空＝自動建立新會議；或貼上既有的 meet.google.com/... 連結"
              value={meetUrl}
              onChange={(e) => setMeetUrl(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={isPending}
          >
            取消
          </Button>
          <Button
            onClick={() => (meetUrl.trim() ? handleSubmit() : handleOneClick())}
            disabled={isPending}
          >
            {isPending ? '建立中…' : meetUrl.trim() ? '建立並邀請蜜塔' : '一鍵開會並邀請蜜塔'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
