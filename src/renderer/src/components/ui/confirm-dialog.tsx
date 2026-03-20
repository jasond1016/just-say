import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  closeAriaLabel: string
  onClose: () => void
  onConfirm: () => Promise<void> | void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  closeAriaLabel,
  onClose,
  onConfirm
}: ConfirmDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) {
      setConfirming(false)
      return
    }

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const frame = window.requestAnimationFrame(() => {
      const firstButton = dialogRef.current?.querySelector<HTMLElement>('button')
      firstButton?.focus()
    })

    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !confirming) {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null

      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', handleKeydown)
      previouslyFocusedRef.current?.focus()
    }
  }, [confirming, onClose, open])

  if (!open) return null

  const handleConfirm = async (): Promise<void> => {
    if (confirming) return
    setConfirming(true)
    try {
      await onConfirm()
    } catch (err) {
      console.error('Confirm dialog action failed:', err)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-foreground/20 animate-[fadeIn_120ms_ease-out]"
        onClick={() => { if (!confirming) onClose() }}
      />

      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        className="relative z-10 w-[440px] max-w-[calc(100vw-2rem)] bg-card border border-border rounded-md shadow-tinted-lg animate-[slideInUp_200ms_var(--ease-out-expo)]"
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 id="confirm-dialog-title" className="text-[15px] font-semibold">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            aria-label={closeAriaLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-4">
          <p id="confirm-dialog-description" className="text-sm text-foreground leading-relaxed">
            {description}
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={confirming}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => { void handleConfirm() }}
            disabled={confirming}
          >
            {confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  )
}
