'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { MeetingDetail, MeetingStatus, PaginatedMeetings } from '@/types/api'

export function useAllMeetings(params?: {
  search?: string
  since?: 1 | 3 | 7
  order?: 'asc' | 'desc'
  status?: MeetingStatus
}) {
  const query = new URLSearchParams()
  if (params?.search) query.set('search', params.search)
  if (params?.since) query.set('since', String(params.since))
  if (params?.order) query.set('order', params.order)
  if (params?.status) query.set('status', params.status)
  const qs = query.toString()

  return useQuery({
    queryKey: ['all-meetings', params],
    queryFn: () =>
      apiClient.get<PaginatedMeetings>(`/meetings${qs ? `?${qs}` : ''}`),
  })
}

export function useCreateGlobalMeeting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      googleMeetUrl: string
      name?: string
      projectId?: string
    }) => apiClient.post<MeetingDetail>('/meetings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-meetings'] })
      queryClient.invalidateQueries({ queryKey: ['meetings'] })
    },
  })
}
