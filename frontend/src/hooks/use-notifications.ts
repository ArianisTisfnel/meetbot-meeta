'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { ProjectNotifications, SectionKey } from '@/types/api'

/**
 * 專案未讀通知。
 *
 * 未讀「數字」跟著專案列表一起回來（ProjectListItem.unreadCount），這裡的
 * useProjectNotifications 是點開圓點時才要的「明細」，所以預設不啟用。
 */
export function useProjectNotifications(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['project-notifications', projectId],
    queryFn: () =>
      apiClient.get<ProjectNotifications>(`/projects/${projectId}/notifications`),
    enabled: !!projectId && enabled,
  })
}

/**
 * 標記已讀。給了 section 就只清那個分頁的紅點（切到哪個分頁就清哪個），
 * 沒給就五個分頁一起清。
 *
 * 待回覆的會議不會被這個清掉——那是待辦，要真的回覆才算。
 */
export function useMarkProjectRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      projectId,
      section,
    }: {
      projectId: string
      section?: SectionKey
    }) =>
      apiClient.post<{
        projectId: string
        sections: SectionKey[]
        lastReadAt: string
      }>(`/projects/${projectId}/read`, section ? { section } : {}),
    onSuccess: (_data, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-notifications', projectId] })
    },
  })
}
