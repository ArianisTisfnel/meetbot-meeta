'use client'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

export interface MeResponse {
  userId: number
  email: string | null
  name: string | null
  maxConcurrentBots: number
  activeBotCount: number
}

/**
 * 目前登入者。行事曆需要它來判斷「哪一筆 RSVP 是我的」——
 * NextAuth 的 session 只有 email，沒有後端的數字 userId。
 */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiClient.get<MeResponse>('/me'),
    staleTime: 5 * 60 * 1000,
  })
}
