import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import * as browserStoreModule from '../src/profiles/store'
import { BrowserService } from '../src/service'

const { BrowserStore } = browserStoreModule
const STATE_NAME = 'browser-state.json'
const BROKEN = '{broken'
const DEFAULT_PROFILE = { id: 'default', label: 'Default', scope: 'default' as const }

type Recovery = { quarantinedPath: string; recoveredProfileIds: string[] }
type RecoveryHooks = {
  afterScan?(): void
  beforeIdentityCheck?(): void
  beforeRename?(): void
  afterQuarantine?(): void
}
type StoreTestHooks = { setBrowserStoreRecoveryHooksForTests?: (hooks: RecoveryHooks | null) => void }

function setRecoveryHooks(hooks: RecoveryHooks | null): void {
  const install = (browserStoreModule as unknown as StoreTestHooks).setBrowserStoreRecoveryHooksForTests
  if (typeof install !== 'function') {
    if (hooks !== null) throw new Error('browser store recovery test hooks are unavailable')
    return
  }
  install(hooks)
}

afterEach(() => setRecoveryHooks(null))

function temporaryRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'quirky-browser-recovery-')))
}

function statePath(dataDir: string): string {
  return join(dataDir, STATE_NAME)
}

function writeState(dataDir: string, contents: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const path = statePath(dataDir)
  writeFileSync(path, contents, { mode: 0o600 })
  return path
}

function validState(profiles: unknown[] = [DEFAULT_PROFILE], pages: unknown[] = []): unknown {
  return { profiles, pages }
}

function validPage(profileId = 'default'): Record<string, unknown> {
  return {
    browserPageId: 'page-one',
    worktreeId: null,
    profileId,
    index: 0,
    active: true,
    url: 'about:blank',
    title: '',
    loadError: null
  }
}

function quarantinePaths(path: string): string[] {
  const prefix = `${basename(path)}.corrupt-`
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dirname(path), name))
}

function temporaryFiles(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))
}

function expectNoRecoveryArtifacts(dataDir: string, path = statePath(dataDir)): void {
  expect(quarantinePaths(path)).toEqual([])
  expect(temporaryFiles(dataDir)).toEqual([])
}

function expectQuarantineName(path: string): void {
  expect(basename(path)).toMatch(/^browser-state\.json\.corrupt-\d+-[0-9a-f]{8}$/)
}

function recoveryOf(store: InstanceType<typeof BrowserStore>): Recovery | null | undefined {
  return (store as unknown as { recovery?: Recovery | null }).recovery
}

function expectDefaultRecovery(store: InstanceType<typeof BrowserStore>, path: string, original: string): string {
  const quarantined = quarantinePaths(path)
  expect(quarantined).toHaveLength(1)
  const [quarantinedPath] = quarantined
  expectQuarantineName(quarantinedPath!)
  expect(readFileSync(quarantinedPath!, 'utf8')).toBe(original)
  expect(lstatSync(path).isFile()).toBe(true)
  expect(lstatSync(path).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ profiles: [DEFAULT_PROFILE], pages: [] })
  expect(store.listProfiles()).toEqual([DEFAULT_PROFILE])
  expect(store.listPages()).toEqual([])
  expect(recoveryOf(store)).toEqual({ quarantinedPath: quarantinedPath!, recoveredProfileIds: [] })
  expect(temporaryFiles(dirname(path))).toEqual([])
  return quarantinedPath!
}

function captureError(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the operation to throw')
}

test('garbage browser state is set aside and rebuilt with private permissions', () => {
  const root = temporaryRoot()
  try {
    const path = writeState(root, BROKEN)
    const store = new BrowserStore(root)
    expectDefaultRecovery(store, path, BROKEN)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wrong-schema and unsafe browser metadata are set aside', () => {
  const unsafePageProfile = validPage('../x')
  const unsafePageLoadError = { ...validPage(), loadError: { code: 1 } }
  const invalidStates = [
    JSON.stringify({ quirkyCorruptStoreSweep: [1] }),
    JSON.stringify({ profiles: [{ id: '../x', label: 'x', scope: 'isolated' }], pages: [] }),
    JSON.stringify(validState([DEFAULT_PROFILE], [unsafePageProfile])),
    JSON.stringify(validState([DEFAULT_PROFILE], [unsafePageLoadError]))
  ]

  for (const original of invalidStates) {
    const root = temporaryRoot()
    try {
      const path = writeState(root, original)
      const store = new BrowserStore(root)
      expectDefaultRecovery(store, path, original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('truncated browser state is set aside', () => {
  const root = temporaryRoot()
  try {
    const fullState = JSON.stringify(validState([DEFAULT_PROFILE], [validPage()]))
    const truncated = fullState.slice(0, Math.floor(fullState.length / 2))
    const path = writeState(root, truncated)
    const store = new BrowserStore(root)
    expectDefaultRecovery(store, path, truncated)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recovery adopts only real profile directories below profiles and preserves their markers', () => {
  const root = temporaryRoot()
  try {
    const path = writeState(root, BROKEN)
    const profiles = join(root, 'profiles')
    const outside = join(root, 'outside-profile')
    const idA = `profile_${'a'.repeat(32)}`
    const idB = `profile_${'b'.repeat(32)}`
    const idFile = `profile_${'c'.repeat(32)}`
    const idLinked = `profile_${'d'.repeat(32)}`
    const idDangling = `profile_${'e'.repeat(32)}`
    mkdirSync(profiles)
    for (const name of [idB, 'default', 'not-a-profile', idA]) mkdirSync(join(profiles, name))
    writeFileSync(join(profiles, idFile), 'not a profile directory')
    mkdirSync(outside)
    writeFileSync(join(outside, 'Cookies'), 'outside cookie bytes')
    symlinkSync(outside, join(profiles, idLinked))
    symlinkSync(join(outside, 'missing-profile'), join(profiles, idDangling))
    writeFileSync(join(profiles, idA, '.no-native-pane'), 'marker-a')

    const store = new BrowserStore(root)
    expect(store.listProfiles()).toEqual([
      DEFAULT_PROFILE,
      { id: idA, label: 'Recovered profile aaaaaaaa', scope: 'isolated' },
      { id: idB, label: 'Recovered profile bbbbbbbb', scope: 'isolated' }
    ])
    expect(store.listPages()).toEqual([])
    const recoveredPath = quarantinePaths(path)[0]!
    expect(recoveryOf(store)).toEqual({ quarantinedPath: recoveredPath, recoveredProfileIds: [idA, idB] })
    expect(readFileSync(recoveredPath, 'utf8')).toBe(BROKEN)
    expect(readFileSync(join(outside, 'Cookies'), 'utf8')).toBe('outside cookie bytes')
    expect(readdirSync(outside)).toEqual(['Cookies'])
    expect(lstatSync(join(profiles, idLinked)).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(profiles, idDangling)).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(profiles, idA, '.no-native-pane'), 'utf8')).toBe('marker-a')
    expect(existsSync(join(profiles, idB, '.no-native-pane'))).toBe(false)
    expect(readFileSync(join(profiles, idFile), 'utf8')).toBe('not a profile directory')
    expect(existsSync(join(profiles, 'not-a-profile'))).toBe(true)

    store.deleteProfile(idA)
    expect(existsSync(join(profiles, idA))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recovered profile labels expand to full ids when their short labels collide', () => {
  const root = temporaryRoot()
  try {
    const path = writeState(root, BROKEN)
    const profiles = join(root, 'profiles')
    const suffixA = `1234abcd${'0'.repeat(24)}`
    const suffixB = `1234abcd${'f'.repeat(24)}`
    const idA = `profile_${suffixA}`
    const idB = `profile_${suffixB}`
    mkdirSync(profiles)
    mkdirSync(join(profiles, idA))
    mkdirSync(join(profiles, idB))

    const store = new BrowserStore(root)
    expect(store.listProfiles()).toEqual([
      DEFAULT_PROFILE,
      { id: idA, label: `Recovered profile ${suffixA}`, scope: 'isolated' },
      { id: idB, label: `Recovered profile ${suffixB}`, scope: 'isolated' }
    ])
    expect(recoveryOf(store)?.recoveredProfileIds).toEqual([idA, idB])
    expect(readFileSync(quarantinePaths(path)[0]!, 'utf8')).toBe(BROKEN)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unsafe profiles root fails closed, while a missing root recovers no profiles', () => {
  for (const rootKind of ['symlink', 'file'] as const) {
    const root = temporaryRoot()
    try {
      const path = writeState(root, BROKEN)
      const profiles = join(root, 'profiles')
      const outside = join(root, 'outside')
      mkdirSync(outside)
      const outsideProfile = `profile_${'a'.repeat(32)}`
      mkdirSync(join(outside, outsideProfile))
      writeFileSync(join(outside, 'Cookies'), 'outside cookie bytes')
      if (rootKind === 'symlink') symlinkSync(outside, profiles)
      else writeFileSync(profiles, 'not a profiles directory')

      expect(captureError(() => new BrowserStore(root))).toBe('invalid_argument: profile storage root is not a safe directory')
      expect(readFileSync(path, 'utf8')).toBe(BROKEN)
      expectNoRecoveryArtifacts(root, path)
      expect(readFileSync(join(outside, 'Cookies'), 'utf8')).toBe('outside cookie bytes')
      expect(existsSync(join(outside, outsideProfile))).toBe(true)
      expect(lstatSync(profiles).isSymbolicLink()).toBe(rootKind === 'symlink')
      if (rootKind === 'file') expect(readFileSync(profiles, 'utf8')).toBe('not a profiles directory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  const root = temporaryRoot()
  try {
    const path = writeState(root, BROKEN)
    const store = new BrowserStore(root)
    expectDefaultRecovery(store, path, BROKEN)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('profiles roots, adopted children, and data directory identity are revalidated after scanning', () => {
  for (const change of ['root', 'child', 'data-directory'] as const) {
    const root = temporaryRoot()
    const dataDir = join(root, 'data')
    const outside = join(root, 'outside')
    const movedDataDir = join(root, 'data-moved')
    try {
      const path = writeState(dataDir, BROKEN)
      const profiles = join(dataDir, 'profiles')
      const idA = `profile_${'a'.repeat(32)}`
      const idB = `profile_${'b'.repeat(32)}`
      mkdirSync(profiles)
      mkdirSync(join(profiles, idA))
      mkdirSync(join(profiles, idB))
      mkdirSync(outside)
      writeFileSync(join(outside, 'Cookies'), 'outside cookie bytes')

      setRecoveryHooks({
        afterScan() {
          if (change === 'root') {
            rmSync(profiles, { recursive: true, force: true })
            symlinkSync(outside, profiles)
          } else if (change === 'child') {
            rmSync(join(profiles, idA), { recursive: true, force: true })
            symlinkSync(outside, join(profiles, idA))
          } else {
            renameSync(dataDir, movedDataDir)
            symlinkSync(movedDataDir, dataDir)
          }
        }
      })

      expect(captureError(() => new BrowserStore(dataDir))).toBe('invalid_argument: profile storage root is not a safe directory')
      expect(readFileSync(path, 'utf8')).toBe(BROKEN)
      expectNoRecoveryArtifacts(dataDir, path)
      expect(readFileSync(join(outside, 'Cookies'), 'utf8')).toBe('outside cookie bytes')
      if (change === 'root') expect(lstatSync(profiles).isSymbolicLink()).toBe(true)
      if (change === 'child') expect(lstatSync(join(profiles, idA)).isSymbolicLink()).toBe(true)
    } finally {
      setRecoveryHooks(null)
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('a replacement at browser-state.json is never renamed or deleted during quarantine', () => {
  for (const hook of ['beforeIdentityCheck', 'beforeRename'] as const) {
    const root = temporaryRoot()
    try {
      const path = writeState(root, BROKEN)
      const savedOriginal = join(root, 'saved-original.json')
      const replacement = '{"other":1}'
      const hookAction = () => {
        renameSync(path, savedOriginal)
        writeFileSync(path, replacement, { mode: 0o600 })
      }
      setRecoveryHooks(hook === 'beforeIdentityCheck' ? { beforeIdentityCheck: hookAction } : { beforeRename: hookAction })

      const message = captureError(() => new BrowserStore(root))
      expect(readFileSync(savedOriginal, 'utf8')).toBe(BROKEN)
      if (hook === 'beforeIdentityCheck') {
        expect(message).toBe('browser_error: persisted browser metadata changed during recovery')
        expect(readFileSync(path, 'utf8')).toBe(replacement)
        expectNoRecoveryArtifacts(root, path)
      } else {
        const [quarantined] = quarantinePaths(path)
        expect(quarantined).toBeDefined()
        expectQuarantineName(quarantined!)
        expect(message).toBe(`browser_error: persisted browser metadata changed during recovery; a file was set aside as ${basename(quarantined!)}`)
        expect(readFileSync(quarantined!, 'utf8')).toBe(replacement)
        expect(existsSync(path)).toBe(false)
        expect(temporaryFiles(root)).toEqual([])
      }
    } finally {
      setRecoveryHooks(null)
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('recovery never overwrites a destination occupied after quarantine', () => {
  for (const destination of ['file', 'directory'] as const) {
    const root = temporaryRoot()
    try {
      const path = writeState(root, BROKEN)
      const replacement = '{"profiles":[],"pages":[],"x":1}'
      setRecoveryHooks({
        afterQuarantine() {
          if (destination === 'file') writeFileSync(path, replacement, { mode: 0o600 })
          else {
            mkdirSync(path)
            writeFileSync(join(path, 'sentinel'), 'directory sentinel')
          }
        }
      })

      const message = captureError(() => new BrowserStore(root))
      const [quarantined] = quarantinePaths(path)
      expect(quarantined).toBeDefined()
      expectQuarantineName(quarantined!)
      expect(message).toBe(`browser_error: persisted browser metadata changed during recovery; the unreadable file was set aside as ${basename(quarantined!)}`)
      expect(readFileSync(quarantined!, 'utf8')).toBe(BROKEN)
      if (destination === 'file') expect(readFileSync(path, 'utf8')).toBe(replacement)
      else expect(readFileSync(join(path, 'sentinel'), 'utf8')).toBe('directory sentinel')
      expect(temporaryFiles(root)).toEqual([])
    } finally {
      setRecoveryHooks(null)
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('a read-only data directory leaves corrupt metadata in place when recovery cannot save', () => {
  if (process.getuid?.() === 0) return
  const root = temporaryRoot()
  try {
    const path = writeState(root, BROKEN)
    chmodSync(root, 0o500)
    expect(captureError(() => new BrowserStore(root))).toBe('browser_error: browser metadata could not be saved')
    expect(readFileSync(path, 'utf8')).toBe(BROKEN)
    expectNoRecoveryArtifacts(root, path)
  } finally {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-regular metadata stays outside recovery while healthy symlink reads and dangling links keep current behavior', () => {
  const root = temporaryRoot()
  try {
    const directoryPath = statePath(root)
    mkdirSync(directoryPath)
    writeFileSync(join(directoryPath, 'sentinel'), 'directory sentinel')
    expect(captureError(() => new BrowserStore(root))).toBe('browser_error: persisted browser metadata is unreadable')
    expect(readFileSync(join(directoryPath, 'sentinel'), 'utf8')).toBe('directory sentinel')
    expectNoRecoveryArtifacts(root, directoryPath)
    rmSync(directoryPath, { recursive: true })

    const garbageTarget = join(root, 'outside-garbage.json')
    const garbageLink = statePath(root)
    writeFileSync(garbageTarget, BROKEN)
    symlinkSync(garbageTarget, garbageLink)
    expect(captureError(() => new BrowserStore(root))).toBe('browser_error: persisted browser metadata is unreadable')
    expect(lstatSync(garbageLink).isSymbolicLink()).toBe(true)
    expect(readFileSync(garbageTarget, 'utf8')).toBe(BROKEN)
    expect(quarantinePaths(garbageLink)).toEqual([])
    rmSync(garbageLink)

    const healthyTarget = join(root, 'outside-healthy.json')
    const healthyBytes = JSON.stringify(validState())
    writeFileSync(healthyTarget, healthyBytes)
    symlinkSync(healthyTarget, statePath(root))
    const linkedStore = new BrowserStore(root)
    expect(linkedStore.listProfiles()).toEqual([DEFAULT_PROFILE])
    expect(recoveryOf(linkedStore)).toBeNull()
    expect(lstatSync(statePath(root)).isSymbolicLink()).toBe(true)
    expect(readFileSync(healthyTarget, 'utf8')).toBe(healthyBytes)
    expect(quarantinePaths(statePath(root))).toEqual([])
    rmSync(statePath(root))

    const danglingTarget = join(root, 'never-created-target.json')
    symlinkSync(danglingTarget, statePath(root))
    const danglingStore = new BrowserStore(root)
    expect(danglingStore.listProfiles()).toEqual([DEFAULT_PROFILE])
    expect(recoveryOf(danglingStore)).toBeNull()
    expect(lstatSync(statePath(root)).isFile()).toBe(true)
    expect(lstatSync(statePath(root)).isSymbolicLink()).toBe(false)
    expect(existsSync(danglingTarget)).toBe(false)
    expect(quarantinePaths(statePath(root))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('healthy metadata is byte-for-byte untouched and has no recovery record', () => {
  const root = temporaryRoot()
  try {
    const isolatedId = `profile_${'a'.repeat(32)}`
    const healthyState = validState(
      [DEFAULT_PROFILE, { id: isolatedId, label: 'Isolated', scope: 'isolated' }],
      [validPage(isolatedId)]
    )
    const original = JSON.stringify(healthyState, null, 2)
    const path = writeState(root, original)
    const store = new BrowserStore(root)

    expect(recoveryOf(store)).toBeNull()
    expect(store.listProfiles()).toHaveLength(2)
    expect(store.listPages()).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(quarantinePaths(path)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BrowserService logs the profile recovery exactly once', () => {
  const root = temporaryRoot()
  try {
    const path = writeState(root, BROKEN)
    const logs: string[] = []
    const context = {
      dataDir: root,
      getSetting: () => undefined,
      log: (message: string) => logs.push(message),
      openStore: () => ({ all: () => [], run: () => undefined, get: () => undefined, transaction: (run: () => unknown) => run() })
    } as unknown as PluginContext
    const dependencies = { runtimeRoot: root, process: {} as never, spawn: (() => { throw new Error('unexpected browser spawn') }) as never }

    new BrowserService(context, dependencies)

    const [quarantined] = quarantinePaths(path)
    expect(quarantined).toBeDefined()
    expect(logs).toEqual([
      `browser: set aside unreadable browser-state.json as ${basename(quarantined!)}; recovered 0 profiles from disk`
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
