'use client'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { PaginatedHistory } from '@/types/api'

export function useHistory(projectId: string) {
  return useQuery({
    queryKey: ['history', projectId],
    queryFn: () =>
      apiClient.get<PaginatedHistory>(`/projects/${projectId}/history`),
    enabled: !!projectId,
  })
}
