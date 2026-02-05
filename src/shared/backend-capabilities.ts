/**
 * 识别后端能力矩阵
 *
 * 定义各识别后端支持的功能特性，UI 根据此矩阵动态显示设置项
 */

export interface BackendCapability {
  /** 自动标点 - 模型是否支持自动添加标点符号 */
  punctuation: boolean
  /** 热词支持 - 模型是否支持自定义热词提升识别准确率 */
  hotWords: boolean
  /** 语言锁定 - 是否支持强制识别某种语言 */
  languageLock: boolean
  /** 流式识别 - 是否支持实时流式返回结果 */
  streaming: boolean
}

export type RecognitionBackend = 'local' | 'api' | 'soniox' | 'groq'

export const backendCapabilities: Record<RecognitionBackend, BackendCapability> = {
  local: {
    punctuation: false, // Faster-Whisper 自动输出标点，无需配置
    hotWords: false,
    languageLock: true,
    streaming: false
  },
  groq: {
    punctuation: false, // Groq Whisper API 自动输出标点，无需配置
    hotWords: false,
    languageLock: true,
    streaming: false
  },
  soniox: {
    punctuation: false, // Soniox 自动输出标点，无需配置
    hotWords: true, // Soniox 支持热词
    languageLock: true,
    streaming: true
  },
  api: {
    punctuation: false, // OpenAI Whisper API 自动输出标点，无需配置
    hotWords: false,
    languageLock: true,
    streaming: false
  }
}

/**
 * 检查指定后端是否支持某项能力
 */
export function hasCapability(
  backend: string | undefined,
  capability: keyof BackendCapability
): boolean {
  if (!backend || !(backend in backendCapabilities)) {
    return false
  }
  return backendCapabilities[backend as RecognitionBackend][capability]
}
