import Store from 'electron-store'
import { safeStorage } from 'electron'

interface SecureStoreSchema {
  soniox_api_key?: string
  groq_api_key?: string
  openai_api_key?: string
}

let secureStore: Store<SecureStoreSchema> | null = null

export function initSecureStore(): void {
  secureStore = new Store<SecureStoreSchema>({
    name: 'secure-keys',
    encryptionKey: 'justsay-encryption-key-v1'
  })
  console.log('[SecureStore] Initialized at:', secureStore.path)
}

function encryptValue(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value)
    return encrypted.toString('base64')
  }
  return value
}

function decryptValue(encryptedValue: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const buffer = Buffer.from(encryptedValue, 'base64')
      return safeStorage.decryptString(buffer)
    } catch {
      return encryptedValue
    }
  }
  return encryptedValue
}

export function setApiKey(provider: 'soniox' | 'groq' | 'openai', apiKey: string): void {
  if (!secureStore) {
    console.error('[SecureStore] Store not initialized')
    return
  }
  const key = `${provider}_api_key` as keyof SecureStoreSchema
  const encrypted = encryptValue(apiKey)
  secureStore.set(key, encrypted)
  console.log(`[SecureStore] ${provider} API key saved (encrypted: ${safeStorage.isEncryptionAvailable()})`)
}

export function getApiKey(provider: 'soniox' | 'groq' | 'openai'): string | undefined {
  if (!secureStore) {
    console.error('[SecureStore] Store not initialized')
    return undefined
  }
  const key = `${provider}_api_key` as keyof SecureStoreSchema
  const encrypted = secureStore.get(key)
  if (!encrypted) return undefined
  return decryptValue(encrypted)
}

export function deleteApiKey(provider: 'soniox' | 'groq' | 'openai'): void {
  if (!secureStore) return
  const key = `${provider}_api_key` as keyof SecureStoreSchema
  secureStore.delete(key)
  console.log(`[SecureStore] ${provider} API key deleted`)
}

export function hasApiKey(provider: 'soniox' | 'groq' | 'openai'): boolean {
  if (!secureStore) return false
  const key = `${provider}_api_key` as keyof SecureStoreSchema
  return secureStore.has(key)
}
