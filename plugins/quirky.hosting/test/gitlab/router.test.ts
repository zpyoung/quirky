import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from '../helpers'
import { bootGitLab, type GitLabWorld } from './world'
import type { Handler, HostingEnv } from '../../src/env'
import { routeByProvider } from '../../src/gitlab/router'
import { mergeRequest } from './stand-in'

let world: HostingTest | undefined
async function boot(options: Parameters<typeof bootGitLab>[0] = {}): Promise<GitLabWorld> {
  const value = await bootGitLab(options)
  world = value
  return value
}
afterEach(async () => { await world?.cleanup(); world = undefined })
const reason = (value: string) => ({ data: { reason: value } })

test('subgroups route repository identity without credentials or requests, including CLI', async () => {
  const w = await boot()
  const expected = { provider: 'gitlab', worktreeId: w.worktree, origin: w.identity, head: w.identity, repository: w.identity, candidates: [w.identity], issueRepository: w.identity, issueSourcePreference: 'origin', issueSourceFellBack: false, apiBase: `${w.server.url}/api/v4` }
  expect(await w.call('repository')).toEqual(expected)
  const cli = await w.cli(['--json', 'hosting', 'repository', '--worktree', w.worktree])
  expect(cli.code).toBe(0)
  expect(JSON.parse(cli.stdout)).toEqual(expected)
  expect(w.server.requests).toEqual([])
  expect(w.glabInvocations()).toEqual([])
  expect(w.invocations()).toEqual([])
})

test('unlisted hosts retain the GitHub unsupported-provider error', async () => {
  const w = await boot({ remote: 'https://gitlab.example.com/a/b.git', ghSource: 'process.stdout.write("{}")' })
  await expect(w.call('repository')).rejects.toMatchObject({ message: 'The origin remote is not GitHub.com or a host authenticated by gh.', ...reason('unsupported_provider') })
  expect(w.server.requests).toEqual([])
  expect(w.glabInvocations()).toEqual([])
})

test('GitHub repository keeps its existing shape and path', async () => {
  world = await bootHosting('process.stdout.write("{}")')
  const value = await world.call('repository') as Record<string, any>
  expect(value.origin).toEqual({ host: 'github.com', owner: 'test-owner', repo: 'test-repo' })
  expect(value.provider).toBeUndefined()
  expect(world.invocations()).toEqual([])
})

test('GitLab refuses every unimplemented method before auth or network; cachedReviews passes through', async () => {
  const w = await boot()
  const requests: Record<string, Record<string, unknown>> = {
    merge: { number: 5, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct' }, autoMerge: { number: 5, action: 'enable', method: 'squash' }, createStacked: { title: 'x', parentNumber: 5 }, reviewers: { number: 5, action: 'add', logins: ['x'] }, reviewAssignees: { number: 5, action: 'add', logins: ['x'] }, reviewStack: { number: 5 }, pushRepository: { remote: 'origin' }, rerunChecks: { number: 5, failedOnly: true }, reaction: { number: 5, action: 'add', subjectId: 'x', content: '+1' }, fileViewed: { number: 5, path: 'x', viewed: true }, files: { number: 5 }, fileContents: { number: 5, path: 'x', side: 'head' }, rateLimit: {}, accounts: {}, configure: {}, configuration: {}
  }
  for (const [method, params] of Object.entries(requests)) {
    await expect(w.call(method, { ...params, ...(method === 'merge' ? { yes: true } : {}) })).rejects.toMatchObject({ message: `GitLab hosting does not answer quirky.hosting/${method} yet.`, ...reason('unsupported_provider') })
  }
  const cached = await w.client.callAny('quirky.hosting/cachedReviews', { worktrees: [w.worktree] })
  expect(cached).toMatchObject({ workspaces: [{ worktreeId: w.worktree, branch: 'feature', review: null, stale: false }] })
  expect(w.server.requests).toEqual([])
  expect(w.glabInvocations()).toEqual([])
})

test('environment auth reports account and scope without running glab or exposing token', async () => {
  const w = await boot()
  const value = await w.call('diagnoseAuth')
  expect(value).toEqual({ provider: 'gitlab', tokenSource: 'env', glabAvailable: null, tokenRejected: false, activeAccount: { host: w.identity.host, user: 'fixture-user' }, accounts: [{ host: w.identity.host, user: 'fixture-user', source: 'env', active: true, scopes: ['api'] }], envTokenInProcess: true, missingScopes: [], requiredScopes: ['api'], hasKeyringFallback: false, requiredHost: w.identity.host, requiredHostAuthenticated: true })
  expect(w.server.requests.map(r => [r.method, r.path])).toEqual([['GET', '/api/v4/user'], ['GET', '/api/v4/personal_access_tokens/self']])
  expect(w.server.requests.every(r => r.authorization === 'Bearer dummy-gitlab-token')).toBe(true)
  expect(JSON.stringify(value)).not.toContain('dummy-gitlab-token')
  expect(w.glabInvocations()).toEqual([])
})

test('scope diagnosis distinguishes missing scopes from unknown OAuth scopes', async () => {
  const w = await boot()
  w.server.scopes = ['read_api']
  expect(await w.call('diagnoseAuth')).toMatchObject({ missingScopes: ['api'], requiredHostAuthenticated: true })
  w.server.failures.set('GET /api/v4/personal_access_tokens/self', { status: 404 })
  expect(await w.call('diagnoseAuth')).toMatchObject({ missingScopes: [], accounts: [{ scopes: [] }], requiredHostAuthenticated: true })
})

test('rejected token resolves diagnosis rather than throwing', async () => {
  const w = await boot({ token: 'wrong' })
  expect(await w.call('diagnoseAuth')).toMatchObject({ tokenRejected: true, activeAccount: null, accounts: [], requiredHostAuthenticated: false })
})

test('glab token is host-specific, noninteractive, and cached', async () => {
  const w = await boot({ token: null, glabOutput: 'dummy-gitlab-token\n' })
  expect(await w.call('diagnoseAuth')).toMatchObject({ tokenSource: 'glab', glabAvailable: true, requiredHostAuthenticated: true })
  await w.call('diagnoseAuth')
  const calls = w.glabInvocations()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.args).toEqual(['config', 'get', 'token', '--host', w.identity.host])
  expect(calls[0]?.env).toMatchObject({ GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false', GLAB_NO_PROMPT: 'true' })
  for (const key of ['GITLAB_HOST', 'GITLAB_URI', 'GL_HOST']) expect(calls[0]?.env[key]).toBeUndefined()
})

for (const glabExit of [0, 1]) test(`silent glab exit ${glabExit} is unauthenticated without requests`, async () => {
  const w = await boot({ token: null, glabOutput: '', glabExit })
  expect(await w.call('diagnoseAuth')).toMatchObject({ tokenSource: null, glabAvailable: true, requiredHostAuthenticated: false })
  await expect(w.call('forBranch')).rejects.toMatchObject({ message: 'GitLab authentication is unavailable. Set GITLAB_TOKEN or run glab auth login.', ...reason('auth_required') })
  expect(w.server.requests).toEqual([])
})

test('viewer caches successful identity for thirty seconds', async () => {
  const w = await boot()
  expect(await w.call('viewer')).toEqual({ login: 'fixture-user' })
  expect(await w.call('viewer')).toEqual({ login: 'fixture-user' })
  expect(w.server.requests.map(r => r.path)).toEqual(['/api/v4/user'])
  expect(w.glabInvocations()).toEqual([])
})

test('redirects never forward the credential to a second server', async () => {
  let requests = 0
  const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json({ username: 'wrong' }) } })
  try {
    const w = await boot()
    w.server.failures.set('GET /api/v4/user', { status: 302, headers: { Location: target.url.toString() } })
    await expect(w.call('viewer')).rejects.toMatchObject(reason('redirect_refused'))
    expect(requests).toBe(0)
  } finally { await target.stop(true) }
})

test('a future GitHub-only method is refused by default on a GitLab origin', async () => {
  let githubCalls = 0
  const env = {
    context: { getSetting: () => 'gitlab.com', process: {} },
    resolveWorktree: async () => ({ id: 'fixture', kind: 'git' }),
    remoteUrls: async () => ({ origin: 'https://gitlab.com/group/sub/proj.git', upstream: null }),
    invalid: (reason: string, message: string) => Object.assign(new Error(message), { data: { reason } })
  } as unknown as HostingEnv
  const table = routeByProvider(env, { futureGitHubOnly: async () => { githubCalls++; return 'wrong provider' } })
  await expect(table.futureGitHubOnly!({}, {} as Parameters<Handler>[1])).rejects.toMatchObject({
    message: 'GitLab hosting does not answer quirky.hosting/futureGitHubOnly yet.',
    data: { reason: 'unsupported_provider' }
  })
  expect(githubCalls).toBe(0)
})

const pinnedCalls: Array<{ method: string; params: Record<string, unknown> }> = [
  { method: 'forBranch', params: {} },
  { method: 'review', params: { number: 5 } },
  { method: 'comments', params: { number: 5 } },
  { method: 'updateReview', params: { number: 5, action: 'close' } },
  { method: 'reviewComment', params: { number: 5, action: 'inline', headSha: 'a'.repeat(40), path: 'src/a.ts', line: 12, body: 'nit' } },
  { method: 'resolveThread', params: { number: 5, threadId: 'a'.repeat(40), action: 'resolve' } },
  { method: 'reviewConversation', params: { number: 5, action: 'add', body: 'lgtm' } },
  { method: 'reviewConversationConfirmation', params: { number: 5, action: 'add', body: 'lgtm' } }
]

for (const { method, params } of pinnedCalls) test(`${method} rejects a foreign repository pin before credential lookup or network`, async () => {
  const w = await boot({ token: null, glabOutput: 'dummy-gitlab-token' })
  w.server.mergeRequests = [mergeRequest()]
  await expect(w.call(method, { ...params, prRepo: { ...w.identity, owner: 'different', repo: 'project' } })).rejects.toMatchObject(reason('repository_mismatch'))
  expect(w.server.requests).toEqual([])
  expect(w.glabInvocations()).toEqual([])
})

test('matching repository pins ignore letter case for reads and writes', async () => {
  const w = await boot()
  w.server.mergeRequests = [mergeRequest()]
  w.server.discussions = [{ id: 'a'.repeat(40), individual_note: false, notes: [{ id: 201, body: 'fix', author: { username: 'reviewer' }, created_at: '2026-01-01T00:00:00Z', system: false, resolvable: true, resolved: false }] }]
  const prRepo = { host: w.identity.host.toUpperCase(), owner: w.identity.owner.toUpperCase(), repo: w.identity.repo.toUpperCase() }
  expect(await w.call('forBranch', { prRepo })).toMatchObject({ kind: 'found', review: { number: 5 } })
  expect(await w.call('review', { number: 5, prRepo })).toMatchObject({ kind: 'found', review: { number: 5 } })
  expect(await w.call('comments', { number: 5, prRepo })).toMatchObject({ comments: [{ id: 201 }] })
  expect(await w.call('updateReview', { number: 5, action: 'close', prRepo })).toMatchObject({ number: 5, updated: true, state: 'closed' })
  expect(await w.call('reviewComment', { number: 5, action: 'inline', headSha: 'a'.repeat(40), path: 'src/a.ts', line: 12, body: 'nit', prRepo })).toMatchObject({ number: 5, action: 'inline', comment: { body: 'nit' } })
  expect(await w.call('resolveThread', { number: 5, threadId: 'a'.repeat(40), action: 'resolve', prRepo })).toMatchObject({ resolved: true })
  expect(await w.call('reviewConversation', { number: 5, action: 'add', body: 'lgtm', prRepo })).toMatchObject({ comment: { body: 'lgtm' } })
  expect(await w.call('reviewConversationConfirmation', { number: 5, action: 'add', body: 'lgtm', prRepo })).toBeNull()
})

test('a populated read cache never bypasses a mismatched pin or changes the origin', async () => {
  const w = await boot()
  w.server.mergeRequests = [mergeRequest()]
  await w.call('forBranch', { prRepo: w.identity })
  await w.call('review', { number: 5, prRepo: w.identity })
  await w.call('comments', { number: 5, prRepo: w.identity })
  const requestCount = w.server.requests.length
  const original = structuredClone(w.server.mergeRequests)
  for (const { method, params } of pinnedCalls) {
    await expect(w.call(method, { ...params, prRepo: { ...w.identity, repo: 'other' } })).rejects.toMatchObject(reason('repository_mismatch'))
  }
  expect(w.server.requests).toHaveLength(requestCount)
  expect(w.server.mergeRequests).toEqual(original)
})

test('unsupported methods retain unsupported-provider refusal even with a foreign pin', async () => {
  const w = await boot({ token: null })
  await expect(w.call('rerunChecks', { number: 5, failedOnly: true, prRepo: { ...w.identity, repo: 'other' } })).rejects.toMatchObject(reason('unsupported_provider'))
  expect(w.server.requests).toEqual([])
  expect(w.glabInvocations()).toEqual([])
})
