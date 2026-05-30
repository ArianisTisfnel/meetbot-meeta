'use client'
import { IndexingStatusBadge } from './indexing-status-badge'
import { Button } from '@/components/ui/button'
import { formatBytes, formatDate } from '@/lib/utils'
import type { Material } from '@/types/api'

interface Props {
  material: Material
  projectId: string
  canEdit: boolean
  onDelete: (materialId: string) => void
}

export function MaterialRow({ material, projectId, canEdit, onDelete }: Props) {
  return (
    <tr className="border-b">
      <td className="py-3 px-4 font-medium">{material.displayName}</td>
      <td className="py-3 px-4 text-muted-foreground">{formatBytes(material.sizeBytes)}</td>
      <td className="py-3 px-4">
        <IndexingStatusBadge
          projectId={projectId}
          materialId={material.id}
          initialStatus={material.indexingStatus}
        />
      </td>
      <td className="py-3 px-4 text-muted-foreground">{material.uploadedBy.name ?? material.uploadedBy.email}</td>
      <td className="py-3 px-4 text-muted-foreground">{formatDate(material.uploadedAt)}</td>
      <td className="py-3 px-4">
        {canEdit && material.indexingStatus !== 'PROCESSING' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(material.id)}
            aria-label="刪除"
          >
            🗑
          </Button>
        )}
      </td>
    </tr>
  )
}
