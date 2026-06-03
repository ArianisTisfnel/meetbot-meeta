'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { MyInvitationsResponse } from '@/types/api'

/** 站內信箱：我的待處理邀請。預設每 60 秒輪詢一次。 */
export function useMyInvitations(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['my-invitations'],
    queryFn: () => apiClient.get<MyInvitationsResponse>('/me/invitations'),
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
  })
}

export function useAcceptInvitation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiClient.post<{ projectId: string; alreadyAccepted?: boolean }>(
        `/me/invitations/${invitationId}/accept`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-invitations'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useDeclineInvitation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiClient.post(`/me/invitations/${invitationId}/decline`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['my-invitations'] }),
  })
}

/** email 邀請連結落地頁用：以 token 接受。 */
export function useAcceptInvitationByToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (token: string) =>
      apiClient.post<{ projectId: string; alreadyAccepted?: boolean }>(
        '/me/invitations/accept-by-token',
        { token },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-invitations'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}
