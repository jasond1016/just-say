import React, { useEffect, useState } from 'react'

const MODEL_INFO: Record<string, { size: string; params: string }> = {
  tiny: { size: '~75 MB', params: '39M' },
  base: { size: '~145 MB', params: '74M' },
  small: { size: '~465 MB', params: '244M' },
  medium: { size: '~1.5 GB', params: '769M' },
  'large-v3': { size: '~3 GB', params: '1550M' }
}

const ALL_MODELS = Object.keys(MODEL_INFO)

interface ModelManagerProps {
  currentModel: string
  onModelChange: (model: string) => void
}

interface DownloadProgress {
  model: string
  percent: number
  status: string
}

export function ModelManager({
  currentModel,
  onModelChange
}: ModelManagerProps): React.JSX.Element {
  const [downloadedModels, setDownloadedModels] = useState<string[]>([])
  const [downloading, setDownloading] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadModels()
  }, [])

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
    if (!confirm(`Delete model "${model}"? This will free up disk space.`)) return

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
    <div className="model-manager">
      <h3>Local Models</h3>
      {error && <div className="error-banner">{error}</div>}
      <div className="models-list">
        {ALL_MODELS.map((model) => {
          const isDownloaded = downloadedModels.includes(model)
          const isCurrent = currentModel === model
          const isDownloading = downloading === model

          const info = MODEL_INFO[model]
          return (
            <div
              key={model}
              className={`model-item ${isCurrent ? 'active' : ''} ${isDownloaded ? 'downloaded' : 'not-downloaded'}`}
            >
              <div className="model-info">
                <div className="model-header">
                  <span className="model-name">{model}</span>
                  {isCurrent && <span className="badge current">Active</span>}
                  {isDownloaded && !isCurrent && <span className="badge downloaded">✓</span>}
                </div>
                <div className="model-meta">
                  {info.size} · {info.params} params
                </div>
              </div>
              <div className="model-actions">
                {isDownloaded ? (
                  <>
                    {!isCurrent && (
                      <button onClick={() => onModelChange(model)} disabled={!!downloading || !!deleting}>
                        Select
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(model)}
                      disabled={!!downloading || !!deleting || isCurrent}
                      className="delete-btn"
                      title={isCurrent ? 'Cannot delete active model' : 'Delete model'}
                    >
                      {deleting === model ? '...' : '✕'}
                    </button>
                  </>
                ) : isDownloading ? (
                  <div className="download-progress">
                    <div className="progress-text">{progress?.status || 'Downloading...'}</div>
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.min(progress?.percent || 0, 100)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => handleDownload(model)}
                    disabled={!!downloading}
                    className="download-btn"
                  >
                    Download
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <style>{`
        .model-manager {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          padding: 16px;
          margin-top: 20px;
        }
        .models-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .model-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 6px;
          border: 1px solid transparent;
          transition: all 0.2s ease;
        }
        .model-item.not-downloaded {
          opacity: 0.6;
        }
        .model-item.downloaded {
          opacity: 1;
        }
        .model-item.active {
          border-color: #646cff;
          background: rgba(100, 108, 255, 0.15);
        }
        .model-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .model-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .model-name {
          font-weight: bold;
          text-transform: capitalize;
        }
        .model-meta {
          font-size: 0.8em;
          color: #888;
        }
        .badge {
          font-size: 0.75em;
          padding: 2px 6px;
          border-radius: 4px;
        }
        .badge.current {
          background: #646cff;
          color: white;
        }
        .badge.downloaded {
          background: #4caf50;
          color: white;
        }
        button {
          padding: 6px 12px;
          border-radius: 4px;
          border: 1px solid #646cff;
          background: transparent;
          color: #646cff;
          cursor: pointer;
        }
        button:hover:not(:disabled) {
          background: #646cff;
          color: white;
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .model-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .delete-btn {
          padding: 4px 8px;
          border-color: #ff6b6b;
          color: #ff6b6b;
          font-size: 0.9em;
        }
        .delete-btn:hover:not(:disabled) {
          background: #ff6b6b;
          color: white;
        }
        .error-banner {
          background: #ff444433;
          color: #ff8888;
          padding: 10px;
          border-radius: 4px;
          margin-bottom: 10px;
        }
        .download-progress {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 150px;
        }
        .progress-text {
          font-size: 0.75em;
          color: #aaa;
          text-align: right;
        }
        .progress-bar {
          height: 6px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 3px;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: #646cff;
          border-radius: 3px;
          transition: width 0.3s ease;
        }
      `}</style>
    </div>
  )
}
