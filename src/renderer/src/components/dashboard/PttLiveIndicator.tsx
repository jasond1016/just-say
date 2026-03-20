import { useEffect, useState, type JSX } from 'react'
import { Mic } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

type PttState = 'idle' | 'recording' | 'processing'

interface PttLiveIndicatorProps {
  hotkey: string
}

export function PttLiveIndicator({ hotkey }: PttLiveIndicatorProps): JSX.Element {
  const { m } = useI18n()
  const [pttState, setPttState] = useState<PttState>('idle')
  const [lastResult, setLastResult] = useState<string | null>(null)

  useEffect(() => {
    window.api.onRecordingState((state) => {
      if (state.processing) {
        setPttState('processing')
      } else if (state.recording) {
        setPttState('recording')
      } else {
        setPttState('idle')
      }
    })

    window.api.onIndicatorFeedback((payload) => {
      if (payload.message && payload.message.trim()) {
        setLastResult(payload.message.trim())
      }
    })

    void window.api.getPttRuntimeState().then((state) => {
      if (state.processing) setPttState('processing')
      else if (state.recording) setPttState('recording')
    }).catch(() => { /* ignore */ })

    return () => {
      window.api.removeAllListeners('recording-state')
      window.api.removeAllListeners('indicator-feedback')
    }
  }, [])

  const isActive = pttState !== 'idle'

  return (
    <div className="space-y-3">
      {/* Live state indicator */}
      <div className="flex items-center gap-3.5">
        <div
          className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors duration-200 ${
            pttState === 'recording'
              ? 'bg-[var(--color-recording-bg)]'
              : pttState === 'processing'
                ? 'bg-[var(--color-info-bg)]'
                : 'bg-muted'
          }`}
        >
          {pttState === 'recording' && (
            <span className="absolute inset-0 rounded-xl bg-[var(--color-recording)]/10 animate-[breathe_1.5s_ease-in-out_infinite]" />
          )}
          <Mic
            className={`h-[18px] w-[18px] relative z-10 transition-colors duration-200 ${
              pttState === 'recording'
                ? 'text-[var(--color-recording)]'
                : pttState === 'processing'
                  ? 'text-[var(--color-info)]'
                  : 'text-muted-foreground'
            }`}
            strokeWidth={1.8}
          />
        </div>

        <div className="flex-1 min-w-0">
          {isActive ? (
            <p className={`text-sm font-medium ${
              pttState === 'recording' ? 'text-[var(--color-recording)]' : 'text-[var(--color-info)]'
            }`}>
              {pttState === 'recording' ? m.pttLive.recording : m.pttLive.processing}
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <kbd className="inline-flex items-center justify-center border border-border bg-background px-3 py-1.5 rounded-md shadow-tinted-sm">
                <span className="font-mono text-[12px] font-medium text-foreground">{hotkey}</span>
              </kbd>
              <span className="text-[13px] text-muted-foreground">{m.pttCard.holdToRecord}</span>
            </div>
          )}
        </div>
      </div>

      {/* Last result */}
      {lastResult ? (
        <div className="border-l-2 border-primary/30 pl-4 py-1">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
            {m.pttLive.lastResult}
          </p>
          <p className="text-[14px] text-foreground leading-relaxed line-clamp-3">
            {lastResult}
          </p>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          {m.pttLive.noResultsYet}
        </p>
      )}
    </div>
  )
}
