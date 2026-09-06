import Link from 'next/link'
import { getServerSession } from 'next-auth'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import { MeetaMark } from '@/components/landing/meeta-mark'
import { Mascot } from '@/components/landing/mascot'
import { HeroScene } from '@/components/landing/hero-scene'
import { DocIcon, MeetingIcon, ReportIcon } from '@/components/ui/icons'

/**
 * 蜜塔 landing page。整頁是 Server Component——沒有任何互動狀態，
 * 動態全部交給 CSS keyframes（見 globals.css 的 mb-* 動畫），零 hydration。
 *
 * ⚠️ 文案準確性：不要寫「歷史會議紀錄她都讀過」這類句子。逐字稿走 Files API
 * 只餵摘要 workflow，唯一進知識庫的路徑是使用者手動上傳的專案資料
 *（backend `material.service.ts` 的 uploadDocument）。
 */

/** 會議流程：進場 → 蜜塔加入 → 三種產出。 */
const OUTPUTS = [
  { Icon: MeetingIcon, title: '記錄', body: '即時逐字轉錄' },
  { Icon: DocIcon, title: '理解', body: '整理重點與決議' },
  { Icon: ReportIcon, title: '行動', body: '產出待辦清單' },
]

// 一場會議的三個時刻：真實時序（會前 → 會中 → 會後）
const MOMENTS = [
  {
    phase: '會前',
    title: '把蜜塔請進會議',
    body: '貼上 Google Meet 連結，蜜塔會自己進場，安靜地待在角落聽。你上傳的專案資料，她都先讀過了。',
  },
  {
    phase: '會中',
    title: '她知道什麼時候該說話',
    body: '喊「蜜塔」直接問，接著追問不必再喊一次名字。沒人叫她時她也在聽——沒人回答的問題會主動補上，冷場太久會開口把討論接回來。',
  },
  {
    phase: '會後',
    title: '摘要自動寫好',
    body: '散會幾分鐘內，重點、決議與待辦整理完成，可直接編輯、勾選、匯出 PDF。想查某句話是誰說的？完整逐字稿隨時可回看。',
  },
] as const

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

      <header className="sticky top-0 z-40 border-b border-line/70 bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            <MeetaMark />
            <span className="font-display text-xl font-bold">蜜塔 MeetBot</span>
          </Link>

          <Link
            href="/login"
            className="ml-auto rounded-full bg-ink px-5 py-2 text-sm font-medium text-hive-fg transition-colors hover:bg-ink-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            登入
          </Link>
        </div>
      </header>

      <main id="main">
        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="mx-auto grid max-w-6xl items-center gap-14 px-6 pb-24 pt-14 lg:grid-cols-[1.02fr_1fr] lg:gap-16 lg:pt-20">
          <div>
            <p
              className="mb-rise font-display text-base font-bold text-honey-deep"
              style={{ '--d': '0s' } as React.CSSProperties}
            >
              你的 AI 會議小幫手
            </p>
            <h1
              className="mb-rise mt-4 text-balance font-display text-4xl font-bold leading-snug sm:text-5xl sm:leading-snug lg:text-6xl lg:leading-[1.18]"
              style={{ '--d': '0.1s' } as React.CSSProperties}
            >
              開會時，
              <br />
              喊一聲<span className="text-honey-deep">「蜜塔」</span>。
            </h1>
            <p
              className="mb-rise mt-6 max-w-md text-pretty text-base leading-7 text-ink-soft"
              style={{ '--d': '0.22s' } as React.CSSProperties}
            >
              不用切換工具，不用翻找舊文件。需要答案時直接問蜜塔——
              該補充時她也會主動開口，散會後摘要自動寫好。
            </p>
            <div
              className="mb-rise mt-9 flex flex-wrap items-center gap-x-5 gap-y-3"
              style={{ '--d': '0.34s' } as React.CSSProperties}
            >
              <Link
                href="/login"
                className="inline-flex items-center gap-2.5 rounded-full bg-ink px-6 py-3.5 text-sm font-bold text-hive-fg transition-colors hover:bg-ink-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
              >
                <GoogleG />
                使用 Google 帳號登入
                <span aria-hidden="true">→</span>
              </Link>
              <a
                href="#how-it-works"
                className="rounded-md px-2 py-3 text-sm font-medium text-honey-deep underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep"
              >
                看看蜜塔怎麼工作 <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>

          <div
            className="mb-rise"
            style={{ '--d': '0.18s' } as React.CSSProperties}
          >
            <HeroScene />
          </div>
        </section>

        {/* ── 運作流程 ────────────────────────────────────────────────── */}
        <section
          id="how-it-works"
          aria-labelledby="how-it-works-title"
          className="scroll-mt-20 border-y border-line bg-pollen/50"
        >
          <div className="mx-auto max-w-6xl px-6 py-16 lg:py-20">
            <h2
              id="how-it-works-title"
              className="text-balance text-center font-display text-2xl font-bold sm:text-3xl"
            >
              你只管開會，剩下交給蜜塔。
            </h2>

            <div className="mt-12 flex flex-col items-center gap-6 lg:flex-row lg:gap-4">
              <div className="flex w-full flex-1 flex-col items-center gap-3 rounded-2xl border border-line bg-paper px-6 py-8">
                <MeetIcon />
                <p className="font-display text-base font-bold">Google Meet</p>
                <p className="text-sm text-ink-soft">開始會議</p>
              </div>

              <Arrow />

              <div className="flex w-full flex-1 flex-col items-center gap-1 rounded-2xl border border-line bg-paper px-6 py-4">
                <Mascot pose="front" className="mb-float size-28" />
                <p className="font-display text-base font-bold">蜜塔加入</p>
                <p className="text-sm text-ink-soft">自動記錄 · 即時轉錄</p>
              </div>

              <Arrow />

              <ul className="grid w-full flex-[1.4] grid-cols-1 gap-3 rounded-2xl border border-line bg-paper p-4 sm:grid-cols-3">
                {OUTPUTS.map(({ Icon, title, body }) => (
                  <li
                    key={title}
                    className="flex flex-col items-center gap-2 rounded-xl px-3 py-5 text-center"
                  >
                    <span className="flex size-11 items-center justify-center rounded-full bg-pollen text-honey-deep">
                      <Icon className="size-5" />
                    </span>
                    <p className="font-display text-sm font-bold">{title}</p>
                    <p className="text-xs text-ink-soft">{body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── 三個時刻 ────────────────────────────────────────────────── */}
        <section aria-labelledby="moments-title">
          <div className="mx-auto max-w-6xl px-6 py-16 lg:py-24">
            <h2
              id="moments-title"
              className="text-balance font-display text-2xl font-bold sm:text-3xl"
            >
              一場會議，三個時刻
            </h2>
            <p className="mt-3 max-w-md text-pretty text-sm leading-6 text-ink-soft">
              從進場到散會，蜜塔在每個階段各做一件事，做好。
            </p>

            <ol className="mt-10 grid gap-6 lg:grid-cols-3">
              {MOMENTS.map((m, i) => (
                <li
                  key={m.phase}
                  className="group flex flex-col rounded-2xl border border-line bg-paper p-6 transition-shadow hover:shadow-lg hover:shadow-ink/5"
                >
                  <p className="font-mono text-xs text-honey-deep">
                    {String(i + 1).padStart(2, '0')} · {m.phase}
                  </p>
                  <h3 className="mt-3 text-balance font-display text-lg font-bold">
                    {m.title}
                  </h3>
                  <p className="mt-2.5 text-pretty text-sm leading-6 text-ink-soft">
                    {m.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── CTA ────────────────────────────────────────────────────── */}
        <section className="border-t border-line bg-pollen/50">
          <div className="mx-auto max-w-6xl px-6 py-20 text-center lg:py-24">
            <Mascot pose="fly" className="mb-float mx-auto size-32" />
            <h2 className="mt-6 text-balance font-display text-2xl font-bold sm:text-3xl">
              準備好讓蜜塔加入你的會議了嗎？
            </h2>
            <Link
              href="/login"
              className="mt-8 inline-flex items-center gap-2.5 rounded-full bg-ink px-7 py-3.5 text-sm font-bold text-hive-fg transition-colors hover:bg-ink-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey-deep focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
            >
              <GoogleG />
              使用 Google 帳號登入
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-xs text-ink-soft">
          <span className="flex items-center gap-2">
            <MeetaMark className="size-5" />
            蜜塔 MeetBot · AI 會議助理
          </span>
          <span translate="no">© 2026 meetbot</span>
        </div>
      </footer>
    </div>
  )
}

/** 流程之間的箭頭：窄螢幕轉向下。 */
function Arrow() {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 rotate-90 text-2xl leading-none text-honey-deep/50 lg:rotate-0"
    >
      →
    </span>
  )
}

/** Google 商標色的 G（登入鈕用）。 */
function GoogleG() {
  return (
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
      className="size-4"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58"
      />
    </svg>
  )
}

/** Google Meet 的攝影機圖示（品牌綠/藍/黃三色）。 */
function MeetIcon() {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className="size-11"
    >
      <rect x="6" y="14" width="26" height="20" rx="3" fill="#1E88E5" />
      <path d="M32 21l10-6v18l-10-6z" fill="#4CAF50" />
      <path d="M6 24h10v10H9a3 3 0 0 1-3-3z" fill="#FBC02D" />
      <path d="M32 21l10-6v6z" fill="#1565C0" opacity=".5" />
    </svg>
  )
}
