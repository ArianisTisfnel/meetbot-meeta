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
import { Input } from '@/components/ui/input'
import { useCreateProject } from '@/hooks/use-projects'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateProjectDialog({ open, onOpenChange }: Props) {
  const [name, setName] = useState('')
  const createMutation = useCreateProject()

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('請填入專案名稱')
      return
    }
    try {
      await createMutation.mutateAsync(name.trim())
      toast.success('專案已建立')
      setName('')
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message ?? '建立失敗')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>建立新專案</DialogTitle>
        </DialogHeader>
        <div>
          <label className="text-sm font-medium">專案名稱</label>
          <Input
            placeholder="例：Q3 產品規劃"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1"
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? '建立中…' : '建立'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
