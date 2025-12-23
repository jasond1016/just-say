import React, { useEffect, useState } from 'react'

const ALL_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']

interface ModelManagerProps {
    currentModel: string
    onModelChange: (model: string) => void
}

export function ModelManager({ currentModel, onModelChange }: ModelManagerProps): React.JSX.Element {
    const [downloadedModels, setDownloadedModels] = useState<string[]>([])
    const [downloading, setDownloading] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        loadModels()
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
        setError(null)
        try {
            await window.api.downloadModel(model)
            await loadModels()
        } catch (err) {
            setError(`Failed to download ${model}: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
            setDownloading(null)
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

                    return (
                        <div key={model} className={`model-item ${isCurrent ? 'active' : ''}`}>
                            <div className="model-info">
                                <span className="model-name">{model}</span>
                                {isCurrent && <span className="badge current">Active</span>}
                                {isDownloaded && !isCurrent && <span className="badge downloaded">Downloaded</span>}
                            </div>
                            <div className="model-actions">
                                {isDownloaded ? (
                                    !isCurrent && (
                                        <button onClick={() => onModelChange(model)} disabled={!!downloading}>
                                            Select
                                        </button>
                                    )
                                ) : (
                                    <button
                                        onClick={() => handleDownload(model)}
                                        disabled={!!downloading}
                                        className="download-btn"
                                    >
                                        {isDownloading ? 'Downloading...' : 'Download'}
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
          padding: 10px;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 6px;
          border: 1px solid transparent;
        }
        .model-item.active {
          border-color: #646cff;
          background: rgba(100, 108, 255, 0.1);
        }
        .model-name {
          font-weight: bold;
          text-transform: capitalize;
          margin-right: 10px;
        }
        .badge {
          font-size: 0.8em;
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
        .error-banner {
          background: #ff444433;
          color: #ff8888;
          padding: 10px;
          border-radius: 4px;
          margin-bottom: 10px;
        }
      `}</style>
        </div>
    )
}
