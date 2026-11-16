import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { MobileStore } from '../src/daemon/storage'
import { OwnerGrantStore } from '../src/daemon/owner-store'

const homes: string[] = []
const aliases: string[] = []
function temporaryDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-mobile-store-'))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const alias of aliases.splice(0)) rmSync(alias, { force: true })
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const BROKEN = '{broken'
const PAIRING_FILES = ['devices.json', 'e2ee-keypair.json'] as const

function expectUnavailable(store: MobileStore): void {
  expect(store.identityAvailable).toBe(false)
  expect(store.registryAvailable).toBe(false)
  expect(store.publicKeyB64).toBeNull()
  expect(store.secretKey).toBeNull()
}

function expectMissing(path: string): void {
  let error: unknown
  try {
    lstatSync(path)
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ code: 'ENOENT' })
}

function damagedPairingFiles(dataDir: string): void {
  for (const filename of PAIRING_FILES) {
    const path = join(dataDir, filename)
    writeFileSync(path, BROKEN, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
}

function quarantineEntries(dataDir: string): string[] {
  return readdirSync(dataDir)
    .filter((name) => PAIRING_FILES.some((filename) => name.startsWith(`${filename}.corrupt-`)))
    .sort()
}

function expectNoPairingTemporaryFiles(dataDir: string): void {
  expect(readdirSync(dataDir).filter((name) =>
    name.startsWith('.devices.json.tmp-') || name.startsWith('.e2ee-keypair.json.tmp-')
  )).toEqual([])
}

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
  test('keeps both pairing stores unavailable across repeated restarts after quarantine', () => {
    const dataDir = temporaryDataDir()
    const seeded = new MobileStore(dataDir)
    const oldPhone = seeded.getOrCreatePending(false)
    expect(seeded.authenticate(oldPhone.token, 100).status).toBe('paired')
    const oldPhoneId = oldPhone.deviceId
    seeded.dispose()

    const ownerStore = new OwnerGrantStore(dataDir)
    const oldGrant = ownerStore.create('Old owner', 'ws://127.0.0.1:1')
    const ownerBytes = readFileSync(ownerStore.path)
    damagedPairingFiles(dataDir)

    const damaged = new MobileStore(dataDir)
    expectUnavailable(damaged)
    damaged.dispose()
    const quarantined = quarantineEntries(dataDir)
    expect(quarantined).toHaveLength(2)
    expect(quarantined.map((name) => name.slice(0, name.indexOf('.corrupt-'))).sort()).toEqual([...PAIRING_FILES].sort())
    for (const name of quarantined) expect(readFileSync(join(dataDir, name), 'utf8')).toBe(BROKEN)

    for (let restart = 0; restart < 2; restart += 1) {
      const store = new MobileStore(dataDir)
      try {
        expectUnavailable(store)
        expect(() => store.getOrCreatePending(false)).toThrow('Mobile device registry unavailable')
        expect(store.authenticate(oldPhone.token)).toEqual({ status: 'registry_unavailable' })
        expect(store.isCurrentCredential(oldPhoneId, oldPhone.token)).toBe(false)
      } finally {
        store.dispose()
      }
      expectMissing(join(dataDir, 'e2ee-keypair.json'))
      expectMissing(join(dataDir, 'devices.json'))
      expect(quarantineEntries(dataDir)).toEqual(quarantined)
      for (const name of quarantined) expect(readFileSync(join(dataDir, name), 'utf8')).toBe(BROKEN)
      expectNoPairingTemporaryFiles(dataDir)
      expect(readFileSync(ownerStore.path)).toEqual(ownerBytes)
      expect(new OwnerGrantStore(dataDir).authenticate(oldGrant.token)).toEqual({ status: 'paired', grant: oldGrant })
    }
  })

  test('keeps quarantined pairing unavailable without an owner-grants file', () => {
    const dataDir = temporaryDataDir()
    const seeded = new MobileStore(dataDir)
    const pending = seeded.getOrCreatePending(false)
    expect(seeded.authenticate(pending.token, 100).status).toBe('paired')
    seeded.dispose()
    damagedPairingFiles(dataDir)
    const damaged = new MobileStore(dataDir)
    damaged.dispose()

    for (let restart = 0; restart < 2; restart += 1) {
      const store = new MobileStore(dataDir)
      try {
        expectUnavailable(store)
      } finally {
        store.dispose()
      }
      expectMissing(join(dataDir, 'e2ee-keypair.json'))
      expectMissing(join(dataDir, 'devices.json'))
      expectMissing(join(dataDir, 'owner-grants.json'))
    }
  })

  test('still initializes an empty directory with a stable private identity and empty registry', () => {
    const dataDir = temporaryDataDir()
    const first = new MobileStore(dataDir)
    const publicKey = first.publicKeyB64
    expect(first.identityAvailable).toBe(true)
    expect(first.registryAvailable).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'devices.json'), 'utf8'))).toEqual([])
    expect(statSync(join(dataDir, 'e2ee-keypair.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'devices.json')).mode & 0o777).toBe(0o600)
    first.dispose()

    const restarted = new MobileStore(dataDir)
    expect(restarted.publicKeyB64).toBe(publicKey)
    expect(restarted.registryAvailable).toBe(true)
    restarted.dispose()
  })

  test('loads valid pairing files unchanged when exact old quarantine evidence remains', () => {
    const dataDir = temporaryDataDir()
    const seeded = new MobileStore(dataDir)
    const pending = seeded.getOrCreatePending(false)
    expect(seeded.authenticate(pending.token, 100).status).toBe('paired')
    const publicKey = seeded.publicKeyB64
    const records = seeded.devices()
    const identityBytes = readFileSync(join(dataDir, 'e2ee-keypair.json'))
    const registryBytes = readFileSync(join(dataDir, 'devices.json'))
    seeded.dispose()

    const oldEvidence = PAIRING_FILES.map((filename) => `${filename}.corrupt-12345678901234567890-aabbccdd`)
    for (const name of oldEvidence) writeFileSync(join(dataDir, name), 'old evidence')
    const store = new MobileStore(dataDir)
    expect(store.identityAvailable).toBe(true)
    expect(store.registryAvailable).toBe(true)
    expect(store.publicKeyB64).toBe(publicKey)
    expect(store.devices()).toEqual(records)
    expect(readFileSync(join(dataDir, 'e2ee-keypair.json'))).toEqual(identityBytes)
    expect(readFileSync(join(dataDir, 'devices.json'))).toEqual(registryBytes)
    for (const name of oldEvidence) expect(readFileSync(join(dataDir, name), 'utf8')).toBe('old evidence')
    store.dispose()
  })

  test.each([
    ['settings.json.corrupt-1-aabbccdd'],
    ['owner-grants.json.corrupt-1-aabbccdd'],
    ['devices.json.corrupt-x'],
    ['devices.json.corrupt-1-AABBCCDD'],
    ['devices.json.corrupt-1-aabbccd'],
    ['devices.json.corrupt-1-aabbccdde'],
    ['devices.json.corrupt-1-aabbccdd.bak'],
    ['xdevices.json.corrupt-1-aabbccdd'],
    ['.devices.json.corrupt-1-aabbccdd'],
    ['devices.json.corrupt-1-aabbccdd\n']
  ] as const)('does not treat the non-exact quarantine name %j as evidence', (name) => {
    const dataDir = temporaryDataDir()
    writeFileSync(join(dataDir, name), 'not pairing evidence')
    const store = new MobileStore(dataDir)
    expect(store.identityAvailable).toBe(true)
    expect(store.registryAvailable).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'devices.json'), 'utf8'))).toEqual([])
    store.dispose()
  })

  test.each([
    ['devices.json', 'regular file'],
    ['devices.json', 'directory'],
    ['devices.json', 'symlink to regular sibling'],
    ['devices.json', 'dangling symlink'],
    ['e2ee-keypair.json', 'regular file'],
    ['e2ee-keypair.json', 'directory'],
    ['e2ee-keypair.json', 'symlink to regular sibling'],
    ['e2ee-keypair.json', 'dangling symlink']
  ] as const)('treats an exact %s quarantine entry of type %s as blocking evidence', (filename, kind) => {
    const dataDir = temporaryDataDir()
    const marker = `${filename}.corrupt-1-aabbccdd`
    const markerPath = join(dataDir, marker)
    const targetPath = join(dataDir, 'preserved-target')
    if (kind === 'regular file') writeFileSync(markerPath, 'marker bytes')
    else if (kind === 'directory') mkdirSync(markerPath)
    else if (kind === 'symlink to regular sibling') {
      writeFileSync(targetPath, 'target bytes')
      symlinkSync('preserved-target', markerPath)
    } else symlinkSync('missing-target', markerPath)
    const before = readdirSync(dataDir).sort()

    const store = new MobileStore(dataDir)
    try {
      expectUnavailable(store)
    } finally {
      store.dispose()
    }
    expectMissing(join(dataDir, 'e2ee-keypair.json'))
    expectMissing(join(dataDir, 'devices.json'))
    expect(readdirSync(dataDir).sort()).toEqual(before)
    const markerStats = lstatSync(markerPath)
    expect(markerStats.isFile()).toBe(kind === 'regular file')
    expect(markerStats.isDirectory()).toBe(kind === 'directory')
    expect(markerStats.isSymbolicLink()).toBe(kind === 'symlink to regular sibling' || kind === 'dangling symlink')
    if (kind === 'regular file') expect(readFileSync(markerPath, 'utf8')).toBe('marker bytes')
    if (kind === 'symlink to regular sibling') {
      expect(readlinkSync(markerPath)).toBe('preserved-target')
      expect(readFileSync(targetPath, 'utf8')).toBe('target bytes')
    }
    if (kind === 'dangling symlink') expect(readlinkSync(markerPath)).toBe('missing-target')
  })

  test('matches an exact quarantine marker with a 180-digit timestamp', () => {
    const dataDir = temporaryDataDir()
    const marker = `devices.json.corrupt-${'9'.repeat(180)}-aabbccdd`
    writeFileSync(join(dataDir, marker), 'long timestamp marker')
    const store = new MobileStore(dataDir)
    try {
      expectUnavailable(store)
    } finally {
      store.dispose()
    }
    expectMissing(join(dataDir, 'e2ee-keypair.json'))
    expectMissing(join(dataDir, 'devices.json'))
    expect(readFileSync(join(dataDir, marker), 'utf8')).toBe('long timestamp marker')
  })

  test('finds a quarantine marker after 1,100 unrelated directory entries', () => {
    const dataDir = temporaryDataDir()
    for (let index = 0; index < 1_100; index += 1) {
      writeFileSync(join(dataDir, `a-unrelated-${index}.entry`), '')
    }
    const marker = 'e2ee-keypair.json.corrupt-1-aabbccdd'
    writeFileSync(join(dataDir, marker), 'marker bytes')

    const store = new MobileStore(dataDir)
    try {
      expectUnavailable(store)
    } finally {
      store.dispose()
    }
    expect(readdirSync(dataDir)).toHaveLength(1_101)
    expectMissing(join(dataDir, 'e2ee-keypair.json'))
    expectMissing(join(dataDir, 'devices.json'))
    expect(readFileSync(join(dataDir, marker), 'utf8')).toBe('marker bytes')
  })

  test.each(['dot segment', 'trailing slash', 'symlink alias'] as const)(
    'finds exact quarantine evidence when the data directory is expressed as a %s',
    (pathStyle) => {
      const dataDir = temporaryDataDir()
      const marker = join(dataDir, 'devices.json.corrupt-1-aabbccdd')
      writeFileSync(marker, 'marker bytes')
      let storePath: string
      if (pathStyle === 'dot segment') storePath = `${dataDir}/.`
      else if (pathStyle === 'trailing slash') storePath = `${dataDir}/`
      else {
        storePath = `${dataDir}-alias`
        aliases.push(storePath)
        symlinkSync(dataDir, storePath, 'dir')
      }

      const store = new MobileStore(storePath)
      try {
        expectUnavailable(store)
      } finally {
        store.dispose()
      }
      expectMissing(join(dataDir, 'e2ee-keypair.json'))
      expectMissing(join(dataDir, 'devices.json'))
      expect(readFileSync(marker, 'utf8')).toBe('marker bytes')
    }
  )

  test.each(PAIRING_FILES)('one %s marker blocks startup but is insufficient for reset', (filename) => {
    const dataDir = temporaryDataDir()
    const marker = `${filename}.corrupt-1-aabbccdd`
    writeFileSync(join(dataDir, marker), 'marker bytes')
    const store = new MobileStore(dataDir)
    expectUnavailable(store)
    expect(store.pairingResetRefusal()?.code).toBe('not_quarantined')
    expect(() => store.resetPairing()).toThrow('not_quarantined:')
    expectMissing(join(dataDir, 'e2ee-keypair.json'))
    expectMissing(join(dataDir, 'devices.json'))
    expect(readFileSync(join(dataDir, marker), 'utf8')).toBe('marker bytes')
    store.dispose()
  })

  test.each(PAIRING_FILES)('does not overwrite a dangling symlink at %s or create its counterpart', (filename) => {
    const dataDir = temporaryDataDir()
    const path = join(dataDir, filename)
    const counterpart = join(dataDir, filename === 'devices.json' ? 'e2ee-keypair.json' : 'devices.json')
    symlinkSync('missing-pairing-target', path)

    const store = new MobileStore(dataDir)
    try {
      expectUnavailable(store)
    } finally {
      store.dispose()
    }
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path)).toBe('missing-pairing-target')
    expectMissing(counterpart)
  })

  test('fails closed when the quarantine directory scan throws, then initializes after it is restored', () => {
    const dataDir = temporaryDataDir()
    const originalReaddirSync = fs.readdirSync
    const scan = spyOn(fs, 'readdirSync').mockImplementation((path) => {
      if (path === dataDir) throw new Error('injected directory scan failure')
      return originalReaddirSync(path)
    })
    let store: MobileStore
    try {
      store = new MobileStore(dataDir)
    } finally {
      scan.mockRestore()
    }
    expectUnavailable(store!)
    expectMissing(join(dataDir, 'e2ee-keypair.json'))
    expectMissing(join(dataDir, 'devices.json'))

    const recovered = new MobileStore(dataDir)
    expect(recovered.identityAvailable).toBe(true)
    expect(recovered.registryAvailable).toBe(true)
    recovered.dispose()
  })

  test('fails closed when lstat cannot establish pairing-path absence', () => {
    const dataDir = temporaryDataDir()
    const identityPath = join(dataDir, 'e2ee-keypair.json')
    const originalLstatSync = fs.lstatSync
    const inspection = spyOn(fs, 'lstatSync').mockImplementation((path) => {
      if (path === identityPath) throw Object.assign(new Error('injected presence inspection failure'), { code: 'EACCES' })
      return originalLstatSync(path)
    })
    let store: MobileStore
    try {
      store = new MobileStore(dataDir)
    } finally {
      inspection.mockRestore()
    }
    expectUnavailable(store!)
    expectMissing(identityPath)
    expectMissing(join(dataDir, 'devices.json'))

    const recovered = new MobileStore(dataDir)
    expect(recovered.identityAvailable).toBe(true)
    expect(recovered.registryAvailable).toBe(true)
    recovered.dispose()
  })

  test('fails closed when the initial pairing-path presence check throws', () => {
    const dataDir = temporaryDataDir()
    const identityPath = join(dataDir, 'e2ee-keypair.json')
    const originalExistsSync = fs.existsSync
    const inspection = spyOn(fs, 'existsSync').mockImplementation((path) => {
      if (path === identityPath) throw Object.assign(new Error('injected presence check failure'), { code: 'EACCES' })
      return originalExistsSync(path)
    })
    let store: MobileStore
    try {
      store = new MobileStore(dataDir)
    } finally {
      inspection.mockRestore()
    }
    expectUnavailable(store!)
    expectMissing(identityPath)
    expectMissing(join(dataDir, 'devices.json'))
  })
})
