import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background cursor-default',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-tinted-sm hover:bg-primary/90 active:bg-primary/80',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-accent active:bg-accent/80',
        ghost:
          'text-foreground hover:bg-accent active:bg-accent/80',
        link:
          'text-primary underline-offset-4 hover:underline active:scale-100',
        danger:
          'border border-destructive/30 bg-transparent text-destructive hover:bg-destructive/5 active:bg-destructive/10'
      },
      size: {
        default: 'h-9 px-4 py-2 rounded-md',
        sm: 'h-8 px-3 text-[13px] rounded-md',
        lg: 'h-11 px-6 text-[15px] rounded-md',
        icon: 'size-9 rounded-md'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot : 'button'

  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
