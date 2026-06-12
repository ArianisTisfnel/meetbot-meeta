'use client'

import Link from 'next/link'
import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { MeetaMark } from '@/components/landing/meeta-mark'

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0">
      <path
        d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z"
        fill="#4285F4"
      />
      <path
        d="M12 24c3.24 0 5.96-1.07 7.93-2.91l-3.87-3c-1.07.72-2.45 1.14-4.06 1.14-3.13 0-5.78-2.11-6.72-4.95H1.29v3.1A12 12 0 0 0 12 24Z"
        fill="#34A853"
      />
      <path
        d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.29a12 12 0 0 0 0 10.76l3.99-3.1Z"
        fill="#FBBC05"
      />
      <path
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.43-3.43A11.97 11.97 0 0 0 1.29 6.62l3.99 3.1C6.22 6.88 8.87 4.77 12 4.77Z"
        fill="#EA4335"
      />
    </svg>
  )
}

// NextAuth 錯誤代碼 → 使用者看得懂的說明
const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: '這個 Google 帳號沒有獲得授權，請換一個帳號試試。',
  OAuthAccountNotLinked: '這個 Email 已用其他方式登入過，請用原本的方式登入。',
  Configuration: '登入服務暫時無法使用，請稍後再試。',
}

function LoginForm() {
  const searchParams = useSearchParams()
  const error = searchParams.get('error')
  const [pending, setPending] = useState(false)

  return (
    <main className="w-full max-w-sm">
      {/* 仿 Meet 字幕的小提示，連結 landing 的逐字稿語彙 */}
      <p
        className="mb-rise mx-auto mb-8 flex w-fit items-center gap-2 rounded-full bg-hive px-4 py-2 text-xs text-hive-fg"
        style={{ '--d': '0.1s' } as React.CSSProperties}
      >
        <span className="font-mono text-hive-faint">10:02</span>
        蜜塔已加入會議
      </p>

      <div
        className="mb-rise rounded-2xl border border-line bg-paper p-8 shadow-sm"
        style={{ '--d': '0.2s' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5">
          <MeetaMark />
          <span className="font-display text-lg font-bold">蜜塔 MeetBot</span>
        </div>

        <h1 className="mt-6 text-balance font-display text-3xl font-bold">
          歡迎回來
        </h1>
        <p className="mt-2 text-pretty text-sm leading-6 text-ink-soft">
          登入後即可建立專案、邀請蜜塔加入你的 Google Meet。
        </p>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            <p>{ERROR_MESSAGES[error] ?? '登入沒有成功，請再試一次。'}</p>
            <p className="mt-1 font-mono text-xs text-red-500">
              錯誤代碼：{error}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            setPending(true)
            signIn('google', { callbackUrl: '/projects' })
          }}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-md border border-ink/15 bg-white px-4 py-3 text-sm font-medium transition-colors hover:bg-pollen/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          {pending ? (
            <>
              <span
                aria-hidden="true"
                className="size-4 animate-spin rounded-full border-2 border-ink/20 border-t-honey-deep motion-reduce:animate-none"
              />
              正在前往 Google…
            </>
          ) : (
            <>
              <GoogleIcon />
              使用 Google 帳號登入
            </>
          )}
        </button>
      </div>

      <p
        className="mb-rise mt-6 text-center text-sm text-ink-soft"
        style={{ '--d': '0.3s' } as React.CSSProperties}
      >
        還不認識蜜塔？{' '}
        <Link
          href="/"
          className="rounded font-medium text-honey-deep underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          看看她能做什麼
        </Link>
      </p>
    </main>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper px-6 py-12 text-ink">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  )
}
