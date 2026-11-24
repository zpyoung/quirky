import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readDataFile,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { legacyLaunchOverrides } from '../../shared/fork-automation-launch-settings/legacy-launch-overrides.test-support'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

describe('automation launch settings persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'quirky-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('normalizes, updates, and clears automation launch overrides', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      launchOverrides: {
        model: ' sonnet ',
        optionValues: { effort: 'high', fastMode: false }
      },
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.launchOverrides).toEqual({
      model: 'sonnet',
      optionValues: { effort: 'high', fastMode: false }
    })
    expect(
      store.updateAutomation(automation.id, {
        launchOverrides: { model: 'opus', optionValues: { effort: 'max' } }
      }).launchOverrides
    ).toEqual({ model: 'opus', optionValues: { effort: 'max' } })

    const cleared = store.updateAutomation(automation.id, { launchOverrides: null })
    expect(Object.hasOwn(cleared, 'launchOverrides')).toBe(false)
    const unrelated = store.updateAutomation(automation.id, { name: 'Renamed' })
    expect(Object.hasOwn(unrelated, 'launchOverrides')).toBe(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness writes automations as an array of plain records.
    const persisted = readDataFile() as { automations: Record<string, unknown>[] }
    expect(Object.hasOwn(persisted.automations[0], 'launchOverrides')).toBe(false)
  })

  it('folds retired launchOverrides.agentArgs from a create into extraAgentArgs', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      extraAgentArgs: '--effort high',
      launchOverrides: legacyLaunchOverrides({ model: 'sonnet', agentArgs: '--add-dir docs' }),
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.extraAgentArgs).toBe('--effort high --add-dir docs')
    expect(automation.launchOverrides).toEqual({ model: 'sonnet' })
  })

  it('folds retired launchOverrides.agentArgs from an update into extraAgentArgs', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const updated = store.updateAutomation(automation.id, {
      launchOverrides: legacyLaunchOverrides({ model: 'opus', agentArgs: '--add-dir docs' })
    })

    expect(updated.extraAgentArgs).toBe('--add-dir docs')
    expect(updated.launchOverrides).toEqual({ model: 'opus' })
  })

  it('migrates a stored launchOverrides.agentArgs without losing it', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      extraAgentArgs: '--effort high',
      launchOverrides: { model: 'sonnet' },
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness writes automations as an array of plain records.
    const persisted = readDataFile() as { automations: Record<string, unknown>[] }
    persisted.automations[0].launchOverrides = { model: 'sonnet', agentArgs: '--add-dir docs' }
    writeDataFile(persisted)
    await closeTestStores()

    const reloaded = await createStore()
    const [migrated] = reloaded.listAutomations()
    expect(migrated.extraAgentArgs).toBe('--effort high --add-dir docs')
    expect(migrated.launchOverrides).toEqual({ model: 'sonnet' })

    const renamed = reloaded.updateAutomation(automation.id, { name: 'Renamed' })
    expect(renamed.extraAgentArgs).toBe('--effort high --add-dir docs')
    expect(renamed.launchOverrides).toEqual({ model: 'sonnet' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness writes automations as an array of plain records.
    const stored = readDataFile() as { automations: Record<string, unknown>[] }
    expect(stored.automations[0].launchOverrides).toEqual({ model: 'sonnet' })
  })

  it('persists automation run launch settings across later status updates', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    expect(run.launchSettings).toBeNull()

    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      launchSettings: {
        agentId: 'claude',
        options: { model: { value: 'sonnet', source: 'explicit' } },
        agentArgs: { value: '--verbose', source: 'inherited' }
      }
    })
    store.updateAutomationRun({ runId: run.id, status: 'completed' })

    expect(store.listAutomationRuns(automation.id)[0].launchSettings).toEqual({
      agentId: 'claude',
      options: { model: { value: 'sonnet', source: 'explicit' } },
      agentArgs: { value: '--verbose', source: 'inherited' }
    })
  })

  it('bounds and sanitizes renderer-supplied run launch settings', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())

    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the payload is deliberately malformed to exercise host-side normalization.
      launchSettings: {
        agentId: 'claude',
        options: {
          model: { value: 'sonnet', source: 'explicit' },
          bogusSource: { value: 'x', source: 'made-up' },
          oversized: { value: 'y'.repeat(600), source: 'explicit' },
          ...Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [`opt${i}`, { value: 'v', source: 'inherited' }])
          )
        },
        agentArgs: { value: 'z'.repeat(5000), source: 'explicit' }
      } as never
    })

    const stored = store.listAutomationRuns(automation.id)[0].launchSettings
    expect(stored?.agentId).toBe('claude')
    expect(Object.keys(stored?.options ?? {}).length).toBeLessThanOrEqual(16)
    expect(stored?.options.bogusSource).toBeUndefined()
    expect(stored?.options.oversized).toEqual({ source: 'explicit' })
    expect(stored?.agentArgs).toBeUndefined()

    // A later status update must not reintroduce the raw value.
    store.updateAutomationRun({ runId: run.id, status: 'completed' })
    expect(store.listAutomationRuns(automation.id)[0].launchSettings?.agentArgs).toBeUndefined()
  })
})
