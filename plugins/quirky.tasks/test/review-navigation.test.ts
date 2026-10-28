import { afterEach, expect, test } from 'bun:test'
import { bootTasks } from './helpers'
import { fixturePullRequest, listFixtureSource, seedListFixture } from './fixtures/list'
import { openReview, type ReviewTarget } from '../src/review-navigation'

const hosts: { cleanup(): Promise<void> }[] = []
afterEach(async () => { for (const host of hosts.splice(0).reverse()) await host.cleanup() })

function contextFor(host: { client: { callAny(method: string, params?: Record<string, unknown>): Promise<unknown> } }) {
  return { call: (method: string, params?: Record<string, unknown>) => host.client.callAny(method, params) }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function reviewTarget(value: unknown): Record<string, unknown> {
  const state = record(value)
  return record(record(state.detail).target)
}

test('openReview canonicalizes an exact GHES pull URL and forwards its source tuple', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const context = { call: async (method: string, params?: Record<string, unknown>) => { calls.push({ method, params }); return { opened: true } } }

  await openReview(context, {
    worktree: 'workspace-1',
    number: 12,
    tab: 'files',
    url: 'https://ghe.example:8443/Team/Widget/pull/12',
    host: 'ghe.example:8443',
    owner: 'team',
    repo: 'widget'
  })

  expect(calls).toEqual([{
    method: 'quirky.reviews/open',
    params: {
      worktree: 'workspace-1',
      number: 12,
      tab: 'files',
      prRepo: { host: 'ghe.example:8443', owner: 'Team', repo: 'Widget' }
    }
  }])
})

test('openReview refuses non-exact, unsafe, and conflicting pull identities before navigation', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const context = { call: async (method: string, params?: Record<string, unknown>) => { calls.push({ method, params }); return {} } }
  const common = { worktree: 'workspace-1', number: 12, tab: 'conversation' as const }
  const invalid: ReviewTarget[] = [
    { ...common, url: 'javascript:alert(1)' },
    { ...common, url: 'https://user:secret@ghe.example/Team/Widget/pull/12' },
    { ...common, url: 'https://@ghe.example/Team/Widget/pull/12' },
    { ...common, url: 'https://ghe.example/Team/Widget/pull/13' },
    { ...common, url: 'https://ghe.example/Team/Widget/issues/12' },
    { ...common, url: 'https://ghe.example/Team/Widget/pull/12/files' },
    { ...common, url: 'https://ghe.example/Team/Widget/pull/12?plain=1' },
    { ...common, url: 'https://ghe.example/Team/Widget%2Fhidden/pull/12' },
    { ...common, url: 'https://ghe.example/Team/Widget/pull/12', owner: 'other-team' },
    { ...common, url: 'https://ghe.example/Team/Widget/pull/12', host: 'ghe.example:8443' },
    { ...common, host: 'ghe.example/path', owner: 'Team', repo: 'Widget' },
    { ...common, owner: 'Team' }
  ]

  for (const target of invalid) await expect(openReview(context, target)).rejects.toThrow()
  expect(calls).toHaveLength(0)
})

test('Tasks review navigation preserves the exact origin or upstream PR source for every tab in daemon state', async () => {
  const host = await bootTasks(listFixtureSource, {
    upstream: 'https://github.com/upstream-owner/upstream-repo.git',
    extraBuiltins: ['quirky.reviews', 'quirky.git']
  })
  hosts.push(host)
  const origin = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  const upstream = fixturePullRequest('upstream-owner', 'upstream-repo', 12, '2026-10-02T00:00:00Z')
  host.writeState(seedListFixture({
    'test-owner/test-repo': [origin],
    'upstream-owner/upstream-repo': [upstream]
  }))
  const openContext = contextFor(host)

  for (const tab of ['conversation', 'checks', 'files'] as const) {
    const result = record(await openReview(openContext, {
      worktree: host.worktree,
      number: 12,
      tab,
      url: upstream.url,
      host: 'github.com',
      owner: 'upstream-owner',
      repo: 'upstream-repo'
    }))
    expect(result).toMatchObject({
      worktree: host.worktree,
      number: 12,
      tab,
      prRepo: { host: 'github.com', owner: 'upstream-owner', repo: 'upstream-repo' }
    })
    const state = await host.client.callAny('quirky.reviews/state', { worktree: host.worktree })
    expect(reviewTarget(state)).toMatchObject({
      worktree: host.worktree,
      number: 12,
      tab,
      prRepo: { host: 'github.com', owner: 'upstream-owner', repo: 'upstream-repo' }
    })
    const ui = record(await host.client.callAny('ui.state', {}))
    expect(record(record(ui.layout).view)).toMatchObject({
      id: 'view:quirky.reviews/review',
      input: { worktree: host.worktree, number: 12, tab, prRepo: { host: 'github.com', owner: 'upstream-owner', repo: 'upstream-repo' } }
    })
    const callsBefore = (Array.isArray(record(host.readState()).calls) ? record(host.readState()).calls as unknown[] : []).length
    const refreshed = record(await host.client.callAny('quirky.reviews/detailRefresh', {
      surface: 'detail',
      worktree: host.worktree,
      number: 12,
      prRepo: { host: 'github.com', owner: 'upstream-owner', repo: 'upstream-repo' }
    }))
    expect(record(refreshed.loaded).review).toBe(true)
    const refreshedState = await host.client.callAny('quirky.reviews/state', { worktree: host.worktree })
    expect(record(record(refreshedState).detail).review).toMatchObject({
      url: upstream.url,
      prRepo: { host: 'github.com', owner: 'upstream-owner', repo: 'upstream-repo' }
    })
    const calls = Array.isArray(record(host.readState()).calls) ? (record(host.readState()).calls as unknown[]).slice(callsBefore).map(record) : []
    const sourceQueries = calls.filter((call) => {
      const variables = record(call.variables)
      const query = typeof variables.query === 'string' ? variables.query : ''
      return ['HostingChecksRollup', 'HostingComments', 'HostingFileViews'].some((operation) => query.includes(operation))
    })
    expect(sourceQueries.length).toBeGreaterThan(0)
    for (const call of sourceQueries) {
      const variables = record(call.variables)
      expect(`${String(variables.owner)}/${String(variables.name ?? variables.repo)}`).toBe('upstream-owner/upstream-repo')
    }
  }

  await openReview(openContext, { worktree: host.worktree, number: 12, tab: 'conversation', url: origin.url })
  const originState = await host.client.callAny('quirky.reviews/state', { worktree: host.worktree })
  expect(reviewTarget(originState)).toMatchObject({
    number: 12,
    prRepo: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
  })
  await host.client.callAny('quirky.reviews/detailRefresh', {
    surface: 'detail',
    worktree: host.worktree,
    number: 12,
    prRepo: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
  })
  const originReviewState = await host.client.callAny('quirky.reviews/state', { worktree: host.worktree })
  expect(record(record(originReviewState).detail).review).toMatchObject({ url: origin.url })
  const previousView = record(record(await host.client.callAny('ui.state', {})).layout).view
  await host.call('open', { mode: 'issues', repoIds: [host.repoId] })
  await host.call('close')
  const restored = record(record(await host.client.callAny('ui.state', {})).layout).view
  expect(restored).toEqual(previousView)
})
