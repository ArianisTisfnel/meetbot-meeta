'use client'
import { usePermissions } from '@/hooks/use-permissions'
import type { UserPermissions } from '@/types/api'

interface Props {
  projectId: string
  require: keyof UserPermissions
  children: React.ReactNode
  fallback?: React.ReactNode
}

export function PermissionGuard({ projectId, require, children, fallback = null }: Props) {
  const permissions = usePermissions(projectId)
  if (!permissions[require]) return <>{fallback}</>
  return <>{children}</>
}
