import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import { afterEach, describe, expect, test } from 'bun:test'
import { bootReviews } from './support'
import { checksFixtureState, checksGhSource, checksReview } from './checks-fixture'
import { createChecksPollingPolicy, installChecksPolling, type ChecksPollingRuntime, type ChecksPollingTarget } from '../src/checks/ChecksPanel'
import type { JsonRecord } from '../src/contracts'

type ReviewsTestHost = {
  client: QuirkyClient
  worktree: string
  repoPath: string
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  writeState(value: unknown): void
  invocations(): { args: string[]; input: string; env: Record<string, string> }[]
  cleanup(): Promise<void>
}

const hosts: ReviewsTestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})


function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a record')
  return value as Record<string, unknown>
}

async function boot() {
  const host = await bootReviews(checksGhSource, { branch: 'feature' })
  hosts.push(host)
  return host
}

const TEST_ORIGIN = 'https://github.com/test-owner/test-repo.git'

function setOrigin(host: Pick<ReviewsTestHost, 'repoPath'>, remote: string | null): void {
  const args = remote === null ? ['remote', 'remove', 'origin'] : ['remote', 'add', 'origin', remote]
  const result = Bun.spawnSync(['git', '-C', host.repoPath, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`Could not update fixture origin: ${new TextDecoder().decode(result.stderr)}`)
}

function stateOf(value: unknown): Record<string, unknown> {
  const state = asRecord(value)
  return asRecord(state.checks)
}

async function addWorktree(host: ReviewsTestHost, branch: string): Promise<string> {
  const origin = asRecord(await host.client.callAny('quirky.worktree/resolve', { selector: host.worktree }))
  const created = asRecord(await host.client.callAny('quirky.worktree/create', {
    repo: origin.repoId,
    branchName: branch,
    name: branch,
    base: 'main',
    noParent: true,
    setup: 'skip',
    activate: false
  }))
  const worktree = asRecord(created.worktree)
  if (typeof worktree.id !== 'string') throw new Error('worktree was not registered')
  return worktree.id
}

function checksFor(client: QuirkyClient, worktree?: string): Promise<Record<string, unknown>> {
  return client.callAny('quirky.reviews/state', worktree === undefined ? {} : { worktree }).then(stateOf)
}


describe('active-workspace checks', () => {
  test('a confirmed no-review lookup retains exact eligibility and exposes no stale composer context', async () => {
    const host = await boot()
    host.writeState(checksFixtureState())

    const result = asRecord(await host.call('checksRefresh', { worktree: host.worktree, force: true }))
    const checks = stateOf(await host.call('state'))
    const eligibility = asRecord(checks.eligibility)

    expect(result.ok).toBe(true)
    expect(checks.worktree).toBe(host.worktree)
    expect(asRecord(checks.lookup).kind).toBe('no-review')
    expect(eligibility).toMatchObject({ eligible: true, head: 'feature', defaultBase: 'main' })
    expect(eligibility.confirmedAt).toEqual(expect.any(Number))

    await host.call('checksSetHeight', { height: 900 })
    const observed = stateOf(await host.call('state'))
    expect(observed.height).toBe(800)
  }, 30_000)
  test('authentication failure stays unavailable and retains canonical CLI diagnosis instead of opening the composer', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([], { authenticated: false }))

    const result = asRecord(await host.call('checksRefresh', { worktree: host.worktree, force: true }))
    const checks = stateOf(await host.call('state'))
    const eligibility = asRecord(checks.eligibility)
    const diagnostics = asRecord(asRecord(checks.lookup).authDiagnostics ?? eligibility.authDiagnostics)

    expect(result.ok).toBe(false)
    expect(asRecord(checks.lookup).kind).toBe('unavailable')
    expect(eligibility.eligible).toBe(false)
    expect(diagnostics.requiredHostAuthenticated).toBe(false)
    expect(diagnostics.ghAvailable).toBe(true)
  }, 30_000)

  test('a missing origin is neutral, clears stale Checks state, and allows a later normal refresh', async () => {
    const host = await boot()
    host.writeState(checksFixtureState())
    await host.call('checksRefresh', { worktree: host.worktree, force: true })

    const eligible = stateOf(await host.call('state'))
    expect(asRecord(eligible.lookup).kind).toBe('no-review')
    expect(asRecord(eligible.eligibility).eligible).toBe(true)

    setOrigin(host, null)
    const missingOrigin = asRecord(await host.call('checksRefresh', { worktree: host.worktree, force: true }))
    expect(missingOrigin).toMatchObject({
      ok: true,
      worktree: host.worktree,
      kind: 'unsupported',
      reason: 'missing_origin'
    })
    const unsupported = stateOf(await host.call('state'))
    expect(unsupported).toMatchObject({
      loading: false,
      error: null,
      lookup: { kind: 'unsupported', reason: 'missing_origin' },
      eligibility: null,
      review: null,
      checks: null,
      comments: null,
      conflicts: null,
      expandedChecks: [],
      queuedComments: [],
      commentDraft: '',
      titleDraft: null,
      agentDialog: null
    })

    setOrigin(host, TEST_ORIGIN)
    host.writeState(checksFixtureState([{
      ...checksReview(),
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY'
    }], { threads: [{ id: 'PRRT_thread_12', commentId: 77, body: 'Please address this.' }] }))
    const found = asRecord(await host.call('checksRefresh', { worktree: host.worktree }))
    expect(found).toMatchObject({ ok: true, worktree: host.worktree, kind: 'found', number: 12 })

    await host.call('checksSetTitleDraft', { worktree: host.worktree, number: 12, title: 'Keep only while review is available' })
    await host.call('checksSetAgentDialog', {
      surface: 'checks',
      worktree: host.worktree,
      number: 12,
      action: 'fix',
      prompt: 'Fix the failing check.'
    })
    const populated = stateOf(await host.call('state'))
    expect(populated.review).toMatchObject({ number: 12 })
    expect(populated.checks).not.toBeNull()
    expect(populated.comments).not.toBeNull()
    expect(populated.conflicts).not.toBeNull()
    expect(populated.titleDraft).toBe('Keep only while review is available')
    expect(populated.agentDialog).toMatchObject({ action: 'fix', prompt: 'Fix the failing check.' })

    setOrigin(host, null)
    const missingAgain = asRecord(await host.call('checksRefresh', { worktree: host.worktree, force: true }))
    expect(missingAgain).toMatchObject({ ok: true, worktree: host.worktree, kind: 'unsupported', reason: 'missing_origin' })
    const cleared = stateOf(await host.call('state'))
    expect(cleared.generation).toBeGreaterThan(populated.generation as number)
    expect(cleared).toMatchObject({
      loading: false,
      error: null,
      lookup: { kind: 'unsupported', reason: 'missing_origin' },
      eligibility: null,
      review: null,
      checks: null,
      comments: null,
      conflicts: null,
      expandedChecks: [],
      queuedComments: [],
      commentDraft: '',
      titleDraft: null,
      agentDialog: null
    })

    setOrigin(host, TEST_ORIGIN)
    const recovered = asRecord(await host.call('checksRefresh', { worktree: host.worktree }))
    expect(recovered).toMatchObject({ ok: true, worktree: host.worktree, kind: 'found', number: 12 })
    const restored = stateOf(await host.call('state'))
    expect(restored.review).toMatchObject({ number: 12 })
    expect(restored.checks).not.toBeNull()
    expect(restored.comments).not.toBeNull()
  }, 60_000)
  test('title drafts and agent dialog edits stay bound to the canonical active review', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview()]))
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    await host.call('checksRefresh', { worktree: host.worktree, force: true })

    await host.call('checksSetTitleDraft', { worktree: host.worktree, number: 12, title: 'A checked title' })
    await host.call('checksSetAgentDialog', {
      surface: 'checks',
      worktree: host.worktree,
      number: 12,
      action: 'fix',
      prompt: 'Fix the failed build check.'
    })
    const checks = stateOf(await host.call('state'))
    expect(checks).toMatchObject({
      titleDraft: 'A checked title',
      agentDialog: { action: 'fix', prompt: 'Fix the failed build check.', target: { worktree: host.worktree, number: 12 } }
    })
  }, 30_000)

  test('refreshing one worktree neither supersedes nor clears another, while a same-worktree supersede is stale', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')]))
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    const second = await addWorktree(host, 'feature-next')
    await host.call('checksLink', { worktree: second, number: 13 })
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')], {
      delayPullNumber: 12,
      delayMs: 250
    }))

    const initialInvocations = host.invocations().length
    const slow = host.call('checksRefresh', { worktree: host.worktree, force: true })
    // The isolated daemon uses a real delayed gh child so the first workspace's response lands after the second's.
    let oldLookupStarted = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      oldLookupStarted = host.invocations().slice(initialInvocations).some(({ args }) =>
        args.includes('pr') && args.includes('view') && args.includes('12'))
      if (oldLookupStarted) break
      await Bun.sleep(10)
    }
    expect(oldLookupStarted).toBe(true)
    const fresh = asRecord(await host.call('checksRefresh', { worktree: second, force: true }))
    const slowResult = asRecord(await slow)

    expect(fresh.ok).toBe(true)
    expect(slowResult).toMatchObject({ ok: true, kind: 'found', number: 12 })
    expect(slowResult.stale).toBeUndefined()
    expect(asRecord(stateOf(await host.call('state', { worktree: host.worktree })).review)).toMatchObject({ number: 12, headRefName: 'feature' })
    const other = stateOf(await host.call('state', { worktree: second }))
    expect(other.worktree).toBe(second)
    expect(asRecord(other.review)).toMatchObject({ number: 13, headRefName: 'feature-next' })
    expect(other.eligibility).toBeNull()

    const superseded = host.call('checksRefresh', { worktree: host.worktree, force: true })
    for (let attempt = 0; attempt < 100 && (stateOf(await host.call('state', { worktree: host.worktree })).loading !== true); attempt += 1) await Bun.sleep(10)
    const newer = asRecord(await host.call('checksRefresh', { worktree: host.worktree, force: true }))
    expect(asRecord(await superseded)).toMatchObject({ ok: false, stale: true })
    expect(newer).toMatchObject({ ok: true, kind: 'found', number: 12 })
  }, 60_000)

  test('drafts and queued comments on one worktree survive a refresh of another', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')], {
      threads: [{ id: 'PRRT_thread_12', commentId: 77, body: 'Please address this.' }]
    }))
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    const second = await addWorktree(host, 'feature-next')
    await host.call('checksLink', { worktree: second, number: 13 })

    await host.call('checksSetTitleDraft', { worktree: host.worktree, number: 12, title: 'Draft on the first workspace' })
    const generation = (await checksFor(host.client, host.worktree)).generation
    await host.call('detailQueueComment', { surface: 'checks', worktree: host.worktree, number: 12, commentId: 'PRRT_thread_12', queued: true })
    await host.call('detailSetCommentDraft', { surface: 'checks', worktree: host.worktree, number: 12, generation, body: 'Unsent reply', draftVersion: 1 })

    await host.call('checksRefresh', { worktree: second, force: true })

    expect(await checksFor(host.client, host.worktree)).toMatchObject({
      titleDraft: 'Draft on the first workspace',
      queuedComments: ['PRRT_thread_12'],
      commentDraft: 'Unsent reply'
    })
    expect(await checksFor(host.client, second)).toMatchObject({ titleDraft: null, queuedComments: [], commentDraft: '' })
  }, 60_000)

  test('the agent dialog is projected only into its own worktree view', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')]))
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    const second = await addWorktree(host, 'feature-next')
    await host.call('checksLink', { worktree: second, number: 13 })

    await host.call('checksSetAgentDialog', { surface: 'checks', worktree: host.worktree, number: 12, action: 'fix', prompt: 'Fix the failed build check.' })

    expect((await checksFor(host.client, host.worktree)).agentDialog).toMatchObject({ action: 'fix', target: { worktree: host.worktree, number: 12 } })
    expect((await checksFor(host.client, second)).agentDialog).toBeNull()
  }, 60_000)

  test('a state read without a worktree returns the most recently refreshed worktree, and a worktree with no entry reads blank', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')]))
    const second = await addWorktree(host, 'feature-next')
    await host.call('checksLink', { worktree: second, number: 13 })
    expect(await checksFor(host.client)).toMatchObject({ worktree: second })
    expect(await checksFor(host.client, host.worktree)).toMatchObject({ worktree: null, review: null, lookup: null })

    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    expect(await checksFor(host.client)).toMatchObject({ worktree: host.worktree })
    expect(await checksFor(host.client, second)).toMatchObject({ worktree: second })
    expect(await checksFor(host.client)).toMatchObject({ worktree: host.worktree })

    const get = asRecord(await host.client.callAny('quirky.reviews/checksGet', {}))
    expect(asRecord(get.checks).worktree).toBe(host.worktree)
    const named = asRecord(await host.client.callAny('quirky.reviews/checksGet', { worktree: second }))
    expect(asRecord(named.checks)).toMatchObject({ worktree: second, review: { number: 13 } })
  }, 60_000)

  test('Checks entries are capped at 16 and evict the least recently used one', async () => {
    const host = await boot()
    const root = mkdtempSync(join(tmpdir(), 'reviews-lru-'))
    try {
      const folders: string[] = []
      for (let index = 0; index < 17; index += 1) {
        const path = join(root, `folder-${index}`)
        mkdirSync(path)
        const project = asRecord(await host.client.callAny('quirky.repo/add', { path, folder: true }))
        const created = asRecord(await host.client.callAny('quirky.worktree/create', { repo: project.id, name: `folder-${index}` }))
        folders.push(String(asRecord(created.worktree).id))
      }
      for (const id of folders.slice(0, 16)) {
        expect(await host.call('checksRefresh', { worktree: id })).toMatchObject({ ok: true, kind: 'folder' })
      }
      for (const id of folders.slice(0, 16)) expect(await checksFor(host.client, id)).toMatchObject({ worktree: id })

      expect(await checksFor(host.client, folders[0])).toMatchObject({ worktree: folders[0] })
      await host.call('checksRefresh', { worktree: folders[16] })

      expect(await checksFor(host.client, folders[16])).toMatchObject({ worktree: folders[16] })
      expect(await checksFor(host.client, folders[0])).toMatchObject({ worktree: folders[0] })
      expect(await checksFor(host.client, folders[1])).toMatchObject({ worktree: null, lookup: null })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('two windows on different worktrees each refresh once and keep their own review', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')]))
    const secondWorktree = await addWorktree(host, 'feature-next')
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    await host.call('checksLink', { worktree: secondWorktree, number: 13 })

    const windows = await Promise.all([host.connect('ui'), host.connect('ui')])
    const mine = [host.worktree, secondWorktree]
    const refreshes = [0, 0]
    const changes = [0, 0]
    const inFlight = [false, false]
    let running = true
    const refreshFor = async (index: number) => {
      refreshes[index] = (refreshes[index] ?? 0) + 1
      await windows[index]!.callAny('quirky.reviews/checksRefresh', { worktree: mine[index], force: true })
    }
    const reconcile = async (index: number) => {
      if (!running || inFlight[index]) return
      inFlight[index] = true
      try {
        const checks = await checksFor(windows[index]!, mine[index])
        if (running && checks.worktree !== mine[index]) await refreshFor(index)
      } finally {
        inFlight[index] = false
      }
    }
    for (const [index, client] of windows.entries()) {
      await client.callAny('events.subscribe', {})
      client.onEvent((event: QuirkyEvent) => {
        if (event.type !== 'quirky.reviews/changed') return
        changes[index] = (changes[index] ?? 0) + 1
        void reconcile(index)
      })
    }
    try {
      await Promise.all(windows.map(async (_client, index) => {
        inFlight[index] = true
        try { await refreshFor(index) } finally { inFlight[index] = false }
      }))
      await Bun.sleep(2_000)
    } finally {
      running = false
      for (const client of windows) client.close()
    }

    expect(refreshes).toEqual([1, 1])
    for (const count of changes) expect(count).toBeLessThan(30)
    expect(asRecord(await checksFor(host.client, host.worktree)).review).toMatchObject({ number: 12 })
    expect(asRecord(await checksFor(host.client, secondWorktree)).review).toMatchObject({ number: 13 })
  }, 60_000)

  test('unlink suppresses rediscovery and relink restores only the canonical review', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview()]))

    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    await host.call('checksUnlink', { worktree: host.worktree })
    const suppressed = await host.call('state')
    expect(asRecord(asRecord(suppressed).suppressed)[host.worktree]).toMatchObject({ number: 12 })

    const before = host.invocations().length
    const refresh = asRecord(await host.call('checksRefresh', { worktree: host.worktree, force: true }))
    expect(refresh.ok).toBe(true)
    expect(host.invocations()).toHaveLength(before)
    expect(stateOf(await host.call('state')).review).toBeNull()

    await host.call('checksRelink', { worktree: host.worktree })
    await host.call('checksRefresh', { worktree: host.worktree, force: true })
    const restored = stateOf(await host.call('state'))
    expect(asRecord(restored.review)).toMatchObject({ number: 12, provider: 'github' })
    expect(asRecord(asRecord(await host.call('state')).links)[host.worktree]).toMatchObject({ number: 12 })
  }, 30_000)

})

test('hidden and unmounted Checks polling clears candidates and never runs a hidden timer', async () => {
  let now = 100_000
  let visible = true
  let refreshes = 0
  let nextTimer = 0
  const scheduled = new Map<number, { at: number; run: () => void }>()
  const reports: JsonRecord[][] = []
  let visibilityListener = () => {}
  let layoutListener = () => {}
  let connectionListener: (status: 'connected' | 'reconnecting') => void = () => {}
  const target: ChecksPollingTarget = {
    worktree: 'id:wt-one',
    branch: 'feature',
    localHead: 'a'.repeat(40),
    number: 12,
    headOid: 'a'.repeat(40),
    provider: 'github',
    reviewState: 'open',
    checksPresent: true,
    checksRollup: 'pending',
    pending: true,
    signature: 'build:in_progress:',
    fetchedAt: now,
    candidate: { worktree: 'id:wt-one', branch: 'feature', number: 12, headOid: 'a'.repeat(40), active: true }
  }
  const runtime: ChecksPollingRuntime = {
    visible: () => visible,
    subscribeVisibility(listener) {
      visibilityListener = listener
      return () => { visibilityListener = () => {} }
    },
    subscribeLayout(listener) {
      layoutListener = listener
      return () => { layoutListener = () => {} }
    },
    subscribeConnection(listener) {
      connectionListener = listener
      return () => { connectionListener = () => {} }
    },
    async report(candidates) { reports.push(candidates) },
    async refresh() { refreshes += 1; return true },
    async invalidate() {},
    schedule(callback, delayMs) {
      const id = ++nextTimer
      scheduled.set(id, { at: now + delayMs, run: callback })
      return id
    },
    cancel(handle) { if (typeof handle === 'number') scheduled.delete(handle) },
    now: () => now,
    onError() {},
    policy: createChecksPollingPolicy()
  }
  const controller = installChecksPolling(target, runtime)
  expect(scheduled.size).toBe(1)
  expect(reports[reports.length - 1]).toEqual([target.candidate])

  visible = false
  visibilityListener()
  now += 90_000
  for (const [id, timer] of [...scheduled]) {
    if (timer.at <= now) {
      scheduled.delete(id)
      timer.run()
    }
  }
  await Promise.resolve()
  expect(scheduled.size).toBe(0)
  expect(refreshes).toBe(0)
  expect(reports[reports.length - 1]).toEqual([])

  controller.dispose()
  layoutListener()
  connectionListener('reconnecting')
  expect(scheduled.size).toBe(0)
  expect(refreshes).toBe(0)
})
