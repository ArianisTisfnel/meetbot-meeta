import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'

const VEXA_API_URL = process.env.VEXA_API_URL ?? 'http://localhost:8056'
const VEXA_ADMIN_API_URL = process.env.VEXA_ADMIN_API_URL ?? 'http://localhost:8057'
const VEXA_ADMIN_API_KEY = process.env.VEXA_ADMIN_API_KEY ?? ''

async function getOrCreateVexaToken(email: string): Promise<string | null> {
  try {
    const adminHeaders = { 'X-Admin-API-Key': VEXA_ADMIN_API_KEY, 'Content-Type': 'application/json' }

    // Find or create user in Vexa
    const userRes = await fetch(`${VEXA_ADMIN_API_URL}/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email }),
    })
    if (!userRes.ok) return null

    const user = await userRes.json()

    // Create a new API token for this user
    const tokenRes = await fetch(`${VEXA_ADMIN_API_URL}/admin/users/${user.id}/tokens`, {
      method: 'POST',
      headers: adminHeaders,
    })
    if (!tokenRes.ok) return null

    const token = await tokenRes.json()
    return token.token
  } catch {
    return null
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile?.email) {
        const vexaToken = await getOrCreateVexaToken(profile.email)
        token.vexaToken = vexaToken
      }
      return token
    },
    async session({ session, token }) {
      ;(session as any).vexaToken = token.vexaToken
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
}
