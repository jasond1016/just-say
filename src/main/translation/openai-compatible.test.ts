import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleTranslator } from './openai-compatible'

describe('OpenAICompatibleTranslator', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('validates configuration against the chat completions endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '连接测试成功' } }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const translator = new OpenAICompatibleTranslator({
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      timeoutMs: 10_000
    })

    const translated = await translator.validateConnection('zh')

    expect(translated).toBe('连接测试成功')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions')

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string) as {
      model: string
      messages: Array<{ role: string; content: string }>
    }

    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages[1]?.content).toContain('Connection test')
    expect(body.messages[1]?.content).toContain('into zh')
  })
})