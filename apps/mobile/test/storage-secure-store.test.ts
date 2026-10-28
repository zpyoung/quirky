import { describe, expect, test } from 'bun:test'
import { createSecureSecretStorage, type SecureStorePort } from '../src/storage/secure-store'

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'

function fakeSecureStore(overrides: Partial<SecureStorePort<number>> = {}) {
  const calls: { operation: string; key: string; value?: string; options?: { keychainAccessible: number } }[] = []
  const store: SecureStorePort<number> = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 17,
    isAvailableAsync: async () => true,
    getItemAsync: async (key) => {
      calls.push({ operation: 'get', key })
      return null
    },
    setItemAsync: async (key, value, options) => { calls.push({ operation: 'set', key, value, options }) },
    deleteItemAsync: async (key) => { calls.push({ operation: 'delete', key }) },
    ...overrides
  }
  return { store, calls }
}

describe('secure pairing credential storage', () => {
  test('uses device-only while-unlocked storage and treats a missing item as missing', async () => {
    const { store, calls } = fakeSecureStore()
    const secrets = createSecureSecretStorage(store)

    expect(await secrets.read('host_example')).toEqual({ kind: 'missing' })
    await secrets.write('host_example', TOKEN)
    expect(calls.at(-1)).toEqual({
      operation: 'set',
      key: 'quirky.mobile.credential.host_example',
      value: TOKEN,
      options: { keychainAccessible: 17 }
    })
    await secrets.remove('host_example')
    expect(calls.at(-1)).toEqual({ operation: 'delete', key: 'quirky.mobile.credential.host_example' })
    expect(calls.map(({ operation }) => operation)).toEqual(['get', 'set', 'delete'])
  })

  test('returns a valid secure-store credential without reading ordinary metadata', async () => {
    const { store } = fakeSecureStore({ getItemAsync: async () => TOKEN })
    expect(await createSecureSecretStorage(store).read('host_example')).toEqual({ kind: 'available', token: TOKEN })
  })

  test('distinguishes locked or unavailable secure storage from an absent credential', async () => {
    const locked = fakeSecureStore({ getItemAsync: async () => { throw new Error('device is locked') } })
    expect(await createSecureSecretStorage(locked.store).read('host_example')).toEqual({ kind: 'unavailable' })

    const unavailable = fakeSecureStore({ isAvailableAsync: async () => false })
    expect(await createSecureSecretStorage(unavailable.store).read('host_example')).toEqual({ kind: 'unavailable' })
    expect(unavailable.calls).toEqual([])
  })

  test('rejects malformed credential material and reports secure-store write failures', async () => {
    const { store } = fakeSecureStore({ setItemAsync: async () => { throw new Error('device is locked') } })
    const secrets = createSecureSecretStorage(store)
    await expect(secrets.write('host_example', 'not-a-token')).rejects.toThrow('Invalid secure pairing credential')
    await expect(secrets.write('host_example', TOKEN)).rejects.toThrow('device is locked')
  })
})
