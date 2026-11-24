import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getManagedQuirkydFenceEnvironmentId } from '../../shared/managed-quirkyd-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  listQuirkydMigrationSourceCutovers,
  quirkydMigrationCutoverJournalDirectory
} from './quirkyd-migration-cutover-journal'
import {
  fenceQuirkydMigrationSource,
  resolveQuirkydMigrationFence
} from './quirkyd-migration-source-fence'
import type { QuirkydMigrationTerminalVerdict } from './quirkyd-migration-terminal-gate'
import { SshTargetQuirkydClaims } from './targets/ssh-target-quirkyd-claims'
import { createQuirkydMigrationManifest } from './quirkyd-migration-manifest-export'
import { MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES } from '../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}
const exited: QuirkydMigrationTerminalVerdict = { verdict: 'exited', provenPtyIds: [] }

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function setup(displayName = 'App') {
  const userDataPath = mkdtempSync(join(tmpdir(), 'quirkyd-migration-fence-'))
  directories.push(userDataPath)
  const dataFile = join(userDataPath, 'quirky-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  const claims = new SshTargetQuirkydClaims(store)
  const fence = (overrides: Partial<Parameters<typeof fenceQuirkydMigrationSource>[0]> = {}) =>
    fenceQuirkydMigrationSource({
      userDataPath,
      store,
      claims,
      targetId: TARGET.id,
      destinationEnvironmentId: 'env-1',
      destinationName: 'Managed',
      terminalProof: exited,
      ...overrides
    })
  const target = () => store.getSshTarget(TARGET.id)!
  return { userDataPath, dataFile, store, claims, fence, target }
}

describe('migration source fence', () => {
  it('journals, then fences, then flushes, all before returning', async () => {
    const harness = setup()
    const order: string[] = []
    const journalWrite = vi
      .spyOn(harness.claims, 'fenceForMigration')
      .mockImplementation((...args) => {
        order.push(
          listQuirkydMigrationSourceCutovers(harness.userDataPath).length ? 'journal' : 'none'
        )
        order.push('fence')
        return SshTargetQuirkydClaims.prototype.fenceForMigration.apply(harness.claims, args)
      })
    const flush = vi.spyOn(harness.claims, 'flush').mockImplementation(async () => {
      order.push(harness.target().quirkydFence ? 'flush-after-fence' : 'flush-before-fence')
    })
    const result = await harness.fence()
    expect(result).toMatchObject({ outcome: 'fenced', resumed: false })
    expect(order).toEqual(['journal', 'fence', 'flush-after-fence'])
    expect(getManagedQuirkydFenceEnvironmentId(harness.target())).toBe('env-1')
    journalWrite.mockRestore()
    flush.mockRestore()
  })

  it('keeps the journal out of the profile, where an older build would strip it', async () => {
    const harness = setup()
    const result = await harness.fence()
    if (result.outcome !== 'fenced') {
      throw new Error('expected a fence')
    }
    await harness.store.flushPendingOrThrowAsync()
    const journalDirectory = quirkydMigrationCutoverJournalDirectory(harness.userDataPath)
    const profileFiles = readdirSync(harness.userDataPath, { recursive: true, encoding: 'utf8' })
      .map((name) => join(harness.userDataPath, name))
      .filter((path) => !path.startsWith(journalDirectory) && statSync(path).isFile())
    expect(profileFiles.length).toBeGreaterThan(0)
    for (const path of profileFiles) {
      expect(readFileSync(path).includes(result.cutover.migrationId)).toBe(false)
    }
    const [onDisk] = listQuirkydMigrationSourceCutovers(harness.userDataPath)
    expect(onDisk).toMatchObject({ phase: 'source-fenced', sshTargetGeneration: 2 })
    expect(onDisk?.manifest.payload.repositories.map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('resumes the same migration instead of starting a second one', async () => {
    const harness = setup()
    const first = await harness.fence()
    const second = await harness.fence({
      terminalProof: { verdict: 'live', ptyIds: ['p'], reason: 'x' }
    })
    expect(second).toMatchObject({ outcome: 'fenced', resumed: true })
    expect(
      first.outcome === 'fenced' && second.outcome === 'fenced' && second.cutover.migrationId
    ).toBe(first.outcome === 'fenced' && first.cutover.migrationId)
    expect(listQuirkydMigrationSourceCutovers(harness.userDataPath)).toHaveLength(1)
  })

  it('treats a fence whose journal was lost as unverifiable and never releases it', async () => {
    const harness = setup()
    await harness.fence()
    rmSync(quirkydMigrationCutoverJournalDirectory(harness.userDataPath), { recursive: true })
    expect(resolveQuirkydMigrationFence(harness.userDataPath, harness.target())).toEqual({
      state: 'fenced-unverifiable',
      environmentId: 'env-1'
    })
    await expect(harness.fence()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'quirkyd_migration_fenced_unverifiable'
    })
    expect(getManagedQuirkydFenceEnvironmentId(harness.target())).toBe('env-1')
  })

  it('treats a journal whose fence an older build removed as stale, granting nothing', async () => {
    const harness = setup()
    await harness.fence()
    harness.store.updateSshTarget(TARGET.id, { quirkydFence: undefined })
    expect(resolveQuirkydMigrationFence(harness.userDataPath, harness.target()).state).toBe(
      'stale-journal'
    )
    await expect(harness.fence()).resolves.toMatchObject({
      code: 'quirkyd_migration_stale_journal'
    })
  })

  it('fails closed on an unreadable journal', async () => {
    const harness = setup()
    await harness.fence()
    const [cutover] = listQuirkydMigrationSourceCutovers(harness.userDataPath)
    writeFileSync(
      join(
        quirkydMigrationCutoverJournalDirectory(harness.userDataPath),
        `${cutover!.migrationId}.json`
      ),
      '{not json'
    )
    expect(() => resolveQuirkydMigrationFence(harness.userDataPath, harness.target())).toThrow(
      'stays fenced'
    )
    await expect(harness.fence()).rejects.toThrow('stays fenced')
  })

  it.each<[QuirkydMigrationTerminalVerdict, string]>([
    [{ verdict: 'live', ptyIds: ['p'], reason: 'terminals run' }, 'live'],
    [{ verdict: 'unverifiable', ptyIds: ['p'], reason: 'relay silent' }, 'unverifiable']
  ])('refuses before fencing when terminals are %j', async (terminalProof, verdict) => {
    const harness = setup()
    await expect(harness.fence({ terminalProof })).resolves.toMatchObject({
      outcome: 'refused',
      verdict
    })
    expect(harness.target().quirkydFence).toBeUndefined()
    expect(listQuirkydMigrationSourceCutovers(harness.userDataPath)).toEqual([])
  })

  it('keeps a blocker it could not read unverifiable, never live', async () => {
    const harness = setup()
    vi.spyOn(harness.store, 'inspectQuirkydMigrationUntransferredDependencies').mockImplementation(
      () => {
        throw new Error('census failed')
      }
    )
    await expect(harness.fence()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'quirkyd_migration_preflight_blocked'
    })
  })

  it('releases its own fence when a terminal appeared before the fence took hold', async () => {
    const harness = setup()
    const flush = vi.spyOn(harness.claims, 'flush').mockImplementation(async () => {
      if (harness.target().quirkydFence) {
        vi.spyOn(harness.store, 'getSshRemotePtyLeases').mockReturnValue([
          { targetId: TARGET.id, ptyId: 'late-pty', state: 'detached', createdAt: 1, updatedAt: 1 }
        ])
      }
    })
    await expect(harness.fence()).resolves.toMatchObject({ outcome: 'refused', verdict: 'live' })
    expect(harness.target().quirkydFence).toBeUndefined()
    expect(listQuirkydMigrationSourceCutovers(harness.userDataPath)).toEqual([])
    flush.mockRestore()
  })

  it('refuses, without a journal or fence, a manifest under the export cap that no request can carry', async () => {
    const probe = setup()
    const baseline = JSON.stringify(
      createQuirkydMigrationManifest(probe.store, probe.target())
    ).length
    // Under the export cap, over the sealed-frame request budget: stage, state and abort all refuse.
    const harness = setup('x'.repeat(MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES - 200 - baseline))
    const manifestBytes = JSON.stringify(
      createQuirkydMigrationManifest(harness.store, harness.target())
    ).length
    expect(manifestBytes).toBeLessThanOrEqual(MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES)

    await expect(harness.fence()).rejects.toThrow(/\(quirkyd_migration_manifest_too_large\)$/)
    expect(listQuirkydMigrationSourceCutovers(harness.userDataPath)).toEqual([])
    expect(harness.target().quirkydFence).toBeUndefined()
  })
})
