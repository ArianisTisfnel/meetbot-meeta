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

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      // calendar.events：一鍵建立會議用（前端以使用者身分呼叫 Calendar API 生成 Meet 連結）。
      // 新 scope 生效需重新登入一次；使用者若在同意畫面拒絕日曆權限，登入仍成功，
      // 僅一鍵建立退化為手動貼連結。
      authorization: {
        params: {
          scope: 'openid email profile https://www.googleapis.com/auth/calendar.events',
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile?.email) {
        const authToken = await getTokenViaBackend(profile.email, profile.name)
        token.authToken = authToken
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
