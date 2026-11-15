import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { PluginActivationDisposer, PluginContext, PluginStore } from '@quirky/protocol'
import { activate } from '../../main'
import { migrations } from '../../src/store'
import * as credentials from '../../src/usage/credentials'

type CredentialRecoveryTestHooks = {
  beforeIdentityCheck?: () => void
  beforeRename?: () => void
}

type RecoveryApi = typeof credentials & {
  recoverCredentialStore(dataDir: string): { quarantinedPath: string } | { diagnostic: string } | null
  setCredentialRecoveryHooksForTests(hooks: CredentialRecoveryTestHooks): void
}

const recovery = credentials as RecoveryApi
const roots: string[] = []
const STORE_NAME = 'usage-credentials.json'
const BROKEN = '{broken'
const isRoot = process.getuid?.() === 0

function dataDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-credentials-recovery-'))
  roots.push(root)
  const dataDir = join(root, 'plugin-data', 'quirky.accounts')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return dataDir
}

function storePath(dataDir: string): string {
  return join(dataDir, STORE_NAME)
}

function writeStore(dataDir: string, contents: string): void {
  writeFileSync(storePath(dataDir), contents, { mode: 0o600 })
}

function corruptNames(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.startsWith(`${STORE_NAME}.corrupt-`))
}

function expectOneCorruptSibling(dataDir: string, contents: string): string {
  const [name] = corruptNames(dataDir)
  expect(corruptNames(dataDir)).toHaveLength(1)
  expect(name).toMatch(/^usage-credentials\.json\.corrupt-\d+-[a-f0-9]{8}$/)
  const path = join(dataDir, name!)
  expect(readFileSync(path, 'utf8')).toBe(contents)
  return path
}

function expectNoCorruptSiblings(dataDir: string): void {
  expect(corruptNames(dataDir)).toEqual([])
}

function expectStatuses(dataDir: string, expected: { configured: boolean; readable: boolean }): void {
  const statuses = credentials.credentialStatuses(dataDir)
  expect(statuses.length).toBeGreaterThan(0)
  expect(statuses.every((status) => status.configured === expected.configured && status.readable === expected.readable)).toBe(true)
}

function installRecoveryHooks(hooks: CredentialRecoveryTestHooks): void {
  recovery.setCredentialRecoveryHooksForTests(hooks)
}

function sqliteStoreFixture(): { database: Database; store: PluginStore } {
  const database = new Database(':memory:')
  const store: PluginStore = {
    version: migrations.length,
    run(sql, ...params) {
      const result = database.query(sql).run(...params as never[])
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: <T>(sql: string, ...params: unknown[]) => (database.query(sql).get(...params as never[]) ?? null) as T | null,
    all: <T>(sql: string, ...params: unknown[]) => database.query(sql).all(...params as never[]) as T[],
    exec: (sql) => database.exec(sql),
    transaction: (work) => database.transaction(work)()
  }
  for (const migration of migrations) {
    if (typeof migration === 'string') database.exec(migration)
    else migration(store)
  }
  return { database, store }
}

function activationFixture(dataDir: string, store: PluginStore, logs: string[]): PluginContext {
  const home = dirname(dirname(dataDir))
  return {
    dataDir,
    home,
    process: {
      run: () => { throw new Error('Unexpected process call during activation') },
      spawn: () => { throw new Error('Unexpected process spawn during activation') }
    },
    call: async () => [],
    emit: () => true,
    log: (message: string) => { logs.push(message) },
    getSetting: () => undefined,
    openStore: () => store,
    provide: () => undefined,
    subscribe: () => () => undefined
  } as unknown as PluginContext
}

afterEach(() => {
  recovery.setCredentialRecoveryHooksForTests?.({})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('usage credential store recovery', () => {
  test('sets aside garbage credentials when reading statuses', () => {
    const dataDir = dataDirectory()
    writeStore(dataDir, BROKEN)

    expectStatuses(dataDir, { configured: false, readable: true })

    expect(existsSync(storePath(dataDir))).toBe(false)
    expectOneCorruptSibling(dataDir, BROKEN)
  })

  test('saves and clears credentials after recovery without disturbing the quarantined bytes', () => {
    const dataDir = dataDirectory()
    writeStore(dataDir, BROKEN)

    expect(credentials.writeStoredCredential(dataDir, 'zcode', 'base-url', 'https://api.z.ai')).toEqual({
      provider: 'zcode', kind: 'base-url', configured: true, readable: true
    })
    expect(credentials.readStoredCredential(dataDir, 'zcode', 'base-url')).toBe('https://api.z.ai')
    expect(credentials.clearStoredCredential(dataDir, 'zcode', 'api-key')).toEqual({
      provider: 'zcode', kind: 'api-key', configured: false, readable: true
    })
    expectOneCorruptSibling(dataDir, BROKEN)
  })

  for (const [label, contents] of [
    ['top-level array', '[]'],
    ['top-level string', '"x"'],
    ['unrecognized root shape', '{"quirkyCorruptStoreSweep":[1]}'],
    ['non-string known credential', '{"zcode":{"api-key":5}}']
  ] as const) {
    test(`sets aside ${label} instead of treating it as empty`, () => {
      const dataDir = dataDirectory()
      writeStore(dataDir, contents)

      expectStatuses(dataDir, { configured: false, readable: true })

      expect(existsSync(storePath(dataDir))).toBe(false)
      expectOneCorruptSibling(dataDir, contents)
    })
  }

  test('preserves unknown provider and kind names when saving a known credential', () => {
    const dataDir = dataDirectory()
    const initial = {
      zcode: { 'api-key': 'known-key', 'future-kind': 'future-value' },
      'future-provider': { x: 'y' }
    }
    writeStore(dataDir, JSON.stringify(initial))

    expect(credentials.readStoredCredential(dataDir, 'zcode', 'api-key')).toBe('known-key')
    expect(credentials.writeStoredCredential(dataDir, 'zcode', 'base-url', 'https://api.z.ai')).toEqual({
      provider: 'zcode', kind: 'base-url', configured: true, readable: true
    })

    expect(JSON.parse(readFileSync(storePath(dataDir), 'utf8'))).toEqual({
      zcode: { 'api-key': 'known-key', 'future-kind': 'future-value', 'base-url': 'https://api.z.ai' },
      'future-provider': { x: 'y' }
    })
    expectNoCorruptSiblings(dataDir)
  })

  test('sets aside an oversized regular file found through its descriptor', () => {
    const dataDir = dataDirectory()
    const oversized = 'x'.repeat(65_537)
    writeStore(dataDir, oversized)

    expectStatuses(dataDir, { configured: false, readable: true })

    expect(existsSync(storePath(dataDir))).toBe(false)
    expectOneCorruptSibling(dataDir, oversized)
  })

  for (const kind of ['valid symlink', 'garbage symlink', 'dangling symlink', 'directory'] as const) {
    test(`does not recover a ${kind} credential store entry`, () => {
      const dataDir = dataDirectory()
      const path = storePath(dataDir)
      const outside = join(dirname(dirname(dataDir)), `outside-${kind.replaceAll(' ', '-')}.json`)
      let outsideContents: string | undefined

      if (kind === 'valid symlink' || kind === 'garbage symlink') {
        outsideContents = kind === 'valid symlink' ? '{"zcode":{"api-key":"outside-key"}}' : BROKEN
        writeFileSync(outside, outsideContents, { mode: 0o600 })
        symlinkSync(outside, path)
      } else if (kind === 'dangling symlink') {
        symlinkSync(outside, path)
      } else {
        mkdirSync(path)
      }

      expectStatuses(dataDir, { configured: false, readable: false })
      expect(() => credentials.writeStoredCredential(dataDir, 'zcode', 'api-key', 'new-key')).toThrow('Credential storage is not readable')
      expectNoCorruptSiblings(dataDir)

      if (kind === 'directory') {
        expect(lstatSync(path).isDirectory()).toBe(true)
      } else {
        expect(lstatSync(path).isSymbolicLink()).toBe(true)
        if (outsideContents !== undefined) expect(readFileSync(outside, 'utf8')).toBe(outsideContents)
        else expect(existsSync(outside)).toBe(false)
      }
    })
  }

  test.skipIf(isRoot)('does not recover a mode-000 credential file or allow a save through it', () => {
    const dataDir = dataDirectory()
    const path = storePath(dataDir)
    writeStore(dataDir, '{"zcode":{"api-key":"private-key"}}')
    chmodSync(path, 0o000)

    try {
      expectStatuses(dataDir, { configured: false, readable: false })
      expect(() => credentials.writeStoredCredential(dataDir, 'zcode', 'api-key', 'new-key')).toThrow('Credential storage is not readable')
      expect(lstatSync(path).mode & 0o777).toBe(0)
      chmodSync(path, 0o600)
      expect(readFileSync(path, 'utf8')).toBe('{"zcode":{"api-key":"private-key"}}')
      expectNoCorruptSiblings(dataDir)
    } finally {
      chmodSync(path, 0o600)
    }
  })

  test.skipIf(isRoot)('fails closed when a corrupt file cannot be renamed out of a read-only data directory', () => {
    const dataDir = dataDirectory()
    const path = storePath(dataDir)
    writeStore(dataDir, BROKEN)
    chmodSync(dataDir, 0o500)

    try {
      expectStatuses(dataDir, { configured: false, readable: false })
      expect(() => credentials.writeStoredCredential(dataDir, 'zcode', 'api-key', 'new-key')).toThrow('Credential storage is not readable')
      expect(readFileSync(path, 'utf8')).toBe(BROKEN)
      expectNoCorruptSiblings(dataDir)
    } finally {
      chmodSync(dataDir, 0o700)
    }
  })

  test('fails closed when the credential file identity changes before its identity check', () => {
    const dataDir = dataDirectory()
    const path = storePath(dataDir)
    const displaced = join(dataDir, 'original-credentials.json')
    const replacement = '{"zcode":{"api-key":"replacement-key"}}'
    writeStore(dataDir, BROKEN)
    installRecoveryHooks({
      beforeIdentityCheck: () => {
        renameSync(path, displaced)
        writeFileSync(path, replacement, { mode: 0o600 })
      }
    })

    expectStatuses(dataDir, { configured: false, readable: false })
    expect(readFileSync(displaced, 'utf8')).toBe(BROKEN)
    expect(readFileSync(path, 'utf8')).toBe(replacement)
    expectNoCorruptSiblings(dataDir)
  })

  test('leaves a swapped-in file at the quarantine sibling when it changes before rename', () => {
    const dataDir = dataDirectory()
    const path = storePath(dataDir)
    const displaced = join(dataDir, 'original-credentials.json')
    const replacement = '{"zcode":{"api-key":"replacement-key"}}'
    writeStore(dataDir, BROKEN)
    installRecoveryHooks({
      beforeRename: () => {
        renameSync(path, displaced)
        writeFileSync(path, replacement, { mode: 0o600 })
      }
    })

    expectStatuses(dataDir, { configured: false, readable: false })
    expect(readFileSync(displaced, 'utf8')).toBe(BROKEN)
    expect(existsSync(path)).toBe(false)
    expectOneCorruptSibling(dataDir, replacement)
  })

  test('returns the quarantined path when recovery repairs garbage credentials', () => {
    const dataDir = dataDirectory()
    writeStore(dataDir, BROKEN)

    const result = recovery.recoverCredentialStore(dataDir)

    expect(result).not.toBeNull()
    if (!result || 'diagnostic' in result) throw new Error('Expected credential recovery to quarantine the corrupt file')
    expect(result.quarantinedPath).toBe(join(dataDir, basename(result.quarantinedPath)))
    expect(readFileSync(result.quarantinedPath, 'utf8')).toBe(BROKEN)
    expect(existsSync(storePath(dataDir))).toBe(false)
  })

  test('eagerly repairs credentials during activation and logs the quarantined sibling using the real store fixture', async () => {
    const dataDir = dataDirectory()
    const path = storePath(dataDir)
    writeStore(dataDir, BROKEN)
    const { database, store } = sqliteStoreFixture()
    const logs: string[] = []
    let dispose: PluginActivationDisposer | undefined

    try {
      dispose = activate(activationFixture(dataDir, store, logs))

      const quarantinedPath = join(dataDir, corruptNames(dataDir)[0]!)
      expect(logs).toEqual([
        `accounts: set aside unreadable usage-credentials.json as ${basename(quarantinedPath)}; saved provider credentials must be entered again`
      ])
      expect(existsSync(path)).toBe(false)
      expect(readFileSync(quarantinedPath, 'utf8')).toBe(BROKEN)
    } finally {
      await dispose?.()
      database.close()
    }
  })

  test('logs a fail-closed recovery diagnostic during activation without moving the replacement', async () => {
    const dataDir = dataDirectory()
    const path = storePath(dataDir)
    const displaced = join(dataDir, 'original-credentials.json')
    const replacement = '{"zcode":{"api-key":"replacement-key"}}'
    writeStore(dataDir, BROKEN)
    installRecoveryHooks({
      beforeIdentityCheck: () => {
        renameSync(path, displaced)
        writeFileSync(path, replacement, { mode: 0o600 })
      }
    })
    const { database, store } = sqliteStoreFixture()
    const logs: string[] = []
    let dispose: PluginActivationDisposer | undefined

    try {
      dispose = activate(activationFixture(dataDir, store, logs))

      expect(logs).toEqual(['accounts: usage-credentials.json changed during recovery; nothing was moved'])
      expect(readFileSync(displaced, 'utf8')).toBe(BROKEN)
      expect(readFileSync(path, 'utf8')).toBe(replacement)
      expectNoCorruptSiblings(dataDir)
    } finally {
      await dispose?.()
      database.close()
    }
  })

  test('leaves a healthy credential store untouched during recovery', () => {
    const dataDir = dataDirectory()
    const contents = '{"zcode":{"base-url":"https://api.z.ai"}}'
    writeStore(dataDir, contents)

    expect(recovery.recoverCredentialStore(dataDir)).toBeNull()
    expect(readFileSync(storePath(dataDir), 'utf8')).toBe(contents)
    expect(credentials.credentialStatuses(dataDir)).toContainEqual({
      provider: 'zcode', kind: 'base-url', configured: true, readable: true
    })
    expectNoCorruptSiblings(dataDir)
  })
})
