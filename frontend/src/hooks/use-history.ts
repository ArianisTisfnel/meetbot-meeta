'use client'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { PaginatedActivity } from '@/types/api'

export function useHistory(projectId: string) {
  return useQuery({
    queryKey: ['history', projectId],
    queryFn: () =>
      apiClient.get<PaginatedActivity>(`/projects/${projectId}/history`),
    enabled: !!projectId,
  })
}
