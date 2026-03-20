import type { AppLocale } from '@/i18n'
import type { TriggerKey } from '../../../../shared/hotkey'

export type ThemeOption = 'system' | 'light' | 'dark'
export type Backend = 'local' | 'api' | 'network' | 'soniox' | 'groq'
export type LocalEngine = 'faster-whisper' | 'sensevoice'
export type LocalRecognitionMode = 'auto' | 'streaming' | 'http_chunk'
export type LocalTranscriptionProfile = 'single_shot' | 'offline_segmented'
export type ModelType = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
export type GroqModelType = 'whisper-large-v3-turbo' | 'whisper-large-v3'
export type TranslationProvider = 'openai-compatible'
export type ApiKeyProvider = 'openai' | 'soniox' | 'groq'
export type EngineOption = 'local-faster-whisper' | 'local-sensevoice' | 'soniox' | 'api' | 'groq'
export type MicrophoneDevice = { id: string; name: string; isDefault?: boolean }

export interface RendererConfig {
  general?: { language?: AppLocale; autostart?: boolean }
  hotkey?: { triggerKey?: TriggerKey }
  audio?: { device?: string }
  recognition?: {
    backend?: Backend
    language?: string
    meeting?: { includeMicrophone?: boolean }
    translation?: {
      provider?: TranslationProvider
      enabledForPtt?: boolean
      enabledForMeeting?: boolean
      targetLanguage?: string
      endpoint?: string
      model?: string
    }
    local?: {
      engine?: LocalEngine
      mode?: LocalRecognitionMode
      transcriptionProfile?: LocalTranscriptionProfile
      modelType?: ModelType
      serverMode?: 'local' | 'remote'
      serverHost?: string
      serverPort?: number
      segmentation?: { holdMs?: number }
    }
    api?: { model?: string }
    soniox?: { model?: string }
    groq?: { model?: GroqModelType }
  }
  ui?: {
    theme?: ThemeOption
    indicatorEnabled?: boolean
    soundFeedback?: boolean
  }
}

export function getApiKeyProvider(engine: EngineOption): ApiKeyProvider | null {
  if (engine === 'api') return 'openai'
  if (engine === 'soniox') return 'soniox'
  if (engine === 'groq') return 'groq'
  return null
}
