import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  createIsolatedRuntimeEnvironment,
  prepareCaptureFixtureHome,
  registerCaptureFixtures,
  seedWorktreeStatuses,
  type FixtureStatus,
  type PreparedCaptureFixtureHome
} from './fixtures'
import { fixtureIssue, fixturePullRequest } from '../../plugins/quirky.tasks/test/fixtures/list'

const TASKS_FIXTURE_OWNER = 'fixture-owner'
const TASKS_FIXTURE_REPO = 'ui-review-fixture'
const TASKS_FIXTURE_ORIGIN = `git@github.com:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}.git`

function expectedTasksItems() {
  const issue = fixtureIssue(TASKS_FIXTURE_OWNER, TASKS_FIXTURE_REPO, 31, '2026-11-01T12:00:00Z')
  issue.title = 'Review the capture fixture issue'
  issue.labels = ['bug', 'needs review']

  const pullRequest = fixturePullRequest(TASKS_FIXTURE_OWNER, TASKS_FIXTURE_REPO, 32, '2026-11-02T12:00:00Z', [
    { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', url: `https://github.com/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/actions/runs/32` }
  ])
  pullRequest.title = 'Add capture fixture Tasks data'
  pullRequest.headRefName = 'feature/capture-fixture-tasks'
  pullRequest.reviewDecision = 'REVIEW_REQUIRED'
  pullRequest.requestedReviewers = ['reviewer-one']
  pullRequest.reviews = [{ author: 'reviewer-two', state: 'APPROVED' }]
  pullRequest.additions = 84
  pullRequest.deletions = 12
  pullRequest.changedFiles = 5

  return { issue, pullRequest }
}

function localFixtureGhPath(home: string, env: Record<string, string>): string {
  const binDirectory = env.PATH.split(delimiter).find((entry) =>
    entry.startsWith(`${home}/`) && existsSync(join(entry, 'gh'))
  )
  if (!binDirectory) throw new Error('prepared fixture did not add its local gh executable to PATH')
  return join(binDirectory, 'gh')
}

function runFixtureGh(ghPath: string, args: string[], cwd: string, env: Record<string, string>): string {
  const result = Bun.spawnSync([ghPath, ...args], { cwd, env, stdin: 'ignore' })
  const stdout = result.stdout.toString()
  if (result.exitCode !== 0) {
    throw new Error(`local fixture gh ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
  }
  return stdout
}

function gitOrigin(path: string, env: Record<string, string>): string | null {
  const result = Bun.spawnSync(['git', '-C', path, 'config', '--get', 'remote.origin.url'], { env, stdin: 'ignore' })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

const temporaryHomes: string[] = []

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-ui-review-fixture-test-'))
  temporaryHomes.push(home)
  return home
}

function fakeFixtureClient(
  prepared: PreparedCaptureFixtureHome,
  failAt?: string
): { callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> } {
  let created = 0
  return {
    async callAny(method: string, params: Record<string, unknown> = {}, _options?: { timeoutMs?: number }) {
      if (method === failAt) throw new Error(`fixture RPC failed at ${method}`)
      if (method === 'quirky.repo/add') return { id: `repo:${String(params.path).split('/').pop()}` }
      if (method === 'quirky.worktree/list') {
        const repoId = String(params.repo)
        const project = prepared.projects.find((candidate) => `repo:${candidate.name}` === repoId)!
        return [{ id: `worktree:${project.name}-main`, repoId, path: project.path, name: project.name, isMain: true, kind: 'git' }]
      }
      if (method === 'quirky.worktree/create') {
        created += 1
        const name = String(params.name)
        return { worktree: {
          id: `worktree:ui-review-${created}`, repoId: String(params.repo),
          path: join(prepared.worktreesRoot, name), name, isMain: false, kind: 'git'
        } }
      }
      return { ok: true }
    }
  }
}

test('removes fixture files when public registration fails', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const client = fakeFixtureClient(prepared, 'quirky.worktree/create')

  await expect(registerCaptureFixtures(client, prepared, { timeoutMs: 2_000 })).rejects.toThrow(/fixture RPC failed/)

  expect(existsSync(prepared.repoPath)).toBe(false)
  expect(existsSync(prepared.worktreesRoot)).toBe(false)
})

test('repeated cleanup is safe after a successful fixture registration', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })

  registered.cleanup()
  registered.cleanup()

  expect(existsSync(prepared.repoPath)).toBe(false)
})


test('registers three projects whose worktrees cover every status dot', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })

  expect(prepared.projects).toHaveLength(3)
  for (const project of prepared.projects) expect(existsSync(join(project.path, '.git'))).toBe(true)
  expect(new Set(registered.worktrees.map((worktree) => worktree.repoId)).size).toBe(3)
  expect(new Set(registered.worktrees.map((worktree) => worktree.status))).toEqual(
    new Set<FixtureStatus>(['working', 'needs-you', 'failing', 'done', 'idle'])
  )
  expect(registered.worktrees.every((worktree) => worktree.id.length > 0 && worktree.path.startsWith(home))).toBe(true)
  expect(registered.primaryWorktree.repoId).toBe(registered.repo.id)
  registered.cleanup()
  for (const project of prepared.projects) expect(existsSync(project.path)).toBe(false)
})

test('seeds one agent session per non-idle worktree and waits for its status', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })
  const hooksBySession = new Map<string, string[]>()
  const sessions = new Map<string, string>()
  const displayOf: Record<string, string> = { UserPromptSubmit: 'working', PermissionRequest: 'waiting', StopFailure: 'failed', Stop: 'done' }
  const client = {
    async callAny(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.terminal/newTab') {
        const session = `session:${sessions.size + 1}`
        sessions.set(session, String(params.workspace))
        return { session, tab: 'tab', pane: 'pane' }
      }
      if (method === 'quirky.agent-status/list') {
        return [...hooksBySession].map(([sessionId, events]) => ({ sessionId, display: displayOf[events.at(-1)!] }))
      }
      return { ok: true }
    }
  }
  const posted: Array<{ url: string; token: string | null }> = []
  const fakeFetch = async (url: string, init: RequestInit) => {
    const session = new URL(url).searchParams.get('session')!
    const event = (JSON.parse(String(init.body)) as { hook_event_name: string }).hook_event_name
    hooksBySession.set(session, [...(hooksBySession.get(session) ?? []), event])
    posted.push({ url, token: new Headers(init.headers).get('x-quirky-hook-token') })
    return { ok: true, status: 200 }
  }

  await seedWorktreeStatuses(client, registered, { port: 4321, hookToken: 'hook-token-value-1234' }, { timeoutMs: 2_000, fetch: fakeFetch })

  const wanted = registered.worktrees.filter((worktree) => worktree.status !== 'idle')
  expect(sessions.size).toBe(wanted.length)
  expect([...hooksBySession.values()].map((events) => displayOf[events.at(-1)!]).sort()).toEqual(['done', 'failed', 'waiting', 'working'])
  expect(posted.every((hook) => hook.url.startsWith('http://127.0.0.1:4321/hook/claude?session=') && hook.token === 'hook-token-value-1234')).toBe(true)
  registered.cleanup()
})

test('a rejected agent hook fails seeding instead of leaving a silent idle dot', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })
  const client = { async callAny() { return { session: 'session:1' } } }

  await expect(seedWorktreeStatuses(client, registered, { port: 1, hookToken: 'x'.repeat(24) }, {
    timeoutMs: 2_000,
    fetch: async () => ({ ok: false, status: 401 })
  })).rejects.toThrow(/rejected with status 401/)
  registered.cleanup()
})

test('prepares populated Tasks data behind an isolated local gh executable', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000, env })
  try {
    const ghPath = localFixtureGhPath(home, env)
    expect(env.PATH.split(delimiter)[0]).toBe(dirname(ghPath))
    const fixtureDir = env.QUIRKY_TEST_FIXTURE_DIR
    expect(fixtureDir.startsWith(`${home}/`)).toBe(true)
    expect(existsSync(join(fixtureDir, 'state.json'))).toBe(true)
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(env[name]).toBeUndefined()
    }

    const version = runFixtureGh(ghPath, ['--version'], home, env)
    expect(version).toMatch(/^gh version \d/)
    const tokenHelp = runFixtureGh(ghPath, ['auth', 'token', '--help'], home, env)
    expect(tokenHelp).toContain('--user')
    expect(runFixtureGh(ghPath, ['auth', 'token', '--hostname', 'github.com', '--user', 'fixture-user'], home, env).trim())
      .toBe('ui-review-capture-fixture-token')
    expect(runFixtureGh(ghPath, ['auth', 'status', '--hostname', 'github.com'], home, env))
      .toContain('Logged in to github.com account fixture-user (keyring)')

    const { issue, pullRequest } = expectedTasksItems()
    const issueQuery = `repo:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO} is:issue is:open`
    const issues = JSON.parse(runFixtureGh(ghPath, [
      'api',
      `search/issues?q=${encodeURIComponent(issueQuery)}&sort=created&order=desc&per_page=100&page=1`
    ], home, env)) as { total_count: number; items: Record<string, unknown>[] }
    expect(issues.total_count).toBe(1)
    expect(issues.items).toHaveLength(1)
    expect(issues.items[0]).toMatchObject({
      number: issue.number,
      title: issue.title,
      state: 'OPEN',
      html_url: issue.url,
      updated_at: issue.updatedAt,
      user: { login: issue.author },
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login }))
    })

    const pullRequestQuery = `repo:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO} is:pr is:open`
    const pullRequests = JSON.parse(runFixtureGh(ghPath, [
      'pr', 'list', '--limit', '100', '--state', 'all',
      '--json', 'number,title,url,state,isDraft,headRefName,reviewDecision,reviewRequests,reviews,additions,deletions,changedFiles',
      '--repo', `${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}`, '--search', pullRequestQuery
    ], home, env)) as Record<string, unknown>[]
    expect(pullRequests).toHaveLength(1)
    expect(pullRequests[0]).toMatchObject({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      state: 'OPEN',
      isDraft: false,
      headRefName: pullRequest.headRefName,
      reviewDecision: pullRequest.reviewDecision,
      reviewRequests: [{ login: 'reviewer-one' }],
      reviews: [{ author: { login: 'reviewer-two' }, state: 'APPROVED' }],
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changedFiles
    })

    const checks = JSON.parse(runFixtureGh(ghPath, [
      'api', 'graphql',
      '-f', 'query=query HostingChecksRollup { repository { pullRequest { headRefOid } } }',
      '-F', `owner=${TASKS_FIXTURE_OWNER}`,
      '-F', `name=${TASKS_FIXTURE_REPO}`,
      '-F', `number=${pullRequest.number}`
    ], home, env))
    expect(checks.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes)
      .toMatchObject([{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }])

    const origins = prepared.projects.map((project) => gitOrigin(project.path, env))
    expect(origins).toEqual([TASKS_FIXTURE_ORIGIN, null, null])
    const sshPath = join(home, 'fakebin', 'ssh-deny')
    const sshConfig = Bun.spawnSync(['git', '-C', prepared.repoPath, 'config', '--get', 'core.sshCommand'], { env })
    expect(sshConfig.exitCode).toBe(0)
    expect(sshConfig.stdout.toString()).toContain(sshPath)
    expect(existsSync(sshPath)).toBe(true)
    expect(Bun.spawnSync([sshPath, '-T', 'git@github.com'], { env, stdin: 'ignore' }).exitCode).toBe(1)
  } finally {
    prepared.cleanup()
  }
})
