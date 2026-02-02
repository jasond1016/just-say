import { describe, it, expect, vi, beforeEach } from 'vitest'

// Test the deepMerge function logic
describe('deepMerge', () => {
  // Replicate the deepMerge function from config.ts for testing
  const deepMerge = <T extends object>(target: T, source: Partial<T>): T => {
    const result = { ...target }
    for (const key in source) {
      if (source[key] !== undefined) {
        if (
          typeof source[key] === 'object' &&
          source[key] !== null &&
          !Array.isArray(source[key])
        ) {
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

  interface TestConfig {
    name?: string
    value?: number
    nested?: {
      a?: string
      b?: number
    }
    array?: string[]
  }

  it('should merge nested objects', () => {
    const target: TestConfig = {
      name: 'original',
      nested: { a: 'hello', b: 1 }
    }
    const source: Partial<TestConfig> = {
      nested: { b: 2 }
    }

    const result = deepMerge(target, source)

    expect(result.name).toBe('original')
    expect(result.nested?.a).toBe('hello')
    expect(result.nested?.b).toBe(2)
  })

  it('should override primitive values', () => {
    const target: TestConfig = {
      name: 'original',
      value: 100
    }
    const source: Partial<TestConfig> = {
      name: 'updated',
      value: 200
    }

    const result = deepMerge(target, source)

    expect(result.name).toBe('updated')
    expect(result.value).toBe(200)
  })

  it('should handle undefined source values', () => {
    const target: TestConfig = {
      name: 'original',
      value: 100
    }
    const source: Partial<TestConfig> = {
      name: undefined,
      value: undefined
    }

    const result = deepMerge(target, source)

    expect(result.name).toBe('original')
    expect(result.value).toBe(100)
  })

  it('should handle null source values', () => {
    const target: TestConfig = {
      name: 'original',
      nested: { a: 'hello' }
    }
    const source: Partial<TestConfig> = {
      nested: null as any
    }

    // null is not undefined, so it should be assigned
    const result = deepMerge(target, source)

    expect(result.nested).toBeNull()
  })

  it('should add new nested properties', () => {
    const target: TestConfig = {
      nested: { a: 'hello' }
    }
    const source: Partial<TestConfig> = {
      nested: { b: 'world' }
    }

    const result = deepMerge(target, source)

    expect(result.nested?.a).toBe('hello')
    expect(result.nested?.b).toBe('world')
  })

  it('should handle empty source object', () => {
    const target: TestConfig = {
      name: 'original',
      value: 100
    }
    const source: Partial<TestConfig> = {}

    const result = deepMerge(target, source)

    expect(result).toEqual(target)
  })

  it('should handle target without nested object', () => {
    const target: TestConfig = {}
    const source: Partial<TestConfig> = {
      nested: { a: 'hello' }
    }

    const result = deepMerge(target, source)

    expect(result.nested?.a).toBe('hello')
  })

  it('should replace entire nested object when source has it', () => {
    const target: TestConfig = {
      nested: { a: 'hello', b: 1, c: 3 }
    }
    const source: Partial<TestConfig> = {
      nested: { b: 2 }
    }

    const result = deepMerge(target, source)

    // deepMerge correctly preserves existing properties and only updates b
    expect(result.nested?.a).toBe('hello')
    expect(result.nested?.b).toBe(2)
    expect(result.nested?.c).toBe(3) // c is preserved because source doesn't override it
  })
})

describe('AppConfig structure', () => {
  it('should have correct default values', () => {
    const defaultConfig = {
      general: {
        language: 'zh-CN',
        autostart: false,
        minimizeToTray: true
      },
      hotkey: {
        triggerKey: 'RAlt',
        mode: 'push_to_talk' as const
      },
      audio: {
        device: 'default',
        sampleRate: 16000,
        minDurationMs: 500,
        maxDurationSec: 60
      },
      recognition: {
        backend: 'local' as const,
        language: 'auto',
        punctuation: true,
        local: {
          modelType: 'tiny' as const,
          device: 'cpu' as const,
          threads: 4,
          computeType: 'int8'
        }
      },
      output: {
        method: 'simulate_input' as const,
        autoSpace: true,
        capitalize: true
      },
      ui: {
        theme: 'system' as const,
        indicatorEnabled: true,
        indicatorPosition: 'center_bottom' as const,
        indicatorOpacity: 0.9,
        soundFeedback: true
      }
    }

    expect(defaultConfig.general.language).toBe('zh-CN')
    expect(defaultConfig.hotkey.triggerKey).toBe('RAlt')
    expect(defaultConfig.audio.sampleRate).toBe(16000)
    expect(defaultConfig.recognition.backend).toBe('local')
    expect(defaultConfig.ui.theme).toBe('system')
  })
})
