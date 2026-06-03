'use client'

import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Suspense } from 'react'
import { Check } from 'lucide-react'
import { Cactus_Classical_Serif } from 'next/font/google'

const cactusSerif = Cactus_Classical_Serif({
  weight: '400',
  subsets: ['latin'],
})

const features = [
  '會議全程自動轉錄，不再手動記錄',
  '呼叫蜜塔即時查詢專案資料',
  '會議結束自動生成摘要與待辦事項',
]

function LoginForm() {
  const searchParams = useSearchParams()
  const error = searchParams.get('error')

  return (
    <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-8">
      <div className="text-center mb-6">
        <div className="text-2xl font-bold tracking-tight mb-1">🤖 MeetBot</div>
        <p className="text-sm text-muted-foreground">蜜塔 — 你的 AI 會議助理</p>
      </div>

      {error && (
        <p className="text-red-500 text-sm mb-4 text-center">登入失敗：{error}</p>
      )}

      <Button
        className="w-full"
        onClick={() => signIn('google', { callbackUrl: '/projects' })}
        type="button"
      >
        使用 Google 帳號登入
      </Button>

      <p className="text-xs text-center text-muted-foreground mt-4">
        登入即代表你同意我們的服務條款與隱私政策
      </p>
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className={`min-h-screen flex ${cactusSerif.className}`}>
      {/* 左側：介紹區 */}
      <div className="flex flex-col justify-between w-1/2 bg-white p-12">
        <div />

        <div className="max-w-md">
          <h1 className="text-5xl leading-tight mb-6">
            讓蜜塔加入<br />每一場會議
          </h1>
          <ul className="space-y-3">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-3 text-sm text-muted-foreground">
                <span className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-sm bg-primary/10 flex items-center justify-center">
                  <Check className="w-3 h-3 text-primary" />
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>

        <div className="text-xs text-muted-foreground">
          Powered by Vexa · Dify · Supabase
        </div>
      </div>

      {/* 右側：登入區 */}
      <div
        className="flex flex-1 items-center justify-center p-8"
        style={{
          background: 'radial-gradient(ellipse at 60% 40%, #4f46e5 0%, #1e1b4b 60%, #0f0e1a 100%)',
        }}
      >
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
