'use client'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useSession, signIn } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { useAcceptInvitationByToken } from '@/hooks/use-invitations'

type Phase = 'idle' | 'accepting' | 'success' | 'error'

function AcceptInvitationInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get('token')
  const { status } = useSession()
  const acceptMutation = useAcceptInvitationByToken()

  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const triggered = useRef(false)

  useEffect(() => {
    if (status !== 'authenticated' || !token || triggered.current) return
    triggered.current = true
    setPhase('accepting')
    acceptMutation
      .mutateAsync(token)
      .then(() => setPhase('success'))
      .catch((e: unknown) => {
        setErrorMsg((e as { message?: string })?.message ?? '接受邀請失敗')
        setPhase('error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, token])

  if (!token) {
    return <Centered title="連結無效" desc="缺少邀請 token，請確認你點的是完整的邀請連結。" />
  }

  if (status === 'loading') {
    return <Centered title="載入中…" desc="正在確認登入狀態。" />
  }

  if (status === 'unauthenticated') {
    return (
      <Centered
        title="接受專案邀請"
        desc="請使用「收到邀請的那個 email」登入後即可接受。"
      >
        <Button onClick={() => signIn('google', { callbackUrl: window.location.href })}>
          使用 Google 登入
        </Button>
      </Centered>
    )
  }

  if (phase === 'accepting' || phase === 'idle') {
    return <Centered title="接受邀請中…" desc="請稍候。" />
  }

  if (phase === 'success') {
    return (
      <Centered title="已加入專案 🎉" desc="你已成功接受邀請。">
        <Button onClick={() => router.push('/projects')}>前往我的專案</Button>
      </Centered>
    )
  }

  return (
    <Centered title="無法接受邀請" desc={errorMsg ?? '發生未知錯誤。'}>
      <Button variant="outline" onClick={() => router.push('/projects')}>
        前往我的專案
      </Button>
    </Centered>
  )
}

function Centered({
  title,
  desc,
  children,
}: {
  title: string
  desc: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border p-6 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{desc}</p>
        {children}
      </div>
    </div>
  )
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={null}>
      <AcceptInvitationInner />
    </Suspense>
  )
}
