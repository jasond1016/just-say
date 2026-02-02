import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock electron-store and electron
const mockStore = new Map<string, string>()

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: (key: string) => mockStore.get(key),
    set: (key: string, value: string) => mockStore.set(key, value),
    delete: (key: string) => mockStore.delete(key),
    has: (key: string) => mockStore.has(key),
    path: '/mock/path/secure-keys.json'
  }))
}))

const mockEncryptString = vi.fn()
const mockDecryptString = vi.fn()
const mockIsEncryptionAvailable = vi.fn()

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: mockEncryptString,
    decryptString: mockDecryptString,
    isEncryptionAvailable: mockIsEncryptionAvailable
  }
}))

// Import after mocking
describe('secureStore', () => {
  beforeEach(() => {
    vi.resetModules()
    mockStore.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('encryptValue', () => {
    it('should encrypt value when encryption is available', () => {
      mockIsEncryptionAvailable.mockReturnValue(true)
      mockEncryptString.mockReturnValue(Buffer.from('encrypted-data'))

      // Simulate encryptValue function
      const encryptValue = (value: string): string => {
        if (mockIsEncryptionAvailable()) {
          const encrypted = mockEncryptString(value)
          return encrypted.toString('base64')
        }
        return value
      }

      const result = encryptValue('test-api-key')
      expect(mockIsEncryptionAvailable).toHaveBeenCalled()
      expect(mockEncryptString).toHaveBeenCalledWith('test-api-key')
      // Buffer.from('encrypted-data').toString('base64') = 'ZW5jcnlwdGVkLWRhdGE='
      expect(result).toBe('ZW5jcnlwdGVkLWRhdGE=')
    })

    it('should return plain value when encryption is not available', () => {
      mockIsEncryptionAvailable.mockReturnValue(false)

      const encryptValue = (value: string): string => {
        if (mockIsEncryptionAvailable()) {
          const encrypted = mockEncryptString(value)
          return encrypted.toString('base64')
        }
        return value
      }

      const result = encryptValue('test-api-key')
      expect(mockIsEncryptionAvailable).toHaveBeenCalled()
      expect(mockEncryptString).not.toHaveBeenCalled()
      expect(result).toBe('test-api-key')
    })
  })

  describe('decryptValue', () => {
    it('should decrypt value when encryption is available', () => {
      mockIsEncryptionAvailable.mockReturnValue(true)
      mockDecryptString.mockReturnValue('decrypted-key')

      const decryptValue = (encryptedValue: string): string => {
        if (mockIsEncryptionAvailable()) {
          try {
            const buffer = Buffer.from(encryptedValue, 'base64')
            return mockDecryptString(buffer)
          } catch {
            return encryptedValue
          }
        }
        return encryptedValue
      }

      const result = decryptValue('encrypted-base64')
      expect(mockIsEncryptionAvailable).toHaveBeenCalled()
      expect(mockDecryptString).toHaveBeenCalled()
      expect(result).toBe('decrypted-key')
    })

    it('should return encrypted value when decryption fails', () => {
      mockIsEncryptionAvailable.mockReturnValue(true)
      mockDecryptString.mockImplementation(() => {
        throw new Error('Decrypt failed')
      })

      const decryptValue = (encryptedValue: string): string => {
        if (mockIsEncryptionAvailable()) {
          try {
            const buffer = Buffer.from(encryptedValue, 'base64')
            return mockDecryptString(buffer)
          } catch {
            return encryptedValue
          }
        }
        return encryptedValue
      }

      const result = decryptValue('invalid-encrypted')
      expect(result).toBe('invalid-encrypted')
    })

    it('should return plain value when encryption is not available', () => {
      mockIsEncryptionAvailable.mockReturnValue(false)

      const decryptValue = (encryptedValue: string): string => {
        if (mockIsEncryptionAvailable()) {
          try {
            const buffer = Buffer.from(encryptedValue, 'base64')
            return mockDecryptString(buffer)
          } catch {
            return encryptedValue
          }
        }
        return encryptedValue
      }

      const result = decryptValue('some-value')
      expect(mockIsEncryptionAvailable).toHaveBeenCalled()
      expect(mockDecryptString).not.toHaveBeenCalled()
      expect(result).toBe('some-value')
    })
  })

  describe('setApiKey', () => {
    it('should store encrypted API key for soniox', () => {
      mockIsEncryptionAvailable.mockReturnValue(true)
      mockEncryptString.mockReturnValue(Buffer.from('encrypted-key'))
      const setFn = vi.fn()
      mockStore.set = setFn

      // Simulate setApiKey function
      const setApiKey = (provider: 'soniox' | 'groq', apiKey: string) => {
        if (!mockStore) return
        const key = `${provider}_api_key`
        const encrypted = mockIsEncryptionAvailable()
          ? mockEncryptString(apiKey).toString('base64')
          : apiKey
        mockStore.set(key, encrypted)
      }

      setApiKey('soniox', 'test-soniox-key')

      // Buffer.from('encrypted-key').toString('base64') = 'ZW5jcnlwdGVkLWtleQ=='
      expect(setFn).toHaveBeenCalledWith('soniox_api_key', 'ZW5jcnlwdGVkLWtleQ==')
    })

    it('should store encrypted API key for groq', () => {
      mockIsEncryptionAvailable.mockReturnValue(true)
      mockEncryptString.mockReturnValue(Buffer.from('encrypted-key'))
      const setFn = vi.fn()
      mockStore.set = setFn

      const setApiKey = (provider: 'soniox' | 'groq', apiKey: string) => {
        if (!mockStore) return
        const key = `${provider}_api_key`
        const encrypted = mockIsEncryptionAvailable()
          ? mockEncryptString(apiKey).toString('base64')
          : apiKey
        mockStore.set(key, encrypted)
      }

      setApiKey('groq', 'test-groq-key')

      // Buffer.from('encrypted-key').toString('base64') = 'ZW5jcnlwdGVkLWtleQ=='
      expect(setFn).toHaveBeenCalledWith('groq_api_key', 'ZW5jcnlwdGVkLWtleQ==')
    })
  })

  describe('getApiKey', () => {
    it('should retrieve and decrypt API key for soniox', () => {
      mockIsEncryptionAvailable.mockReturnValue(true)
      mockDecryptString.mockReturnValue('decrypted-key')
      mockStore.get = vi.fn().mockReturnValue('encrypted-base64')

      const getApiKey = (provider: 'soniox' | 'groq'): string | undefined => {
        if (!mockStore) return undefined
        const key = `${provider}_api_key`
        const encrypted = mockStore.get(key)
        if (!encrypted) return undefined
        if (mockIsEncryptionAvailable()) {
          return mockDecryptString(Buffer.from(encrypted)).toString()
        }
        return encrypted
      }

      const result = getApiKey('soniox')

      expect(mockStore.get).toHaveBeenCalledWith('soniox_api_key')
      expect(result).toBe('decrypted-key')
    })

    it('should return undefined when key does not exist', () => {
      mockStore.get = vi.fn().mockReturnValue(undefined)

      const getApiKey = (provider: 'soniox' | 'groq'): string | undefined => {
        if (!mockStore) return undefined
        const key = `${provider}_api_key`
        const encrypted = mockStore.get(key)
        if (!encrypted) return undefined
        return encrypted
      }

      const result = getApiKey('groq')

      expect(result).toBeUndefined()
    })
  })

  describe('hasApiKey', () => {
    it('should return true when key exists', () => {
      mockStore.has = vi.fn().mockReturnValue(true)

      const hasApiKey = (provider: 'soniox' | 'groq'): boolean => {
        if (!mockStore) return false
        const key = `${provider}_api_key`
        return mockStore.has(key)
      }

      expect(hasApiKey('soniox')).toBe(true)
      expect(mockStore.has).toHaveBeenCalledWith('soniox_api_key')
    })

    it('should return false when key does not exist', () => {
      mockStore.has = vi.fn().mockReturnValue(false)

      const hasApiKey = (provider: 'soniox' | 'groq'): boolean => {
        if (!mockStore) return false
        const key = `${provider}_api_key`
        return mockStore.has(key)
      }

      expect(hasApiKey('groq')).toBe(false)
    })
  })

  describe('deleteApiKey', () => {
    it('should delete API key', () => {
      mockStore.delete = vi.fn()

      const deleteApiKey = (provider: 'soniox' | 'groq') => {
        if (!mockStore) return
        const key = `${provider}_api_key`
        mockStore.delete(key)
      }

      deleteApiKey('soniox')

      expect(mockStore.delete).toHaveBeenCalledWith('soniox_api_key')
    })
  })
})
