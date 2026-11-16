import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { OwnerGrantStore, setOwnerGrantWriteHooksForTests } from '../src/daemon/owner-store'
import { MobilePairingResetError, MobilePairingResetOutcome, MobilePairingResetHookPoint, MobileStore, setPairingResetHooksForTests } from '../src/daemon/storage'

const dataDirs: string[] = []
const REGISTRY = 'devices.json'
const IDENTITY = 'e2ee-keypair.json'
const OWNER_GRANTS = 'owner-grants.json'
const BROKEN = '{broken'

function temporaryDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-mobile-pairing-reset-'))
  dataDirs.push(dir)
  return dir
}

afterEach(() => {
  try {
    setPairingResetHooksForTests(null)
  } finally {
    try {
      setOwnerGrantWriteHooksForTests(null)
    } finally {
      for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    }
  }
})

function captureResetError(store: MobileStore): MobilePairingResetError {
  let caught: unknown
  try {
    store.resetPairing()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  return caught as MobilePairingResetError
}

function expectResetError(store: MobileStore, code: string, message: string, registryReset = false): MobilePairingResetError {
  const error = captureResetError(store)
  expect(error.code).toBe(code)
  expect(error.message).toBe(message)
  expect(error.registryReset).toBe(registryReset)
  return error
}

function writePrivateFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function seed(dataDir: string, paired = true): { token: string; publicKey: string; registryBytes: string } {
  const store = new MobileStore(dataDir)
  const pending = store.getOrCreatePending(false)
  if (paired) expect(store.authenticate(pending.token, 100).status).toBe('paired')
  const seeded = { token: pending.token, publicKey: store.publicKeyB64!, registryBytes: readFileSync(join(dataDir, REGISTRY), 'utf8') }
  store.dispose()
  return seeded
}

function corrupt(dataDir: string, filename: string): string {
  writePrivateFile(join(dataDir, filename), BROKEN)
  const damaged = new MobileStore(dataDir)
  damaged.dispose()
  const siblings = readdirSync(dataDir).filter((name) => name.startsWith(`${filename}.corrupt-`))
  expect(siblings).toHaveLength(1)
  return siblings[0]!
}


function quarantineNames(dataDir: string): string[] {
  return readdirSync(dataDir)
    .filter((name) => /^(?:devices\.json|e2ee-keypair\.json)\.corrupt-\d+-[0-9a-f]{8}$/.test(name))
    .sort()
}

function resetCopies(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => /^devices\.json\.reset-\d+-[0-9a-f]{8}$/.test(name)).sort()
}

function temporaryNames(dataDir: string): string[] {
  return readdirSync(dataDir)
    .filter((name) => name.startsWith('.devices.json.tmp-') || name.startsWith('.e2ee-keypair.json.tmp-'))
    .sort()
}

function expectNoTemporaryFiles(dataDir: string, except?: string): void {
  expect(temporaryNames(dataDir)).toEqual(except ? [basename(except)] : [])
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

function refuseWithMissingRegistry(store: MobileStore): void {
  expectResetError(
    store,
    'not_quarantined',
    'not_quarantined: devices.json is missing and no devices.json.corrupt- file exists; nothing was reset'
  )
}

describe('mobile pairing reset store', () => {
  test('resets a set-aside registry while retaining the identity and allowing pairing again', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    const identityBytes = readFileSync(join(dataDir, IDENTITY))
    const quarantinedName = corrupt(dataDir, REGISTRY)
    const store = new MobileStore(dataDir)

    expect(store.registryAvailable).toBe(false)
    expect(store.identityAvailable).toBe(true)
    expect(store.pairingResetRefusal()).toBeNull()
    expect(store.resetPairing()).toEqual({
      identityCreated: false,
      unpairedDevices: 0,
      previousRegistry: null,
      quarantined: [quarantinedName],
      unsynced: []
    })
    expect(store.registryAvailable).toBe(true)
    expect(store.publicKeyB64).toBe(seeded.publicKey)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expect(mode(join(dataDir, REGISTRY))).toBe(0o600)
    expect(readFileSync(join(dataDir, IDENTITY))).toEqual(identityBytes)
    expectNoTemporaryFiles(dataDir)
    expect(readFileSync(join(dataDir, quarantinedName), 'utf8')).toBe(BROKEN)

    const pending = store.getOrCreatePending(false)
    expect(pending.token).toMatch(/^[0-9a-f]{48}$/)
    const restarted = new MobileStore(dataDir)
    expect(restarted.registryAvailable).toBe(true)
    expect(restarted.identityAvailable).toBe(true)
    expect(restarted.publicKeyB64).toBe(seeded.publicKey)
    expect(restarted.getOrCreatePending(false)).toEqual(pending)
  })

  test('forces registry mode to 0600 under a restrictive umask', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    corrupt(dataDir, REGISTRY)
    const store = new MobileStore(dataDir)
    const previousUmask = process.umask(0o277)
    try {
      store.resetPairing()
    } finally {
      process.umask(previousUmask)
    }
    expect(mode(join(dataDir, REGISTRY))).toBe(0o600)
  })

  test('replaces a set-aside identity and copies the non-empty paired registry aside', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    const quarantinedName = corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)

    expect(store.registryAvailable).toBe(true)
    expect(store.identityAvailable).toBe(false)
    expect(store.resetPairing()).toMatchObject({
      identityCreated: true,
      unpairedDevices: 1,
      quarantined: [quarantinedName],
      unsynced: []
    })
    const copies = resetCopies(dataDir)
    expect(copies).toHaveLength(1)
    const previousRegistry = copies[0]!
    expect(previousRegistry).toMatch(/^devices\.json\.reset-\d+-[0-9a-f]{8}$/)
    expect(readFileSync(join(dataDir, previousRegistry), 'utf8')).toBe(seeded.registryBytes)
    expect(mode(join(dataDir, previousRegistry))).toBe(0o600)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expect(mode(join(dataDir, REGISTRY))).toBe(0o600)
    const identity = JSON.parse(readFileSync(join(dataDir, IDENTITY), 'utf8')) as Record<string, unknown>
    expect(Object.keys(identity).sort()).toEqual(['publicKeyB64', 'secretKeyB64', 'v'])
    expect(identity.v).toBe(1)
    expect(identity.publicKeyB64).not.toBe(seeded.publicKey)
    expect(store.publicKeyB64).toBe(identity.publicKeyB64)
    expect(mode(join(dataDir, IDENTITY))).toBe(0o600)
    expect(store.authenticate(seeded.token).status).toBe('unauthorized')
    expect(readFileSync(join(dataDir, quarantinedName), 'utf8')).toBe(BROKEN)
    expectNoTemporaryFiles(dataDir)

    const restarted = new MobileStore(dataDir)
    expect(restarted.registryAvailable).toBe(true)
    expect(restarted.identityAvailable).toBe(true)
    expect(restarted.publicKeyB64).toBe(identity.publicKeyB64)
  })

  test('forces registry, identity, and registry-copy modes to 0600 under a restrictive umask', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    const previousUmask = process.umask(0o277)
    try {
      store.resetPairing()
    } finally {
      process.umask(previousUmask)
    }
    expect(mode(join(dataDir, REGISTRY))).toBe(0o600)
    expect(mode(join(dataDir, IDENTITY))).toBe(0o600)
    expect(mode(join(dataDir, resetCopies(dataDir)[0]!))).toBe(0o600)
  })

  test('copies a registry that contains only a pending offer', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir, false)
    const bytes = readFileSync(join(dataDir, REGISTRY), 'utf8')
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)

    const result: MobilePairingResetOutcome = store.resetPairing()
    expect(result.identityCreated).toBe(true)
    expect(result.unpairedDevices).toBe(0)
    expect(result.previousRegistry).not.toBeNull()
    expect(readFileSync(join(dataDir, result.previousRegistry!), 'utf8')).toBe(bytes)
  })

  test('does not copy an empty registry during an identity reset', () => {
    const dataDir = temporaryDataDir()
    const initial = new MobileStore(dataDir)
    initial.dispose()
    expect(readFileSync(join(dataDir, REGISTRY), 'utf8')).toBe('[]')
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)

    const result: MobilePairingResetOutcome = store.resetPairing()
    expect(result.previousRegistry).toBeNull()
    expect(resetCopies(dataDir)).toEqual([])
    expect(result.identityCreated).toBe(true)
  })

  test('resets both components set aside at the same startup', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    writePrivateFile(join(dataDir, REGISTRY), BROKEN)
    writePrivateFile(join(dataDir, IDENTITY), BROKEN)
    const store = new MobileStore(dataDir)
    const quarantined = quarantineNames(dataDir)

    const result: MobilePairingResetOutcome = store.resetPairing()
    expect(result).toEqual({
      identityCreated: true,
      unpairedDevices: 0,
      previousRegistry: null,
      quarantined,
      unsynced: []
    })
    expect(quarantineNames(dataDir)).toEqual(quarantined)
    for (const name of quarantined) expect(readFileSync(join(dataDir, name), 'utf8')).toBe(BROKEN)
    expect(store.getOrCreatePending(false).token).toMatch(/^[0-9a-f]{48}$/)
  })

  test('refuses a healthy store without changing its directory or pairing files', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    const store = new MobileStore(dataDir)
    const entries = readdirSync(dataDir).sort()
    const registryBytes = readFileSync(join(dataDir, REGISTRY))
    const identityBytes = readFileSync(join(dataDir, IDENTITY))
    const message = 'pairing_available: the device registry and encryption identity are both available; nothing was reset'

    const refusal = store.pairingResetRefusal()!
    expect(refusal.code).toBe('pairing_available')
    expect(refusal.message).toBe(message)
    expectResetError(store, 'pairing_available', message)
    expect(readdirSync(dataDir).sort()).toEqual(entries)
    expect(readFileSync(join(dataDir, REGISTRY))).toEqual(registryBytes)
    expect(readFileSync(join(dataDir, IDENTITY))).toEqual(identityBytes)
  })

  test('refuses a registry deleted by hand when no set-aside file exists', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    rmSync(join(dataDir, REGISTRY))
    const store = new MobileStore(dataDir)
    const entries = readdirSync(dataDir).sort()

    expect(store.registryAvailable).toBe(false)
    refuseWithMissingRegistry(store)
    expect(readdirSync(dataDir).sort()).toEqual(entries)
    expect(existsSync(join(dataDir, REGISTRY))).toBe(false)
  })

  test('refuses an unavailable registry entry that was not set aside', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    corrupt(dataDir, REGISTRY)
    const store = new MobileStore(dataDir)
    const registryPath = join(dataDir, REGISTRY)
    mkdirSync(registryPath)
    expect(() => store.getOrCreatePending(false)).toThrow()
    expect(store.registryAvailable).toBe(false)
    const entries = readdirSync(dataDir).sort()

    expectResetError(
      store,
      'not_quarantined',
      'not_quarantined: devices.json exists but is unavailable; it was not set aside, so nothing was reset'
    )
    expect(lstatSync(registryPath).isDirectory()).toBe(true)
    expect(readdirSync(dataDir).sort()).toEqual(entries)
  })

  test('refuses a dangling symlink at the unavailable registry path without following it', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    corrupt(dataDir, REGISTRY)
    const registryPath = join(dataDir, REGISTRY)
    const target = join(dataDir, 'nowhere')
    symlinkSync(target, registryPath)
    const store = new MobileStore(dataDir)
    const entries = readdirSync(dataDir).sort()
    const message = 'not_quarantined: devices.json exists but is unavailable; it was not set aside, so nothing was reset'

    expectResetError(store, 'not_quarantined', message)
    expect(lstatSync(registryPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(registryPath)).toBe(target)
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dataDir).sort()).toEqual(entries)
  })

  test('refuses a deleted identity when no identity set-aside file exists', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    rmSync(join(dataDir, IDENTITY))
    const store = new MobileStore(dataDir)
    const registryBytes = readFileSync(join(dataDir, REGISTRY))
    const entries = readdirSync(dataDir).sort()

    expect(store.identityAvailable).toBe(false)
    expect(store.registryAvailable).toBe(true)
    expectResetError(
      store,
      'not_quarantined',
      'not_quarantined: e2ee-keypair.json is missing and no e2ee-keypair.json.corrupt- file exists; nothing was reset'
    )
    expect(readFileSync(join(dataDir, REGISTRY))).toEqual(registryBytes)
    expect(store.authenticate(seeded.token).status).toBe('paired')
    expect(readdirSync(dataDir).sort()).toEqual(entries)
  })

  test('counts only regular files with the exact registry quarantine basename', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    rmSync(join(dataDir, REGISTRY))
    const store = new MobileStore(dataDir)
    const validShape = 'devices.json.corrupt-1-0a1b2c3d'
    const target = join(dataDir, 'regular-target')
    writePrivateFile(target, 'target')
    const invalidNames = [
      { name: validShape, kind: 'directory' },
      { name: validShape, kind: 'symlink' },
      { name: 'devices.json.corrupt-x', kind: 'file' },
      { name: 'devices.json.corrupt-1-ZZZZZZZZ', kind: 'file' },
      { name: 'devices.json.corrupt-1-0a1b2c3d.bak', kind: 'file' },
      { name: 'xdevices.json.corrupt-1-0a1b2c3d', kind: 'file' },
      { name: 'e2ee-keypair.json.corrupt-1-0a1b2c3d', kind: 'file' }
    ] as const

    for (const entry of invalidNames) {
      const path = join(dataDir, entry.name)
      if (entry.kind === 'directory') mkdirSync(path)
      else if (entry.kind === 'symlink') symlinkSync(target, path)
      else writePrivateFile(path, 'lookalike')
      expectResetError(
        store,
        'not_quarantined',
        'not_quarantined: devices.json is missing and no devices.json.corrupt- file exists; nothing was reset'
      )
      expect(existsSync(join(dataDir, REGISTRY))).toBe(false)
      expect(resetCopies(dataDir)).toEqual([])
      if (entry.kind === 'directory') rmSync(path, { recursive: true })
      else rmSync(path)
    }

    writePrivateFile(join(dataDir, validShape), 'control')
    const result: MobilePairingResetOutcome = store.resetPairing()
    expect(result.quarantined).toEqual([validShape])
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expect(readFileSync(join(dataDir, validShape), 'utf8')).toBe('control')
  })

  test('refuses a non-regular registry entry when the identity is unavailable', () => {
    const dataDir = temporaryDataDir()
    seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    const registryPath = join(dataDir, REGISTRY)
    rmSync(registryPath)
    mkdirSync(registryPath)
    const entries = readdirSync(dataDir).sort()

    expectResetError(store, 'unexpected_entry', 'unexpected_entry: devices.json is not a regular file; nothing was reset')
    expect(readdirSync(dataDir).sort()).toEqual(entries)
    expect(lstatSync(registryPath).isDirectory()).toBe(true)
    expect(resetCopies(dataDir)).toEqual([])
    expect(existsSync(join(dataDir, IDENTITY))).toBe(false)
  })

  test('cleans only its own registry temp after an occupied temp name and retries', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    const identityBytes = readFileSync(join(dataDir, IDENTITY))
    const quarantinedName = corrupt(dataDir, REGISTRY)
    const store = new MobileStore(dataDir)
    let plantedPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'registry:beforeTempOpen') return
        plantedPath = path
        writeFileSync(path, 'occupied', { flag: 'wx', mode: 0o600 })
      }
    })

    const error = captureResetError(store)
    expect(error.code).toBe('write_failed')
    expect(error.message.startsWith('write_failed: devices.json could not be written (EEXIST')).toBe(true)
    expect(error.message.endsWith('); the registry and identity are unchanged')).toBe(true)
    expect(error.registryReset).toBe(false)
    expect(store.registryAvailable).toBe(false)
    expect(existsSync(join(dataDir, REGISTRY))).toBe(false)
    expect(readFileSync(join(dataDir, IDENTITY))).toEqual(identityBytes)
    expect(readFileSync(plantedPath, 'utf8')).toBe('occupied')
    expectNoTemporaryFiles(dataDir, plantedPath)

    setPairingResetHooksForTests(null)
    expect(store.resetPairing()).toMatchObject({ identityCreated: false, unpairedDevices: 0, quarantined: [quarantinedName] })
    expect(readFileSync(plantedPath, 'utf8')).toBe('occupied')
    expectNoTemporaryFiles(dataDir, plantedPath)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expect(store.publicKeyB64).toBe(seeded.publicKey)
    expect(store.getOrCreatePending(false).token).toMatch(/^[0-9a-f]{48}$/)
  })

  test('closes and removes an opened registry temp after failure, then retries', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    const identityBytes = readFileSync(join(dataDir, IDENTITY))
    corrupt(dataDir, REGISTRY)
    const store = new MobileStore(dataDir)
    let tempPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'registry:tempOpened') return
        tempPath = path
        expect(existsSync(path)).toBe(true)
        expect(statSync(path).size).toBe(0)
        throw new Error('injected')
      }
    })

    expectResetError(
      store,
      'write_failed',
      'write_failed: devices.json could not be written (injected); the registry and identity are unchanged'
    )
    expect(store.registryAvailable).toBe(false)
    expect(existsSync(join(dataDir, REGISTRY))).toBe(false)
    expect(readFileSync(join(dataDir, IDENTITY))).toEqual(identityBytes)
    expect(existsSync(tempPath)).toBe(false)
    expectNoTemporaryFiles(dataDir)

    setPairingResetHooksForTests(null)
    store.resetPairing()
    expect(store.registryAvailable).toBe(true)
    expect(store.publicKeyB64).toBe(seeded.publicKey)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expect(store.getOrCreatePending(false).token).toMatch(/^[0-9a-f]{48}$/)
    expectNoTemporaryFiles(dataDir)
  })

  test('removes a closed registry temp after failure, then retries', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    const identityBytes = readFileSync(join(dataDir, IDENTITY))
    corrupt(dataDir, REGISTRY)
    const store = new MobileStore(dataDir)
    let tempPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'registry:tempWritten') return
        tempPath = path
        expect(readFileSync(path, 'utf8')).toBe('[]')
        throw new Error('injected')
      }
    })

    expectResetError(
      store,
      'write_failed',
      'write_failed: devices.json could not be written (injected); the registry and identity are unchanged'
    )
    expect(store.registryAvailable).toBe(false)
    expect(existsSync(join(dataDir, REGISTRY))).toBe(false)
    expect(readFileSync(join(dataDir, IDENTITY))).toEqual(identityBytes)
    expect(existsSync(tempPath)).toBe(false)
    expectNoTemporaryFiles(dataDir)

    setPairingResetHooksForTests(null)
    store.resetPairing()
    expect(store.registryAvailable).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expect(store.publicKeyB64).toBe(seeded.publicKey)
    expect(store.getOrCreatePending(false).token).toMatch(/^[0-9a-f]{48}$/)
    expectNoTemporaryFiles(dataDir)
  })

  test('reports a committed registry whose directory sync failed without retrying the write', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    corrupt(dataDir, REGISTRY)
    const store = new MobileStore(dataDir)
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint) {
        if (point === 'registry:renamed') throw new Error('injected')
      }
    })

    const result: MobilePairingResetOutcome = store.resetPairing()
    expect(result.unsynced).toEqual([REGISTRY])
    expect(store.registryAvailable).toBe(true)
    expect(store.publicKeyB64).toBe(seeded.publicKey)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expectNoTemporaryFiles(dataDir)
    expectResetError(
      store,
      'pairing_available',
      'pairing_available: the device registry and encryption identity are both available; nothing was reset'
    )
  })

  test('cleans only its own identity temp after an occupied name and retries on the reset registry', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    const quarantinedName = corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    let plantedPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'identity:beforeTempOpen') return
        plantedPath = path
        writeFileSync(path, 'occupied', { flag: 'wx', mode: 0o600 })
      }
    })

    const error = captureResetError(store)
    expect(error.code).toBe('write_failed')
    expect(error.message.startsWith('write_failed: e2ee-keypair.json could not be written (EEXIST')).toBe(true)
    expect(error.message.endsWith('; the device registry was reset, so run reset-pairing again')).toBe(true)
    expect(error.registryReset).toBe(true)
    expect(store.registryAvailable).toBe(true)
    expect(store.identityAvailable).toBe(false)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    const previousRegistry = resetCopies(dataDir)
    expect(previousRegistry).toHaveLength(1)
    expect(readFileSync(join(dataDir, previousRegistry[0]!), 'utf8')).toBe(seeded.registryBytes)
    expect(existsSync(join(dataDir, IDENTITY))).toBe(false)
    expect(readFileSync(plantedPath, 'utf8')).toBe('occupied')
    expectNoTemporaryFiles(dataDir, plantedPath)

    setPairingResetHooksForTests(null)
    const retry = store.resetPairing()
    expect(retry).toMatchObject({ identityCreated: true, unpairedDevices: 0, previousRegistry: null, quarantined: [quarantinedName] })
    expect(store.getOrCreatePending(false).token).toMatch(/^[0-9a-f]{48}$/)
    expect(readFileSync(plantedPath, 'utf8')).toBe('occupied')
    expectNoTemporaryFiles(dataDir, plantedPath)
  })

  test('closes and removes an opened identity temp after failure, then retries', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    let tempPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'identity:tempOpened') return
        tempPath = path
        expect(existsSync(path)).toBe(true)
        expect(statSync(path).size).toBe(0)
        throw new Error('injected')
      }
    })

    expectResetError(
      store,
      'write_failed',
      'write_failed: e2ee-keypair.json could not be written (injected); the device registry was reset, so run reset-pairing again',
      true
    )
    expect(store.registryAvailable).toBe(true)
    expect(store.identityAvailable).toBe(false)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    const copies = resetCopies(dataDir)
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(dataDir, copies[0]!), 'utf8')).toBe(seeded.registryBytes)
    expect(existsSync(join(dataDir, IDENTITY))).toBe(false)
    expect(existsSync(tempPath)).toBe(false)
    expectNoTemporaryFiles(dataDir)

    setPairingResetHooksForTests(null)
    expect(store.resetPairing()).toMatchObject({ identityCreated: true, unpairedDevices: 0, previousRegistry: null })
    expect(store.getOrCreatePending(false).token).toMatch(/^[0-9a-f]{48}$/)
    expectNoTemporaryFiles(dataDir)
  })

  test('removes a closed identity temp after failure, then retries', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    let tempPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'identity:tempWritten') return
        tempPath = path
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ v: 1 })
        throw new Error('injected')
      }
    })

    expectResetError(
      store,
      'write_failed',
      'write_failed: e2ee-keypair.json could not be written (injected); the device registry was reset, so run reset-pairing again',
      true
    )
    expect(store.registryAvailable).toBe(true)
    expect(store.identityAvailable).toBe(false)
    expect(existsSync(join(dataDir, IDENTITY))).toBe(false)
    const copies = resetCopies(dataDir)
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(dataDir, copies[0]!), 'utf8')).toBe(seeded.registryBytes)
    expect(existsSync(tempPath)).toBe(false)
    expectNoTemporaryFiles(dataDir)

    setPairingResetHooksForTests(null)
    store.resetPairing()
    expect(store.identityAvailable).toBe(true)
    expect(store.getOrCreatePending(false).token).toMatch(/^[0-9a-f]{48}$/)
    expectNoTemporaryFiles(dataDir)
  })

  test('reports a committed identity whose directory sync failed and loads that identity after restart', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint) {
        if (point === 'identity:renamed') throw new Error('injected')
      }
    })

    const result: MobilePairingResetOutcome = store.resetPairing()
    expect(result.identityCreated).toBe(true)
    expect(result.unsynced).toEqual([IDENTITY])
    expect(store.publicKeyB64).not.toBe(seeded.publicKey)
    expect(JSON.parse(readFileSync(join(dataDir, IDENTITY), 'utf8')).publicKeyB64).toBe(store.publicKeyB64)
    const restarted = new MobileStore(dataDir)
    expect(restarted.identityAvailable).toBe(true)
    expect(restarted.publicKeyB64).toBe(store.publicKeyB64)
    expectNoTemporaryFiles(dataDir)
  })

  test('preserves an occupied registry-copy name and retries with another copy name', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    let occupiedPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'copy:beforeOpen') return
        occupiedPath = path
        writeFileSync(path, 'occupied', { flag: 'wx', mode: 0o600 })
      }
    })

    const error = captureResetError(store)
    expect(error.code).toBe('write_failed')
    expect(error.message.startsWith('write_failed: devices.json.reset- copy could not be written (EEXIST')).toBe(true)
    expect(error.message.endsWith('); nothing was reset')).toBe(true)
    expect(error.registryReset).toBe(false)
    expect(readFileSync(occupiedPath, 'utf8')).toBe('occupied')
    expect(readFileSync(join(dataDir, REGISTRY), 'utf8')).toBe(seeded.registryBytes)
    expect(existsSync(join(dataDir, IDENTITY))).toBe(false)
    expectNoTemporaryFiles(dataDir)

    setPairingResetHooksForTests(null)
    const retry = store.resetPairing()
    expect(retry.previousRegistry).not.toBeNull()
    expect(retry.previousRegistry).not.toBe(basename(occupiedPath))
    expect(readFileSync(occupiedPath, 'utf8')).toBe('occupied')
    expect(readFileSync(join(dataDir, retry.previousRegistry!), 'utf8')).toBe(seeded.registryBytes)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expectNoTemporaryFiles(dataDir)
  })

  test('removes a registry copy it created when the copy hook fails, then retries', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    let failedPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'copy:created') return
        failedPath = path
        expect(existsSync(path)).toBe(true)
        expect(readFileSync(path, 'utf8')).toBe('')
        throw new Error('injected')
      }
    })

    expectResetError(
      store,
      'write_failed',
      'write_failed: devices.json.reset- copy could not be written (injected); nothing was reset'
    )
    expect(readFileSync(join(dataDir, REGISTRY), 'utf8')).toBe(seeded.registryBytes)
    expect(existsSync(join(dataDir, IDENTITY))).toBe(false)
    expect(existsSync(failedPath)).toBe(false)
    expect(resetCopies(dataDir)).toEqual([])
    expectNoTemporaryFiles(dataDir)

    setPairingResetHooksForTests(null)
    const retry = store.resetPairing()
    expect(retry.previousRegistry).not.toBeNull()
    expect(retry.previousRegistry).not.toBe(basename(failedPath))
    expect(readFileSync(join(dataDir, retry.previousRegistry!), 'utf8')).toBe(seeded.registryBytes)
    expectNoTemporaryFiles(dataDir)
  })

  test('reports a registry copy committed before its directory sync failed', () => {
    const dataDir = temporaryDataDir()
    const seeded = seed(dataDir)
    corrupt(dataDir, IDENTITY)
    const store = new MobileStore(dataDir)
    let copyPath = ''
    setPairingResetHooksForTests({
      at(point: MobilePairingResetHookPoint, path) {
        if (point !== 'copy:written') return
        copyPath = path
        expect(readFileSync(path, 'utf8')).toBe(seeded.registryBytes)
        throw new Error('injected')
      }
    })

    const result = store.resetPairing()
    expect(result.previousRegistry).toBe(basename(copyPath))
    expect(result.unsynced).toEqual([basename(copyPath)])
    expect(readFileSync(copyPath, 'utf8')).toBe(seeded.registryBytes)
    expect(mode(copyPath)).toBe(0o600)
    expect(store.registryAvailable).toBe(true)
    expect(store.identityAvailable).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, REGISTRY), 'utf8'))).toEqual([])
    expectNoTemporaryFiles(dataDir)
  })
})

describe('owner grant revoke all', () => {
  test('revokes two owner grants in one write', () => {
    const dataDir = temporaryDataDir()
    const store = new OwnerGrantStore(dataDir)
    store.create('First owner', 'ws://127.0.0.1:1')
    store.create('Second owner', 'ws://127.0.0.1:2')

    expect(store.revokeAll()).toBe(2)
    expect(JSON.parse(readFileSync(join(dataDir, OWNER_GRANTS), 'utf8'))).toEqual({ version: 1, grants: [] })
    expect(store.grants()).toEqual([])
  })

  test('does not write when no owner grants remain', () => {
    const dataDir = temporaryDataDir()
    const store = new OwnerGrantStore(dataDir)
    const grant = store.create('Owner', 'ws://127.0.0.1:1')
    expect(store.revoke(grant.grantId)).toBe(true)
    const path = join(dataDir, OWNER_GRANTS)
    const bytes = readFileSync(path)
    const mtime = statSync(path, { bigint: true }).mtimeNs

    expect(store.revokeAll()).toBe(0)
    expect(store.grants()).toEqual([])
    expect(readFileSync(path)).toEqual(bytes)
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(mtime)
  })

  test('refuses to revoke all grants from an unavailable owner store', () => {
    const dataDir = temporaryDataDir()
    mkdirSync(join(dataDir, OWNER_GRANTS))
    const store = new OwnerGrantStore(dataDir)

    expect(store.registryAvailable).toBe(false)
    expect(() => store.revokeAll()).toThrow('Owner grant registry is unavailable')
  })

  test('leaves the on-disk grant in place when owner revocation fails before rename', () => {
    const dataDir = temporaryDataDir()
    const store = new OwnerGrantStore(dataDir)
    const grant = store.create('Owner', 'ws://127.0.0.1:1')
    const path = join(dataDir, OWNER_GRANTS)
    const originalBytes = readFileSync(path)
    setOwnerGrantWriteHooksForTests({ beforeRename: () => { throw new Error('injected') } })

    expect(() => store.revokeAll()).toThrow('Owner grant registry is unavailable')
    expect(store.registryAvailable).toBe(false)
    expect(readFileSync(path)).toEqual(originalBytes)
    expect((JSON.parse(readFileSync(path, 'utf8')) as { grants: { grantId: string }[] }).grants.map((entry) => entry.grantId)).toEqual([grant.grantId])
    expect(new OwnerGrantStore(dataDir).grants().map((entry) => entry.grantId)).toEqual([grant.grantId])
  })

  test('keeps the committed empty owner registry when revocation fails after rename', () => {
    const dataDir = temporaryDataDir()
    const store = new OwnerGrantStore(dataDir)
    store.create('Owner', 'ws://127.0.0.1:1')
    const path = join(dataDir, OWNER_GRANTS)
    setOwnerGrantWriteHooksForTests({ afterRename: () => { throw new Error('injected') } })

    expect(() => store.revokeAll()).toThrow('Owner grant registry is unavailable')
    expect(store.registryAvailable).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, grants: [] })
    expect(new OwnerGrantStore(dataDir).grants()).toEqual([])
  })
})
