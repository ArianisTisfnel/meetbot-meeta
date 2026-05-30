'use client'
import { use } from 'react'
import { useMaterials } from '@/hooks/use-materials'
import { usePermissions } from '@/hooks/use-permissions'
import { UploadZone } from '@/components/materials/upload-zone'
import { MaterialTable } from '@/components/materials/material-table'

interface Props {
  params: Promise<{ projectId: string }>
}

export default function MaterialsPage({ params }: Props) {
  const { projectId } = use(params)
  const { data, isLoading, refetch } = useMaterials(projectId)
  const permissions = usePermissions(projectId)

  return (
    <div>
      {permissions.canEdit && (
        <div className="mb-6">
          <UploadZone projectId={projectId} onSuccess={refetch} />
        </div>
      )}

      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">
          檔案清單（{data?.total ?? 0} 份）
        </h2>
        {isLoading ? (
          <p className="text-muted-foreground">載入中…</p>
        ) : (
          <MaterialTable
            materials={data?.items ?? []}
            projectId={projectId}
            canEdit={permissions.canEdit}
          />
        )}
      </div>
    </div>
  )
}
