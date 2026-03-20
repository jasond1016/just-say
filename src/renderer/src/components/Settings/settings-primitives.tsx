import React from 'react'
import { Button } from '@/components/ui/button'

/* ─── Form field styles ─── */
export const fieldClass =
  'h-9 rounded-md border border-input bg-card text-foreground px-3 text-[13px] outline-none transition-all focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:shadow-tinted-sm placeholder:text-muted-foreground/50 appearance-none'
export const fullFieldClass = `${fieldClass} w-full`

/* ─── Toggle ─── */
export function Toggle({
  checked,
  onChange,
  labelledBy
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  labelledBy?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 items-center rounded-full border transition-colors duration-200 ${
        checked ? 'border-primary bg-primary' : 'border-border bg-muted'
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[20px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}

/* ─── Row: label + value on same line ─── */
export function FieldRow({
  label,
  htmlFor,
  children
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-[13px] font-medium shrink-0" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="w-[220px] shrink-0">{children}</div>
    </div>
  )
}

/* ─── Toggle row: label+desc on left, toggle on right ─── */
export function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p id={id} className="text-[13px] font-medium">{label}</p>
        {description && <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} labelledBy={id} />
    </div>
  )
}

/* ─── Section divider ─── */
export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pt-4 pb-2 border-b border-border mb-3">
      <p className="text-[11px] font-medium tracking-widest uppercase text-muted-foreground">
        {children}
      </p>
    </div>
  )
}

/* ─── Stacked field: label above, full-width input below ─── */
export function StackedField({
  label,
  htmlFor,
  hint,
  children
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-[13px] font-medium" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground leading-relaxed">{hint}</p>}
    </div>
  )
}

/* ─── Status bar ─── */
export function StatusBar({
  text,
  action,
  actionLabel,
  actionDisabled
}: {
  text: string
  action?: () => void
  actionLabel?: string
  actionDisabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border border-border bg-muted/30 px-3 py-2 rounded-md">
      <p className="text-[12px] text-muted-foreground">{text}</p>
      {action && actionLabel && (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={action} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
