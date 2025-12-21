import Store from 'electron-store'

export interface AppConfig {
  general?: {
    language?: string
    autostart?: boolean
    minimizeToTray?: boolean
  }
  hotkey?: {
    triggerKey?: string
    mode?: 'push_to_talk' | 'toggle'
  }
  audio?: {
    device?: string
    sampleRate?: number
    minDurationMs?: number
    maxDurationSec?: number
  }
  recognition?: {
    backend?: 'local' | 'api' | 'network'
    language?: string
    punctuation?: boolean
    local?: {
      modelPath?: string
      modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
      device?: 'cpu' | 'cuda'
      threads?: number
      computeType?: string
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
  }
  output?: {
    method?: 'simulate_input' | 'clipboard'
    autoSpace?: boolean
    capitalize?: boolean
  }
  ui?: {
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
    triggerKey: 'RAlt',
    mode: 'push_to_talk'
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
    local: {
      modelType: 'tiny',
      device: 'cpu',
      threads: 4,
      computeType: 'int8'
    }
  },
  output: {
    method: 'simulate_input',
    autoSpace: true,
    capitalize: true
  },
  ui: {
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
