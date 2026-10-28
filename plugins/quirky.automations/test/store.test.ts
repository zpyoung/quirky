import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import type { PluginStore } from '@quirky/protocol'
import { AutomationStoreError, createAutomationStore, migrations } from '../store'
import type { AutomationDefinition, AutomationRun, AutomationRunInput, AutomationStore } from '../types'

type Fixture = {
  readonly store: AutomationStore
  reopen(): AutomationStore
  database: PluginStore
  dispose(): void
}
const fixtures: Fixture[] = []

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose()
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'quirky-automations-store-'))
  let opened = openPluginStore({ home, pluginId: 'quirky.automations', migrations, isActive: () => true })
  let store = createAutomationStore(opened.store)
  return {
    home,
    get store() { return store },
    reopen() {
      opened.close()
      opened = openPluginStore({ home, pluginId: 'quirky.automations', migrations, isActive: () => true })
      store = createAutomationStore(opened.store)
      return store
    },
    get database(): PluginStore { return opened.store },
    dispose() {
      opened.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
}

function freshFixture() {
  const item = fixture()
  fixtures.push(item)
  return item
}

function definition(id = 'automation-1', overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id,
    name: 'Repository audit',
    prompt: 'Review the repository.',
    agentId: 'codex',
    projectId: 'project-1',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    baseBranch: null,
    reuseSession: false,
    runContext: { kind: 'workspace-run', projectId: 'project-1' },
    sourceContext: null,
    launchOverrides: null,
    precheck: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 100,
    enabled: true,
    nextRunAt: 86_400_000,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

function createRun(store: AutomationStore, automationId: string, input: {
  trigger?: 'manual' | 'scheduled'
  scheduledFor?: number
  status?: AutomationRun['status']
  now?: number
  error?: string | null
} = {}) {
  const runInput: AutomationRunInput = {
    trigger: input.trigger ?? 'manual',
    scheduledFor: input.scheduledFor ?? input.now ?? 1000,
    now: input.now ?? 1000
  }
  if (input.status !== undefined) runInput.status = input.status
  if (input.error !== undefined) runInput.error = input.error
  return store.createRun(automationId, runInput)
}

function expectStoreError(action: () => unknown, code: AutomationStoreError['code']) {
  try {
    action()
    throw new Error('expected AutomationStoreError')
  } catch (error) {
    expect(error).toBeInstanceOf(AutomationStoreError)
    expect((error as AutomationStoreError).code).toBe(code)
  }
}

describe('automation store persistence and retention', () => {
  test('persists definitions and run state when reopened', () => {
    const { store, reopen } = freshFixture()
    const savedDefinition = store.insert(definition('persisted', { creationKey: 'create-once' }))
    const savedRun = createRun(store, savedDefinition.id, { trigger: 'manual', now: 500 })
    store.claimRun(savedRun.id, 501)

    const reopened = reopen()
    expect(reopened.get('persisted')).toMatchObject({ id: 'persisted', lastRunAt: 501, updatedAt: 501, nextRunAt: 86_400_000 })
    expect(reopened.findByCreationKey('create-once')).toEqual(reopened.get('persisted'))
    expect(reopened.getRun(savedRun.id)).toMatchObject({ id: savedRun.id, status: 'dispatching', startedAt: 501 })
  })

  test('returns the existing definition for a repeated creation key without overwriting it', () => {
    const store = freshFixture().store
    const original = store.insert(definition('original', { creationKey: 'same-request' }))
    const repeated = store.insert(definition('different', { creationKey: 'same-request', name: 'Must not replace' }))
    expect(repeated).toEqual(original)
    expect(store.list()).toEqual([original])
  })

  test('ignores undefined fields in definition updates and allows explicit nullable clears', () => {
    const store = freshFixture().store
    store.insert(definition())
    const updated = store.update('automation-1', { name: undefined, prompt: undefined, sourceContext: { taskId: 'task-1' } })
    expect(updated).toMatchObject({ name: 'Repository audit', prompt: 'Review the repository.', sourceContext: { taskId: 'task-1' } })
    expect(store.update('automation-1', { sourceContext: null }).sourceContext).toBeNull()
  })
  test('normalizes workspace policy on insert and mode changes', () => {
    const store = freshFixture().store
    const existing = store.insert(definition('existing-choice', {
      workspaceMode: 'existing',
      baseBranch: 'feature',
      setupDecision: 'skip'
    }))
    expect(existing).toMatchObject({ workspaceMode: 'existing', baseBranch: null })
    expect(existing.setupDecision).toBeUndefined()

    const newPerRun = store.insert(definition('new-choice', {
      workspaceMode: 'new_per_run',
      workspaceId: 'workspace-1',
      reuseSession: true,
      setupDecision: 'run'
    }))
    expect(newPerRun).toMatchObject({ workspaceMode: 'new_per_run', workspaceId: null, reuseSession: false, setupDecision: 'run' })

    const existingAgain = store.update('new-choice', {
      workspaceMode: 'existing',
      baseBranch: 'release',
      setupDecision: undefined
    })
    expect(existingAgain).toMatchObject({ workspaceMode: 'existing', baseBranch: null })
    expect(existingAgain.setupDecision).toBeUndefined()

    const newAgain = store.update('new-choice', {
      workspaceMode: 'new_per_run',
      workspaceId: 'workspace-2',
      reuseSession: true
    })
    expect(newAgain).toMatchObject({ workspaceMode: 'new_per_run', workspaceId: null, reuseSession: false })
  })

  test('retention breaks equal creation times by scheduled occurrence before run ID', () => {
    const item = freshFixture()
    const { store, database } = item
    store.insert(definition())
    const olderOccurrence = createRun(store, 'automation-1', { status: 'completed', now: 1000, scheduledFor: 100 })
    const newerOccurrence = createRun(store, 'automation-1', { status: 'completed', now: 1000, scheduledFor: 200 })
    // Fixed persisted IDs oppose occurrence order so this exercises the retention boundary deterministically.
    database.run('UPDATE automation_runs SET id = ?, data = ? WHERE id = ?',
      'a-older-occurrence', JSON.stringify({ ...olderOccurrence, id: 'a-older-occurrence' }), olderOccurrence.id)
    database.run('UPDATE automation_runs SET id = ?, data = ? WHERE id = ?',
      'z-newer-occurrence', JSON.stringify({ ...newerOccurrence, id: 'z-newer-occurrence' }), newerOccurrence.id)
    for (let index = 0; index < 99; index++) {
      createRun(store, 'automation-1', { status: 'completed', now: 2000 + index, scheduledFor: 1000 + index })
    }
    expect(store.getRun('a-older-occurrence')).toBeNull()
    expect(store.getRun('z-newer-occurrence')).toMatchObject({ scheduledFor: 200, createdAt: 1000 })
    expect(store.runs('automation-1', 100).runs).toHaveLength(100)
  })

  test('retains the newest 100 final runs and every active run without reusing numbers', () => {
    const store = freshFixture().store
    store.insert(definition())
    for (let index = 0; index < 105; index++) {
      createRun(store, 'automation-1', { trigger: 'manual', status: 'completed', now: index + 1000 })
    }

    const activePending = createRun(store, 'automation-1', { now: 2000 })
    const activeDispatching = createRun(store, 'automation-1', { now: 2001 })
    store.claimRun(activeDispatching.id, 2002)
    const activeDispatched = createRun(store, 'automation-1', { now: 2003 })
    store.claimRun(activeDispatched.id, 2004)
    store.updateRun(activeDispatched.id, { status: 'dispatched' }, 2005)

    let page = store.runs('automation-1', 100)
    let retained = page.runs
    while (page.nextCursor) {
      page = store.runs('automation-1', 100, page.nextCursor)
      retained = retained.concat(page.runs)
    }
    expect(retained).toHaveLength(103)
    expect(retained.filter((run) => run.status === 'completed')).toHaveLength(100)
    expect(retained.map((run) => run.id)).toContain(activePending.id)
    expect(retained.map((run) => run.id)).toContain(activeDispatching.id)
    expect(retained.map((run) => run.id)).toContain(activeDispatched.id)

    const next = createRun(store, 'automation-1', { trigger: 'manual', status: 'completed', now: 2010 })
    expect(next.runNumber).toBe(109)
    expect(store.runs('automation-1', 100).runs).toHaveLength(100)
  })

  test('pruned scheduled occurrences cannot be replayed after restart', () => {
    const item = freshFixture()
    const store = item.store
    store.insert(definition())
    const first = createRun(store, 'automation-1', { trigger: 'scheduled', scheduledFor: 100, status: 'completed', now: 100 })
    for (let index = 0; index < 100; index++) {
      createRun(store, 'automation-1', { trigger: 'scheduled', scheduledFor: 200 + index, status: 'completed', now: 200 + index })
    }
    const reopened = item.reopen()
    expect(reopened.getRun(first.id)).toBeNull()
    expectStoreError(() => createRun(reopened, 'automation-1', {
      trigger: 'scheduled', scheduledFor: 100, status: 'completed', now: 500
    }), 'conflict')
    const next = createRun(reopened, 'automation-1', { trigger: 'scheduled', scheduledFor: 600, now: 600 })
    expect(next.runNumber).toBe(102)
  })

  test('occurrence metadata remains bounded while refusals fold and final history is pruned', () => {
    const { store, database } = freshFixture()
    store.insert(definition())
    const folded = store.foldUnavailable('automation-1', 100, 'Host unavailable', 101)
    for (let index = 1; index <= 200; index++) {
      store.foldUnavailable('automation-1', 100 + index, 'Host unavailable', 101 + index)
    }
    expect(store.getRun(folded.id)?.occurrenceCount).toBe(201)
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_occurrences')?.count).toBeLessThanOrEqual(100)
    for (let index = 0; index < 100; index++) {
      createRun(store, 'automation-1', { trigger: 'scheduled', scheduledFor: 500 + index, status: 'completed', now: 500 + index })
    }
    expect(store.getRun(folded.id)).toBeNull()
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_occurrences')?.count).toBeLessThanOrEqual(100)
    expectStoreError(() => store.foldUnavailable('automation-1', 100, 'Host unavailable', 1000), 'conflict')
  })

  test('creates distinct manual runs at the same instant', () => {
    const store = freshFixture().store
    store.insert(definition())
    const first = createRun(store, 'automation-1', { trigger: 'manual', scheduledFor: 900, now: 900 })
    const second = createRun(store, 'automation-1', { trigger: 'manual', scheduledFor: 900, now: 900 })

    expect(second.id).not.toBe(first.id)
    expect(second.runNumber).toBe(first.runNumber + 1)
    expect(second.scheduledFor).toBe(first.scheduledFor)
  })

  test('orders timestamp ties stably, filters definitions, supports offsets, and rejects invalid cursors', () => {
    const store = freshFixture().store
    store.insert(definition('first'))
    store.insert(definition('second'))
    const firstRuns = [
      createRun(store, 'first', { now: 500 }),
      createRun(store, 'first', { now: 500 }),
      createRun(store, 'first', { now: 400 })
    ]
    createRun(store, 'second', { now: 500 })
    const sorted = store.runs(undefined, 100).runs
    expect(sorted.map((run) => run.id)).toEqual([...sorted].sort((left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id)
    ).map((run) => run.id))

    const firstPage = store.runs(undefined, 2)
    expect(firstPage.runs).toHaveLength(2)
    expect(firstPage.nextCursor).not.toBeNull()
    const secondPage = store.runs(undefined, 2, firstPage.nextCursor ?? undefined)
    expect([...firstPage.runs, ...secondPage.runs].map((run) => run.id)).toEqual(sorted.map((run) => run.id))
    expect(store.runs('first', 100).runs).toHaveLength(firstRuns.length)
    expect(store.runs('first', 1, '1').runs[0]?.id).toBe(store.runs('first', 100).runs[1]?.id)
    expect(store.runs(undefined, 500).runs).toHaveLength(4)
    expect(store.runs(undefined, -10).runs).toHaveLength(1)
    expectStoreError(() => store.runs(undefined, 10, 'not-a-cursor'), 'invalid-params')
  })
})

describe('automation run lifecycle', () => {
  test('claims once, follows the status graph, stamps timestamps once, and permits evidence clearing', () => {
    const store = freshFixture().store
    store.insert(definition())
    const pending = createRun(store, 'automation-1', { trigger: 'manual', now: 1000 })

    const dispatching = store.claimRun(pending.id, 1100)
    expect(dispatching).toMatchObject({ status: 'dispatching', startedAt: 1100 })
    expectStoreError(() => store.claimRun(pending.id, 1200), 'conflict')
    expect(store.getRun(pending.id)).toEqual(dispatching)

    const dispatched = store.updateRun(pending.id, {
      status: 'dispatched',
      workspaceId: 'workspace-2',
      workspaceDisplayName: 'Feature branch',
      sessionId: 'session-1',
      outputSnapshot: { format: 'plain_text', content: 'latest output', capturedAt: 1200, truncated: false }
    }, 1200)
    expect(dispatched).toMatchObject({ status: 'dispatched', startedAt: 1100, dispatchedAt: 1200 })
    const sameState = store.updateRun(pending.id, { status: 'dispatched', sessionId: 'session-2' }, 1250)
    expect(sameState.dispatchedAt).toBe(1200)
    expect(sameState.sessionId).toBe('session-2')

    const completed = store.updateRun(pending.id, {
      status: 'completed',
      workspaceDisplayName: null,
      sessionId: null,
      outputSnapshot: null,
      error: null
    }, 1300)
    expect(completed).toMatchObject({ status: 'completed', completedAt: 1300, workspaceDisplayName: null, sessionId: null, outputSnapshot: null, error: null })
    expectStoreError(() => store.updateRun(pending.id, { status: 'pending' }, 1400), 'conflict')
    expectStoreError(() => store.updateRun(pending.id, { status: 'dispatch_failed' }, 1400), 'conflict')
    expect(store.getRun(pending.id)).toEqual(completed)
    expect(store.get('automation-1')).toMatchObject({ lastRunAt: 1300, updatedAt: 1300, nextRunAt: 86_400_000 })
  })

  test('allows pending refusal but not fabricated success and stamps completion once', () => {
    const store = freshFixture().store
    store.insert(definition())
    const run = createRun(store, 'automation-1', { now: 2000 })
    expectStoreError(() => store.updateRun(run.id, { status: 'completed' }, 2100), 'conflict')
    const skipped = store.updateRun(run.id, { status: 'skipped_precheck', error: 'precheck failed' }, 2200)
    expect(skipped).toMatchObject({ status: 'skipped_precheck', completedAt: 2200, error: 'precheck failed' })
    expect(store.updateRun(run.id, { error: null }, 2300).completedAt).toBe(2200)
  })

  test('caps output snapshots at 256 KiB of UTF-8 without splitting characters', () => {
    const store = freshFixture().store
    store.insert(definition())
    const run = createRun(store, 'automation-1', { now: 3000 })
    const content = '🙂'.repeat(70_000)
    const updated = store.updateRun(run.id, {
      outputSnapshot: { format: 'plain_text', content, capturedAt: 3001, truncated: false }
    }, 3001)
    expect(updated.outputSnapshot?.truncated).toBe(true)
    expect(Buffer.byteLength(updated.outputSnapshot?.content ?? '', 'utf8')).toBeLessThanOrEqual(256 * 1024)
    expect(updated.outputSnapshot?.content.endsWith('🙂')).toBe(true)
  })

  test('rolls nested store writes back with the caller transaction', () => {
    const item = freshFixture()
    expect(() => item.database.transaction(() => {
      item.store.insert(definition('rolled-back'))
      throw new Error('abort')
    })).toThrow('abort')
    expect(item.store.get('rolled-back')).toBeNull()
  })

  test('deleting a definition removes history and occurrence dedupe metadata', () => {
    const store = freshFixture().store
    const saved = store.insert(definition('delete-me', { creationKey: 'delete-key' }))
    const removedRun = createRun(store, saved.id, { trigger: 'scheduled', scheduledFor: 456, now: 456 })
    expect(store.remove(saved.id)).toBe(true)
    expect(store.getRun(removedRun.id)).toBeNull()
    expect(store.runs(saved.id).runs).toEqual([])
    expect(store.findByCreationKey('delete-key')).toBeNull()

    store.insert(definition('delete-me', { creationKey: 'delete-key' }))
    const recreated = createRun(store, 'delete-me', { trigger: 'scheduled', scheduledFor: 456, now: 500 })
    expect(recreated.id).not.toBe(removedRun.id)
    expect(recreated.runNumber).toBe(1)
  })

  test('folds each newest byte-identical scheduled refusal once and advances occurrence time chronologically', () => {
    const store = freshFixture().store
    store.insert(definition())
    const first = store.foldUnavailable('automation-1', 100, 'Host unavailable', 101)
    expect(first).toMatchObject({ status: 'skipped_unavailable', trigger: 'scheduled', occurrenceCount: 1, lastOccurrenceAt: 100 })
    expect(store.foldUnavailable('automation-1', 100, 'Host unavailable', 102)).toEqual(first)
    const folded = store.foldUnavailable('automation-1', 300, 'Host unavailable', 301)
    expect(folded).toMatchObject({ id: first.id, occurrenceCount: 2, lastOccurrenceAt: 300 })
    const outOfOrder = store.foldUnavailable('automation-1', 200, 'Host unavailable', 302)
    expect(outOfOrder).toMatchObject({ id: first.id, occurrenceCount: 3, lastOccurrenceAt: 300 })
    expect(store.get('automation-1')).toMatchObject({ lastRunAt: 302, updatedAt: 302 })

    createRun(store, 'automation-1', { trigger: 'manual', now: 400 })
    const afterNewerRun = store.foldUnavailable('automation-1', 500, 'Host unavailable', 501)
    expect(afterNewerRun.id).not.toBe(first.id)
    expect(afterNewerRun.occurrenceCount).toBe(1)
  })
})
