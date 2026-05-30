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
