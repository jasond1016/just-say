import Store from 'electron-store'
import { DEFAULT_TRIGGER_KEY, type TriggerKey } from '../shared/hotkey'

export interface AppConfig {
  general?: {
    language?: string
    autostart?: boolean
    minimizeToTray?: boolean
  }
  hotkey?: {
    triggerKey?: TriggerKey
  }
  audio?: {
    device?: string
    sampleRate?: number
    minDurationMs?: number
    maxDurationSec?: number
  }
  recognition?: {
    backend?: 'local' | 'api' | 'network' | 'soniox' | 'groq'
    language?: string
    punctuation?: boolean
    translation?: {
      provider?: 'openai-compatible'
      enabledForPtt?: boolean
      enabledForMeeting?: boolean
      targetLanguage?: string
      endpoint?: string
      model?: string
      timeoutMs?: number
    }
    local?: {
      modelPath?: string
      engine?: 'faster-whisper' | 'sensevoice'
      modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
      sensevoice?: {
        modelId?: string
        useItn?: boolean
      }
      device?: 'cpu' | 'cuda'
      threads?: number
      computeType?: string
      serverMode?: 'local' | 'remote'
      serverHost?: string
      serverPort?: number
    }
    api?: {
      provider?: string
      endpoint?: string
      apiKey?: string
      model?: string
    }
    network?: {
      endpoint?: string
      protocol?: string
      authType?: string
      authToken?: string
    }
    soniox?: {
      apiKey?: string
      model?: string
      languageHints?: string[]
    }
    groq?: {
      apiKey?: string
      model?: 'whisper-large-v3-turbo' | 'whisper-large-v3'
      chatModel?: string // For translation, default: 'llama-3.3-70b-versatile'
      rateControl?: {
        mode?: 'free-tier' | 'balanced'
        targetRpm?: number
        minRequestIntervalMs?: number
        maxBackoffMs?: number
        allowPreview?: boolean
      }
    }
  }
  output?: {
    method?: 'simulate_input' | 'clipboard' | 'popup'
    autoSpace?: boolean
    capitalize?: boolean
  }
  ui?: {
    theme?: 'system' | 'light' | 'dark'
    indicatorEnabled?: boolean
    indicatorPosition?: 'center_bottom' | 'cursor'
    indicatorOpacity?: number
    soundFeedback?: boolean
  }
}

const defaultConfig: AppConfig = {
  general: {
    language: 'zh-CN',
    autostart: false,
    minimizeToTray: true
  },
  hotkey: {
    triggerKey: DEFAULT_TRIGGER_KEY
  },
  audio: {
    device: 'default',
    sampleRate: 16000,
    minDurationMs: 500,
    maxDurationSec: 60
  },
  recognition: {
    backend: 'local',
    language: 'auto',
    punctuation: true,
    translation: {
      provider: 'openai-compatible',
      enabledForPtt: false,
      enabledForMeeting: false,
      targetLanguage: 'en',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      timeoutMs: 15000
    },
    local: {
      engine: 'faster-whisper',
      modelType: 'tiny',
      sensevoice: {
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        useItn: true
      },
      device: 'cpu',
      threads: 4,
      computeType: 'int8',
      serverMode: 'local',
      serverPort: 8765
    },
    api: {
      endpoint: 'https://api.openai.com/v1',
      model: 'whisper-1'
    }
  },
  output: {
    method: 'simulate_input',
    autoSpace: true,
    capitalize: true
  },
  ui: {
    theme: 'system',
    indicatorEnabled: true,
    indicatorPosition: 'center_bottom',
    indicatorOpacity: 0.9,
    soundFeedback: true
  }
}

let store: Store<AppConfig> | null = null

export function initConfig(): void {
  store = new Store<AppConfig>({
    name: 'config',
    defaults: defaultConfig
  })
  console.log('[Config] Loaded from:', store.path)
}

export function getConfig(): AppConfig {
  if (!store) {
    console.warn('[Config] Store not initialized, returning defaults')
    return defaultConfig
  }
  return store.store
}

export function setConfig(config: Partial<AppConfig>): void {
  if (!store) return
  const current = store.store
  store.store = deepMerge(current, config)
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key in source) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        result[key] = deepMerge(
          (target[key] as object) || {},
          source[key] as object
        ) as T[typeof key]
      } else {
        result[key] = source[key] as T[typeof key]
      }
    }
  }
  return result
}
