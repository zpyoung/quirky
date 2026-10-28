import type { MobileSecretStorage } from '../contracts'

const SECRET_PREFIX = 'quirky.mobile.credential.'
const TOKEN = /^[0-9a-f]{48}$/

export type SecureStorePort<TAccessibility = unknown> = {
  readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: TAccessibility
  isAvailableAsync(): Promise<boolean>
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string, options: { keychainAccessible: TAccessibility }): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

export function createSecureSecretStorage<TAccessibility>(store: SecureStorePort<TAccessibility>): MobileSecretStorage {
  return {
    async read(hostId) {
      try {
        if (!await store.isAvailableAsync()) return { kind: 'unavailable' }
        const token = await store.getItemAsync(`${SECRET_PREFIX}${hostId}`)
        if (token === null) return { kind: 'missing' }
        return TOKEN.test(token) ? { kind: 'available', token } : { kind: 'unavailable' }
      } catch {
        return { kind: 'unavailable' }
      }
    },
    async write(hostId, token) {
      if (!TOKEN.test(token)) throw new Error('Invalid secure pairing credential')
      if (!await store.isAvailableAsync()) throw new Error('Secure storage is unavailable')
      await store.setItemAsync(`${SECRET_PREFIX}${hostId}`, token, {
        keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY
      })
    },
    async remove(hostId) {
      if (!await store.isAvailableAsync()) throw new Error('Secure storage is unavailable')
      await store.deleteItemAsync(`${SECRET_PREFIX}${hostId}`)
    }
  }
}
