import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NATIVE_BROWSER_DEFAULT_PARTITION,
  createNativeBrowserStorage,
  loadNativeBrowserInstallId,
  nativeBrowserStorageIdentifier,
  type NativeBrowserStorageSession
} from '../src/bun/native-browser-storage'

const INSTALL_ID = '6F1C2B9E-3D47-4A8B-9C10-5E2F7A1B4D63'
const PROFILE = `persist:quirky-browser-profile_${'a'.repeat(32)}`

/** Models Electrobun's Session: identifiers stick once assigned, and clears report a status. */
class SessionModel {
  readonly assigned = new Map<string, string>()
  readonly calls: string[] = []
  identifierStatus = 'set'
  clearStatus: { status: string; reason?: string } = { status: 'cleared' }

  session(partition: string): NativeBrowserStorageSession {
    return {
      setStorageIdentifier: (identifier) => {
        this.calls.push(`assign:${partition}`)
        if (this.identifierStatus === 'set') this.assigned.set(partition, identifier)
        return this.identifierStatus === 'set' ? { status: 'set' } : { status: 'unsupported', reason: 'platform' }
      },
      clearStorageData: () => {
        this.calls.push(`clear:${partition}:${this.assigned.get(partition) ?? 'unassigned'}`)
        return this.clearStatus
      }
    }
  }
}

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-native-storage-'))
  homes.push(home)
  return home
}

describe('native browser storage identifiers', () => {
  test('are stable UUIDs that differ by Quirky home and by profile', () => {
    const identifier = nativeBrowserStorageIdentifier(INSTALL_ID, NATIVE_BROWSER_DEFAULT_PARTITION)
    expect(identifier).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
    expect(nativeBrowserStorageIdentifier(INSTALL_ID, NATIVE_BROWSER_DEFAULT_PARTITION)).toBe(identifier)
    expect(nativeBrowserStorageIdentifier(INSTALL_ID, PROFILE)).not.toBe(identifier)
    expect(nativeBrowserStorageIdentifier(crypto.randomUUID(), NATIVE_BROWSER_DEFAULT_PARTITION)).not.toBe(identifier)
  })

  test('each Quirky home gets its own install id, kept across launches', () => {
    const home = freshHome()
    const id = loadNativeBrowserInstallId(home)
    expect(loadNativeBrowserInstallId(home)).toBe(id)
    expect(loadNativeBrowserInstallId(freshHome())).not.toBe(id)
    const path = join(home, 'desktop', 'native-browser-storage-id')
    expect(readFileSync(path, 'utf8').trim()).toBe(id)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  // replacing a damaged id would silently point every profile at new, empty stores.
  test('a damaged install id is refused rather than replaced', () => {
    const home = freshHome()
    loadNativeBrowserInstallId(home)
    const path = join(home, 'desktop', 'native-browser-storage-id')
    writeFileSync(path, 'not-a-uuid\n')
    expect(() => loadNativeBrowserInstallId(home)).toThrow(/does not hold a native browser storage id/)
    expect(readFileSync(path, 'utf8')).toBe('not-a-uuid\n')
  })
})

describe('native browser storage', () => {
  test('assigns the Default store before any view and reports support', () => {
    const model = new SessionModel()
    const storage = createNativeBrowserStorage({ installId: INSTALL_ID, session: (partition) => model.session(partition) })

    expect(storage.supported).toBe(true)
    expect(model.assigned.get(NATIVE_BROWSER_DEFAULT_PARTITION)).toBe(nativeBrowserStorageIdentifier(INSTALL_ID, NATIVE_BROWSER_DEFAULT_PARTITION))
    expect(storage.prepare(PROFILE)).toEqual({ storageIdentifier: nativeBrowserStorageIdentifier(INSTALL_ID, PROFILE) })
    expect(storage.identifierFor(PROFILE)).toBe(nativeBrowserStorageIdentifier(INSTALL_ID, PROFILE))
  })

  test('clears a profile only after pointing it at its own store', () => {
    const model = new SessionModel()
    const storage = createNativeBrowserStorage({ installId: INSTALL_ID, session: (partition) => model.session(partition) })

    expect(storage.clear(PROFILE)).toEqual({ cleared: true })
    expect(model.calls.slice(-2)).toEqual([
      `assign:${PROFILE}`,
      `clear:${PROFILE}:${nativeBrowserStorageIdentifier(INSTALL_ID, PROFILE)}`
    ])
  })

  test.each([
    { status: 'failed', reason: 'timeout' },
    { status: 'unsupported', reason: 'platform' }
  ])('a $status ($reason) clear is reported as incomplete', (result) => {
    const model = new SessionModel()
    model.clearStatus = result
    const storage = createNativeBrowserStorage({ installId: INSTALL_ID, session: (partition) => model.session(partition) })

    expect(() => storage.clear(PROFILE)).toThrow(`Native website-data removal did not complete (${result.status}: ${result.reason})`)
  })

  test('without per-profile stores, views keep working but nothing is cleared', () => {
    for (const setup of [
      () => { const model = new SessionModel(); model.identifierStatus = 'unsupported'; return { model, installId: INSTALL_ID } },
      () => ({ model: new SessionModel(), installId: null })
    ]) {
      const { model, installId } = setup()
      const storage = createNativeBrowserStorage({ installId, session: (partition) => model.session(partition) })

      expect(storage.supported).toBe(false)
      expect(storage.identifierFor(PROFILE)).toBeNull()
      expect(storage.prepare(PROFILE)).toEqual({ storageIdentifier: null })
      expect(() => storage.clear(PROFILE)).toThrow(/macOS 14 or later/)
      expect(model.calls.filter((call) => call.startsWith('clear:'))).toEqual([])
    }
  })

  test('rejects partitions that are not Browser profiles', () => {
    const model = new SessionModel()
    const storage = createNativeBrowserStorage({ installId: INSTALL_ID, session: (partition) => model.session(partition) })

    for (const partition of ['persist:default', 'persist:quirky-browser-other', 'temp:quirky-browser-default']) {
      expect(() => storage.prepare(partition)).toThrow(/unsupported browser partition/)
      expect(() => storage.clear(partition)).toThrow(/unsupported browser partition/)
    }
    expect(model.calls).toEqual([`assign:${NATIVE_BROWSER_DEFAULT_PARTITION}`])
  })
})
