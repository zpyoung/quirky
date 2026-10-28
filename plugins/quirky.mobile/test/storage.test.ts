import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'bun:test'
import { MobileStore } from '../src/daemon/storage'

const homes: string[] = []
function temporaryDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-mobile-store-'))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('mobile private store', () => {
  test('creates a stable 0600 identity and registry in a fresh private directory', () => {
    const dataDir = temporaryDataDir()
    const first = new MobileStore(dataDir)
    const publicKey = first.publicKeyB64
    const offer = first.getOrCreatePending(false)
    expect(offer.token).toMatch(/^[0-9a-f]{48}$/)
    expect(statSync(join(dataDir, 'e2ee-keypair.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'devices.json')).mode & 0o777).toBe(0o600)
    const restarted = new MobileStore(dataDir)
    expect(restarted.publicKeyB64).toBe(publicKey)
    expect(restarted.getOrCreatePending(false)).toEqual(offer)
  })

  test('reuses one pending offer, rotates only pending tokens, and preserves paired rows', () => {
    const store = new MobileStore(temporaryDataDir())
    const pending = store.getOrCreatePending(false)
    expect(store.getOrCreatePending(false)).toEqual(pending)
    const paired = store.authenticate(pending.token, 1234)
    expect(paired.status).toBe('paired')
    const replacement = store.getOrCreatePending(true)
    expect(replacement.token).not.toBe(pending.token)
    expect(store.devices()).toEqual([{ deviceId: pending.deviceId, name: pending.name, pairedAt: pending.pairedAt, lastSeenAt: 1234 }])
    expect(store.authenticate(pending.token, 2000).status).toBe('unauthorized')
  })

  test('persists first authentication before success and revocation through restart', () => {
    const dataDir = temporaryDataDir()
    const store = new MobileStore(dataDir)
    const pending = store.getOrCreatePending(false)
    expect(store.authenticate(pending.token, 5678).status).toBe('paired')
    const restarted = new MobileStore(dataDir)
    expect(restarted.devices()[0]?.lastSeenAt).toBe(5678)
    expect(restarted.revoke(pending.deviceId)).toBe(true)
    expect(new MobileStore(dataDir).devices()).toEqual([])
  })
  test('does not return a pending credential when the durable registry write fails', () => {
    const dataDir = temporaryDataDir()
    const store = new MobileStore(dataDir)
    rmSync(join(dataDir, 'devices.json'))
    mkdirSync(join(dataDir, 'devices.json'))
    expect(() => store.getOrCreatePending(false)).toThrow()
    expect(store.registryAvailable).toBe(false)
  })

  test('quarantines corrupt identity/registry data and fails closed instead of silently unpairing', () => {
    const dataDir = temporaryDataDir()
    new MobileStore(dataDir).getOrCreatePending(false)
    writeFileSync(join(dataDir, 'e2ee-keypair.json'), '{broken')
    chmodSync(join(dataDir, 'e2ee-keypair.json'), 0o600)
    const corruptIdentity = new MobileStore(dataDir)
    expect(corruptIdentity.identityAvailable).toBe(false)
    expect(corruptIdentity.registryAvailable).toBe(true)
    expect(() => corruptIdentity.getOrCreatePending(false)).toThrow('Mobile encryption identity unavailable')
    expect(readdirSync(dataDir).some((name) => name.includes('e2ee-keypair.json.corrupt'))).toBe(true)
    const registryDir = temporaryDataDir()
    const store = new MobileStore(registryDir)
    const pending = store.getOrCreatePending(false)
    store.authenticate(pending.token, 100)
    writeFileSync(join(registryDir, 'devices.json'), '{corrupt')
    const corruptRegistry = new MobileStore(registryDir)
    expect(corruptRegistry.registryAvailable).toBe(false)
    expect(readdirSync(registryDir).some((name) => name.includes('devices.json.corrupt'))).toBe(true)
    expect(readFileSync(join(registryDir, readdirSync(registryDir).find((name) => name.includes('devices.json.corrupt'))!), 'utf8')).toContain('corrupt')
  })
})
