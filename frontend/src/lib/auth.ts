import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'

const VEXA_API_URL = process.env.VEXA_API_URL ?? 'http://localhost:8056'
const VEXA_ADMIN_API_URL = process.env.VEXA_ADMIN_API_URL ?? 'http://localhost:8057'
const VEXA_ADMIN_API_KEY = process.env.VEXA_ADMIN_API_KEY ?? ''

async function getOrCreateVexaToken(email: string): Promise<string | null> {
  try {
    // Look up user in Vexa
    const lookupRes = await fetch(`${VEXA_ADMIN_API_URL}/users/lookup?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': VEXA_ADMIN_API_KEY },
    })
    if (lookupRes.ok) {
      const user = await lookupRes.json()
      // Get or create API token for this user
      const tokenRes = await fetch(`${VEXA_ADMIN_API_URL}/users/${user.id}/tokens`, {
        method: 'POST',
        headers: { 'X-API-Key': VEXA_ADMIN_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes: ['bot', 'browser', 'tx'] }),
      })
      if (tokenRes.ok) {
        const token = await tokenRes.json()
        return token.token
      }
    }
    return null
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
