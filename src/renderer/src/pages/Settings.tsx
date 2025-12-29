import React, { useEffect, useState } from 'react'
import { ModelManager } from '../components/Settings/ModelManager'

export function Settings(): React.JSX.Element {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async (): Promise<void> => {
    try {
      const cfg = await window.api.getConfig()
      setConfig(cfg)
    } catch (err) {
      console.error('Failed to load config:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleModelChange = async (modelType: string): Promise<void> => {
    if (!config) return

    const newConfig = {
      ...config,
      recognition: {
        ...config.recognition,
        local: {
          ...config.recognition?.local,
          modelType
        }
      }
    }

    try {
      await window.api.setConfig(newConfig)
      setConfig(newConfig)
    } catch (err) {
      console.error('Failed to save config:', err)
    }
  }

  if (loading) return <div>Loading settings...</div>
  if (!config) return <div>Failed to load settings</div>

  return (
    <div className="settings-page">
      <h2>Settings</h2>

      <div className="section">
        <h3>Recognition Backend</h3>
        <select
          value={config.recognition?.backend || 'local'}
          onChange={(e) => {
            // TODO: Implement backend switching logic fully
            // For now just update config
            window.api
              .setConfig({
                ...config,
                recognition: { ...config.recognition, backend: e.target.value }
              })
              .then(loadConfig)
          }}
        >
          <option value="local">Local (Faster-Whisper)</option>
          <option value="api">OpenAI API</option>
        </select>
      </div>

      {(!config.recognition?.backend || config.recognition?.backend === 'local') && (
        <ModelManager
          currentModel={config.recognition?.local?.modelType || 'tiny'}
          onModelChange={handleModelChange}
        />
      )}

      <style>{`
        .settings-page {
          padding: 20px;
          max-width: 600px;
          width: 100%;
          color: white;
        }
        .section {
          margin-bottom: 20px;
        }
        select {
          padding: 8px;
          border-radius: 4px;
          border: 1px solid #444;
          background: #222;
          color: white;
          width: 100%;
        }
      `}</style>
    </div>
  )
}
