'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import { Toaster, toast } from 'sonner'
import { useEffect, useState } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1 },
        },
      })
  )

  useEffect(() => {
    // sonner 沒有內建「點擊外部關閉」選項，點擊 toaster 容器以外時手動 dismiss
    function handleOutsideClick(event: MouseEvent) {
      const toaster = document.querySelector('[data-sonner-toaster]')
      if (toaster && event.target instanceof Node && !toaster.contains(event.target)) {
        toast.dismiss()
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [])

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </SessionProvider>
  )
}
