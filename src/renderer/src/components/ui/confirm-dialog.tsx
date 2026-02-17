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

      if (event.key !== 'Tab' || !dialogRef.current) {
        return
      }

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) {
        return
      }

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

  if (!open) {
    return null
  }

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
        className="animate-[fadeIn_140ms_ease-out] absolute inset-0 bg-black/40"
        onClick={() => {
          if (!confirming) {
            onClose()
          }
        }}
      />

      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        className="animate-[fadeInUp_180ms_var(--ease-out-expo)] relative z-10 w-[460px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border bg-background shadow-lg"
      >
        <header className="flex items-center justify-between border-b px-5 py-4">
          <h3 id="confirm-dialog-title" className="text-base font-semibold">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[4px] text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={closeAriaLabel}
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="px-5 py-4">
          <p id="confirm-dialog-description" className="text-sm text-foreground">
            {description}
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t px-5 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 px-4 text-sm"
            onClick={onClose}
            disabled={confirming}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-9 bg-red-500 px-4 text-sm text-white hover:bg-red-600"
            onClick={() => {
              void handleConfirm()
            }}
            disabled={confirming}
          >
            {confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  )
}
