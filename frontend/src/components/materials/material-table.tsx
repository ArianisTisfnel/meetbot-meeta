'use client'
import { MaterialRow } from './material-row'
import { useDeleteMaterial } from '@/hooks/use-materials'
import { toast } from 'sonner'
import type { Material } from '@/types/api'

interface Props {
  materials: Material[]
  projectId: string
  canEdit: boolean
}

export function MaterialTable({ materials, projectId, canEdit }: Props) {
  const deleteMutation = useDeleteMaterial(projectId)

  const handleDelete = (materialId: string) => {
    if (!confirm('確定要刪除這份資料嗎？')) return
    deleteMutation.mutate(materialId, {
      onSuccess: () => toast.success('資料已刪除'),
      onError: () => toast.error('刪除失敗，請稍後再試'),
    })
  }

  if (materials.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-12">
        尚無資料，請上傳檔案
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-3 px-4">檔案名稱</th>
            <th className="py-3 px-4">大小</th>
            <th className="py-3 px-4">狀態</th>
            <th className="py-3 px-4">上傳者</th>
            <th className="py-3 px-4">上傳時間</th>
            <th className="py-3 px-4"></th>
          </tr>
        </thead>
        <tbody>
          {materials.map((m) => (
            <MaterialRow
              key={m.id}
              material={m}
              projectId={projectId}
              canEdit={canEdit}
              onDelete={handleDelete}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
