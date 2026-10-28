import type { QuirkyClient } from '@quirky/protocol'
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { bootReviews } from './support'
import { checksFixtureState, checksGhSource, checksReview } from './checks-fixture'
import { createChecksPollingPolicy, installChecksPolling, type ChecksPollingRuntime, type ChecksPollingTarget } from '../src/checks/ChecksPanel'
import type { JsonRecord } from '../src/contracts'

type ReviewsTestHost = {
  client: QuirkyClient
  worktree: string
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  writeState(value: unknown): void
  readState(): unknown
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

function stateOf(value: unknown): Record<string, unknown> {
  const state = asRecord(value)
  return asRecord(state.checks)
}

function graphqlOperations(host: ReviewsTestHost): string[] {
  return host.invocations().flatMap(({ args, input }) => {
    if (!args.includes('graphql')) return []
    const request = input ? asRecord(JSON.parse(input) as unknown) : {}
    const query = typeof request.query === 'string' ? request.query : ''
    const match = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)
    const operation = query.includes('resolveReviewThread') ? 'resolveReviewThread' : match?.[1]
    return operation ? [operation] : []
  })
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
    await host.call('detailSetAudience', { surface: 'checks', audience: 'bots' })
    await host.call('detailSetGrouping', { surface: 'checks', grouping: 'timeline' })
    const observed = stateOf(await host.call('state'))
    expect(observed).toMatchObject({
      height: 800,
      audience: 'bots',
      grouping: 'timeline'
    })
  }, 30_000)
  test('authentication failure stays unavailable and retains canonical CLI diagnosis instead of opening the composer', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([], { authenticated: false }))

    const result = asRecord(await host.call('checksRefresh', { worktree: host.worktree, force: true }))
    const checks = stateOf(await host.call('state'))
    const eligibility = asRecord(checks.eligibility)
    const diagnostics = asRecord(eligibility.authDiagnostics)

    expect(result.ok).toBe(false)
    expect(asRecord(checks.lookup).kind).toBe('unavailable')
    expect(eligibility.eligible).toBe(false)
    expect(diagnostics.requiredHostAuthenticated).toBe(false)
    expect(diagnostics.ghAvailable).toBe(true)
  }, 30_000)
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

  test('a slower old-worktree refresh cannot overwrite the newer workspace or its eligibility', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')]))
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    const created = asRecord(await host.client.callAny('quirky.worktree/create', {
      branchName: 'feature-next',
      name: 'feature-next',
      base: 'main',
      noParent: true,
      setup: 'skip',
      activate: false
    }))
    const secondWorktree = asRecord(created.worktree)
    if (typeof secondWorktree.id !== 'string') throw new Error('second worktree was not registered')
    await host.call('checksLink', { worktree: secondWorktree.id, number: 13 })
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')], {
      delayPullNumber: 12,
      delayMs: 250
    }))

    const initialInvocations = host.invocations().length
    const stale = host.call('checksRefresh', { worktree: host.worktree, force: true })
    // The isolated daemon uses a real delayed gh child to make the old response arrive after the new one.
    let oldLookupStarted = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      oldLookupStarted = host.invocations().slice(initialInvocations).some(({ args }) =>
        args.includes('pr') && args.includes('view') && args.includes('12'))
      if (oldLookupStarted) break
      await Bun.sleep(10)
    }
    expect(oldLookupStarted).toBe(true)
    const fresh = asRecord(await host.call('checksRefresh', { worktree: secondWorktree.id, force: true }))
    await stale

    const checks = stateOf(await host.call('state'))
    expect(fresh.ok).toBe(true)
    expect(checks.worktree).toBe(secondWorktree.id)
    expect(asRecord(checks.review)).toMatchObject({ number: 13, headRefName: 'feature-next' })
    expect(checks.eligibility).toBeNull()
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

  test('queued comments stay unresolved after failed delivery and resolve only after ready-agent delivery succeeds', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview()], { threads: [{ id: 'thread-1', commentId: 77, body: 'Please fix this.' }] }))
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    await host.call('checksRefresh', { worktree: host.worktree, force: true })
    await host.call('detailQueueComment', { surface: 'checks', commentId: '77', queued: true })
    await host.call('checksSetAgentDialog', { action: 'comments', prompt: 'Resolve the selected review comments.' })

    const bin = process.env.PATH?.split(delimiter)[0]
    if (!bin) throw new Error('isolated agent bin is unavailable')
    const command = join(bin, 'claude')
    const fakeAgent = resolve(import.meta.dir, '../../quirky.agents/test/support/fake-agent.ts')
    writeFileSync(command, `#!/usr/bin/env bun\nimport ${JSON.stringify(fakeAgent)}\n`)
    chmodSync(command, 0o755)
    writeFileSync(`${command}.json`, JSON.stringify({ exitAfterMs: 10, exitCode: 1 }))
    await host.client.callAny('quirky.agents/refresh', {})

    const failed = await host.call('checksLaunchAgent', { worktree: host.worktree, agent: 'claude' })
    expect(asRecord(failed).delivered).toBe(false)
    expect(stateOf(await host.call('state')).queuedComments).toEqual(['77'])
    expect(host.readState()).toMatchObject({ resolvedThreads: [] })
    expect(graphqlOperations(host)).not.toContain('resolveReviewThread')

    writeFileSync(`${command}.json`, JSON.stringify({ steps: [{ afterMs: 1, write: '\u001b[?2004h' }] }))
    const delivered = await host.call('checksLaunchAgent', { worktree: host.worktree, agent: 'claude' })
    expect(asRecord(delivered).delivered).toBe(true)
    expect(host.readState()).toMatchObject({ resolvedThreads: ['thread-1'] })
    expect(stateOf(await host.call('state')).queuedComments).toEqual([])
    expect(graphqlOperations(host)).toContain('resolveReviewThread')
  }, 60_000)
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
