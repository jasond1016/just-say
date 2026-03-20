import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase',
  {
    variants: {
      variant: {
        default: 'bg-primary/10 text-primary',
        secondary: 'bg-secondary text-secondary-foreground',
        outline: 'border text-foreground',
        success: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
        info: 'bg-[var(--color-info-bg)] text-[var(--color-info)]',
        warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
        danger: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

type BadgeProps = React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>

function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge }
