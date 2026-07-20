import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'

export async function POST() {
  const session = await getServerSession(authOptions)
  const accessToken = (session as any)?.googleAccessToken
  if (!accessToken) {
    return NextResponse.json({ error: '未授權，請重新登入以授予日曆權限' }, { status: 401 })
  }

  const start = new Date()
  const end = new Date(start.getTime() + 60 * 60 * 1000)

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: '蜜塔會議',
        start: { dateTime: start.toISOString() },
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

  if (!res.ok) {
    // Google 錯誤可能是 JSON 或 HTML 頁面，只取簡短訊息避免把整頁倒給前端
    const detail = await res.text()
    let message = `HTTP ${res.status}`
    try {
      const parsed = JSON.parse(detail)
      message = parsed.error?.message ?? message
    } catch {
      /* HTML 錯誤頁，僅保留狀態碼 */
    }
    console.error('[meet/create] Google Calendar API error:', res.status, detail.slice(0, 500))
    return NextResponse.json({ error: `建立 Meet 失敗：${message}` }, { status: 502 })
  }

  const data = await res.json()
  const meetEntry = data.conferenceData?.entryPoints?.find(
    (e: any) => e.entryPointType === 'video'
  )
  if (!meetEntry?.uri) {
    return NextResponse.json({ error: '未取得 Meet 連結' }, { status: 502 })
  }

  return NextResponse.json({ meetUrl: meetEntry.uri as string })
}
