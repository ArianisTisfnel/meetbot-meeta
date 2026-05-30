'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { Material, PaginatedMaterials } from '@/types/api'

export function useMaterials(projectId: string) {
  return useQuery({
    queryKey: ['materials', projectId],
    queryFn: () =>
      apiClient.get<PaginatedMaterials>(`/projects/${projectId}/materials`),
    enabled: !!projectId,
  })
}

export function useMaterialStatus(projectId: string, materialId: string) {
  return useQuery({
    queryKey: ['material', projectId, materialId],
    queryFn: () =>
      apiClient.get<Material>(`/projects/${projectId}/materials/${materialId}`),
    enabled: !!projectId && !!materialId,
    refetchInterval: (query) => {
      const status = query.state.data?.indexingStatus
      return status === 'PROCESSING' || status === 'PENDING' ? 5000 : false
    },
  })
}

export function useUploadMaterial(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (formData: FormData) =>
      apiClient.postForm<Material>(`/projects/${projectId}/materials`, formData),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['materials', projectId] }),
  })
}

export function useDeleteMaterial(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (materialId: string) =>
      apiClient.delete(`/projects/${projectId}/materials/${materialId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['materials', projectId] }),
  })
}
