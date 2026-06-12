'use client'
import { useState, useRef, useCallback } from 'react'
import { UploadIcon } from '@/components/ui/icons'
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
      <button
        type="button"
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragActive(true) }}
        onDragLeave={() => setIsDragActive(false)}
        onClick={() => inputRef.current?.click()}
        className={`w-full rounded-xl border-2 border-dashed p-12 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          isDragActive
            ? 'border-honey bg-pollen/50'
            : 'border-line hover:border-honey/60 hover:bg-pollen/30'
        }`}
      >
        <span className="flex flex-col items-center gap-2 text-muted-foreground">
          <UploadIcon
            className={`size-6 ${isDragActive ? 'text-honey-deep' : ''}`}
          />
          <span>拖拉檔案至此，或點擊選擇（PDF / DOCX / TXT / MD）</span>
          <span className="text-xs">單檔最大 15 MB</span>
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleFileInput}
      />

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
