'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { ProjectListResponse, ProjectDetail } from '@/types/api'

export function useProjects(params?: {
  search?: string
  type?: 'all' | 'owned' | 'shared'
  order?: 'asc' | 'desc'
}) {
  const query = new URLSearchParams()
  if (params?.search) query.set('search', params.search)
  if (params?.type) query.set('type', params.type)
  if (params?.order) query.set('order', params.order)
  const qs = query.toString()

  return useQuery({
    queryKey: ['projects', params],
    queryFn: () => apiClient.get<ProjectListResponse>(`/projects${qs ? `?${qs}` : ''}`),
    // 未讀圓點跟著這份清單回來，所以要自己會更新：每分鐘一次、回到分頁時再抓一次。
    // 別再短，別人上傳一份資料不值得每十秒打一次 DB。
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiClient.get<ProjectDetail>(`/projects/${projectId}`),
    enabled: !!projectId,
  })
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => apiClient.post<ProjectDetail>('/projects', { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => apiClient.delete(`/projects/${projectId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useUpdateProject(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      apiClient.patch<ProjectDetail>(`/projects/${projectId}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })
}
