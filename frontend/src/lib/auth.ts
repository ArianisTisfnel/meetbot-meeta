import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'

async function getTokenViaBackend(email: string, name?: string | null): Promise<string | null> {
  const secret = process.env.INTERNAL_AUTH_SECRET
  if (!secret) return null
  const base = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
  try {
    const res = await fetch(`${base}/internal/token`, {
      method: 'POST',
      headers: { 'x-internal-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { token?: string }
    return data.token ?? null
  } catch {
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
