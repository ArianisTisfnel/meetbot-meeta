'use client'
import { useMaterialStatus } from '@/hooks/use-materials'
import { Badge } from '@/components/ui/badge'
import type { IndexingStatus } from '@/types/api'

const STATUS_CONFIG: Record<
  IndexingStatus,
  { label: string; variant: 'secondary' | 'outline' | 'success' | 'destructive' }
> = {
  PENDING:    { label: '等待中',   variant: 'secondary' },
  PROCESSING: { label: '索引中',   variant: 'outline' },
  COMPLETED:  { label: '索引完成', variant: 'success' },
  FAILED:     { label: '索引失敗', variant: 'destructive' },
}

interface Props {
  projectId: string
  materialId: string
  initialStatus: IndexingStatus
}

export function IndexingStatusBadge({ projectId, materialId, initialStatus }: Props) {
  const { data } = useMaterialStatus(projectId, materialId)
  const status: IndexingStatus = data?.indexingStatus ?? initialStatus
  const config = STATUS_CONFIG[status]

  return (
    <Badge variant={config.variant}>
      {config.label}
    </Badge>
  )
}
