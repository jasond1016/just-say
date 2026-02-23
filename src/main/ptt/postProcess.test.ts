import { describe, expect, it, vi } from 'vitest'
import { processPttRecognitionResult } from './postProcess'

describe('processPttRecognitionResult', () => {
  it('skips processing when source text is empty', async () => {
    const translate = vi.fn(async () => 'translated')
    const trackUsage = vi.fn()
    const persistTranscript = vi.fn()
    const notifyIndicatorOutputText = vi.fn()
    const showOutputWindow = vi.fn()

    const result = await processPttRecognitionResult({
      sourceText: '   ',
      startedAt: null,
      deps: {
        translate,
        trackUsage,
        persistTranscript,
        notifyIndicatorOutputText,
        showOutputWindow
      }
    })

    expect(result).toBeNull()
    expect(translate).not.toHaveBeenCalled()
    expect(trackUsage).not.toHaveBeenCalled()
    expect(persistTranscript).not.toHaveBeenCalled()
  })

  it('processes text and defaults to simulate_input output method', async () => {
    const translate = vi.fn(async () => 'translated')
    const typeText = vi.fn(async () => 'typed text')
    const trackUsage = vi.fn()
    const persistTranscript = vi.fn()
    const notifyIndicatorOutputText = vi.fn()
    const showOutputWindow = vi.fn()

    const result = await processPttRecognitionResult({
      sourceText: 'source text',
      startedAt: 123,
      deps: {
        translate,
        typeText,
        trackUsage,
        persistTranscript,
        notifyIndicatorOutputText,
        showOutputWindow
      }
    })

    expect(typeText).toHaveBeenCalledWith('translated', {
      method: 'simulate_input',
      autoSpace: undefined,
      capitalize: undefined
    })
    expect(trackUsage).toHaveBeenCalledWith('typed text', 123)
    expect(persistTranscript).toHaveBeenCalledWith('source text', 'translated', 123)
    expect(notifyIndicatorOutputText).toHaveBeenCalledWith('typed text')
    expect(showOutputWindow).not.toHaveBeenCalled()
    expect(result).toEqual({
      translatedText: 'translated',
      finalText: 'typed text',
      method: 'simulate_input'
    })
  })

  it('shows popup when popup output is selected and final text exists', async () => {
    const translate = vi.fn(async () => 'translated')
    const typeText = vi.fn(async () => 'popup text')
    const trackUsage = vi.fn()
    const persistTranscript = vi.fn()
    const notifyIndicatorOutputText = vi.fn()
    const showOutputWindow = vi.fn()

    await processPttRecognitionResult({
      sourceText: 'source text',
      startedAt: 42,
      outputConfig: {
        method: 'popup',
        autoSpace: true,
        capitalize: true
      },
      deps: {
        translate,
        typeText,
        trackUsage,
        persistTranscript,
        notifyIndicatorOutputText,
        showOutputWindow
      }
    })

    expect(typeText).toHaveBeenCalledWith('translated', {
      method: 'popup',
      autoSpace: true,
      capitalize: true
    })
    expect(trackUsage).toHaveBeenCalledWith('popup text', 42)
    expect(notifyIndicatorOutputText).toHaveBeenCalledWith('popup text')
    expect(showOutputWindow).toHaveBeenCalledWith('popup text')
  })

  it('tracks translated text when typeText is unavailable', async () => {
    const translate = vi.fn(async () => 'translated only')
    const trackUsage = vi.fn()
    const persistTranscript = vi.fn()
    const notifyIndicatorOutputText = vi.fn()
    const showOutputWindow = vi.fn()

    await processPttRecognitionResult({
      sourceText: 'source text',
      startedAt: null,
      outputConfig: {
        method: 'clipboard'
      },
      deps: {
        translate,
        trackUsage,
        persistTranscript,
        notifyIndicatorOutputText,
        showOutputWindow
      }
    })

    expect(trackUsage).toHaveBeenCalledWith('translated only', null)
    expect(persistTranscript).toHaveBeenCalledWith('source text', 'translated only', null)
    expect(notifyIndicatorOutputText).not.toHaveBeenCalled()
    expect(showOutputWindow).not.toHaveBeenCalled()
  })
})
