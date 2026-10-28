import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bootTasks } from './helpers'
import { fixtureIssue, fixturePullRequest, listFixtureSource, seedListFixture } from './fixtures/list'

type CleanupHost = { cleanup(): Promise<void> }
type RepoRegistrationHost = {
  root: string
  client: { callAny(method: string, params?: Record<string, unknown>): Promise<unknown> }
}
type ListItem = Record<string, unknown> & { repoId: string }
type ListResult = {
  items: ListItem[]
  page: number
  totalPages: number
  perRepo: number
  failures: Record<string, unknown>[]
  sources: Record<string, unknown>
}

const hosts: CleanupHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`expected ${key} to be a string`)
  return field
}

function listResult(value: unknown): ListResult {
  const result = record(value)
  const itemsValue = result.items
  const failuresValue = result.failures
  if (!Array.isArray(itemsValue) || !Array.isArray(failuresValue)) throw new Error('list result arrays are missing')
  const items = itemsValue.map((item) => {
    const row = record(item)
    return { ...row, repoId: stringField(row, 'repoId') }
  })
  const failures = failuresValue.map((failure) => record(failure))
  return {
    items,
    page: Number(result.page),
    totalPages: Number(result.totalPages),
    perRepo: Number(result.perRepo),
    failures,
    sources: record(result.sources)
  }
}

function stateCalls(value: unknown): unknown[] {
  const calls = record(value).calls
  return Array.isArray(calls) ? calls : []
}

function initRepo(path: string, remote: string): void {
  mkdirSync(path, { recursive: true })
  const commands = [
    ['init', '-b', 'main', path],
    ['-C', path, 'config', 'user.name', 'Tasks Fixture'],
    ['-C', path, 'config', 'user.email', 'tasks@example.invalid']
  ]
  for (const args of commands) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  const commitCommands = [
    ['-C', path, 'add', 'README.md'],
    ['-C', path, 'commit', '-m', 'fixture'],
    ['-C', path, 'remote', 'add', 'origin', remote]
  ]
  for (const args of commitCommands) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
}

async function addRepo(host: RepoRegistrationHost, path: string, remote: string): Promise<string> {
  initRepo(path, remote)
  const result = record(await host.client.callAny('quirky.repo/add', { path }))
  return stringField(result, 'id')
}

test('list fans out by repository, pages directly, and strips a qualifying repo before host fanout', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const secondRepoId = await addRepo(host, join(host.root, 'repo-b'), 'https://github.com/other-owner/other-repo.git')
  const alphaItems = Array.from({ length: 40 }, (_, index) => fixtureIssue('test-owner', 'test-repo', index + 1, `2026-10-${String(25 - Math.floor(index / 3)).padStart(2, '0')}T00:00:00Z`))
  const betaItems = Array.from({ length: 40 }, (_, index) => fixtureIssue('other-owner', 'other-repo', index + 101, `2026-10-${String(25 - Math.floor(index / 3)).padStart(2, '0')}T00:00:00Z`))
  host.writeState(seedListFixture({ 'test-owner/test-repo': alphaItems, 'other-owner/other-repo': betaItems }))

  const pageOne = listResult(await host.call('list', { mode: 'issues', repoIds: [host.repoId, secondRepoId], query: 'is:open', page: 1 }))
  expect(pageOne).toMatchObject({ page: 1, perRepo: 36, totalPages: 2, failures: [] })
  expect(pageOne.items).toHaveLength(72)
  expect(new Set(pageOne.items.map((item) => item.repoId))).toEqual(new Set([host.repoId, secondRepoId]))
  expect(record(pageOne.sources[host.repoId])).toMatchObject({ status: 'available', issueSource: 'origin' })

  const pageTwo = listResult(await host.call('list', { mode: 'issues', repoIds: [host.repoId, secondRepoId], query: 'is:open', page: 2 }))
  expect(pageTwo).toMatchObject({ page: 2, totalPages: 2 })
  expect(pageTwo.items).toHaveLength(8)

  const before = stateCalls(host.readState()).length
  const qualified = listResult(await host.call('list', { mode: 'issues', repoIds: [host.repoId, secondRepoId], query: 'repo:test-owner/test-repo is:open', page: 1 }))
  expect(qualified.items).toHaveLength(36)
  const calls = stateCalls(host.readState()).slice(before)
  expect(calls.some((call) => JSON.stringify(call).includes('other-owner/other-repo'))).toBe(false)
})

test('PR mode returns pull-request rows with the selected per-repository count', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-02T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z'), pull] }))
  const result = listResult(await host.call('list', { mode: 'prs', repoIds: [host.repoId], query: 'is:open' }))
  expect(result).toMatchObject({ page: 1, totalPages: 1, perRepo: 36 })
  expect(result.items).toEqual([expect.objectContaining({ kind: 'pullRequest', number: 12, title: 'Pull request 12' })])
})

test('list rejects over-limit search before any GitHub invocation and exposes count failures as continuation', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const fullPage = Array.from({ length: 36 }, (_, index) => fixtureIssue('test-owner', 'test-repo', index + 1, '2026-10-01T00:00:00Z'))
  host.writeState(seedListFixture({ 'test-owner/test-repo': fullPage }))
  const beforeInvalid = host.invocations().length
  await expect(host.call('list', { mode: 'issues', repoIds: [host.repoId], query: 'x'.repeat(8193) })).rejects.toThrow(/8192/)
  expect(host.invocations()).toHaveLength(beforeInvalid)

  host.writeState(seedListFixture({ 'test-owner/test-repo': fullPage }, { unknownCount: true }))
  const page = listResult(await host.call('list', { mode: 'issues', repoIds: [host.repoId], query: 'is:open', page: 1 }))
  expect(page.items).toHaveLength(36)
  expect(page.totalPages).toBe(2)
  expect(page.failures).toContainEqual(expect.objectContaining({ repoId: host.repoId, stage: 'count' }))
})

test('list distinguishes empty matches, unavailable authentication, and provider failures', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  host.writeState(seedListFixture({ 'test-owner/test-repo': [] }))
  const empty = listResult(await host.call('list', { mode: 'issues', repoIds: [host.repoId], query: 'is:open' }))
  expect(empty.items).toHaveLength(0)
  expect(empty.failures).toHaveLength(0)
  expect(record(empty.sources[host.repoId])).toMatchObject({ status: 'available' })

  host.writeState(seedListFixture({ 'test-owner/test-repo': [] }, { auth: false }))
  const unavailable = listResult(await host.call('list', { mode: 'issues', repoIds: [host.repoId], query: 'is:open' }))
  expect(unavailable.items).toHaveLength(0)
  expect(record(unavailable.sources[host.repoId])).toMatchObject({ status: 'unavailable', reason: 'auth_required' })
  expect(unavailable.failures).toContainEqual(expect.objectContaining({ repoId: host.repoId, stage: 'availability' }))

  host.writeState(seedListFixture({ 'test-owner/test-repo': [fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')] }, { failList: 'test-owner/test-repo' }))
  const failed = listResult(await host.call('list', { mode: 'issues', repoIds: [host.repoId], query: 'is:open', refresh: true }))
  expect(failed.items).toHaveLength(0)
  expect(failed.failures).toContainEqual(expect.objectContaining({ repoId: host.repoId, stage: 'list' }))
})


test('row validates issue duplicate identity and reviewer bounds before writing', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const target = { worktree: host.worktree, kind: 'issue', number: 7, url: 'https://github.com/test-owner/test-repo/issues/7' }
  const pullTarget = { ...target, kind: 'pullRequest', url: 'https://github.com/test-owner/test-repo/pull/7' }
  const before = host.invocations().length
  await expect(host.call('row', { target, action: 'issueStatus', state: 'closed', stateReason: 'duplicate', duplicateOf: 7 })).rejects.toThrow()
  await expect(host.call('row', { target: pullTarget, action: 'reviewers', reviewerAction: 'add', reviewerText: '@one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen' })).rejects.toThrow()
  await expect(host.call('row', { target: pullTarget, action: 'reviewers', reviewerAction: 'add', reviewerText: 'x'.repeat(2049) })).rejects.toThrow()
  expect(host.invocations()).toHaveLength(before)
})

test('assignee row updates use idempotent set semantics over public Hosting mutations', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const item = fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [item] }))
  const target = { worktree: host.worktree, kind: 'issue', number: 7, url: item.url }
  const updated = record(await host.call('row', { target, action: 'assignees', assignees: ['reviewer-two'] }))
  expect(updated.item).toMatchObject({ number: 7, assignees: ['reviewer-two'] })
  const editCount = () => stateCalls(host.readState()).filter((call) => {
    const args = record(call).args
    return Array.isArray(args) && args[0] === 'issue' && args[1] === 'edit'
  }).length
  const beforeNoop = editCount()
  const noChange = record(await host.call('row', { target, action: 'assignees', assignees: ['reviewer-two'] }))
  expect(noChange).toMatchObject({ kind: 'updated', noChange: true })
  expect(editCount()).toBe(beforeNoop)
})

test('row adds parsed reviewers through the public Hosting mutation', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }))
  const target = { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url }
  const result = record(await host.call('row', { target, action: 'reviewers', reviewerAction: 'add', reviewerText: '@reviewer-one, reviewer-three' }))
  expect(result).toMatchObject({ kind: 'updated', result: { number: 12, updated: true } })
  const items = record(record(host.readState()).items)
  const repoItems = items['test-owner/test-repo']
  if (!Array.isArray(repoItems)) throw new Error('fixture pull-request state was not updated')
  expect(record(repoItems[0]).requestedReviewers).toEqual(['reviewer-one', 'reviewer-three'])
})

test('PR metadata and reviewer mutations target the configured upstream source', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const listed = record(await host.call('list', { mode: 'prs', repoIds: [host.repoId], query: 'is:open' }))
  const repositories = listed.repositories
  if (!Array.isArray(repositories)) throw new Error('repository list was not returned')
  const localRepo = repositories.map(record).find((repo) => repo.id === host.repoId)
  if (!localRepo) throw new Error('registered local repository was not returned')
  const upstream = spawnSync('git', ['-C', stringField(localRepo, 'path'), 'remote', 'add', 'upstream', 'https://github.com/upstream-owner/upstream-repo.git'], { encoding: 'utf8' })
  if (upstream.status !== 0) throw new Error(upstream.stderr)

  const originPull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  originPull.title = 'Origin PR 12'
  originPull.requestedReviewers = ['origin-reviewer']
  const upstreamPull = fixturePullRequest('upstream-owner', 'upstream-repo', 12, '2026-10-02T00:00:00Z')
  upstreamPull.title = 'Upstream PR 12'
  upstreamPull.additions = 17
  upstreamPull.deletions = 4
  upstreamPull.changedFiles = 3
  upstreamPull.reviewDecision = 'APPROVED'
  upstreamPull.requestedReviewers = ['upstream-reviewer']
  upstreamPull.reviews = [{ author: 'active-reviewer', state: 'APPROVED' }]
  upstreamPull.reviewAssignees = ['assignee-reviewer']
  host.writeState(seedListFixture({
    'test-owner/test-repo': [originPull],
    'upstream-owner/upstream-repo': [upstreamPull]
  }))

  const target = { worktree: host.worktree, kind: 'pullRequest', number: 12, url: upstreamPull.url }
  const metadata = record(await host.call('mergeMetadata', { target }))
  expect(metadata.review).toMatchObject({
    state: 'open',
    title: 'Upstream PR 12',
    url: upstreamPull.url,
    additions: 17,
    deletions: 4,
    changedFiles: 3,
    reviewDecision: 'APPROVED',
    requestedReviewers: ['upstream-reviewer'],
    reviews: [{ author: 'active-reviewer', state: 'APPROVED' }],
    assignees: ['assignee-reviewer']
  })

  const result = record(await host.call('row', {
    target,
    action: 'reviewers',
    reviewerAction: 'add',
    reviewerText: 'added-upstream'
  }))
  expect(result).toMatchObject({ kind: 'updated', result: { number: 12, updated: true } })

  const stored = record(record(host.readState()).items)
  const originItems = stored['test-owner/test-repo']
  const upstreamItems = stored['upstream-owner/upstream-repo']
  if (!Array.isArray(originItems) || !Array.isArray(upstreamItems)) throw new Error('fixture PR source state was not retained')
  expect(record(originItems[0]).requestedReviewers).toEqual(['origin-reviewer'])
  expect(record(upstreamItems[0]).requestedReviewers).toEqual(['upstream-reviewer', 'added-upstream'])
})

test('row merge requires head consent and confirms the stateful GitHub result', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  const expectedHead = pull.headRefOid
  if (!expectedHead) throw new Error('fixture pull-request head was not set')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }, { mergeQueueRequired: false, autoMergeAllowed: true }))
  const target = { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url }
  await expect(host.call('row', { target, action: 'merge', method: 'squash', expectedHead }))
    .rejects.toMatchObject({ code: -32009 })
  const afterConsent = record(host.readState())
  const consentItems = record(afterConsent.items)['test-owner/test-repo']
  if (!Array.isArray(consentItems)) throw new Error('fixture pull-request state was not retained')
  expect(record(consentItems[0]).state).toBe('open')

  const staleHead = 'c'.repeat(40)
  await expect(host.call('row', { target, action: 'merge', method: 'squash', expectedHead: staleHead, yes: true })).rejects.toThrow()
  const afterStale = record(host.readState())
  const staleItems = record(afterStale.items)['test-owner/test-repo']
  if (!Array.isArray(staleItems)) throw new Error('fixture pull-request state was not retained')
  expect(record(staleItems[0]).state).toBe('open')

  const merged = record(await host.call('row', { target, action: 'merge', method: 'squash', expectedHead, yes: true }))
  expect(merged).toMatchObject({ kind: 'merged', result: { state: 'merged', number: 12, head: expectedHead } })
  const confirmed = record(await host.call('mergeMetadata', { target }))
  expect(record(confirmed.review).state).toBe('merged')
  const finalItems = record(record(host.readState()).items)['test-owner/test-repo']
  if (!Array.isArray(finalItems)) throw new Error('fixture pull-request state was not retained')
  expect(record(finalItems[0]).state).toBe('merged')
})


test('checks returns the provider rollup without treating a failing check as merge-safe', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z', [{ name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }])
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }))
  const result = record(await host.call('checks', { target: { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url } }))
  expect(result).toMatchObject({ rollup: 'failure', checks: [expect.objectContaining({ name: 'CI', conclusion: 'FAILURE' })] })
})

test('merge metadata offers direct methods only when repository queue policy confirms them', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }, { mergeQueueRequired: false, autoMergeAllowed: true }))
  const result = record(await host.call('mergeMetadata', { target: { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url } }))
  expect(result).toMatchObject({ mergeMetadataKnown: true, mergeQueueRequired: false, autoMergeAllowed: true, mergeEligible: true, queueEligible: false })
  expect(result.directMethods).toEqual(['squash', 'merge', 'rebase'])
  expect(result.queueMethods).toEqual([])
})

test('merge metadata exposes queue action only when GitHub confirms queue policy', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }, { mergeQueueRequired: true, autoMergeAllowed: false }))
  const result = record(await host.call('mergeMetadata', { target: { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url } }))
  expect(result).toMatchObject({ mergeMetadataKnown: true, mergeQueueRequired: true, autoMergeAllowed: false, mergeEligible: false, queueEligible: true })
  expect(result.directMethods).toEqual([])
  expect(result.queueMethods).toEqual(['squash', 'merge', 'rebase'])
  expect(result.autoMergeEnableEligible).toBe(false)
})

test('unknown queue and auto-merge metadata disables unsafe actions', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  pull.requestedReviewers = null
  pull.reviews = null
  pull.reviewAssignees = null
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }, { mergeQueueRequired: null, autoMergeAllowed: null }))
  const result = record(await host.call('mergeMetadata', { target: { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url } }))
  expect(result).toMatchObject({ mergeMetadataKnown: false, mergeQueueRequired: null, autoMergeAllowed: null, mergeKnown: false, mergeEligible: false, queueEligible: false, autoMergeEnableEligible: false })
  expect(result.review).toMatchObject({ requestedReviewers: null, reviews: null, assignees: null })
  expect(result.directMethods).toEqual([])
  expect(result.queueMethods).toEqual([])
})

test('row closes a duplicate issue through the stateful Hosting API', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  host.writeState(seedListFixture({ 'test-owner/test-repo': [fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')] }))
  const target = { worktree: host.worktree, kind: 'issue', number: 7, url: 'https://github.com/test-owner/test-repo/issues/7' }
  const result = record(await host.call('row', { target, action: 'issueStatus', state: 'closed', stateReason: 'duplicate', duplicateOf: 8 }))
  expect(result.kind).toBe('updated')
  expect(result.item).toMatchObject({ kind: 'issue', number: 7, state: 'closed', duplicateOf: 8 })
  const stored = record(host.readState())
  const items = record(stored.items)
  const repoItems = items['test-owner/test-repo']
  if (!Array.isArray(repoItems)) throw new Error('fixture issue state was not updated')
  expect(repoItems[0]).toMatchObject({ state: 'closed', duplicateOf: 8 })
})



test('workspace uses exact URL links, retains a visible composer request, and creates through worktree API', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-02T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z'), pull] }))
  const target = { worktree: host.worktree, kind: 'issue', number: 7, url: 'https://github.com/test-owner/test-repo/issues/7' } as const

  const request = record(await host.call('workspace', { target, action: 'start' }))
  expect(request).toMatchObject({ kind: 'composer', target, repoId: host.repoId, title: 'Issue 7' })
  const requestId = stringField(request, 'requestId')
  expect(await host.call('workspaceComposerState')).toMatchObject({ requestId, target })
  await host.call('workspaceComposerCancel', { requestId })
  expect(await host.call('workspaceComposerState')).toBeNull()

  const pullTarget = { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url } as const
  const pullRequest = record(await host.call('workspace', { target: pullTarget, action: 'start' }))
  expect(pullRequest).toMatchObject({ kind: 'composer', target: pullTarget, title: 'Pull request 12' })
  const pullRequestId = stringField(pullRequest, 'requestId')
  expect(await host.call('workspaceComposerState')).toMatchObject({ requestId: pullRequestId, target: pullTarget })
  await host.call('workspaceComposerCancel', { requestId: pullRequestId })
  expect(await host.call('workspaceComposerState')).toBeNull()

  expect(await host.call('workspace', { target, action: 'link', worktree: host.worktree })).toMatchObject({ kind: 'linked', worktree: host.worktree })
  const state = record(await host.call('state'))
  const links = record(state.links)
  expect(links[target.url]).toMatchObject({ worktree: host.worktree, repoId: host.repoId, url: target.url })
  expect(await host.call('workspace', { target, action: 'unlink' })).toMatchObject({ kind: 'unlinked' })
  expect(record(record(await host.call('state')).links)[target.url]).toBeUndefined()
  const withoutUrl = { worktree: host.worktree, kind: 'issue', number: 7, host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
  const canonicalKey = 'github.com|issue|test-owner/test-repo|7'
  await host.call('workspace', { target: withoutUrl, action: 'link', worktree: host.worktree })
  expect(record(record(await host.call('state')).links)[canonicalKey]).toMatchObject({ worktree: host.worktree, repoId: host.repoId })
  await host.call('workspace', { target: withoutUrl, action: 'unlink' })

  const fresh = record(await host.call('workspace', { target, action: 'start' }))
  const created = await host.call('workspace', { target, action: 'start', newWorkspace: true, composerRequestId: stringField(fresh, 'requestId'), setup: 'skip', name: 'tasks-issue-7' })
  expect(created).toMatchObject({ kind: 'created', worktree: { repoId: host.repoId, name: 'tasks-issue-7' } })
  expect(await host.call('workspaceComposerState')).toBeNull()
})


test('PR Open preference persists the mode-specific default preset key', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  await host.call('preferences', { defaultTaskViewPreset: 'prs' })
  const saved = record(await host.call('state'))
  expect(record(saved.preferences).defaultTaskViewPreset).toBe('prs')
})
test('generated Tasks CLI command reaches the same bounded list method', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  host.writeState(seedListFixture({ 'test-owner/test-repo': [fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')] }))
  const description = await host.client.callAny('api.describe', {})
  expect(JSON.stringify(description)).toContain('quirky.tasks/list')
  const result = await host.cli(['--json', 'tasks', 'list', '--worktree', host.worktree, '--mode', 'issues', '--query', 'is:open'])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(result.stdout)).toMatchObject({ page: 1, totalPages: 1, perRepo: 36 })
})
