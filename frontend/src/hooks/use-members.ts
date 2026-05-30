'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { MembersResponse, ProjectMember } from '@/types/api'

export function useMembers(projectId: string) {
  return useQuery({
    queryKey: ['members', projectId],
    queryFn: () =>
      apiClient.get<MembersResponse>(`/projects/${projectId}/members`),
    enabled: !!projectId,
  })
}

export function useInviteMember(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      email: string
      canView: boolean
      canEdit: boolean
      canMeeting: boolean
    }) => apiClient.post<ProjectMember>(`/projects/${projectId}/members`, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['members', projectId] }),
  })
}

export function useUpdateMember(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      vexaUserId,
      ...permissions
    }: {
      vexaUserId: number
      canView?: boolean
      canEdit?: boolean
      canMeeting?: boolean
    }) =>
      apiClient.patch<ProjectMember>(
        `/projects/${projectId}/members/${vexaUserId}`,
        permissions
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['members', projectId] }),
  })
}

export function useRemoveMember(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (vexaUserId: number) =>
      apiClient.delete(`/projects/${projectId}/members/${vexaUserId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['members', projectId] }),
  })
}
