import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranslationService } from './service'
import type { AppConfig } from '../config'

function buildConfig(): AppConfig {
  return {
    recognition: {
      translation: {
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        timeoutMs: 15000,
        enabledForPtt: true,
        targetLanguage: 'zh-CN',
        rateControl: {
          preset: 'balanced',
          enabled: true,
          maxRequestsPerMinute: 20,
          maxTokensPerMinute: 40000,
          minRequestIntervalMs: 1200,
          maxQueueSize: 64,
          maxQueueWaitMs: 45000,
          dropPolicy: 'drop_oldest'
        }
      }
    }
  }
}

function extractMessagesFromFetchCall(fetchMock: ReturnType<typeof vi.fn>): {
  system: string
  user: string
} {
  const [, init] = fetchMock.mock.calls[0]
  const body = JSON.parse((init as RequestInit).body as string) as {
    messages: Array<{ role: string; content: string }>
  }

  const system = body.messages.find((message) => message.role === 'system')?.content || ''
  const user = body.messages.find((message) => message.role === 'user')?.content || ''
  return { system, user }
}

describe('TranslationService prompts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('includes light-cleanup instructions and meeting context', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '这是翻译结果。' } }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new TranslationService(
      () => buildConfig(),
      () => 'test-key'
    )
    await service.translate('um I think we should should start now', 'zh-CN', {
      context: 'meeting',
      fallbackToSource: false
    })

    const messages = extractMessagesFromFetchCall(fetchMock)
    expect(messages.system).toContain('spoken-text editor')
    expect(messages.system).toContain('light cleanup')
    expect(messages.user).toContain('Context: real-time meeting transcript.')
    expect(messages.user).toContain('Remove obvious filler words')
    expect(messages.user).toContain('Output only the translated result')
  })

  it('uses push-to-talk context for translateForPtt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '你好。' } }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new TranslationService(
      () => buildConfig(),
      () => 'test-key'
    )
    await service.translateForPtt('uh hello there')

    const messages = extractMessagesFromFetchCall(fetchMock)
    expect(messages.user).toContain('Context: push-to-talk.')
  })

  it('supports batch meeting translation in a single request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: ['你好，大家好。', '我们开始吧。']
              })
            }
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new TranslationService(
      () => buildConfig(),
      () => 'test-key'
    )
    const translated = await service.translateBatchForMeeting(
      ['hello everyone', "let's get started"],
      'zh-CN'
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(translated).toEqual(['你好，大家好。', '我们开始吧。'])

    const messages = extractMessagesFromFetchCall(fetchMock)
    expect(messages.user).toContain('Return strict JSON')
    expect(messages.user).toContain('"translations"')
    expect(messages.user).toContain('Input JSON')
  })

  it('exposes meeting rate limiter metrics snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '翻译' } }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new TranslationService(
      () => buildConfig(),
      () => 'test-key'
    )
    const result = await service.translateForMeeting('hello', 'zh-CN')
    expect(result.translated).toBe(true)

    const metrics = service.getMeetingTranslationMetricsSnapshot()
    expect(metrics).not.toBeNull()
    expect(metrics?.limiter.totalEnqueued).toBe(1)
    expect(metrics?.limiter.totalExecuted).toBe(1)
    expect(metrics?.limiter.totalDroppedOverflow).toBe(0)
  })
})
