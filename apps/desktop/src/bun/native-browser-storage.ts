import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NATIVE_BROWSER_PARTITION_RE } from '@quirky/protocol'

/** The parts of an Electrobun `Session` that native Browser storage uses. */
export type NativeBrowserStorageSession = {
  setStorageIdentifier(identifier: string): { status: string; reason?: string }
  clearStorageData(types: 'all'): { status: string; reason?: string }
}

/** Per-profile native website-data stores, scoped to one Quirky home. */
export type NativeBrowserStorage = {
  /** Whether Browser partitions get their own native stores and clears report completion. */
  readonly supported: boolean
  /** The store a Browser partition's native views must use, or null when unsupported. */
  identifierFor(partition: string): string | null
  /** Assigns the partition's store; must run before its first native view is created. */
  prepare(partition: string): { storageIdentifier: string | null }
  /** Removes every kind of website data from the partition's store, returning only once the engine reports completion. */
  clear(partition: string): { cleared: true }
}

export const NATIVE_BROWSER_DEFAULT_PARTITION = 'persist:quirky-browser-default'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertBrowserPartition(partition: string): void {
  if (!NATIVE_BROWSER_PARTITION_RE.test(partition)) throw new Error('unsupported browser partition')
}

/** A stable UUID naming one Quirky home's store for one Browser partition. */
export function nativeBrowserStorageIdentifier(installId: string, partition: string): string {
  const hex = createHash('sha256').update(`${installId}\n${partition}`).digest('hex').slice(0, 32).toUpperCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Reads the id that scopes this Quirky home's native stores, creating it on first use.
 * Throws when the stored id is unreadable, so a damaged file never silently moves profiles to new stores.
 */
export function loadNativeBrowserInstallId(home: string): string {
  const dir = join(home, 'desktop')
  const path = join(dir, 'native-browser-storage-id')
  const read = (): string | null => {
    try {
      return readFileSync(path, 'utf8').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  let id = read()
  if (id === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(path, `${randomUUID()}\n`, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    id = read()
  }
  if (id === null || !UUID_RE.test(id)) throw new Error(`${path} does not hold a native browser storage id`)
  return id
}

/** Assigns the Default store at once, so it is in place before any window can create a Default view. */
export function createNativeBrowserStorage(deps: {
  installId: string | null
  session(partition: string): NativeBrowserStorageSession
}): NativeBrowserStorage {
  const assign = (partition: string): string | null => {
    if (deps.installId === null) return null
    const identifier = nativeBrowserStorageIdentifier(deps.installId, partition)
    return deps.session(partition).setStorageIdentifier(identifier).status === 'set' ? identifier : null
  }
  const supported = assign(NATIVE_BROWSER_DEFAULT_PARTITION) !== null

  const prepare = (partition: string) => {
    assertBrowserPartition(partition)
    if (!supported) return { storageIdentifier: null }
    const storageIdentifier = assign(partition)
    if (storageIdentifier === null) throw new Error('native browser profile storage could not be assigned')
    return { storageIdentifier }
  }

  return {
    supported,
    identifierFor(partition) {
      assertBrowserPartition(partition)
      return supported && deps.installId !== null ? nativeBrowserStorageIdentifier(deps.installId, partition) : null
    },
    prepare,
    clear(partition) {
      assertBrowserPartition(partition)
      if (!supported) throw new Error('Native browser profile clearing is unavailable: this Mac cannot confirm native website-data removal (macOS 14 or later is required)')
      // the assignment is per process, so a profile not opened since launch must be pointed at its store first.
      prepare(partition)
      const result = deps.session(partition).clearStorageData('all')
      if (result.status !== 'cleared') {
        throw new Error(`Native website-data removal did not complete (${result.status}${result.reason ? `: ${result.reason}` : ''})`)
      }
      return { cleared: true }
    }
  }
}
