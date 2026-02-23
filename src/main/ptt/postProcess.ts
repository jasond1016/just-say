import type { AppConfig } from '../config'

type OutputConfig = AppConfig['output']
type OutputMethod = NonNullable<OutputConfig>['method']

export interface PttTypeOptions {
  method: OutputMethod
  autoSpace?: boolean
  capitalize?: boolean
}

export interface ProcessPttRecognitionDeps {
  translate: (text: string) => Promise<string>
  typeText?: (text: string, options: PttTypeOptions) => Promise<string | null | undefined>
  trackUsage: (text: string, startedAt: number | null) => void
  persistTranscript: (sourceText: string, translatedText: string, startedAt: number | null) => void
  notifyIndicatorOutputText: (text: string) => void
  showOutputWindow: (text: string) => void
}

export interface ProcessPttRecognitionOptions {
  sourceText: string
  startedAt: number | null
  outputConfig?: OutputConfig
  deps: ProcessPttRecognitionDeps
}

export interface ProcessPttRecognitionResult {
  translatedText: string
  finalText: string | null | undefined
  method: OutputMethod
}

export async function processPttRecognitionResult(
  options: ProcessPttRecognitionOptions
): Promise<ProcessPttRecognitionResult | null> {
  const { sourceText, startedAt, outputConfig, deps } = options
  if (!sourceText?.trim()) {
    return null
  }

  const translatedText = await deps.translate(sourceText)
  const method = outputConfig?.method || 'simulate_input'
  const finalText = deps.typeText
    ? await deps.typeText(translatedText, {
        method,
        autoSpace: outputConfig?.autoSpace,
        capitalize: outputConfig?.capitalize
      })
    : undefined

  deps.trackUsage(finalText || translatedText || sourceText, startedAt)
  deps.persistTranscript(sourceText, translatedText, startedAt)
  if (finalText) {
    deps.notifyIndicatorOutputText(finalText)
  }
  if (method === 'popup' && finalText) {
    deps.showOutputWindow(finalText)
  }

  return {
    translatedText,
    finalText,
    method
  }
}
