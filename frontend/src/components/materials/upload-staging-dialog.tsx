'use client'
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUploadMaterial } from '@/hooks/use-materials'
import { formatBytes } from '@/lib/utils'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  files: File[]
  onRemove: (index: number) => void
  projectId: string
  onSuccess: () => void
}

export function UploadStagingDialog({
  open,
  onOpenChange,
  files,
  onRemove,
  projectId,
  onSuccess,
}: Props) {
  const [uploading, setUploading] = useState(false)
  const uploadMutation = useUploadMaterial(projectId)

  const handleConfirm = async () => {
    setUploading(true)
    try {
      for (const file of files) {
        const formData = new FormData()
        formData.append('file', file)
        try {
          await uploadMutation.mutateAsync(formData)
        } catch (err: any) {
          // 顯示後端真正的錯誤訊息（api-client 會 throw {error_code, message}）
          const msg = err?.message ?? err?.error_code ?? '未知錯誤'
          toast.error(`「${file.name}」上傳失敗：${msg}`)
          return
        }
      }
      toast.success(`成功上傳 ${files.length} 個檔案`)
      onSuccess()
      onOpenChange(false)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>確認上傳</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">
          以下檔案將上傳至專案並建立 AI 知識庫索引：
        </p>
        <ul className="space-y-2">
          {files.map((file, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <span>📄 {file.name} ({formatBytes(file.size)})</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(i)}
                disabled={uploading}
              >
                ✕ 移除
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={uploading || files.length === 0}>
            {uploading ? '上傳中…' : '確認上傳'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
