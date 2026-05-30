'use client'
import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { UploadStagingDialog } from './upload-staging-dialog'

const ACCEPTED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md'],
}
const MAX_SIZE = 15 * 1024 * 1024 // 15 MB

interface Props {
  projectId: string
  onSuccess?: () => void
}

export function UploadZone({ projectId, onSuccess }: Props) {
  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return
    setStagedFiles((prev) => [...prev, ...acceptedFiles])
    setDialogOpen(true)
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_SIZE,
    multiple: true,
  })

  const handleRemove = (index: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSuccess = () => {
    setStagedFiles([])
    onSuccess?.()
  }

  return (
    <>
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
          isDragActive
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/30 hover:border-primary/50'
        }`}
      >
        <input {...getInputProps()} />
        <p className="text-muted-foreground">
          📤 拖拉檔案至此，或點擊選擇（PDF / DOCX / TXT / MD）
        </p>
        <p className="text-xs text-muted-foreground mt-1">最大 15 MB</p>
      </div>

      <UploadStagingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        files={stagedFiles}
        onRemove={handleRemove}
        projectId={projectId}
        onSuccess={handleSuccess}
      />
    </>
  )
}
