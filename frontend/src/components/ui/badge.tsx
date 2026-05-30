import * as React from 'react'
import { cn } from '@/lib/utils'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success'

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default:     'border-transparent bg-slate-900 text-white',
  secondary:   'border-transparent bg-slate-100 text-slate-900',
  destructive: 'border-transparent bg-red-500 text-white',
  outline:     'border-slate-200 text-slate-900',
  success:     'border-transparent bg-green-100 text-green-800',
}

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        VARIANT_CLASSES[variant],
        className
      )}
      {...props}
    />
  )
}

export { Badge }
