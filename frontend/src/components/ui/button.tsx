import * as React from 'react'
import { cn } from '@/lib/utils'

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default:     'bg-primary text-primary-foreground hover:bg-roast-deep',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline:     'border border-border bg-transparent hover:bg-accent',
  secondary:   'bg-secondary text-secondary-foreground hover:bg-secondary/70',
  ghost:       'hover:bg-accent',
  link:        'text-foreground underline-offset-4 hover:underline',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: 'h-10 px-4 py-2',
  sm:      'h-9 rounded-md px-3 text-sm',
  lg:      'h-11 rounded-md px-8',
  icon:    'h-10 w-10',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children as React.ReactElement<any>, {
        className: cn(
          'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
          (children as React.ReactElement<any>).props.className
        ),
        ...props,
      })
    }

    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className
        )}
        {...props}
      >
        {children}
      </button>
    )
  }
)
Button.displayName = 'Button'

export { Button }
