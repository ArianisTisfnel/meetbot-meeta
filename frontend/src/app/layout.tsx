import type { Metadata, Viewport } from 'next'
import { Noto_Sans_TC, LXGW_WenKai_TC, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const sans = Noto_Sans_TC({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-sans',
})

const display = LXGW_WenKai_TC({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-display',
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

export const viewport: Viewport = {
  themeColor: '#FFFDF7',
}

export const metadata: Metadata = {
  title: '蜜塔 MeetBot — AI 會議助理',
  description:
    '蜜塔是加入 Google Meet 的 AI 會議助理：會議中喊「蜜塔」即時回答問題，散會後自動生成摘要與待辦。',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-TW">
      <body
        className={`${sans.variable} ${display.variable} ${mono.variable} font-sans antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
