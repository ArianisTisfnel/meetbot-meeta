import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '登入 — 蜜塔 MeetBot',
  description: '使用 Google 帳號登入蜜塔，建立專案並邀請她加入你的 Google Meet。',
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}