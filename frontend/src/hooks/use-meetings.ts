'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { MeetingListItem, MeetingDetail, PaginatedMeetings } from '@/types/api'

export function useMeetings(
  projectId: string,
  params?: {
    search?: string
    since?: 1 | 3 | 7
    order?: 'asc' | 'desc'
  }
) {
  const query = new URLSearchParams()
  if (params?.search) query.set('search', params.search)
  if (params?.since) query.set('since', String(params.since))
  if (params?.order) query.set('order', params.order)
  const qs = query.toString()

  return useQuery({
    queryKey: ['meetings', projectId, params],
    queryFn: () =>
      apiClient.get<PaginatedMeetings>(
        `/projects/${projectId}/meetings${qs ? `?${qs}` : ''}`
      ),
    enabled: !!projectId,
  })
}

export function useCreateMeeting(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { googleMeetUrl: string; name?: string }) =>
      apiClient.post<MeetingDetail>(
        `/projects/${projectId}/meetings`,
        data
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['meetings', projectId] }),
  })
}
