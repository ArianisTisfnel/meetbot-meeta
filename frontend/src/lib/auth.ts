import { execFileSync } from 'child_process'
import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'

const VEXA_ADMIN_API_KEY = process.env.VEXA_ADMIN_API_KEY ?? ''

// Admin API (8057) only binds to 127.0.0.1 inside the container, so Docker port
// forwarding can't reach it. We use docker exec to call it from within the container.
function getVexaContainerId(): string | null {
  try {
    // 1) 先用 ancestor 精確過濾。
    const byAncestor = execFileSync(
      'docker',
      ['ps', '--filter', 'ancestor=vexaai/vexa-lite:latest', '-q'],
      { timeout: 3000 },
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)[0]
    if (byAncestor) return byAncestor

    // 2) Fallback：當 vexaai/vexa-lite:latest tag 飄移（被重新 pull 指到新 image，
    //    但執行中的容器仍是舊 image）時，ancestor filter 會失效。改列出所有執行中
    //    容器、比對其「建立時的 image 名稱」前綴，避開 tag 飄移問題。
    const ids = execFileSync('docker', ['ps', '-q'], { timeout: 3000 })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const id of ids) {
      const image = execFileSync('docker', ['inspect', id, '--format', '{{.Config.Image}}'], {
        timeout: 3000,
      })
        .toString()
        .trim()
      if (image.startsWith('vexaai/vexa-lite')) return id
    }
    return null
  } catch {
    return null
  }
}

function dockerExecCurl(containerId: string, args: string[]): unknown {
  const result = execFileSync('docker', ['exec', containerId, 'curl', '-s', ...args], { timeout: 8000 })
  return JSON.parse(result.toString())
}

async function getOrCreateVexaToken(email: string, name?: string | null): Promise<string | null> {
  const containerId = getVexaContainerId()
  if (!containerId) return null

  try {
    // 帶上 Google 的顯示名稱，讓 Vexa public.users.name 有值
    // （否則成員列表只能 fallback 顯示 email 前段，見 U8/U16）
    const body: { email: string; name?: string } = { email }
    if (name) body.name = name

    const user = dockerExecCurl(containerId, [
      '-X', 'POST',
      '-H', `X-Admin-API-Key: ${VEXA_ADMIN_API_KEY}`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(body),
      'http://localhost:8057/admin/users',
    ]) as { id?: number }
    if (!user.id) return null

    const token = dockerExecCurl(containerId, [
      '-X', 'POST',
      '-H', `X-Admin-API-Key: ${VEXA_ADMIN_API_KEY}`,
      `http://localhost:8057/admin/users/${user.id}/tokens?scopes=bot,browser,tx`,
    ]) as { token?: string }
    return token.token ?? null
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
        const vexaToken = await getOrCreateVexaToken(profile.email, profile.name)
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
