import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootHosting, type HostingTest } from '../helpers'
import { bootGitLab, type GitLabWorld } from './world'
import { mergeRequest } from './stand-in'
import type { HostingEnv } from '../../src/env'
import { createGitLabClient } from '../../src/gitlab/api'
import { createGitLabReviewHandlers } from '../../src/gitlab/reviews'
import type { GitLabScope } from '../../src/gitlab/types'

let active: HostingTest | undefined
async function boot(options: Parameters<typeof bootGitLab>[0] = {}): Promise<GitLabWorld> {
  const world = await bootGitLab(options)
  active = world
  return world
}
afterEach(async () => {
  await active?.cleanup()
  active = undefined
})

const reason = (value: string) => ({ data: { reason: value } })
const projectPath = (world: GitLabWorld) => `/api/v4/projects/${encodeURIComponent(`${world.identity.owner}/${world.identity.repo}`)}`
const listPath = (world: GitLabWorld) => `${projectPath(world)}/merge_requests`
const reviewPath = (world: GitLabWorld, number: number) => `${listPath(world)}/${number}`
const reviewUrl = (world: GitLabWorld, number: number) => `${world.server.url}/${world.identity.owner}/${world.identity.repo}/-/merge_requests/${number}`

async function expectCreateBlocked(
  world: GitLabWorld,
  expectedReason: string,
  message: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  await expect(world.call('create', { title: 'Add x', ...params })).rejects.toMatchObject({
    message, ...reason(expectedReason)
  })
  expect(world.server.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
}

function runGit(world: GitLabWorld, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: world.repoPath, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git fixture setup failed: ${new TextDecoder().decode(result.stderr)}`)
  return new TextDecoder().decode(result.stdout).trim()
}

function ignoreTemplateFixture(world: GitLabWorld): void {
  appendFileSync(join(world.repoPath, '.git', 'info', 'exclude'), '\n/.gitlab/merge_request_templates/Default.md\n')
}

async function listenForEvents(world: GitLabWorld): Promise<unknown[]> {
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})
  return events
}

function localHead(world: GitLabWorld): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: world.repoPath })
  if (result.exitCode !== 0) throw new Error('could not read the fixture branch head')
  return new TextDecoder().decode(result.stdout).trim()
}

function matchingChangedEvent(events: unknown[], world: GitLabWorld): boolean {
  return events.some((event) => {
    if (typeof event !== 'object' || event === null || !('type' in event) || event.type !== 'quirky.hosting/changed') return false
    const data = 'data' in event && typeof event.data === 'object' && event.data !== null ? event.data : {}
    return 'worktreeId' in data && data.worktreeId === world.worktree
      && 'host' in data && data.host === world.identity.host
      && 'owner' in data && data.owner === world.identity.owner
      && 'repo' in data && data.repo === world.identity.repo
  })
}

test('forBranch returns no-review and uses the scoped, sorted merge-request query', async () => {
  const world = await boot()
  const result = await world.call('forBranch')
  expect(result).toMatchObject({ kind: 'no-review', fetchedAt: expect.any(Number) })
  expect(world.server.requests.map((request) => [request.method, request.path])).toEqual([
    ['GET', projectPath(world)],
    ['GET', listPath(world)]
  ])
  expect(world.server.requests[1]?.query).toEqual({
    source_branch: 'feature', state: 'all', order_by: 'updated_at', sort: 'desc', per_page: '100'
  })
})

test('forBranch rejects before network when GitLab authentication is unavailable', async () => {
  const world = await boot({ token: null })
  await expect(world.call('forBranch')).rejects.toMatchObject({
    message: 'GitLab authentication is unavailable. Set GITLAB_TOKEN or run glab auth login.',
    ...reason('auth_required')
  })
  expect(world.server.requests).toEqual([])
})

for (const method of ['forBranch', 'review'] as const) {
  test(`${method} validates fresh before authentication or snapshot capture`, async () => {
    const env = {
      invalid: (reason: string, message: string) => Object.assign(new Error(message), { data: { reason } })
    } as HostingEnv
    const unexpected = async (): Promise<never> => { throw new Error('unexpected provider operation') }
    const client = createGitLabClient(env, { fetch: unexpected, readToken: unexpected })
    const handler = createGitLabReviewHandlers(env, client)[method]!
    for (const fresh of [null, 'true', 1, {}, []]) {
      await expect(handler(
        {} as GitLabScope,
        { branch: 'feature', number: 5, fresh },
        { role: 'plugin', pluginId: 'quirky.hosting' },
        unexpected
      )).rejects.toMatchObject({
        message: 'fresh must be a boolean.',
        ...reason('validation_error')
      })
    }
  })

  test(`${method} records a cache-only auth-failure snapshot`, async () => {
    const world = await boot({ token: null })
    const head = localHead(world)
    await expect(world.call(method, { number: 5 })).rejects.toMatchObject(reason('auth_required'))
    expect(world.server.requests).toEqual([])
    const authProbes = world.glabInvocations().length
    for (let read = 0; read < 2; read++) {
      const result = await world.client.callAny('quirky.hosting/cachedReviews', { worktrees: [world.worktree] })
      expect(result).toMatchObject({
        workspaces: [{
          worktreeId: world.worktree,
          branch: 'feature',
          headOid: head,
          review: null,
          stale: false,
          error: 'GitLab authentication is unavailable. Set GITLAB_TOKEN or run glab auth login.'
        }]
      })
    }
    expect(world.server.requests).toEqual([])
    expect(world.glabInvocations()).toHaveLength(authProbes)
    expect(world.invocations()).toEqual([])
  })
}

test('forBranch normalizes the complete GitLab review shape and caches non-fresh reads', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  const result = await world.call('forBranch') as Record<string, any>
  expect(result).toMatchObject({
    kind: 'found',
    review: {
      provider: 'gitlab', number: 5, url: reviewUrl(world, 5), title: 'Add x', body: 'body',
      state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40),
      baseRefOid: 'c'.repeat(40), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      detailedMergeStatus: 'mergeable', checksStatus: 'success', reviewDecision: 'REVIEW_REQUIRED',
      reviews: [], requestedReviewers: ['rev'], assignees: [], participantsTruncated: false,
      autoMergeRequest: null, stack: null, mergeMethods: { default: null, allowed: [] },
      mergeQueueRequired: false, inMergeQueue: false, mergeQueueEntry: null,
      autoMergeAllowed: null, mergeMetadataKnown: false,
      repository: world.identity
    },
    fetchedAt: expect.any(Number)
  })
  expect(result.review.updatedAt).toEqual(expect.any(String))
  expect(world.server.requests.filter((request) => request.path === reviewPath(world, 5))).toHaveLength(1)
  const requestsAfterFirstRead = world.server.requests.length
  await world.call('forBranch')
  expect(world.server.requests).toHaveLength(requestsAfterFirstRead)
})

test('draft titles normalize all supported prefixes', async () => {
  const world = await boot()
  for (const [title, expected] of [
    ['Draft: Add x', 'Add x'], ['[dRaFt] Add x', 'Add x'], ['(DRAFT) Add x', 'Add x']
  ]) {
    world.server.mergeRequests = [mergeRequest({ title, draft: true })]
    const result = await world.call('forBranch', { fresh: true }) as Record<string, any>
    expect(result).toMatchObject({ kind: 'found', review: { state: 'draft', title: expected } })
  }
})

test('forBranch excludes fork requests and resolves multiple open requests by freshness', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest({ source_project_id: 99 })]
  expect(await world.call('forBranch')).toMatchObject({ kind: 'no-review' })

  await world.cleanup()
  const multiple = await boot()
  multiple.server.mergeRequests = [
    mergeRequest({ iid: 5, updated_at: '2026-01-01T00:00:00Z' }),
    mergeRequest({ iid: 8, updated_at: '2026-01-02T00:00:00Z' })
  ]
  expect(await multiple.call('forBranch')).toMatchObject({ kind: 'found', review: { number: 8 } })
  expect(await multiple.call('forBranch', { fresh: true })).toMatchObject({
    kind: 'unavailable', reason: 'ambiguous_head', message: 'More than one merge request is open for this branch.'
  })
})

test('forBranch only reuses closed or merged requests when their head equals the current branch', async () => {
  const world = await boot()
  const head = localHead(world)
  for (const [state, expected] of [['merged', 'merged'], ['closed', 'closed']] as const) {
    world.server.mergeRequests = [mergeRequest({ state, sha: head, diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head } })]
    expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'found', review: { state: expected } })
    world.server.mergeRequests = [mergeRequest({ state, sha: 'd'.repeat(40) })]
    expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'no-review' })
  }
})

test('forBranch hydrates selected terminal rows from the merge-request detail endpoint', async () => {
  const world = await boot()
  const head = localHead(world)
  world.server.mergeRequests = [mergeRequest({
    state: 'merged',
    sha: head,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head }
  })]
  expect(await world.call('forBranch', { fresh: true })).toMatchObject({
    kind: 'found', review: { number: 5, state: 'merged', headRefOid: head }
  })
  expect(world.server.requests.filter((request) => request.path === reviewPath(world, 5))).toHaveLength(1)
})

test.each([
  ['project', mergeRequest({ project_id: 99 })],
  ['source project', mergeRequest({ source_project_id: 99 })],
  ['branch', mergeRequest({ source_branch: 'another-branch' })],
  ['newly closed head', mergeRequest({ state: 'closed', sha: 'd'.repeat(40) })],
  ['newly merged head', mergeRequest({ state: 'merged', sha: 'd'.repeat(40) })]
])('forBranch rechecks the hydrated %s before normalization', async (_field, detail) => {
  const world = await boot()
  world.server.mergeRequests = [detail]
  world.server.listMergeRequests = [mergeRequest()]
  expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'no-review' })
  expect(world.server.requests.filter((request) => request.path === reviewPath(world, 5))).toHaveLength(1)
  expect(world.server.requests.some((request) => request.path === `${reviewPath(world, 5)}/approvals`)).toBe(false)
})

test('forBranch rechecks the terminal head after hydration', async () => {
  const world = await boot()
  const head = localHead(world)
  world.server.mergeRequests = [mergeRequest({ state: 'merged', sha: 'd'.repeat(40) })]
  world.server.listMergeRequests = [mergeRequest({ state: 'merged', sha: head })]
  expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'no-review' })
  expect(world.server.requests.filter((request) => request.path === reviewPath(world, 5))).toHaveLength(1)
})

test('forBranch reads a linked number directly and uses fallbackPRNumber after a branch miss', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  expect(await world.call('forBranch', { number: 5 })).toMatchObject({ kind: 'found', review: { number: 5 } })
  expect(world.server.requests.some((request) => request.path === listPath(world))).toBe(false)

  world.server.requests.length = 0
  world.server.mergeRequests = [mergeRequest({ source_branch: 'another-branch' })]
  expect(await world.call('forBranch', { fallbackPRNumber: 5 })).toMatchObject({ kind: 'found', review: { number: 5 } })
  expect(world.server.requests.some((request) => request.path === listPath(world))).toBe(true)
})

test('a missing diff is retryable and reported as diff_pending', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest({ diff_refs: null })]
  const result = await world.call('forBranch') as Record<string, any>
  expect(result.nextAutoRetryAt - result.fetchedAt).toBe(5000)
  expect(result).toMatchObject({
    kind: 'unavailable', reason: 'diff_pending', message: 'GitLab is still preparing this merge request.',
    fetchedAt: expect.any(Number), nextAutoRetryAt: expect.any(Number)
  })
  expect(world.server.requests.filter((request) => request.path === reviewPath(world, 5))).toHaveLength(1)
})

test('approval data maps into review decisions and tolerates unavailable approvals', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  world.server.approvals['5'] = { approved: true, approvals_left: 0, approved_by: [{ user: { username: 'teammate' } }] }
  expect(await world.call('forBranch')).toMatchObject({
    kind: 'found', review: { reviewDecision: 'APPROVED', reviews: [{ author: 'teammate', state: 'APPROVED' }] }
  })

  world.server.failures.set(`GET ${reviewPath(world, 5)}/approvals`, { status: 403 })
  expect(await world.call('forBranch', { fresh: true })).toMatchObject({
    kind: 'found', review: { reviewDecision: '', reviews: null }
  })
})

test('merge-status and pipeline statuses map to the GitHub-shaped vocabulary', async () => {
  const world = await boot()
  const mergeCases: [string, boolean | undefined, string, string][] = [
    ['mergeable', undefined, 'MERGEABLE', 'CLEAN'], ['conflict', undefined, 'CONFLICTING', 'DIRTY'],
    ['mergeable', true, 'CONFLICTING', 'DIRTY'], ['need_rebase', undefined, 'UNKNOWN', 'BEHIND'],
    ['draft_status', undefined, 'UNKNOWN', 'DRAFT'], ['checking', undefined, 'UNKNOWN', 'UNKNOWN'],
    ['unchecked', undefined, 'UNKNOWN', 'UNKNOWN'], ['preparing', undefined, 'UNKNOWN', 'UNKNOWN'],
    ['unexpected', undefined, 'UNKNOWN', 'BLOCKED']
  ]
  for (const [status, conflicts, mergeable, mergeStateStatus] of mergeCases) {
    world.server.mergeRequests = [mergeRequest({ detailed_merge_status: status, ...(conflicts ? { has_conflicts: true } : {}) })]
    expect(await world.call('forBranch', { fresh: true })).toMatchObject({
      kind: 'found', review: { mergeable, mergeStateStatus, detailedMergeStatus: status }
    })
  }

  const pipelineCases: [string | null, string][] = [
    ['success', 'success'], ['failed', 'failure'], ['canceled', 'failure'],
    ['created', 'pending'], ['waiting_for_resource', 'pending'], ['preparing', 'pending'],
    ['pending', 'pending'], ['running', 'pending'], ['scheduled', 'pending'],
    ['skipped', 'neutral'], ['manual', 'neutral'], ['unknown', 'neutral'], [null, 'neutral']
  ]
  for (const [status, checksStatus] of pipelineCases) {
    world.server.mergeRequests = [mergeRequest({ head_pipeline: status === null ? null : { status } })]
    expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'found', review: { checksStatus } })
  }
})

test('forBranch maps server errors and rate limits to unavailable results', async () => {
  const world = await boot()
  world.server.failures.set(`GET ${listPath(world)}`, { status: 500 })
  expect(await world.call('forBranch')).toMatchObject({ kind: 'unavailable', reason: 'server_error' })

  world.server.failures.set(`GET ${listPath(world)}`, { status: 429, headers: { 'Retry-After': '30' } })
  const result = await world.call('forBranch', { fresh: true }) as Record<string, any>
  expect(result.retryDisabledUntil).toBeGreaterThanOrEqual(result.fetchedAt + 29_000)
  expect(result.retryDisabledUntil).toBeLessThanOrEqual(result.fetchedAt + 31_000)
  expect(result).toMatchObject({ kind: 'unavailable', reason: 'rate_limited', fetchedAt: expect.any(Number), retryDisabledUntil: expect.any(Number) })
})

test('review reads by number, caches non-fresh reads, and checks repository mismatch before network', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  const before = world.server.requests.length
  await expect(world.call('review', { number: 5, prRepo: { host: world.identity.host, owner: 'group', repo: 'sub' } }))
    .rejects.toMatchObject({ ...reason('repository_mismatch') })
  expect(world.server.requests).toHaveLength(before)

  expect(await world.call('review', { number: 5 })).toMatchObject({ kind: 'found', review: { number: 5 } })
  const requestsAfterRead = world.server.requests.length
  expect(await world.call('review', { number: 5 })).toMatchObject({ kind: 'found', review: { number: 5 } })
  expect(world.server.requests).toHaveLength(requestsAfterRead)
  expect(await world.call('review', {
    number: 5, prRepo: { host: world.identity.host.toUpperCase(), owner: 'GROUP/SUB', repo: 'PROJ' }
  })).toMatchObject({ kind: 'found', review: { number: 5 } })
  expect(world.server.requests.some((request) => request.path === listPath(world))).toBe(false)
})

test('review returns no-review for a missing number', async () => {
  const world = await boot()
  expect(await world.call('review', { number: 77 })).toMatchObject({ kind: 'no-review' })
})

test('project and review lookup caches share the environment cache and fresh bypasses branch results', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  await world.call('forBranch')
  const firstReadCount = world.server.requests.length
  await world.call('forBranch')
  expect(world.server.requests).toHaveLength(firstReadCount)
  await world.call('forBranch', { fresh: true })
  expect(world.server.requests.filter((request) => request.path === projectPath(world))).toHaveLength(1)
  expect(world.server.requests.filter((request) => request.path === listPath(world))).toHaveLength(2)
})

test('creationEligibility reports an existing review blocker', async () => {
  const existingWorld = await boot()
  existingWorld.server.mergeRequests = [mergeRequest()]
  expect(await existingWorld.call('creationEligibility')).toMatchObject({
    eligible: false, reason: 'existing_review', nextAction: 'open_existing_review',
    blockers: [{ reason: 'existing_review', nextAction: 'open_existing_review', message: 'This branch already has a merge request.' }],
    review: { number: 5 }
  })

})

test('creationEligibility reports a dirty-tree blocker', async () => {
  const dirtyWorld = await boot()
  writeFileSync(join(dirtyWorld.repoPath, 'untracked.txt'), 'dirty\n')
  expect(await dirtyWorld.call('creationEligibility')).toMatchObject({ eligible: false, reason: 'dirty_tree', blockers: [{ reason: 'dirty_tree' }] })

})

test('creationEligibility reports a default-branch blocker', async () => {
  const defaultBranchWorld = await boot({ branch: 'main' })
  expect(await defaultBranchWorld.call('creationEligibility')).toMatchObject({ eligible: false, reason: 'default_branch', blockers: [{ reason: 'default_branch' }] })

})

test('creationEligibility reports an authentication blocker without requests', async () => {
  const unauthenticatedWorld = await boot({ token: null })
  expect(await unauthenticatedWorld.call('creationEligibility')).toMatchObject({
    eligible: false, reason: 'authentication_required', blockers: [{
      reason: 'authentication_required',
      message: 'GitLab authentication is unavailable. Set GITLAB_TOKEN or run glab auth login.'
    }]
  })
  expect(unauthenticatedWorld.server.requests).toEqual([])
})

test('creationEligibility returns the clean fixture branch and project default base', async () => {
  const world = await boot()
  expect(await world.call('creationEligibility')).toEqual({
    eligible: true, defaultBase: 'main', head: 'feature', title: '', body: '', blockers: []
  })
})

test('create validates title and head before making any GitLab request', async () => {
  const world = await boot()
  await expect(world.call('create', { title: '  ' })).rejects.toMatchObject(reason('validation_error'))
  await expect(world.call('create', { title: 'x', head: 'other' })).rejects.toMatchObject({
    message: 'head must be the current branch.', ...reason('validation_error')
  })
  expect(world.server.requests).toEqual([])
})

function creationExpectation(world: GitLabWorld) {
  return {
    branch: 'feature',
    headSha: localHead(world),
    baseRefName: 'main',
    repository: { ...world.identity },
    headRepository: { ...world.identity }
  }
}

for (const field of ['branch', 'headSha', 'baseRefName', 'repository', 'headRepository', 'matching'] as const) {
  test(`create refuses ${field} expected guards before GitLab authentication or requests`, async () => {
    const world = await boot({ token: null, glabOutput: 'dummy-gitlab-token' })
    const expected = creationExpectation(world)
    if (field === 'branch') expected.branch = 'another-branch'
    if (field === 'headSha') expected.headSha = `${expected.headSha[0] === '0' ? '1' : '0'}${expected.headSha.slice(1)}`
    if (field === 'baseRefName') expected.baseRefName = 'another-base'
    if (field === 'repository' || field === 'headRepository') expected[field] = { ...world.identity, repo: 'another-project' }
    await expect(world.call('create', { title: 'Pinned creation', expected })).rejects.toMatchObject({
      message: 'GitLab hosting does not support pinned merge-request creation.',
      data: { reason: 'unsupported_provider' }
    })
    expect(world.server.requests).toEqual([])
    expect(world.glabInvocations()).toEqual([])
  })
}

test('create refuses expected guards before returning an existing GitLab review', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  await expect(world.call('create', { title: 'Pinned creation', expected: creationExpectation(world) })).rejects.toMatchObject({
    data: { reason: 'unsupported_provider' }
  })
  expect(world.server.requests).toEqual([])
  expect(world.glabInvocations()).toEqual([])
})

test('create returns an existing same-branch merge request without posting', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  expect(await world.call('create', { title: 'Add x' })).toEqual({
    number: 5, url: reviewUrl(world, 5), existing: true
  })
  expect(world.server.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
})

test('create rechecks a dirty tree before posting', async () => {
  const world = await boot()
  writeFileSync(join(world.repoPath, 'untracked.txt'), 'dirty\n')
  await expectCreateBlocked(world, 'dirty_tree', 'Commit or discard local changes before creating a merge request.')
})

test('create rechecks an unpublished branch before posting', async () => {
  const world = await boot()
  runGit(world, ['branch', '--unset-upstream', 'feature'])
  await expectCreateBlocked(world, 'no_upstream', 'Publish this branch and configure its upstream before creating a merge request.')
})

test('create rechecks an unpushed branch before posting', async () => {
  const world = await boot()
  runGit(world, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'local ahead'])
  await expectCreateBlocked(world, 'branch_ahead', 'Push local commits to the configured upstream before creating a merge request.')
})

test('create rechecks a behind branch before posting', async () => {
  const world = await boot()
  const base = runGit(world, ['rev-parse', 'HEAD'])
  const upstream = runGit(world, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'remote ahead'])
  runGit(world, ['update-ref', 'refs/remotes/origin/feature', upstream])
  await expectCreateBlocked(world, 'branch_behind', 'Sync this branch with its upstream before creating a merge request.')
})

test('create rechecks a diverged branch before posting', async () => {
  const world = await boot()
  const base = runGit(world, ['rev-parse', 'HEAD'])
  runGit(world, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'local divergence'])
  const upstream = runGit(world, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'remote divergence'])
  runGit(world, ['update-ref', 'refs/remotes/origin/feature', upstream])
  await expectCreateBlocked(world, 'branch_behind', 'Sync this branch with its upstream before creating a merge request.')
})

test('create refuses the repository default branch before posting', async () => {
  const world = await boot({ branch: 'main' })
  await expectCreateBlocked(world, 'default_branch', 'A merge request cannot be created from the repository default branch.')
})

test('create refuses its own branch as a base before posting', async () => {
  const world = await boot()
  await expectCreateBlocked(world, 'default_branch', 'A merge request cannot be created from the repository default branch.', { base: 'feature' })
})

test('create requires a known remote base before posting', async () => {
  const world = await boot()
  await expectCreateBlocked(world, 'missing_remote_base', 'The base branch unavailable is not present on a configured remote.', { base: 'unavailable' })
})

test('create requires a successful review lookup before posting', async () => {
  const world = await boot()
  world.server.failures.set(`GET ${listPath(world)}`, { status: 500 })
  await expectCreateBlocked(world, 'lookup_unavailable', 'Could not verify whether this branch already has a merge request.')
})

test('create opens a draft merge request, emits changed, and invalidates review caches', async () => {
  const world = await boot()
  const events = await listenForEvents(world)
  const created = await world.call('create', { title: 'Add x', body: 'b', draft: true })
  expect(created).toEqual({ number: 6, url: reviewUrl(world, 6), existing: false })
  const post = world.server.requests.find((request) => request.method === 'POST' && request.path === listPath(world))
  expect(post?.body).toEqual({ source_branch: 'feature', target_branch: 'main', title: 'Draft: Add x', description: 'b' })
  expect(matchingChangedEvent(events, world)).toBe(true)
  expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'found', review: { number: 6, title: 'Add x', state: 'draft' } })

  await world.call('review', { number: 6 })
  const beforeMutationRead = world.server.requests.filter((request) => request.path === reviewPath(world, 6)).length
  await world.call('updateReview', { number: 6, action: 'edit', title: 'Changed' })
  expect(await world.call('review', { number: 6 })).toMatchObject({ kind: 'found', review: { title: 'Changed' } })
  expect(world.server.requests.filter((request) => request.path === reviewPath(world, 6)).length).toBeGreaterThan(beforeMutationRead)
})

test('create reads the GitLab merge-request template and ignores oversized templates', async () => {
  const world = await boot()
  ignoreTemplateFixture(world)
  const directory = join(world.repoPath, '.gitlab', 'merge_request_templates')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'Default.md'), 'tmpl')
  await world.call('create', { title: 'Add x', useTemplate: true })
  expect(world.server.requests.find((request) => request.method === 'POST')?.body).toMatchObject({ description: 'tmpl' })

  await world.cleanup()
  const oversizedWorld = await boot()
  ignoreTemplateFixture(oversizedWorld)
  const oversizedDirectory = join(oversizedWorld.repoPath, '.gitlab', 'merge_request_templates')
  mkdirSync(oversizedDirectory, { recursive: true })
  writeFileSync(join(oversizedDirectory, 'Default.md'), 'x'.repeat(64 * 1024 + 1))
  await oversizedWorld.call('create', { title: 'Add x', useTemplate: true })
  expect(oversizedWorld.server.requests.find((request) => request.method === 'POST')?.body).toMatchObject({ description: '' })
})


test('create reconciles 409 only to a same-project candidate', async () => {
  const world = await boot()
  world.server.createMode = 'conflict'
  world.server.conflictCandidates = [
    mergeRequest(),
    mergeRequest({ iid: 8, project_id: 99 }),
    mergeRequest({ iid: 9, source_project_id: 99 })
  ]
  expect(await world.call('create', { title: 'Add x' })).toEqual({ number: 5, url: reviewUrl(world, 5), existing: true })
  expect(world.server.requests.filter((request) => request.method === 'POST')).toHaveLength(1)

})

test('create refuses a fork-only candidate after 409', async () => {
  const forkOnly = await boot()
  forkOnly.server.createMode = 'conflict'
  forkOnly.server.conflictCandidates = [mergeRequest({ source_project_id: 99 })]
  await expect(forkOnly.call('create', { title: 'Add x' })).rejects.toMatchObject({
    message: 'A matching GitLab resource already exists.', ...reason('already_exists')
  })
  expect(forkOnly.server.requests.filter((request) => request.method === 'POST')).toHaveLength(1)

})

test('create refuses ambiguous same-project candidates after 409', async () => {
  const ambiguous = await boot()
  ambiguous.server.createMode = 'conflict'
  ambiguous.server.conflictCandidates = [mergeRequest(), mergeRequest({ iid: 8 })]
  await expect(ambiguous.call('create', { title: 'Add x' })).rejects.toMatchObject(reason('already_exists'))
  expect(ambiguous.server.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
})


test('create reconciles lost responses only to current-project candidates and reports unknown completion', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest({ iid: 4, source_project_id: 99 })]
  world.server.createMode = 'lost-created'
  expect(await world.call('create', { title: 'Add x' })).toEqual({ number: 6, url: reviewUrl(world, 6), existing: false })
  expect(world.server.requests.filter((request) => request.method === 'POST')).toHaveLength(1)

  await world.cleanup()
  const lostWorld = await boot()
  lostWorld.server.mergeRequests = [mergeRequest({ source_project_id: 99 })]
  lostWorld.server.createMode = 'lost-empty'
  let failure: unknown
  try {
    await lostWorld.call('create', { title: 'Add x' })
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({
    message: 'GitLab may have created the merge request. Refresh before retrying.', ...reason('unknown_completion')
  })
  expect(lostWorld.server.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
})

test('ready and draft actions remove or add the Draft title prefix only when needed', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest({ iid: 6, title: 'Draft: Add x', draft: true })]
  const ready = await world.call('updateReview', { number: 6, action: 'ready' })
  expect(ready).toEqual({ number: 6, updated: true, state: 'open' })
  expect(world.server.requests.find((request) => request.method === 'PUT')?.body).toEqual({ title: 'Add x' })

  const draft = await world.call('updateReview', { number: 6, action: 'draft' })
  expect(draft).toEqual({ number: 6, updated: true, state: 'draft' })
  expect(world.server.requests.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({ title: 'Draft: Add x' })
  expect(await world.call('updateReview', { number: 6, action: 'draft' })).toEqual({ number: 6, updated: false, state: 'draft' })
  expect(world.server.requests.filter((request) => request.method === 'PUT')).toHaveLength(2)
})

test('updateReview edits drafts, validates empty edits before PUT, and closes/reopens with events', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest({ iid: 6, title: '[Draft] Add x', draft: true })]
  const events = await listenForEvents(world)
  expect(await world.call('updateReview', { number: 6, action: 'edit', title: 'New' })).toEqual({ number: 6, updated: true, state: 'draft' })
  expect(world.server.requests.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({ title: 'Draft: New' })
  await world.call('updateReview', { number: 6, action: 'edit', body: 'd' })
  expect(world.server.requests.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({ description: 'd' })
  const putsBeforeEmptyEdit = world.server.requests.filter((request) => request.method === 'PUT').length
  await expect(world.call('updateReview', { number: 6, action: 'edit' })).rejects.toMatchObject(reason('validation_error'))
  expect(world.server.requests.filter((request) => request.method === 'PUT')).toHaveLength(putsBeforeEmptyEdit)

  expect(await world.call('updateReview', { number: 6, action: 'close' })).toEqual({ number: 6, updated: true, state: 'closed' })
  expect(world.server.requests.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({ state_event: 'close' })
  expect(await world.call('updateReview', { number: 6, action: 'reopen' })).toEqual({ number: 6, updated: true, state: 'open' })
  expect(world.server.requests.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({ state_event: 'reopen' })
  expect(events.filter((event) => typeof event === 'object' && event !== null && 'type' in event && event.type === 'quirky.hosting/changed')).toHaveLength(4)
  expect(events.every((event) => !JSON.stringify(event).includes('dummy-gitlab-token'))).toBe(true)
})

test('ready on an open merge request is idempotent', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest({ iid: 6, title: 'Add x', draft: false })]
  expect(await world.call('updateReview', { number: 6, action: 'ready' })).toEqual({ number: 6, updated: false, state: 'open' })
  expect(world.server.requests.some((request) => request.method === 'PUT')).toBe(false)
})

test('GitHub continues to refuse the GitLab-only draft action without calling gh', async () => {
  const host = await bootHosting('process.stdout.write("{}")')
  active = host
  await expect(host.call('updateReview', { number: 1, action: 'draft' })).rejects.toMatchObject({
    message: 'action must be edit, close, reopen, or ready.', ...reason('validation_error')
  })
  expect(host.invocations()).toEqual([])
})

test('GitLab review results, errors, and events never expose the token', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest()]
  const events = await listenForEvents(world)
  const result = await world.call('forBranch')
  expect(JSON.stringify(result)).not.toContain('dummy-gitlab-token')

  world.server.failures.set(`GET ${listPath(world)}`, {
    status: 500, body: { message: 'dummy-gitlab-token must not be returned' }
  })
  const failedLookup = await world.call('forBranch', { fresh: true })
  expect(failedLookup).toMatchObject({ kind: 'unavailable', reason: 'server_error' })
  expect(JSON.stringify(failedLookup)).not.toContain('dummy-gitlab-token')

  await world.call('updateReview', { number: 5, action: 'close' })
  world.server.failures.set(`PUT ${reviewPath(world, 5)}`, {
    status: 500, body: { message: 'dummy-gitlab-token must not be returned' }
  })
  let failure: unknown
  try {
    await world.call('updateReview', { number: 5, action: 'reopen' })
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject(reason('server_error'))
  const failureFields = failure as { message?: unknown; data?: unknown }
  expect(JSON.stringify({ message: failureFields?.message, data: failureFields?.data })).not.toContain('dummy-gitlab-token')
  expect(JSON.stringify(events)).not.toContain('dummy-gitlab-token')
  expect(world.glabInvocations()).toEqual([])
})
