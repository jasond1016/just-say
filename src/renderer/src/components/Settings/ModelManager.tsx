import React, { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

type LocalEngine = 'faster-whisper' | 'sensevoice'

const FASTER_WHISPER_MODEL_INFO: Record<string, { label: string; size: string; params: string }> = {
  tiny: { label: 'tiny', size: '~75 MB', params: '39M' },
  base: { label: 'base', size: '~145 MB', params: '74M' },
  small: { label: 'small', size: '~465 MB', params: '244M' },
  medium: { label: 'medium', size: '~1.5 GB', params: '769M' },
  'large-v3': { label: 'large-v3', size: '~3 GB', params: '1550M' }
}

const SENSEVOICE_MODEL_INFO: Record<string, { label: string; size: string; params: string }> = {
  'sensevoice-small': { label: 'SenseVoiceSmall', size: '~300 MB+', params: 'N/A' }
}

interface ModelManagerProps {
  engine: LocalEngine
  currentModel: string
  onModelChange: (model: string) => void
}

interface DownloadProgress {
  model: string
  percent: number
  status: string
}

export function ModelManager({
  engine,
  currentModel,
  onModelChange
}: ModelManagerProps): React.JSX.Element {
  const { m } = useI18n()
  const [downloadedModels, setDownloadedModels] = useState<string[]>([])
  const [downloading, setDownloading] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pendingDeleteModel, setPendingDeleteModel] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadModels()
  }, [engine])

  useEffect(() => {
    const unsubscribe = window.api.onDownloadProgress((p) => {
      setProgress(p)
    })
    return unsubscribe
  }, [])

  const loadModels = async (): Promise<void> => {
    try {
      const models = await window.api.getLocalModels()
      setDownloadedModels(models)
    } catch (err) {
      console.error('Failed to load models:', err)
    }
  }

  const handleDownload = async (model: string): Promise<void> => {
    setDownloading(model)
    setProgress(null)
    setError(null)
    try {
      await window.api.downloadModel(model)
      await loadModels()
    } catch (err) {
      setError(`Failed to download ${model}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDownloading(null)
      setProgress(null)
    }
  }

  const handleDelete = async (model: string): Promise<void> => {
    setDeleting(model)
    setError(null)
    try {
      await window.api.deleteModel(model)
      await loadModels()
    } catch (err) {
      setError(`Failed to delete ${model}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="bg-card mt-5 rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold">Local Models</h3>
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        {(() => {
          const modelInfo =
            engine === 'sensevoice' ? SENSEVOICE_MODEL_INFO : FASTER_WHISPER_MODEL_INFO
          const allModels = Object.keys(modelInfo)

          return allModels.map((model) => {
            const isDownloaded = downloadedModels.includes(model)
            const isCurrent = currentModel === model
            const isDownloading = downloading === model
            const info = modelInfo[model]

            return (
              <div
                key={model}
                className={cn(
                  'bg-muted/25 flex items-center justify-between gap-3 rounded-md border p-3 transition-colors',
                  !isDownloaded && 'opacity-70',
                  isCurrent && 'border-violet-300 bg-violet-50'
                )}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{info.label}</span>
                    {isCurrent && <Badge className="bg-violet-600 text-white">Active</Badge>}
                    {isDownloaded && !isCurrent && (
                      <Badge className="bg-emerald-600 text-white">Downloaded</Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {info.size} · {info.params} params
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isDownloaded ? (
                    <>
                      {!isCurrent && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onModelChange(model)}
                          disabled={!!downloading || !!deleting}
                        >
                          Select
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPendingDeleteModel(model)}
                        disabled={!!downloading || !!deleting || isCurrent}
                        className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
                        title={isCurrent ? 'Cannot delete active model' : 'Delete model'}
                      >
                        {deleting === model ? '...' : '✕'}
                      </Button>
                    </>
                  ) : isDownloading ? (
                    <div className="min-w-[180px]">
                      <div className="text-muted-foreground mb-1 text-right text-xs">
                        {progress?.status || 'Downloading...'}
                      </div>
                      <div className="bg-border h-1.5 w-full overflow-hidden rounded-full">
                        <div
                          className="h-full rounded-full bg-violet-600 transition-all"
                          style={{ width: `${Math.min(progress?.percent || 0, 100)}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownload(model)}
                      disabled={!!downloading}
                    >
                      Download
                    </Button>
                  )}
                </div>
              </div>
            )
          })
        })()}
      </div>

      <ConfirmDialog
        open={!!pendingDeleteModel}
        title={m.settings.deleteModelDialogTitle}
        description={
          pendingDeleteModel ? m.settings.deleteModelDialogDescription(pendingDeleteModel) : ''
        }
        confirmLabel={m.detail.delete}
        cancelLabel={m.common.cancel}
        closeAriaLabel={m.common.close}
        onClose={() => setPendingDeleteModel(null)}
        onConfirm={async () => {
          if (!pendingDeleteModel) return
          await handleDelete(pendingDeleteModel)
          setPendingDeleteModel(null)
        }}
      />
    </div>
  )
}
