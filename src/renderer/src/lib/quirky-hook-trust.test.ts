import { afterEach, describe, expect, it } from 'vitest'
import { hashQuirkyHookScript } from './quirky-hook-trust'

const realCrypto = globalThis.crypto

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
})

function stubCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true })
}

describe('hashQuirkyHookScript', () => {
  it('produces a stable hex digest via crypto.subtle', async () => {
    const hash = await hashQuirkyHookScript('echo hi')
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(await hashQuirkyHookScript('  echo hi  ')).toBe(hash)
  })

  // Why: LAN web clients run on plain HTTP where crypto.subtle is undefined.
  // The hash must still compute (no "crypto.subtle is undefined" throw) and stay
  // deterministic so trust comparisons keep working.
  it('falls back to a deterministic hash when crypto.subtle is unavailable', async () => {
    stubCrypto(undefined)
    const hash = await hashQuirkyHookScript('echo hi')
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(await hashQuirkyHookScript('echo hi')).toBe(hash)
    expect(await hashQuirkyHookScript('echo bye')).not.toBe(hash)
  })
})
