import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  closeCaptureTerminalFixture,
  createCaptureTerminalFixture,
  createIsolatedRuntimeEnvironment,
  createLoopFixture,
  createTranscriptFixture,
  prepareCaptureFixtureHome,
  prepareProviderExecutables,
  registerCaptureFixtures,
  seedWorktreeStatuses,
  type FixtureRpcClient,
  type FixtureStatus,
  type PreparedCaptureFixtureHome,
  type RegisteredCaptureFixtures
} from './fixtures'
import { fixtureIssue, fixturePullRequest } from '../../plugins/quirky.tasks/test/fixtures/list'
import { createProcessRunner } from '../../packages/process/src/api'
import type { ProcessRunner } from '@quirky/protocol'
import { resolveCodexThroughLoginShell } from '../../plugins/quirky.structured/codex-path'

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

test('isolated provider logins write disposable credentials and guard the host Keychain', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000, env })
  try {
    const bin = join(home, 'fakebin')
    const browserLog = join(home, 'browser-url')
    const browser = join(bin, 'fixture-browser')
    writeFileSync(browser, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(browserLog)}, process.argv[2])\n`, { mode: 0o700 })
    const providerEnv = { ...env, CLAUDE_CONFIG_DIR: join(home, 'claude-login'), CODEX_HOME: join(home, 'codex-login'), BROWSER: browser }
    for (const [provider, version] of [['claude', 'Claude Code 2.1.80\n'], ['codex', 'codex 1.0.0\n']]) {
      const executable = join(bin, provider!)
      for (const flag of ['--version', '-v']) {
        const result = Bun.spawnSync([executable, flag], { env: providerEnv })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toBe(version!)
      }
      expect(Bun.spawnSync([executable, 'login'], { env: providerEnv }).exitCode).toBe(0)
    }
    expect(JSON.parse(readFileSync(join(providerEnv.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8')))
      .toEqual({ oauthAccount: { emailAddress: 'claude@example.test', organizationUuid: 'fixture-org', organizationName: 'Fixture Org' } })
    const claudeCredentials = join(providerEnv.CLAUDE_CONFIG_DIR, '.credentials.json')
    expect(JSON.parse(readFileSync(claudeCredentials, 'utf8')).claudeAiOauth.accessToken).toBe('fixture-claude-token')
    expect(statSync(claudeCredentials).mode & 0o777).toBe(0o600)
    expect(readFileSync(browserLog, 'utf8')).toContain('https://claude.ai/oauth/authorize?client_id=fixture')
    const codexCredentials = join(providerEnv.CODEX_HOME, 'auth.json')
    const auth = JSON.parse(readFileSync(codexCredentials, 'utf8'))
    expect(auth.auth_mode).toBe('chatgpt')
    expect(auth.tokens.account_id).toBe('fixture-workspace')
    expect(JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString()).email).toBe('codex@example.test')
    expect(statSync(codexCredentials).mode & 0o777).toBe(0o600)
    for (const action of ['find-generic-password', 'delete-generic-password']) {
      expect(Bun.spawnSync([join(bin, 'security'), action], { env }).exitCode).toBe(44)
    }
    expect(Bun.spawnSync([join(bin, 'security'), 'other'], { env }).exitCode).toBe(2)
  } finally {
    prepared.cleanup()
  }
})

test('fake gh answers the Reviews routes and delegates other commands to the Tasks fixture', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000, env })
  try {
    const gh = localFixtureGhPath(home, env)
    const rateLimit = JSON.parse(runFixtureGh(gh, ['api', 'rate_limit'], home, env))
    expect(rateLimit.resources).toEqual({
      core: { limit: 5000, remaining: 4200, reset: 1999999999 },
      search: { limit: 30, remaining: 28, reset: 1999999999 },
      graphql: { limit: 5000, remaining: 4000, reset: 1999999999 }
    })

    expect(JSON.parse(runFixtureGh(gh, ['api', '--hostname=github.com', 'rate_limit'], home, env)))
      .toEqual(rateLimit)
    expect(JSON.parse(runFixtureGh(gh, [
      'api',
      '--hostname', 'github.com',
      `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls?head=fixture-owner:ui-review-ready&state=all&per_page=100`,
      '-X', 'GET'
    ], home, env))).toEqual([])

    for (const head of ['fixture-owner:ui-review-ready', 'fixture-owner:main']) {
      expect(JSON.parse(runFixtureGh(gh, [
        'api',
        `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls?head=${head}&state=all&per_page=100`,
        '-X', 'GET'
      ], home, env))).toEqual([])
    }
    expect(JSON.parse(runFixtureGh(gh, [
      'api',
      `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls?head=fixture-owner:feature/capture-fixture-tasks&state=all&per_page=100`,
      '-X', 'GET'
    ], home, env))).toEqual([{
      number: 32,
      state: 'open',
      head: {
        ref: 'feature/capture-fixture-tasks',
        repo: { name: TASKS_FIXTURE_REPO, owner: { login: TASKS_FIXTURE_OWNER } }
      }
    }])
    expect(JSON.parse(runFixtureGh(gh, ['repo', 'view', '--json', 'defaultBranchRef'], home, env)))
      .toEqual({ defaultBranchRef: { name: 'main' } })

    const query = `repo:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO} is:issue is:open`
    const delegated = JSON.parse(runFixtureGh(gh, [
      'api', `search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=100&page=1`
    ], home, env))
    expect(delegated.total_count).toBe(1)
    expect(delegated.items[0].number).toBe(31)
  } finally {
    prepared.cleanup()
  }
})

test('provider environment is pinned to fixture executables and the private worker bridge', () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home, { repoRoot: '/repo/fixture' })

  expect(env.QUIRKY_AGENT_SEARCH_DIRS).toBe(join(home, 'fakebin'))
  expect(env.WORKER_TEST_CLI).toBe(join('/repo/fixture', 'packages/cli/src/main.ts'))
  expect(env.WORKER_TEST_CLI).toBe(env.QUIRKY_CLI_ENTRY)

  const withoutRepo = createIsolatedRuntimeEnvironment(home)
  expect(withoutRepo.QUIRKY_AGENT_SEARCH_DIRS).toBe(join(home, 'fakebin'))
  expect(withoutRepo.WORKER_TEST_CLI).toBeUndefined()
})

test('fixture login shell resolves local Codex without reading a hostile profile', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  prepareProviderExecutables(home)
  const profileMarker = join(home, 'profile-was-loaded')
  writeFileSync(join(home, '.profile'), `touch '${profileMarker}'\nPATH=/usr/bin:/bin\nexport PATH\n`)
  const processRunner = createProcessRunner({ owner: 'ui-review-fixture-login-shell-test' })
  const runner: ProcessRunner = {
    run: (argv, options) => processRunner.run(argv, { ...(options ?? {}), env })
  }
  try {
    expect(env.SHELL).toBe(join(home, 'fakebin', 'sh'))
    expect(env.PATH.split(delimiter)[0]).toBe(join(home, 'fakebin'))
    expect(await resolveCodexThroughLoginShell(runner, env.SHELL)).toBe(join(home, 'fakebin', 'codex'))
    expect(existsSync(profileMarker)).toBe(false)
  } finally {
    await processRunner.dispose()
  }
})

test('codex forwards app-server to the native fixture executable', async () => {
  const home = freshHome()
  prepareProviderExecutables(home)
  const env = { ...createIsolatedRuntimeEnvironment(home), CODEX_HOME: join(home, 'codex') }
  const codex = join(home, 'fakebin', 'codex')
  const child = Bun.spawn([codex, 'app-server'], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    child.stdin.write('{"id":1,"method":"initialize","params":{}}\n')
    child.stdin.end()
    const result = await Promise.race([
      Promise.all([child.exited, stdout, stderr]),
      Bun.sleep(5_000).then(() => { throw new Error('codex app-server fixture exceeded 5000ms') })
    ])
    expect(result[0]).toBe(0)
    expect(JSON.parse(result[1])).toEqual({
      id: 1,
      result: { userAgent: 'codex-fixture', platformFamily: 'unix', platformOs: 'macos' }
    })
    expect(result[2]).toBe('')
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(500).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(500)])
      }
    }
  }
})

test('claude launches the acceptance agent only with both private bridge variables set', async () => {
  const home = freshHome()
  prepareProviderExecutables(home)
  const cli = join(home, 'fixture-cli.ts')
  writeFileSync(cli, "process.stdout.write(JSON.stringify({ ok: true }))\n")
  const session = 'provider-fixture-session'
  const child = Bun.spawn([join(home, 'fakebin', 'claude')], {
    env: {
      ...createIsolatedRuntimeEnvironment(home),
      QUIRKY_SESSION_ID: session,
      WORKER_TEST_CLI: cli
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stdout = new Response(child.stdout).text()
  try {
    const root = join(home, 'worker-fixture')
    const eventsPath = join(root, `${session}.events.jsonl`)
    const requestsPath = join(root, `${session}.requests.jsonl`)
    const readyDeadline = Date.now() + 5_000
    while (!existsSync(eventsPath) && Date.now() < readyDeadline) await Bun.sleep(25)
    expect(existsSync(eventsPath)).toBe(true)
    expect(readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).type))
      .toContain('started')

    appendFileSync(requestsPath, `${JSON.stringify({ id: 'fixture-request-1', args: ['probe'] })}\n`)
    const replyPath = join(root, 'fixture-request-1.reply.json')
    const replyDeadline = Date.now() + 5_000
    while (!existsSync(replyPath) && Date.now() < replyDeadline) await Bun.sleep(25)
    expect(existsSync(replyPath)).toBe(true)
    expect(JSON.parse(readFileSync(replyPath, 'utf8'))).toMatchObject({
      code: 0,
      stdout: '{"ok":true}',
      stderr: ''
    })
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(500).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(500)])
      }
    }
  }
  const output = await stdout
  expect(output.startsWith('\x1b[?2004h')).toBe(true)
  expect(output).toContain('● Ready.')
})

test('claude stays silent and alive without the private worker CLI', async () => {
  const home = freshHome()
  prepareProviderExecutables(home)
  const env: Record<string, string> = { ...createIsolatedRuntimeEnvironment(home), QUIRKY_SESSION_ID: 'idle-provider-session' }
  delete env.WORKER_TEST_CLI
  const child = Bun.spawn([join(home, 'fakebin', 'claude')], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const reader = child.stdout.getReader()
  const firstOutput = reader.read()
  try {
    const activity = await Promise.race([
      firstOutput.then(() => 'output'),
      Bun.sleep(500).then(() => 'quiet')
    ])
    expect(activity).toBe('quiet')
    expect(child.exitCode).toBeNull()
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(500).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(500)])
      }
    }
    await firstOutput
  }
})

test('transcript fixture records four turns on a titled shell session', async () => {
  const home = freshHome()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = {
    home,
    primaryWorktree: { id: 'worktree:primary', path: join(home, 'projects', 'primary') }
  } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.terminal/newTab') return { session: 'session:transcript', tab: 'tab:transcript', pane: 'pane:transcript' }
      return { ok: true }
    }
  }

  const transcript = await createTranscriptFixture(client, fixtures, { timeoutMs: 1_000 })
  const contents = readFileSync(transcript.transcriptPath, 'utf8')
  const rows = contents.trimEnd().split('\n').map((line) => JSON.parse(line))

  expect(transcript).toEqual({
    sessionId: 'session:transcript',
    transcriptPath: join(home, 'transcripts', 'ui-review-transcript.jsonl')
  })
  expect(rows).toHaveLength(4)
  expect(rows.map((row) => row.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
  expect(contents).toContain('Summarize the fixture change.')
  expect(contents).toContain('All provider and GitHub activity stays inside this fixture.')
  expect(calls).toEqual([
    {
      method: 'quirky.terminal/newTab',
      params: {
        workspace: fixtures.primaryWorktree.id,
        cwd: fixtures.primaryWorktree.path,
        agent: 'shell',
        title: 'UI Review Transcript',
        activate: true
      }
    },
    {
      method: 'quirky.session/setProviderSession',
      params: {
        session: transcript.sessionId,
        id: 'ui-review-transcript',
        transcriptPath: transcript.transcriptPath
      }
    }
  ])
})

test('terminal fixtures honor titles and close their own tab with confirmation', async () => {
  const home = freshHome()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = {
    primaryWorktree: { id: 'worktree:primary', path: join(home, 'projects', 'primary') }
  } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      return { session: 'session:cell', tab: 'tab:cell', pane: 'pane:cell' }
    }
  }

  const terminal = await createCaptureTerminalFixture(client, fixtures, { timeoutMs: 1_000 }, 'UI Review Handoff')
  await closeCaptureTerminalFixture(client, terminal, { timeoutMs: 1_000 })

  expect(calls).toEqual([
    {
      method: 'quirky.terminal/newTab',
      params: {
        workspace: fixtures.primaryWorktree.id,
        cwd: fixtures.primaryWorktree.path,
        agent: 'shell',
        title: 'UI Review Handoff',
        activate: true
      }
    },
    { method: 'quirky.terminal/closeTab', params: { tab: terminal.tabId, yes: true } }
  ])
})

test('loop fixture enables Codex, creates one iteration, and polls to the cap pause', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let polls = 0
  const fixtures = { primaryWorktree: { id: 'worktree:primary' } } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/create') return { id: 'loop:fixture' }
      if (method === 'quirky.loops/get') {
        polls += 1
        return polls === 1
          ? { id: 'loop:fixture', state: 'running', iterationsCompleted: 0 }
          : { id: 'loop:fixture', state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 1 }
      }
      return { ok: true }
    }
  }

  await expect(createLoopFixture(client, fixtures, { timeoutMs: 1_000 })).resolves.toEqual({ loopId: 'loop:fixture' })

  expect(calls.slice(0, 3)).toEqual([
    { method: 'quirky.agents/refresh', params: {} },
    { method: 'quirky.agents/setEnabled', params: { agent: 'codex', enabled: true } },
    {
      method: 'quirky.loops/create',
      params: {
        worktreeId: fixtures.primaryWorktree.id,
        name: 'UI review loop',
        agent: 'codex',
        config: {
          promptSource: { kind: 'repeat', body: 'Summarize the fixture change in one sentence.' },
          pacing: { kind: 'on-idle' },
          sessionPolicy: 'fresh',
          done: {},
          caps: { maxIterations: 1 },
          noProgress: false,
          checkpointCommits: false,
          askBeforeNext: false,
          resumeAtLimitReset: false
        }
      }
    }
  ])
  expect(polls).toBe(2)
})

test('loop fixture stops a failed loop and reports the refused step', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = { primaryWorktree: { id: 'worktree:primary' } } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/create') return { id: 'loop:fixture' }
      if (method === 'quirky.loops/get') throw new Error('snapshot unavailable')
      return { ok: true }
    }
  }

  await expect(createLoopFixture(client, fixtures, { timeoutMs: 1_000 }))
    .rejects.toThrow('loop fixture quirky.loops/get: snapshot unavailable')
  expect(calls.at(-1)).toEqual({
    method: 'quirky.loops/stop',
    params: { loopId: 'loop:fixture', mode: 'now' }
  })
})

test('loop fixture times out with its last snapshot and stops the loop', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = { primaryWorktree: { id: 'worktree:primary' } } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/create') return { id: 'loop:fixture' }
      if (method === 'quirky.loops/get') return { id: 'loop:fixture', state: 'running', iterationsCompleted: 0 }
      return { ok: true }
    }
  }

  await expect(createLoopFixture(client, fixtures, { timeoutMs: 40 }))
    .rejects.toThrow(/loop fixture quirky\.loops\/get: timed out after 40ms; last snapshot .*"state":"running"/)
  expect(calls.at(-1)).toEqual({
    method: 'quirky.loops/stop',
    params: { loopId: 'loop:fixture', mode: 'now' }
  })
})
