import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { SecretStore } from '../../shared/secret-store'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import type { ImportStore } from './apply'
import { deriveOsCryptKey } from '../browser/browser-cookie-key'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'quirky-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const { createProfileStateStore } =
  await import('../persistence/profile-state/profile-state-store-factory')
const { importFromOrcaDev, detectImportFromOrca } = await import('./import-from-orca-dev')
const { default: Database } = await import('../sqlite/sync-database')
const { resolveSecrets } = await import('./secrets-step')
const { canonicalWorktreeIdentity } = await import('../../shared/worktree/identity')

const PRIMARY_PASSWORD = 'primary-keychain-password'
const FALLBACK_PASSWORD = 'fallback-keychain-password'
const COOKIE = 'plaintext-session-cookie-value'
const NOW = new Date('2026-11-24T12:00:00.000Z')

function osCryptStore(password: string): SecretStore {
  const key = deriveOsCryptKey(password)
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
      return Buffer.concat([Buffer.from('v10'), cipher.update(plain, 'utf8'), cipher.final()])
    },
    decryptString: () => {
      throw new Error('source store never decrypts here')
    },
    describeProtectionGap: () => null
  }
}

const quirkyStore: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`QK:${plain}`, 'utf8'),
  decryptString: (cipher) => cipher.toString('utf8').slice(3),
  describeProtectionGap: () => null
}

type Fixture = {
  root: string
  sourceRoot: string
  sourceHome: string
  quirkyDir: string
  userDataPath: string
  homeDir: string
  tempDir: string
}

const roots: string[] = []

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'import-from-orca-test-'))
  roots.push(root)
  const fixture: Fixture = {
    root,
    sourceRoot: join(root, 'source', 'orca'),
    sourceHome: join(root, 'source', 'dot-orca'),
    quirkyDir: join(root, 'quirky'),
    userDataPath: join(root, 'quirky', 'userData'),
    homeDir: join(root, 'quirky', 'home'),
    tempDir: join(root, 'quirky', 'tmp')
  }
  for (const dir of [
    fixture.sourceRoot,
    fixture.sourceHome,
    fixture.userDataPath,
    fixture.homeDir,
    fixture.tempDir
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  return fixture
}

function openStore(directory: string, profileId: string) {
  mkdirSync(directory, { recursive: true })
  return createProfileStateStore({
    dataFile: join(directory, 'state-data.json'),
    databaseFile: join(directory, 'profile-state.db'),
    profileId
  }).store
}

function repoRow(id: string) {
  return { id, path: `/work/${id}`, displayName: id, badgeColor: '#737373', addedAt: 1 }
}

const worktreeOne = 'repo-a::/work/repo-a-wt-one'
const worktreeTwo = 'repo-a::/work/repo-a-wt-two'

function automationInput(name: string) {
  return {
    name,
    prompt: `run ${name}`,
    agentId: 'claude' as const,
    projectId: 'repo-a',
    workspaceMode: 'new_per_run' as const,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: Date.UTC(2026, 0, 1)
  }
}

/** Builds Orca Dev's data folder with the repo's own persistence code. */
function buildSource(
  fixture: Fixture,
  options: { withSecrets?: boolean; settings?: Partial<GlobalSettings> } = {}
) {
  const profileDir = join(fixture.sourceRoot, 'profiles', 'local-default')
  writeFileSync(
    join(fixture.sourceRoot, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeProfileId: 'local-default',
      profiles: [{ id: 'local-default', name: 'Default' }]
    })
  )
  setSecretStore(osCryptStore(PRIMARY_PASSWORD))
  const store = openStore(profileDir, 'local-default')
  store.addRepo(repoRow('repo-a'))
  store.addRepo(repoRow('repo-b'))
  store.setWorktreeMeta({ id: worktreeOne, hostId: 'local' } as never, { displayName: 'one' })
  store.setWorktreeMeta({ id: worktreeTwo, hostId: 'local' } as never, { displayName: 'two' })
  store.createAutomation(automationInput('nightly'))
  store.createAutomation(automationInput('weekly'))
  store.updateSettings({
    theme: 'dark',
    workspaceDir: '/Users/owner/orca/workspaces',
    claudeManagedAccounts: [
      {
        id: 'acc1',
        email: 'owner@example.test',
        managedAuthPath: join(fixture.sourceRoot, 'claude-accounts', 'acc1'),
        authMethod: 'unknown',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    ...(options.withSecrets ? { opencodeSessionCookie: COOKIE } : {}),
    ...options.settings
  })
  store.flushOrThrow()
  store.freezeWrites()
  const checkpoint = new Database(join(profileDir, 'profile-state.db'))
  try {
    checkpoint.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    checkpoint.close()
  }
  mkdirSync(join(fixture.sourceRoot, 'claude-accounts', 'acc1'), { recursive: true })
  writeFileSync(join(fixture.sourceRoot, 'claude-accounts', 'acc1', 'auth.json'), '{"token":"t"}')
  writeFileSync(join(fixture.sourceHome, 'keybindings.json'), '{"bindings":{}}')
  setSecretStore(quirkyStore)
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? [path, ...walk(path)] : [path]
  })
}

function snapshotTree(directory: string) {
  return walk(directory)
    .sort()
    .map((path) => {
      const stat = statSync(path)
      const hash = stat.isFile()
        ? createHash('sha256').update(readFileSync(path)).digest('hex')
        : 'dir'
      return [path, stat.mtimeMs, hash] as const
    })
}

function setReadOnly(directory: string, readOnly: boolean): void {
  const paths = [directory, ...walk(directory)]
  for (const path of readOnly ? paths.toReversed() : paths) {
    chmodSync(
      path,
      statSync(path).isDirectory() ? (readOnly ? 0o500 : 0o700) : readOnly ? 0o400 : 0o600
    )
  }
}

function runImport(
  fixture: Fixture,
  store: ImportStore,
  mode: 'first-run' | 'rerun',
  readKeychainPassword: (service: string, account: string) => Promise<string> = async (service) => {
    if (service === 'orca Safe Storage') {
      return PRIMARY_PASSWORD
    }
    return FALLBACK_PASSWORD
  }
) {
  return importFromOrcaDev(
    { mode },
    {
      sourceRoot: fixture.sourceRoot,
      sourceHome: fixture.sourceHome,
      userDataPath: fixture.userDataPath,
      homeDir: fixture.homeDir,
      tempDir: fixture.tempDir,
      readKeychainPassword,
      safeStorage: quirkyStore,
      store,
      now: () => NOW
    }
  )
}

beforeEach(() => {
  setSecretStore(quirkyStore)
})

afterEach(() => {
  _resetSecretStoreForTests()
  for (const root of roots.splice(0)) {
    try {
      setReadOnly(root, false)
    } catch {
      // the tree may already be gone
    }
    rmSync(root, { recursive: true, force: true })
  }
})

describe('importFromOrcaDev', () => {
  it('SC-6: imports a full source into an empty store with automations paused', async () => {
    const fixture = makeFixture()
    buildSource(fixture, { withSecrets: true })
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    expect(
      detectImportFromOrca({
        sourceRoot: fixture.sourceRoot,
        userDataPath: fixture.userDataPath,
        homeDir: fixture.homeDir,
        store
      })
    ).toEqual({ sourceFound: true, quirkyHasRepos: false, offerFirstRun: true })

    const report = await runImport(fixture, store, 'first-run')

    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.imported).toMatchObject({
      repos: 2,
      worktreeMeta: 2,
      automations: 2,
      settings: 1
    })
    expect(report.keychainItem).toBe('primary')
    expect(
      store
        .getRepos()
        .map((repo) => repo.id)
        .sort()
    ).toEqual(['repo-a', 'repo-b'])
    expect(Object.keys(store.getAllWorktreeMeta()).sort()).toEqual([worktreeOne, worktreeTwo])
    expect(store.listAutomations().map((automation) => automation.enabled)).toEqual([false, false])
    expect(store.getSettings().theme).toBe('dark')
    expect(store.getSettings().workspaceDir).toBe(join(fixture.homeDir, 'quirky', 'workspaces'))
    expect(store.getSettings().claudeManagedAccounts[0].managedAuthPath).toBe(
      join(fixture.userDataPath, 'claude-accounts', 'acc1')
    )
    expect(
      readFileSync(join(fixture.userDataPath, 'claude-accounts', 'acc1', 'auth.json'), 'utf8')
    ).toBe('{"token":"t"}')
    expect(readFileSync(join(fixture.homeDir, '.quirky', 'keybindings.json'), 'utf8')).toBe(
      '{"bindings":{}}'
    )
    const receipt = JSON.parse(
      readFileSync(join(fixture.userDataPath, 'orca-import-receipt.json'), 'utf8')
    )
    expect(receipt.version).toBe(1)
    expect(receipt.runs).toHaveLength(1)
    expect(receipt.runs[0].mode).toBe('first-run')
    expect(receipt.runs[0].imported.repos.sort()).toEqual(['repo-a', 'repo-b'])
    expect(JSON.stringify(receipt)).not.toContain(COOKIE)
    expect(JSON.stringify(report)).not.toContain(COOKIE)
    store.freezeWrites()
  })

  it('secrets: round-trips a v10 value into Quirky sealing without writing plaintext', async () => {
    const fixture = makeFixture()
    buildSource(fixture, { withSecrets: true })
    const quirkyDir = join(fixture.quirkyDir, 'profile')
    const store = openStore(quirkyDir, 'local-default')

    const report = await runImport(fixture, store, 'first-run')

    expect(report.skippedSecrets).toEqual([])
    expect(store.getSettings().opencodeSessionCookie).toBe(COOKIE)
    const exported = store.prepareProfileStateExport().json
    expect(exported).not.toContain(COOKIE)
    expect(exported).toContain(Buffer.from(`QK:${COOKIE}`).toString('base64'))
    store.flushOrThrow()
    for (const file of readdirSync(quirkyDir)) {
      expect(readFileSync(join(quirkyDir, file)).includes(COOKIE)).toBe(false)
    }
    store.freezeWrites()
  })

  it('secrets: a wrong primary password falls back to the second keychain item', async () => {
    const fixture = makeFixture()
    buildSource(fixture, { withSecrets: true })
    setSecretStore(osCryptStore(FALLBACK_PASSWORD))
    const profileDir = join(fixture.sourceRoot, 'profiles', 'local-default')
    rmSync(profileDir, { recursive: true, force: true })
    const store = openStore(profileDir, 'local-default')
    store.updateSettings({ opencodeSessionCookie: COOKIE, theme: 'dark' })
    store.addRepo(repoRow('repo-a'))
    store.flushOrThrow()
    store.freezeWrites()
    const checkpoint = new Database(join(profileDir, 'profile-state.db'))
    checkpoint.pragma('wal_checkpoint(TRUNCATE)')
    checkpoint.close()
    setSecretStore(quirkyStore)
    const target = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    const services: string[] = []

    const report = await runImport(fixture, target, 'first-run', async (service) => {
      services.push(service)
      return service === 'orca Safe Storage' ? 'wrong-password' : FALLBACK_PASSWORD
    })

    expect(services).toEqual(['orca Safe Storage', 'Orca Dev Safe Storage'])
    expect(report.keychainItem).toBe('fallback')
    expect(target.getSettings().opencodeSessionCookie).toBe(COOKIE)
    target.freezeWrites()
  })

  it('secrets: a denied keychain read reports KEYCHAIN_DENIED and still imports the rest', async () => {
    const fixture = makeFixture()
    buildSource(fixture, { withSecrets: true })
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')

    const report = await runImport(fixture, store, 'first-run', async () => {
      throw new Error('user denied')
    })

    expect(report.ok).toBe(true)
    expect(report.errors.map((error) => error.code)).toEqual(['KEYCHAIN_DENIED'])
    expect(report.keychainItem).toBeNull()
    expect(report.skippedSecrets).toEqual(['settings.opencodeSessionCookie'])
    expect(store.getRepos()).toHaveLength(2)
    expect(store.getSettings().opencodeSessionCookie).toBe('')
    store.freezeWrites()
  })

  it('SC-7: a rerun adds a new source repo and does not restore a worktree deleted in Quirky', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    await runImport(fixture, store, 'first-run')

    store.removeWorktreeMeta({ id: worktreeTwo, hostId: 'local' } as never)
    store.removeProjectForHost({ id: 'repo-b' })
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-a'])

    addSourceRepo(fixture, 'repo-c')
    const report = await runImport(fixture, store, 'rerun')

    expect(report.ok).toBe(true)
    expect(report.imported.repos).toBe(1)
    expect(report.imported.projects).toBe(1)
    expect(
      store
        .getRepos()
        .map((repo) => repo.id)
        .sort()
    ).toEqual(['repo-a', 'repo-c'])
    expect(Object.keys(store.getAllWorktreeMeta())).toEqual([worktreeOne])
    expect(store.listAutomations()).toHaveLength(2)
    const receipt = JSON.parse(
      readFileSync(join(fixture.userDataPath, 'orca-import-receipt.json'), 'utf8')
    )
    expect(receipt.runs.map((run: { mode: string }) => run.mode)).toEqual(['first-run', 'rerun'])
    store.freezeWrites()
  })

  it('read-only: never changes a read-only source', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    const sourceTree = join(fixture.root, 'source')
    const before = snapshotTree(sourceTree)
    const filesBefore = walk(sourceTree).sort()
    setReadOnly(sourceTree, true)
    let report
    try {
      report = await runImport(fixture, store, 'first-run')
    } finally {
      setReadOnly(sourceTree, false)
    }

    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(snapshotTree(sourceTree)).toEqual(before)
    expect(walk(sourceTree).sort()).toEqual(filesBefore)
    store.freezeWrites()
  })

  it('rollback: a setter that throws mid-apply leaves nothing from the run behind', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    const failing = Object.assign(Object.create(store), {
      createAutomation: () => {
        throw new Error('setter failed')
      }
    })

    const report = await runImport(fixture, failing, 'first-run')

    expect(report.ok).toBe(false)
    expect(report.errors.map((error) => error.code)).toEqual(['WRITE_FAILED'])
    expect(store.getRepos()).toEqual([])
    expect(store.getAllWorktreeMeta()).toEqual({})
    expect(store.getSettings().theme).not.toBe('dark')
    expect(store.getSettings().claudeManagedAccounts).toEqual([])
    expect(existsSync(join(fixture.userDataPath, 'orca-import-receipt.json'))).toBe(false)
    expect(existsSync(join(fixture.userDataPath, 'claude-accounts'))).toBe(false)
    expect(existsSync(join(fixture.homeDir, '.quirky', 'keybindings.json'))).toBe(false)
    store.freezeWrites()
  })

  it('first import into a used profile keeps its settings and linked accounts', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    const existing = {
      id: 'existing',
      email: 'me@example.test',
      managedAuthPath: join(fixture.userDataPath, 'claude-accounts', 'existing'),
      authMethod: 'unknown' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    store.updateSettings({ theme: 'light', claudeManagedAccounts: [existing] })

    const report = await runImport(fixture, store, 'first-run')

    expect(report.ok).toBe(true)
    expect(store.getSettings().theme).toBe('light')
    expect(store.getSettings().claudeManagedAccounts.map((account) => account.id)).toEqual([
      'existing',
      'acc1'
    ])
    expect(store.getSettings().workspaceDir).toBe(join(fixture.homeDir, 'quirky', 'workspaces'))
    store.freezeWrites()
  })

  it('never brings back Orca terminal defaults, but keeps a theme the owner chose', async () => {
    const fixture = makeFixture()
    buildSource(fixture, {
      settings: {
        terminalThemeDark: 'Ghostty Default Style Dark',
        terminalThemeLight: 'GitHub Light',
        terminalDividerColorDark: '#3f3f46',
        terminalDividerColorLight: '#d4d4d8'
      }
    })
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')

    const report = await runImport(fixture, store, 'first-run')

    expect(report.ok).toBe(true)
    expect(store.getSettings()).toMatchObject({
      terminalThemeDark: 'Quirky Graphite Dark',
      terminalThemeLight: 'GitHub Light',
      terminalDividerColorDark: '#24262c',
      terminalDividerColorLight: '#e3e5ea'
    })
    store.freezeWrites()
  })

  it('a rerun does not restore copied files the owner deleted', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    await runImport(fixture, store, 'first-run')
    rmSync(join(fixture.userDataPath, 'claude-accounts', 'acc1'), { recursive: true })
    rmSync(join(fixture.homeDir, '.quirky', 'keybindings.json'))

    const report = await runImport(fixture, store, 'rerun')

    expect(report.ok).toBe(true)
    expect(report.copiedFiles).toEqual([])
    expect(existsSync(join(fixture.userDataPath, 'claude-accounts', 'acc1'))).toBe(false)
    expect(existsSync(join(fixture.homeDir, '.quirky', 'keybindings.json'))).toBe(false)
    const receipt = JSON.parse(
      readFileSync(join(fixture.userDataPath, 'orca-import-receipt.json'), 'utf8')
    )
    expect(receipt.runs[0].copiedFiles.sort()).toEqual(['claude-accounts/acc1', 'keybindings.json'])
    store.freezeWrites()
  })

  it('secrets: one undecryptable value does not stop the others', async () => {
    const seal = osCryptStore(PRIMARY_PASSWORD).encryptString('plaintext-proxy-value')
    const corrupt = Buffer.concat([Buffer.from('v10'), Buffer.alloc(16, 7)]).toString('base64')
    const run = (password: string) =>
      resolveSecrets({
        source: {
          settings: { opencodeSessionCookie: corrupt, httpProxyUrl: seal.toString('base64') },
          ui: { browserKagiSessionLink: Buffer.from('v10short').toString('base64') }
        },
        sourceHome: join(tmpdir(), 'import-from-orca-no-such-home'),
        quirkyHome: join(tmpdir(), 'import-from-orca-no-such-quirky'),
        alreadyImportedSlots: new Set(),
        readKeychainPassword: () => password,
        safeStorage: quirkyStore
      })

    const good = await run(PRIMARY_PASSWORD)
    expect([...good.plaintext.keys()]).toEqual(['settings.httpProxyUrl'])
    expect(good.skipped.sort()).toEqual([
      'settings.opencodeSessionCookie',
      'ui.browserKagiSessionLink'
    ])
    expect(good.errors).toEqual([])

    const wrong = await run('some-other-password')
    expect(wrong.plaintext.size).toBe(0)
    expect(wrong.errors.map((error) => error.code)).toEqual(['SECRETS_NOT_DECRYPTED'])
  })

  it('identity maps and the ssh generation counter come across', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const profileDir = join(fixture.sourceRoot, 'profiles', 'local-default')
    const source = openStore(profileDir, 'local-default')
    for (let index = 0; index < 3; index += 1) {
      source.allocateSshTargetGeneration()
    }
    const sourceInstanceIds = Object.fromEntries(
      Object.entries(source.getAllWorktreeMeta()).map(([id, meta]) => [id, meta.instanceId])
    )
    source.flushOrThrow()
    source.freezeWrites()
    const checkpoint = new Database(join(profileDir, 'profile-state.db'))
    checkpoint.pragma('wal_checkpoint(TRUNCATE)')
    checkpoint.close()
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')

    const report = await runImport(fixture, store, 'first-run')

    expect(report.ok).toBe(true)
    expect(store.getSshTargetGenerationCounter()).toBe(3)
    const exported = JSON.parse(store.prepareProfileStateExport().json)
    const aliasedKeys = Object.values(exported.worktreeIdentityAliases ?? {}).flat()
    const rows = Object.entries(store.getAllWorktreeMeta())
    expect(rows).toHaveLength(2)
    expect(Object.fromEntries(rows.map(([id, meta]) => [id, meta.instanceId]))).toEqual(
      sourceInstanceIds
    )
    for (const [worktreeId, meta] of rows) {
      expect(aliasedKeys).toContain(
        canonicalWorktreeIdentity({
          worktreeId,
          executionHostId: 'local',
          instanceId: meta.instanceId ?? ''
        })
      )
    }
    store.freezeWrites()
  })

  it('rollback: a failed final flush also restores retired names and workspace lineage', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const profileDir = join(fixture.sourceRoot, 'profiles', 'local-default')
    const source = openStore(profileDir, 'local-default')
    source.mergeRetiredWorktreeNamesForNamespace('ns-1', ['nautilus'])
    source.setWorkspaceLineage({
      childWorkspaceKey: `worktree:${worktreeOne}`,
      parentWorkspaceKey: `worktree:${worktreeTwo}`,
      origin: 'manual',
      capture: { source: 'manual', confidence: 'explicit' },
      createdAt: 1
    } as never)
    source.flushOrThrow()
    source.freezeWrites()
    const checkpoint = new Database(join(profileDir, 'profile-state.db'))
    checkpoint.pragma('wal_checkpoint(TRUNCATE)')
    checkpoint.close()
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    store.mergeRetiredWorktreeNamesForNamespace('ns-1', ['seahorse'])
    const priorNames = store.getRetiredWorktreeNameRegistryForNamespace('ns-1')
    expect(priorNames.names).toEqual(['seahorse'])
    let flushes = 0
    const failing = Object.assign(Object.create(store), {
      flushPendingOrThrowAsync: async () => {
        flushes += 1
        if (flushes === 1) {
          throw new Error('flush failed')
        }
      }
    })

    const report = await runImport(fixture, failing, 'first-run')

    expect(report.errors.map((error) => error.code)).toEqual(['WRITE_FAILED'])
    expect(store.getRetiredWorktreeNameRegistryForNamespace('ns-1')).toEqual(priorNames)
    expect(store.getAllWorkspaceLineage()).toEqual({})
    expect(store.getRepos()).toEqual([])
    store.freezeWrites()
  })

  it('rollback: restores namespaces a capped merge evicted', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const profileDir = join(fixture.sourceRoot, 'profiles', 'local-default')
    const source = openStore(profileDir, 'local-default')
    source.mergeRetiredWorktreeNamesForNamespace('imported-ns', ['nautilus'])
    source.flushOrThrow()
    source.freezeWrites()
    const checkpoint = new Database(join(profileDir, 'profile-state.db'))
    checkpoint.pragma('wal_checkpoint(TRUNCATE)')
    checkpoint.close()
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    // 256 is the namespace registry cap, so the imported namespace evicts the oldest one.
    for (let index = 0; index < 256; index += 1) {
      store.mergeRetiredWorktreeNamesForNamespace(`ns-${index}`, ['seahorse'])
    }
    const before = store.snapshotRetiredWorktreeNamespaceRegistries()
    let flushes = 0
    const failing = Object.assign(Object.create(store), {
      flushPendingOrThrowAsync: async () => {
        flushes += 1
        if (flushes === 1) {
          throw new Error('flush failed')
        }
      }
    })

    const report = await runImport(fixture, failing, 'first-run')

    expect(report.errors.map((error) => error.code)).toEqual(['WRITE_FAILED'])
    expect(store.snapshotRetiredWorktreeNamespaceRegistries()).toEqual(before)
    store.freezeWrites()
  })

  it('imports through the live app store, whose authority rejects synchronous flushes', async () => {
    const fixture = makeFixture()
    buildSource(fixture)
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')
    // mirrors the packaged app's async profile-state authority
    const live = Object.assign(Object.create(store), {
      flushOrThrow: () => {
        throw new Error('Live profile persistence requires an awaited flush')
      }
    })

    const report = await runImport(fixture, live, 'first-run')

    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(store.getRepos().map((repo) => repo.id)).toHaveLength(2)
    store.freezeWrites()
  })

  it('reports SOURCE_MISSING when Orca Dev data is absent', async () => {
    const fixture = makeFixture()
    const store = openStore(join(fixture.quirkyDir, 'profile'), 'local-default')

    const report = await runImport(fixture, store, 'first-run')

    expect(report.ok).toBe(false)
    expect(report.errors.map((error) => error.code)).toEqual(['SOURCE_MISSING'])
    store.freezeWrites()
  })
})

function addSourceRepo(fixture: Fixture, id: string): void {
  const profileDir = join(fixture.sourceRoot, 'profiles', 'local-default')
  setSecretStore(osCryptStore(PRIMARY_PASSWORD))
  const store = openStore(profileDir, 'local-default')
  store.addRepo(repoRow(id))
  store.flushOrThrow()
  store.freezeWrites()
  const checkpoint = new Database(join(profileDir, 'profile-state.db'))
  checkpoint.pragma('wal_checkpoint(TRUNCATE)')
  checkpoint.close()
  setSecretStore(quirkyStore)
}
