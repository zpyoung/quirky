import { afterEach, describe, expect, test } from 'bun:test'
import { isRecord } from '../src/pr-data'
import { bootHosting, type HostingTest } from './helpers'

const hosts: HostingTest[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

function state(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected fixture object')
  return value
}

const ghFixture = String.raw`
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const fixture = JSON.parse(readFileSync(join(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', 'state.json'), 'utf8'))
const args = process.argv.slice(2)
const emit = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => { process.stderr.write(message); process.exit(1) }
if (args[0] === 'auth' && args[1] === 'status') {
  if (fixture.authenticated === false) fail('not logged in')
  emit('Logged in to github.com account test-user (keyring)\n')
} else if (args[0] === 'pr' && args[1] === 'list') {
  if (fixture.listFailure) fail(String(fixture.listFailure))
  emit([])
} else if (args[0] === 'pr' && args[1] === 'view') {
  fail('HTTP 404: Not Found')
} else if (args[0] === 'repo' && args[1] === 'view') {
  emit({ nameWithOwner: 'test-owner/test-repo', defaultBranchRef: { name: 'main' }, isFork: false, parent: null })
} else if (args[0] === 'api' && args.includes('rate_limit')) {
  emit({ resources: { core: { limit: 5000, remaining: 4000, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4000, reset: 1999999999 }, search: { limit: 30, remaining: 30, reset: 1999999999 } } })
} else {
  emit({})
}
`

async function host(): Promise<HostingTest> {
  const value = await bootHosting(ghFixture)
  hosts.push(value)
  value.writeState({ authenticated: true })
  return value
}

function candidate(testHost: HostingTest, branch = 'feature') {
  return { worktree: testHost.worktree, branch, active: true }
}

describe('quirky.hosting connection-owned refresh', () => {
  test('GH12 visibility sets union by connection, ignore stale generations, and clean up only the closing owner', async () => {
    const testHost = await host()
    const firstCandidate = candidate(testHost)
    const secondCandidate = candidate(testHost, 'release')
    const second = await testHost.connect('ui')
    const firstResult = state(await testHost.call('visibleRefreshCandidates', { generation: 4, candidates: [firstCandidate] }))
    const secondResult = state(await second.callAny('quirky.hosting/visibleRefreshCandidates', { generation: 2, candidates: [secondCandidate] }))
    expect(firstResult).toMatchObject({ accepted: true, generation: 4, candidates: 1 })
    expect(secondResult).toMatchObject({ accepted: true, generation: 2, candidates: 1 })
    expect(await testHost.call('refreshState')).toMatchObject({ owners: 2, visibleCandidates: 2 })
  
    const stale = state(await testHost.call('visibleRefreshCandidates', { generation: 4, candidates: [] }))
    expect(stale).toMatchObject({ accepted: false, generation: 4, candidates: 1 })
    second.close()
    expect(await testHost.call('refreshState')).toMatchObject({ owners: 1, visibleCandidates: 1 })
    const survivingOwner = state(await testHost.call('visibleRefreshCandidates', { generation: 5, candidates: [firstCandidate] }))
    expect(survivingOwner).toMatchObject({ accepted: true, generation: 5, candidates: 1 })
  
    const reconnected = await testHost.connect('ui')
    const freshGeneration = state(await reconnected.callAny('quirky.hosting/visibleRefreshCandidates', { generation: 0, candidates: [] }))
    expect(freshGeneration).toMatchObject({ accepted: true, generation: 0, candidates: 0 })
    expect(await testHost.call('refreshState')).toMatchObject({ owners: 2, visibleCandidates: 1 })
    reconnected.close()
  }, 20_000)

  test('GH12 refresh methods require a real connection and reject unregistered candidates before GitHub calls', async () => {
    const testHost = await host()
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
    const before = testHost.invocations().length
    const result = await testHost.pluginCall('quirky.hosting/visibleRefreshCandidates', {
      generation: 1,
      candidates: [{ worktree: 'path:/tmp/not-registered', branch: 'feature' }]
    })
    expect(result).toMatchObject({ rejected: true })
    expect(testHost.invocations().slice(before)).toHaveLength(0)
    const invalid = await testHost.call('enqueueRefresh', {
      candidate: { worktree: 'path:/tmp/not-registered', branch: 'feature' },
      reason: 'visible'
    })
    expect(invalid).toMatchObject({ kind: 'skipped', skippedReason: 'validation-denied' })
    expect(testHost.invocations().slice(before)).toHaveLength(0)
    const deniedEvent = events.find((event) =>
      isRecord(event) && event.type === 'quirky.hosting/refresh' && isRecord(event.data) && event.data.skippedReason === 'remote')
    expect(deniedEvent).toMatchObject({
      type: 'quirky.hosting/refresh',
      data: {
        sequence: expect.any(Number),
        reason: 'visible',
        aliases: ['path:/tmp/not-registered'],
        worktreeId: null,
        repoId: null,
        status: 'skipped',
        skippedReason: 'remote'
      }
    })
  }, 20_000)

  test('GH12 manual refresh is immediate, post-push is delayed, and both publish lifecycle events', async () => {
    const testHost = await host()
    const worktrees = await testHost.client.callAny('quirky.worktree/list', {})
    if (!Array.isArray(worktrees)) throw new Error('expected worktree list')
    const registered = worktrees.map(state).find((worktree) => worktree.id === testHost.worktree)
    if (!registered || typeof registered.repoId !== 'string') throw new Error('expected registered repository identity')
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
    const work = candidate(testHost)
  
    const manual = await testHost.call('refresh', { candidate: work, reason: 'manual' })
    expect(manual).toMatchObject({ kind: 'no-review' })
    const queued = await testHost.call('enqueueRefresh', { candidate: work, reason: 'post-push', priority: 100 })
    expect(queued).toMatchObject({ kind: 'queued' })
    const refreshEvents = events.filter((event) => isRecord(event) && event.type === 'quirky.hosting/refresh')
    expect(refreshEvents.length).toBeGreaterThan(0)
    const payloads = refreshEvents.map((event) => state((event as Record<string, unknown>).data))
    const started = payloads.find((event) => event.reason === 'manual' && event.status === 'in-flight')
    expect(structuredClone(started)).toMatchObject({
      sequence: expect.any(Number),
      reason: 'manual',
      aliases: [testHost.worktree],
      worktreeId: testHost.worktree,
      repoId: registered.repoId,
      status: 'in-flight',
      requestStartedAt: expect.any(Number)
    })
    const completed = payloads.find((event) => event.reason === 'manual' && 'outcome' in event)
    expect(completed).toMatchObject({
      reason: 'manual',
      aliases: [testHost.worktree],
      worktreeId: testHost.worktree,
      repoId: registered.repoId,
      outcome: { kind: 'no-review' }
    })
    const sequences = payloads.map((event) => event.sequence)
    expect(sequences.every((value) => typeof value === 'number')).toBe(true)
    expect(sequences).toEqual([...sequences].sort((left, right) => Number(left) - Number(right)))
    expect(await testHost.call('refreshState')).toMatchObject({ budgets: { backgroundStarts: 0 } })
  }, 20_000)

  test('GH12 pacing snapshots remain host/account scoped and bounded', async () => {
    const testHost = await host()
    const before = state(await testHost.call('refreshState'))
    expect(before).toMatchObject({ queued: 0, inFlight: 0, budgets: { backgroundStarts: 0, activeStarts: 0 }, owners: 1 })
  
    const report = await testHost.call('visibleRefreshCandidates', { generation: 1, candidates: [candidate(testHost)] })
    expect(report).toMatchObject({ accepted: true, candidates: 1 })
    const snapshot = state(await testHost.call('refreshState'))
    expect(snapshot.owners).toBe(1)
    expect(Number(snapshot.queued)).toBeLessThanOrEqual(1)
  }, 20_000)
  test('GH12 active bursts are bounded per connection and GitHub account', async () => {
    const testHost = await host()
    const second = await testHost.connect('ui')
    const work = candidate(testHost)
    for (let start = 0; start < 3; start += 1) {
      await testHost.call('refresh', { candidate: work, reason: 'active' })
    }
    const deferred = await testHost.call('refresh', { candidate: work, reason: 'active' })
    expect(deferred).toMatchObject({ kind: 'queued' })
    const firstBudget = await testHost.call('refreshState')
    expect(firstBudget).toMatchObject({ queued: 1, budgets: { activeStarts: 3 } })
  
    for (let start = 0; start < 3; start += 1) {
      await second.callAny('quirky.hosting/refresh', { candidate: work, reason: 'active' })
    }
    const secondBudget = await second.callAny('quirky.hosting/refreshState', {})
    expect(secondBudget).toMatchObject({ budgets: { activeStarts: 3 } })
    second.close()
  }, 20_000)
})
