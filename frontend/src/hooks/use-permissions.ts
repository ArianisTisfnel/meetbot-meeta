'use client'
import { useProject } from '@/hooks/use-projects'
import type { UserPermissions } from '@/types/api'

const DEFAULT_PERMISSIONS: UserPermissions = {
  canView: false,
  canEdit: false,
  canDelete: false,
  canManage: false,
  canMeeting: false,
}

export function usePermissions(projectId: string): UserPermissions {
  const { data: project } = useProject(projectId)
  return project?.permissions ?? DEFAULT_PERMISSIONS
}
