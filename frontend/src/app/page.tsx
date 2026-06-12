import Link from 'next/link'
import { getServerSession } from 'next-auth'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import { MeetaMark } from '@/components/landing/meeta-mark'
import { TranscriptDemo } from '@/components/landing/transcript-demo'

// 一場會議的三個時刻：真實時序（會前 → 會中 → 會後）
const MOMENTS = [
  {
    phase: '會前',
    title: '把蜜塔請進會議',
    body: '貼上 Google Meet 連結，蜜塔會自己進場，安靜地待在角落聽。專案資料、歷史會議紀錄，她都先讀過了。',
  },
  {
    phase: '會中',
    title: '喊一聲就有答案',
    body: '討論卡住時，喊「蜜塔」直接問。她根據專案資料當場回答，不用有人離開會議去翻文件。',
  },
  {
    phase: '會後',
    title: '摘要自動寫好',
    body: '散會幾分鐘內，重點、決議與待辦整理完成。想查某句話是誰說的？完整逐字稿隨時可回看。',
  },
]

export default async function HomePage() {
  const session = await getServerSession(authOptions)
  if (session) redirect('/projects')

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-paper focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-honey-deep"
      >
        跳到主要內容
      </a>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          <MeetaMark />
          <span className="font-display text-xl font-bold">蜜塔 MeetBot</span>
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-ink/15 px-4 py-2 text-sm font-medium transition-colors hover:bg-pollen focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          登入
        </Link>
      </header>

      <main id="main">
        {/* Hero：左論述、右逐字稿示意 */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pt-20">
          <div>
            <h1
              className="mb-rise text-balance font-display text-4xl font-bold leading-snug sm:text-5xl sm:leading-snug"
              style={{ '--d': '0s' } as React.CSSProperties}
            >
              開會時，
              <br />
              喊一聲<span className="text-honey-deep">「蜜塔」</span>。
            </h1>
            <p
              className="mb-rise mt-6 max-w-md text-pretty text-base leading-7 text-ink-soft"
              style={{ '--d': '0.15s' } as React.CSSProperties}
            >
              蜜塔是加入 Google Meet 的 AI
              會議助理——會議中隨時回答你的問題，散會後自動把摘要寫好。
            </p>
            <div
              className="mb-rise mt-8 flex flex-wrap items-center gap-4"
              style={{ '--d': '0.3s' } as React.CSSProperties}
            >
              <Link
                href="/login"
                className="rounded-md bg-honey px-6 py-3 text-sm font-bold text-ink transition-colors hover:bg-honey-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
              >
                使用 Google 帳號登入
              </Link>
              <a
                href="#how-it-works"
                className="rounded-md px-2 py-3 text-sm font-medium text-honey-deep underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
              >
                看看她怎麼工作
              </a>
            </div>
          </div>

          <div
            className="mb-rise"
            style={{ '--d': '0.2s' } as React.CSSProperties}
          >
            <TranscriptDemo />
          </div>
        </section>

        {/* 一場會議的三個時刻 */}
        <section
          id="how-it-works"
          aria-labelledby="how-it-works-title"
          className="scroll-mt-8 border-t border-line bg-pollen/40"
        >
          <div className="mx-auto max-w-6xl px-6 py-16 lg:py-20">
            <h2
              id="how-it-works-title"
              className="text-balance font-display text-2xl font-bold sm:text-3xl"
            >
              一場會議，三個時刻
            </h2>
            <p className="mt-3 max-w-md text-pretty text-sm leading-6 text-ink-soft">
              從進場到散會，蜜塔在每個階段各做一件事，做好。
            </p>
            <ol className="mt-10 grid gap-8 sm:grid-cols-3 sm:gap-6">
              {MOMENTS.map((m, i) => (
                <li
                  key={m.phase}
                  className="rounded-xl border border-line bg-paper p-6"
                >
                  <p className="font-mono text-xs text-honey-deep">
                    {String(i + 1).padStart(2, '0')} · {m.phase}
                  </p>
                  <h3 className="mt-3 font-display text-lg font-bold">
                    {m.title}
                  </h3>
                  <p className="mt-2 text-pretty text-sm leading-6 text-ink-soft">
                    {m.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-xs text-ink-soft">
          <span className="flex items-center gap-2">
            <MeetaMark className="size-5" />
            蜜塔 MeetBot · AI 會議助理
          </span>
          <span>© 2026 meetbot</span>
        </div>
      </footer>
    </div>
  )
}
