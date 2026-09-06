import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'

/**
 * 向後端內部端點換取 API token（登入流程的唯一發 token 路徑）。
 *
 * 回 null 時務必留下訊息：這裡失敗**不會**讓登入失敗——NextAuth 照樣建立 session，
 * 只是 session.authToken 是 null，於是之後每一個 API 呼叫都丟 "Not authenticated"。
 * 使用者看到的是「登入成功但全站壞掉」，若這裡靜默回 null 就沒有任何線索指向原因
 * （移除 Vexa 之前還有 docker exec 後路兜著，現在沒有了）。
 */
async function getTokenViaBackend(email: string, name?: string | null): Promise<string | null> {
  const secret = process.env.INTERNAL_AUTH_SECRET
  if (!secret) {
    console.error(
      '[auth] INTERNAL_AUTH_SECRET 未設定 → 無法取得 API token，登入後所有 API 都會 401。' +
        '請在 frontend/.env.local 與 backend/.env 設同一組值（start.ps1 會自動補齊）。',
    )
    return null
  }
  const base = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
  try {
    const res = await fetch(`${base}/internal/token`, {
      method: 'POST',
      headers: { 'x-internal-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name }),
    })
    if (!res.ok) {
      console.error(
        `[auth] /internal/token 回 ${res.status} → 無法取得 API token。` +
          (res.status === 401
            ? ' 前後端的 INTERNAL_AUTH_SECRET 不一致。'
            : res.status === 503
              ? ' 後端沒設 INTERNAL_AUTH_SECRET（端點停用）。'
              : ''),
      )
      return null
    }
    const data = (await res.json()) as { token?: string }
    if (!data.token) {
      console.error('[auth] /internal/token 回 200 但沒有 token 欄位 → 無法取得 API token。')
      return null
    }
    return data.token
  } catch (err) {
    console.error(`[auth] 呼叫 ${base}/internal/token 失敗（後端沒起來？）→ 無法取得 API token。`, err)
    return null
  }
}

/**
 * 把 Google refresh token 交給後端保存，讓背景同步在使用者離線時也能運作。
 *
 * 一律 best-effort：這裡失敗只代表行事曆同步不會動，不該讓登入失敗。
 * Google 沒發新的 refresh token 時照樣呼叫——後端會保留既有連結，
 * 順便藉此確認連結還在。
 */
async function saveCalendarConnection(
  email: string,
  refreshToken?: string | null,
): Promise<void> {
  const secret = process.env.INTERNAL_AUTH_SECRET
  if (!secret) return
  const base =
    process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
  try {
    const res = await fetch(`${base}/internal/calendar-connection`, {
      method: 'POST',
      headers: { 'x-internal-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, refreshToken: refreshToken ?? null }),
    })
    if (!res.ok) {
      console.error(
        `[auth] /internal/calendar-connection 回 ${res.status} → 行事曆同步不會運作（其餘功能不受影響）。`,
      )
    }
  } catch (err) {
    console.error('[auth] 保存 Google Calendar 連結失敗 → 行事曆同步不會運作。', err)
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      // calendar.events：一鍵建立會議 + 行事曆把會議寫回與會者日曆。
      // calendar.freebusy：只讀「幾點到幾點忙」，不讀行程標題與內容——疊圖與找空檔
      //   只需要這個，是能滿足需求的最小權限（spec §5 隱私）。
      //
      // access_type=offline + prompt=consent：後端要拿得到 refresh token，才能在
      // 使用者離線時同步忙碌時段。Google 只在「重新同意授權」時發 refresh token，
      // 不強制 prompt 的話換一台裝置登入就再也拿不到，背景同步會無聲失效。
      // 代價是每次登入都會看到同意畫面——若覺得太吵，可改成拿掉 prompt 並另做一顆
      // 「連結 Google Calendar」按鈕走獨立授權流程。
      //
      // 新 scope 生效需重新登入一次；使用者若在同意畫面拒絕日曆權限，登入仍成功，
      // 只是行事曆同步與一鍵建立會退化。
      authorization: {
        params: {
          scope: [
            'openid',
            'email',
            'profile',
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/calendar.freebusy',
          ].join(' '),
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile?.email) {
        const authToken = await getTokenViaBackend(profile.email, profile.name)
        token.authToken = authToken
        // 必須排在取得 authToken 之後：後端要先有這個使用者才存得了連結
        await saveCalendarConnection(profile.email, account.refresh_token)
      }
      if (account) {
        // Google access token（約 1 小時效期）：一鍵建立會議的 Calendar API 呼叫用。
        // 未實作 refresh rotation——過期時前端會提示重新登入（demo 場景足夠）。
        token.googleAccessToken = account.access_token
        token.googleAccessTokenExpires = account.expires_at
      }
      return token
    },
    async session({ session, token }) {
      ;(session as any).authToken = token.authToken
      ;(session as any).googleAccessToken = token.googleAccessToken
      ;(session as any).googleAccessTokenExpires = token.googleAccessTokenExpires
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
}
