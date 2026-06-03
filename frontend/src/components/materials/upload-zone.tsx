'use client'
import { useState, useRef, useCallback } from 'react'
import { UploadStagingDialog } from './upload-staging-dialog'

const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md']
const ACCEPTED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]
const MAX_SIZE = 15 * 1024 * 1024

interface Props {
  projectId: string
  onSuccess?: () => void
}

export function UploadZone({ projectId, onSuccess }: Props) {
  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback((incoming: File[]) => {
    const valid = incoming.filter(
      (f) => (ACCEPTED_MIME.includes(f.type) || ACCEPTED_EXTENSIONS.some((ext) => f.name.endsWith(ext))) && f.size <= MAX_SIZE
    )
    if (valid.length === 0) return
    setStagedFiles((prev) => [...prev, ...valid])
    setDialogOpen(true)
  }, [])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragActive(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []))
    e.target.value = ''
  }

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
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragActive(true) }}
        onDragLeave={() => setIsDragActive(false)}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
          isDragActive
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/30 hover:border-primary/50'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(',')}
          className="hidden"
          onChange={handleFileInput}
        />
        <p className="text-muted-foreground flex items-center justify-center gap-2">
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>upload_file</span>
          拖拉檔案至此，或點擊選擇（PDF / DOCX / TXT / MD）
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
