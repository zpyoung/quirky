import { describe, expect, test } from 'bun:test'
import { loadDesktopClientId } from '../src/lib/desktop-client-id'

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

function memoryStorage(initial: string | null = null): Storage & { value: string | null } {
  return {
    value: initial,
    getItem() { return this.value },
    setItem(_key, value) { this.value = value }
  }
}

describe('durable desktop client identity', () => {
  test('persists one UUID and reuses it for later UI connections', () => {
    const storage = memoryStorage()
    const first = loadDesktopClientId(storage)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(storage.value).toBe(first)
    expect(loadDesktopClientId(storage)).toBe(first)
  })

  test('replaces invalid stored identity and fails closed when persistence is unavailable', () => {
    const storage = memoryStorage('not-a-uuid')
    const replacement = loadDesktopClientId(storage)
    expect(replacement).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(storage.value).toBe(replacement)
    expect(loadDesktopClientId({ getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } })).toBeUndefined()
  })
})
