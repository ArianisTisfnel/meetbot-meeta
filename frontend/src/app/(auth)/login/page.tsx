import { signIn } from 'next-auth/react'
import { Button } from '@/components/ui/button'

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-lg border shadow-sm text-center">
        <h1 className="text-2xl font-bold mb-2">🤖 MeetBot</h1>
        <p className="text-muted-foreground mb-8">AI 會議助理，讓蜜塔加入你的 Google Meet</p>
        <form action={async () => {
          'use server'
          // handled client-side below
        }}>
          <Button
            className="w-full"
            onClick={() => signIn('google', { callbackUrl: '/projects' })}
            type="button"
          >
            使用 Google 帳號登入
          </Button>
        </form>
      </div>
    </div>
  )
}
