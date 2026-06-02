'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { MeetingDetail } from '@/types/api'

/**
 * 計算 useMeeting 的 refetchInterval。
 * 導出為純函式以便單元測試。
 *
 * 輪詢邏輯：
 *   PENDING        → 3000  (等待 Bot 加入)
 *   ACTIVE         → 5000  (偵測 ACTIVE → ENDED 狀態轉換)
 *   ENDED+null     → 5000  (摘要生成中，null 代表尚未嘗試)
 *   ENDED+非null   → false (summary='' 表示無內容，字串表示有內容，均停止)
 *   FAILED         → false (終止態)
 */
export function computeRefetchInterval(data: MeetingDetail | undefined): number | false {
  if (!data) return 3000
  if (data.status === 'PENDING') return 3000
  if (data.status === 'ACTIVE') return 5000
  if (data.status === 'ENDED' && data.summary === null) return 5000
  return false
}

export function useMeeting(projectId: string | null, meetingId: string) {
  return useQuery({
    queryKey: ['meeting', meetingId],
    queryFn: () =>
      projectId
        ? apiClient.get<MeetingDetail>(
            `/projects/${projectId}/meetings/${meetingId}`
          )
        : apiClient.get<MeetingDetail>(`/meetings/${meetingId}`),
    enabled: !!meetingId,
    refetchInterval: (query) => computeRefetchInterval(query.state.data),
  })
}

export function useBotLeave(projectId: string | null, meetingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      projectId
        ? apiClient.post<{ id: string; status: string; endedAt: string }>(
            `/projects/${projectId}/meetings/${meetingId}/bot/leave`
          )
        : apiClient.post<{ id: string; status: string; endedAt: string }>(
            `/meetings/${meetingId}/bot/leave`
          ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting', meetingId] })
      queryClient.invalidateQueries({ queryKey: ['meetings'] })
      queryClient.invalidateQueries({ queryKey: ['all-meetings'] })
    },
  })
}

export function useCancelMeeting(projectId: string | null, meetingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      projectId
        ? apiClient.post<{ id: string; status: string; endedAt: string }>(
            `/projects/${projectId}/meetings/${meetingId}/cancel`
          )
        : apiClient.post<{ id: string; status: string; endedAt: string }>(
            `/meetings/${meetingId}/cancel`
          ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting', meetingId] })
      queryClient.invalidateQueries({ queryKey: ['meetings'] })
      queryClient.invalidateQueries({ queryKey: ['all-meetings'] })
    },
  })
}

export function useBotReinvite(projectId: string | null, meetingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      projectId
        ? apiClient.post<{ id: string; status: string }>(
            `/projects/${projectId}/meetings/${meetingId}/bot/reinvite`
          )
        : apiClient.post<{ id: string; status: string }>(
            `/meetings/${meetingId}/bot/reinvite`
          ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting', meetingId] })
      queryClient.invalidateQueries({ queryKey: ['meetings'] })
      queryClient.invalidateQueries({ queryKey: ['all-meetings'] })
    },
  })
}
