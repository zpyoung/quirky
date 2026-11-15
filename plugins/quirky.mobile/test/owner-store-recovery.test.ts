import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import * as ownerStoreModule from '../src/daemon/owner-store'
import { OwnerGrantStore } from '../src/daemon/owner-store'
import { MobileService } from '../src/daemon/service'

const tempDirs: string[] = []

type RecoveryMetadata = {
  recoveredFrom: string | null
  recoveryDiagnostic: string | null
}

type RecoveryHooks = {
  beforeIdentityCheck?: () => void
  beforeRename?: () => void
}

type RecoveryHookApi = {
  setOwnerGrantRecoveryHooksForTests?: (hooks: RecoveryHooks | null) => void
}

const recoveryHookApi = ownerStoreModule as unknown as RecoveryHookApi

function temporaryDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-owner-recovery-'))
  tempDirs.push(dir)
  return dir
}

function ownerStorePath(dataDir: string): string {
  return join(dataDir, 'owner-grants.json')
}

function corruptSiblings(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => /^owner-grants\.json\.corrupt-\d+-[0-9a-f]{8}$/.test(name))
}

function writeStore(dataDir: string, contents: string): void {
  writeFileSync(ownerStorePath(dataDir), contents, { mode: 0o600 })
  chmodSync(ownerStorePath(dataDir), 0o600)
}

function recoveryMetadata(store: OwnerGrantStore): RecoveryMetadata {
  return store as unknown as RecoveryMetadata
}

function expectQuarantined(dataDir: string, store: OwnerGrantStore, contents: string): void {
  const siblings = corruptSiblings(dataDir)
  expect(siblings).toHaveLength(1)
  const sibling = siblings[0]
  expect(sibling).toMatch(/^owner-grants\.json\.corrupt-\d+-[0-9a-f]{8}$/)
  if (!sibling) return
  const quarantinedPath = join(dataDir, sibling)
  expect(readFileSync(quarantinedPath, 'utf8')).toBe(contents)
  expect(existsSync(ownerStorePath(dataDir))).toBe(false)
  expect(recoveryMetadata(store).recoveredFrom).toBe(quarantinedPath)
  expect(recoveryMetadata(store).recoveryDiagnostic).toBeNull()
}

function expectUnavailable(store: OwnerGrantStore): void {
  expect(store.registryAvailable).toBe(false)
  expect(() => store.grants()).toThrow('Owner grant registry is unavailable')
}

function setRecoveryHooks(hooks: RecoveryHooks): void {
  expect(typeof recoveryHookApi.setOwnerGrantRecoveryHooksForTests).toBe('function')
  recoveryHookApi.setOwnerGrantRecoveryHooksForTests?.(hooks)
}

function makePluginContext(dataDir: string, log: (message: string) => void): PluginContext {
  return { pluginId: 'quirky.mobile', dataDir, log } as unknown as PluginContext
}

afterEach(() => {
  recoveryHookApi.setOwnerGrantRecoveryHooksForTests?.(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mobile owner-grant recovery', () => {
  test('sets malformed version-1 data aside and makes the registry available', () => {
    const dataDir = temporaryDataDir()
    const damaged = '{broken'
    writeStore(dataDir, damaged)

    const store = new OwnerGrantStore(dataDir)

    expect(store.registryAvailable).toBe(true)
    if (!store.registryAvailable) return
    expect(store.grants()).toEqual([])
    expect(recoveryMetadata(store).recoveryDiagnostic).toBeNull()
    expectQuarantined(dataDir, store, damaged)
  })

  test('sets each malformed version-1 shape aside without adopting it', () => {
    const fixtures: { name: string; damaged: (dataDir: string) => string }[] = [
      { name: 'corrupt-store marker', damaged: () => '{"quirkyCorruptStoreSweep":[1]}' },
      { name: 'string version', damaged: () => '{"version":"2","grants":[]}' },
      { name: 'non-array grants', damaged: () => '{"version":1,"grants":{}}' },
      {
        name: 'invalid token',
        damaged: (dataDir) => {
          const grant = new OwnerGrantStore(dataDir).create('Original', 'ws://127.0.0.1:1')
          return JSON.stringify({ version: 1, grants: [{ ...grant, token: 'zz' }] })
        }
      },
      {
        name: 'duplicate token',
        damaged: (dataDir) => {
          const store = new OwnerGrantStore(dataDir)
          const first = store.create('First', 'ws://127.0.0.1:1')
          const second = store.create('Second', 'ws://127.0.0.1:1')
          return JSON.stringify({ version: 1, grants: [first, { ...second, token: first.token }] })
        }
      },
      {
        name: 'truncated valid data',
        damaged: (dataDir) => {
          new OwnerGrantStore(dataDir).create('Original', 'ws://127.0.0.1:1')
          const validBytes = readFileSync(ownerStorePath(dataDir), 'utf8')
          return validBytes.slice(0, Math.floor(validBytes.length / 2))
        }
      }
    ]

    for (const fixture of fixtures) {
      const dataDir = temporaryDataDir()
      const damaged = fixture.damaged(dataDir)
      writeStore(dataDir, damaged)
      const store = new OwnerGrantStore(dataDir)

      expect(store.registryAvailable).toBe(true)
      if (store.registryAvailable) expect(store.grants()).toEqual([])
      expectQuarantined(dataDir, store, damaged)
    }
  })

  test('leaves newer integer formats untouched and unavailable', () => {
    const contents = [
      '{"version":2,"grants":[]}',
      '{"version":7,"anything":true}'
    ]

    for (const value of contents) {
      const dataDir = temporaryDataDir()
      writeStore(dataDir, value)
      const mode = statSync(ownerStorePath(dataDir)).mode & 0o777

      const store = new OwnerGrantStore(dataDir)

      expectUnavailable(store)
      expect(recoveryMetadata(store).recoveredFrom).toBeNull()
      expect(readFileSync(ownerStorePath(dataDir), 'utf8')).toBe(value)
      expect(statSync(ownerStorePath(dataDir)).mode & 0o777).toBe(mode)
      expect(corruptSiblings(dataDir)).toEqual([])
      expect(() => store.create('x', 'ws://127.0.0.1:1')).toThrow('Owner grant registry is unavailable')
      expect(readFileSync(ownerStorePath(dataDir), 'utf8')).toBe(value)
    }
  })

  test('refuses old tokens after corrupt grants are quarantined', () => {
    const dataDir = temporaryDataDir()
    const original = new OwnerGrantStore(dataDir).create('Original', 'ws://127.0.0.1:1')
    const damaged = '{broken'
    writeStore(dataDir, damaged)

    const store = new OwnerGrantStore(dataDir)

    expect(store.registryAvailable).toBe(true)
    expect(store.authenticate(original.token)).toEqual({ status: 'unauthorized' })
    expect(store.isCurrentCredential(original.grantId, original.token)).toBe(false)
    expectQuarantined(dataDir, store, damaged)
  })

  test('allows pairing again after recovery and preserves the quarantined bytes', () => {
    const dataDir = temporaryDataDir()
    const damaged = '{broken'
    writeStore(dataDir, damaged)
    const store = new OwnerGrantStore(dataDir)
    expect(store.registryAvailable).toBe(true)
    if (!store.registryAvailable) return
    const grant = store.create('again', 'ws://127.0.0.1:1')
    const restarted = new OwnerGrantStore(dataDir)

    expect(restarted.grants()).toEqual([{
      grantId: grant.grantId,
      name: 'again',
      endpoint: 'ws://127.0.0.1:1',
      scope: 'owner-cli',
      createdAt: grant.createdAt
    }])
    const quarantinedPath = recoveryMetadata(store).recoveredFrom
    expect(quarantinedPath).toBeDefined()
    if (!quarantinedPath) return
    expect(readFileSync(quarantinedPath, 'utf8')).toBe(damaged)
    expect(corruptSiblings(dataDir)).toEqual([basename(quarantinedPath)])
  })

  test('fails closed when the original file changes before identity validation', () => {
    const dataDir = temporaryDataDir()
    const path = ownerStorePath(dataDir)
    const originalPath = join(dataDir, 'original-owner-grants.json')
    const damaged = '{broken'
    const replacement = '{"version":1,"grants":[]}'
    writeStore(dataDir, damaged)

    setRecoveryHooks({
      beforeIdentityCheck: () => {
        renameSync(path, originalPath)
        writeStore(dataDir, replacement)
      }
    })

    const store = new OwnerGrantStore(dataDir)

    expectUnavailable(store)
    expect(recoveryMetadata(store).recoveredFrom).toBeNull()
    expect(recoveryMetadata(store).recoveryDiagnostic).toBe('owner-grants.json changed during recovery; nothing was moved')
    expect(existsSync(originalPath)).toBe(true)
    if (existsSync(originalPath)) expect(readFileSync(originalPath, 'utf8')).toBe(damaged)
    expect(existsSync(path)).toBe(true)
    if (existsSync(path)) expect(readFileSync(path, 'utf8')).toBe(replacement)
    expect(corruptSiblings(dataDir)).toEqual([])
  })

  test('leaves a swapped-in file at the quarantine path when it changes before rename', () => {
    const dataDir = temporaryDataDir()
    const path = ownerStorePath(dataDir)
    const originalPath = join(dataDir, 'original-owner-grants.json')
    const damaged = '{broken'
    const replacement = '{"version":1,"grants":[]}'
    writeStore(dataDir, damaged)

    setRecoveryHooks({
      beforeRename: () => {
        renameSync(path, originalPath)
        writeStore(dataDir, replacement)
      }
    })

    const store = new OwnerGrantStore(dataDir)

    expectUnavailable(store)
    const siblings = corruptSiblings(dataDir)
    expect(siblings).toHaveLength(1)
    expect(recoveryMetadata(store).recoveryDiagnostic).toBe(`owner-grants.json changed during recovery; a file was set aside as ${siblings[0]}`)
    expect(existsSync(originalPath)).toBe(true)
    if (existsSync(originalPath)) expect(readFileSync(originalPath, 'utf8')).toBe(damaged)
    if (siblings[0]) expect(readFileSync(join(dataDir, siblings[0]), 'utf8')).toBe(replacement)
    expect(existsSync(path)).toBe(false)
  })

  test('rejects non-regular entries without changing them or their outside targets', () => {
    const directoryDataDir = temporaryDataDir()
    const directoryPath = ownerStorePath(directoryDataDir)
    mkdirSync(directoryPath)
    const directoryStore = new OwnerGrantStore(directoryDataDir)
    expectUnavailable(directoryStore)
    expect(recoveryMetadata(directoryStore).recoveredFrom).toBeNull()
    expect(readdirSync(directoryPath)).toEqual([])
    expect(corruptSiblings(directoryDataDir)).toEqual([])

    for (const outsideContents of ['{"version":1,"grants":[]}', '{broken']) {
      const dataDir = temporaryDataDir()
      const outsideDir = temporaryDataDir()
      const outsidePath = ownerStorePath(outsideDir)
      writeStore(outsideDir, outsideContents)
      const path = ownerStorePath(dataDir)
      symlinkSync(outsidePath, path)

      const store = new OwnerGrantStore(dataDir)

      expectUnavailable(store)
      expect(recoveryMetadata(store).recoveredFrom).toBeNull()
      expect(lstatSync(path).isSymbolicLink()).toBe(true)
      expect(readlinkSync(path)).toBe(outsidePath)
      expect(readFileSync(outsidePath, 'utf8')).toBe(outsideContents)
      expect(corruptSiblings(dataDir)).toEqual([])
    }
  })

  test('fails closed without moving garbage when the data directory cannot be renamed in', () => {
    if (process.getuid?.() === 0) return
    const dataDir = temporaryDataDir()
    const damaged = '{broken'
    writeStore(dataDir, damaged)
    chmodSync(dataDir, 0o500)

    try {
      const store = new OwnerGrantStore(dataDir)
      expectUnavailable(store)
      expect(recoveryMetadata(store).recoveredFrom).toBeNull()
      expect(readFileSync(ownerStorePath(dataDir), 'utf8')).toBe(damaged)
      expect(corruptSiblings(dataDir)).toEqual([])
    } finally {
      chmodSync(dataDir, 0o700)
    }
  })

  test('leaves a healthy registry untouched', () => {
    const dataDir = temporaryDataDir()
    const original = new OwnerGrantStore(dataDir).create('Existing', 'ws://127.0.0.1:1')
    const bytes = readFileSync(ownerStorePath(dataDir), 'utf8')

    const store = new OwnerGrantStore(dataDir)

    expect(recoveryMetadata(store).recoveredFrom).toBeNull()
    expect(store.grants()).toEqual([{
      grantId: original.grantId,
      name: original.name,
      endpoint: original.endpoint,
      scope: 'owner-cli',
      createdAt: original.createdAt
    }])
    expect(readFileSync(ownerStorePath(dataDir), 'utf8')).toBe(bytes)
    expect(corruptSiblings(dataDir)).toEqual([])
  })

  test('logs successful owner-grant recovery during mobile service construction', async () => {
    const dataDir = temporaryDataDir()
    writeStore(dataDir, '{broken')
    const messages: string[] = []

    const service = new MobileService(makePluginContext(dataDir, (message) => messages.push(message)), {
      hostValue: '127.0.0.1',
      portValue: '0'
    })

    try {
      const [sibling] = corruptSiblings(dataDir)
      expect(sibling).toBeDefined()
      expect(messages).toContain(`mobile: set aside unreadable owner-grants.json as ${sibling}; paired owner CLIs must pair again`)
    } finally {
      await service.stop()
    }
  })

  test('logs owner-grant recovery diagnostics during mobile service construction', async () => {
    const dataDir = temporaryDataDir()
    const path = ownerStorePath(dataDir)
    const originalPath = join(dataDir, 'original-owner-grants.json')
    writeStore(dataDir, '{broken')
    setRecoveryHooks({
      beforeIdentityCheck: () => {
        renameSync(path, originalPath)
        writeStore(dataDir, '{"version":1,"grants":[]}')
      }
    })
    const messages: string[] = []

    const service = new MobileService(makePluginContext(dataDir, (message) => messages.push(message)), {
      hostValue: '127.0.0.1',
      portValue: '0'
    })

    try {
      expect(messages).toContain('mobile: owner-grants.json changed during recovery; nothing was moved')
      expect(existsSync(originalPath)).toBe(true)
      if (existsSync(originalPath)) expect(readFileSync(originalPath, 'utf8')).toBe('{broken')
      expect(corruptSiblings(dataDir)).toEqual([])
    } finally {
      await service.stop()
    }
  })
})
