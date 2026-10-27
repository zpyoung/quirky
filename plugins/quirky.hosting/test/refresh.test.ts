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
    expect(await testHost.call('refreshState', { worktree: testHost.worktree })).toMatchObject({ owners: 2, visibleCandidates: 2 })

    const stale = state(await testHost.call('visibleRefreshCandidates', { generation: 4, candidates: [] }))
    expect(stale).toMatchObject({ accepted: false, generation: 4, candidates: 1 })
    second.close()
    expect(await testHost.call('refreshState', { worktree: testHost.worktree })).toMatchObject({ owners: 1, visibleCandidates: 1 })
    const survivingOwner = state(await testHost.call('visibleRefreshCandidates', { generation: 5, candidates: [firstCandidate] }))
    expect(survivingOwner).toMatchObject({ accepted: true, generation: 5, candidates: 1 })

    const reconnected = await testHost.connect('ui')
    const freshGeneration = state(await reconnected.callAny('quirky.hosting/visibleRefreshCandidates', { generation: 0, candidates: [] }))
    expect(freshGeneration).toMatchObject({ accepted: true, generation: 0, candidates: 0 })
    expect(await testHost.call('refreshState', { worktree: testHost.worktree })).toMatchObject({ owners: 2, visibleCandidates: 1 })
    reconnected.close()
  })

  test('GH12 refresh methods require a real connection and reject unregistered candidates before GitHub calls', async () => {
    const testHost = await host()
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
  })

  test('GH12 manual refresh is immediate, post-push is delayed, and both publish lifecycle events', async () => {
    const testHost = await host()
    const events: unknown[] = []
    testHost.client.onEvent((event) => events.push(event))
    await testHost.client.callAny('events.subscribe', {})
    const work = candidate(testHost)

    const manual = await testHost.call('refresh', { candidate: work, reason: 'manual' })
    expect(manual).toMatchObject({ kind: 'no-review' })
    const queued = await testHost.call('enqueueRefresh', { candidate: work, reason: 'post-push', priority: 100 })
    expect(queued).toMatchObject({ kind: 'queued' })
    expect(events.some((event) => typeof event === 'object' && event !== null && 'type' in event && event.type === 'quirky.hosting/refresh')).toBe(true)
    expect(await testHost.call('refreshState', { worktree: testHost.worktree })).toMatchObject({ budgets: { backgroundStarts: 0 } })
  })

  test('GH12 pacing snapshots remain host/account scoped and bounded', async () => {
    const testHost = await host()
    const before = state(await testHost.call('refreshState', { worktree: testHost.worktree }))
    expect(before).toMatchObject({ queued: 0, inFlight: 0, budgets: { backgroundStarts: 0, activeStarts: 0 }, owners: 1 })

    const report = await testHost.call('visibleRefreshCandidates', { generation: 1, candidates: [candidate(testHost)] })
    expect(report).toMatchObject({ accepted: true, candidates: 1 })
    const snapshot = state(await testHost.call('refreshState', { worktree: testHost.worktree }))
    expect(snapshot.owners).toBe(1)
    expect(Number(snapshot.queued)).toBeLessThanOrEqual(1)
  })
  test('GH12 active bursts are bounded per connection and GitHub account', async () => {
    const testHost = await host()
    const second = await testHost.connect('ui')
    const work = candidate(testHost)
    for (let start = 0; start < 3; start += 1) {
      await testHost.call('refresh', { candidate: work, reason: 'active' })
    }
    const deferred = await testHost.call('refresh', { candidate: work, reason: 'active' })
    expect(deferred).toMatchObject({ kind: 'queued' })
    const firstBudget = await testHost.call('refreshState', { worktree: testHost.worktree })
    expect(firstBudget).toMatchObject({ queued: 1, budgets: { activeStarts: 3 } })

    for (let start = 0; start < 3; start += 1) {
      await second.callAny('quirky.hosting/refresh', { candidate: work, reason: 'active' })
    }
    const secondBudget = await second.callAny('quirky.hosting/refreshState', { worktree: testHost.worktree })
    expect(secondBudget).toMatchObject({ budgets: { activeStarts: 3 } })
    second.close()
  })
})
