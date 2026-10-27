import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { bootHosting, type HostingTest } from './helpers'

const ghSource = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const statePath = process.env.QUIRKY_TEST_FIXTURE_DIR + '/state.json'
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)
appendFileSync(process.env.QUIRKY_TEST_GH_ACTIVITY, JSON.stringify({ event: 'start', pid: process.pid }) + '\n')
const key = args[0] === 'auth' && args[1] === 'token' && args.includes('--help') ? 'auth_help'
  : args[0] === 'auth' && args[1] === 'status' ? 'auth_status'
  : args[0] === 'auth' && args[1] === 'token' ? 'auth_token'
  : args[0] === 'api' && args.includes('rate_limit') ? 'rate_limit'
  : args[0] === 'api' && args.includes('user') ? 'user'
  : args[0] === 'api' && args.includes('graphql') ? 'graphql'
  : args[0] ?? 'other'
const command = state.responses?.[key] ?? {}
const count = (state.counts?.[key] ?? 0) + 1
state.counts = { ...(state.counts ?? {}), [key]: count }
writeFileSync(statePath, JSON.stringify(state))
const response = Array.isArray(command.attempts) ? (command.attempts[count - 1] ?? command.attempts.at(-1) ?? {}) : command
if (response.delayMs) await Bun.sleep(response.delayMs)
if (response.hang) await Bun.sleep(60_000)
if (response.repeatBytes) process.stdout.write('x'.repeat(response.repeatBytes))
else if (typeof response.stdout === 'string') process.stdout.write(response.stdout)
else if (response.stdout !== undefined) process.stdout.write(JSON.stringify(response.stdout))
else if (key === 'auth_status') process.stdout.write(state.authStatus ?? 'Logged in to github.com account fixture-user (keyring)\nActive account: true\nToken scopes: repo, read:org, project\n')
else if (key === 'auth_help') process.stdout.write('gh auth token [--user USER] [--hostname HOST]')
else if (key === 'auth_token') {
  const userAt = args.indexOf('--user')
  const user = userAt >= 0 ? args[userAt + 1] : 'fixture-user'
  process.stdout.write(state.tokens?.[user] ?? 'fixture-token-' + user)
}
else if (key === 'rate_limit') process.stdout.write(JSON.stringify(state.rateLimit ?? { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 }, search: { limit: 30, remaining: 29, reset: Math.floor(Date.now() / 1000) + 3600 }, graphql: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } }))
else if (key === 'user') process.stdout.write(JSON.stringify(state.viewer ?? { login: 'fixture-user', email: 'fixture@example.test' }))
else process.stdout.write('{}')
if (response.stderr) process.stderr.write(response.stderr)
appendFileSync(process.env.QUIRKY_TEST_GH_ACTIVITY, JSON.stringify({ event: 'end' }) + '\n')
process.exitCode = response.exitCode ?? 0
`

let running: HostingTest[] = []
afterEach(async () => {
  for (const host of running.splice(0).reverse()) await host.cleanup()
})

async function boot(options: Parameters<typeof bootHosting>[1] = {}): Promise<HostingTest> {
  const host = await bootHosting(ghSource, options)
  running.push(host)
  return host
}

describe('GH01-GH08: GitHub runtime boundary', () => {
  test('GH01 resolves standard GitHub remotes, SSH aliases, SSH ports, and authenticated enterprise hosts', async () => {
    const githubUrls = [
      'https://github.com/test-owner/test-repo.git',
      'git@github.com:test-owner/test-repo.git',
      'ssh://git@github.com:2222/test-owner/test-repo.git',
      'git@github-work:test-owner/test-repo.git'
    ]
    for (const remote of githubUrls) {
      const host = await boot({ remote })
      const result = await host.call('repository') as { origin: { host: string; owner: string; repo: string } }
      expect(result.origin).toEqual({ host: 'github.com', owner: 'test-owner', repo: 'test-repo' })
      await host.cleanup()
      running = running.filter((candidate) => candidate !== host)
    }

    const enterprise = await boot({ remote: 'https://github.enterprise.test/org/private.git' })
    enterprise.writeState({
      authStatus: 'Logged in to github.enterprise.test account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n'
    })
    expect(await enterprise.call('repository')).toMatchObject({
      origin: { host: 'github.enterprise.test', owner: 'org', repo: 'private' }
    })
    expect(enterprise.invocations().some((item) => item.args.includes('github.enterprise.test'))).toBe(false)
    await enterprise.cleanup()
    running = running.filter((candidate) => candidate !== enterprise)

    const enterprisePort = await boot({ remote: 'https://github.enterprise.test:8443/org/private.git' })
    enterprisePort.writeState({
      authStatus: 'Logged in to github.enterprise.test:8443 account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n'
    })
    expect(await enterprisePort.call('repository')).toMatchObject({
      origin: { host: 'github.enterprise.test:8443', owner: 'org', repo: 'private' }
    })
    expect(enterprisePort.invocations().every((item) => !item.args.includes('github.enterprise.test:8443'))).toBe(true)
    await enterprisePort.cleanup()
    running = running.filter((candidate) => candidate !== enterprisePort)

    const sshEnterprise = await boot({ remote: 'git@github.enterprise.test:org/private.git' })
    sshEnterprise.writeState({
      authStatus: 'Logged in to github.enterprise.test:8443 account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n'
    })
    expect(await sshEnterprise.call('repository')).toMatchObject({
      origin: { host: 'github.enterprise.test:8443', owner: 'org', repo: 'private' }
    })
  })

  test('GH01 keeps origin as head, orders PR candidates upstream-first, and honors issue-source preference', async () => {
    const host = await boot({
      remote: 'https://github.com/fork-owner/fork-repo.git',
      upstream: 'https://github.com/upstream-owner/upstream-repo.git'
    })
    const automatic = await host.call('repository')
    expect(automatic).toMatchObject({
      head: { owner: 'fork-owner', repo: 'fork-repo' },
      candidates: [{ owner: 'upstream-owner', repo: 'upstream-repo' }, { owner: 'fork-owner', repo: 'fork-repo' }],
      issueRepository: { owner: 'upstream-owner', repo: 'upstream-repo' },
      issueSourcePreference: 'auto',
      issueSourceFellBack: false
    })

    await host.call('configure', { issueSourcePreference: 'origin' })
    expect(await host.call('repository')).toMatchObject({
      issueRepository: { owner: 'fork-owner', repo: 'fork-repo' },
      candidates: [{ owner: 'upstream-owner' }, { owner: 'fork-owner' }],
      issueSourceFellBack: false
    })
    await host.call('configure', { issueSourcePreference: 'upstream' })
    execFileSync('git', ['remote', 'remove', 'upstream'], { cwd: host.repoPath })
    expect(await host.call('repository')).toMatchObject({
      issueRepository: { owner: 'fork-owner', repo: 'fork-repo' },
      issueSourceFellBack: true
    })
  })

  test('GH02 rejects unregistered selectors and foreign identities before an authenticated gh request', async () => {
    const host = await boot()
    await expect(host.call('repository', { worktree: 'path:/etc' })).rejects.toMatchObject({ data: { reason: 'worktree_unavailable' } })
    await expect(host.call('forBranch', {
      branch: 'feature',
      prRepo: { host: 'attacker.example', owner: 'other', repo: 'private' }
    })).rejects.toMatchObject({ data: { reason: 'repository_mismatch' } })
    expect(host.invocations()).toEqual([])
  })

  test('GH03 returns safe, distinct reasons for missing CLI, authentication, repository, and network failures', async () => {
    const cases = [
      { response: { exitCode: 127, stderr: 'gh: command not found' }, reason: 'gh_unavailable' },
      { response: { exitCode: 1, stderr: 'HTTP 401: not logged in' }, reason: 'not_authenticated' },
      { response: { exitCode: 1, stderr: 'HTTP 404: Not Found' }, reason: 'repository_unavailable' },
      { response: { exitCode: 1, stderr: 'connection reset by peer' }, reason: 'network_error' }
    ]
    for (const scenario of cases) {
      const host = await boot()
      host.writeState({ responses: { user: scenario.response } })
      await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: scenario.reason } })
      const error = await host.call('diagnoseAuth').catch((value: unknown) => value)
      expect(JSON.stringify(error)).not.toContain('connection reset by peer')
      await host.cleanup()
      running = running.filter((candidate) => candidate !== host)
    }
  })

  test('GH04 binds only an existing keyring account, strips ambient tokens in the bound child, and persists no token', async () => {
    const host = await boot()
    host.writeState({
      authStatus: 'Logged in to github.com account alice (keyring)\nActive account: true\nToken scopes: repo\nLogged in to github.com account bob (keyring)\nActive account: false\nToken scopes: repo\n',
      tokens: { alice: 'fixture-alice-token' }
    })
    await host.call('configure', { account: { host: 'github.com', user: 'alice' } })
    expect(await host.call('viewer')).toMatchObject({ login: 'fixture-user' })
    const bound = host.invocations().find((item) => item.args.includes('api') && item.args.includes('user'))
    expect(bound?.args).toContain('--hostname')
    expect(bound?.args).toContain('github.com')
    expect(bound?.env).toMatchObject({ GH_TOKEN: 'fixture-alice-token' })
    expect(bound?.env.GITHUB_TOKEN).toBeUndefined()
    expect(JSON.stringify(await host.call('configuration'))).not.toContain('fixture-alice-token')
    const storedFiles = readdirSync(join(host.home, 'plugin-data', 'quirky.hosting'))
      .map((file) => readFileSync(join(host.home, 'plugin-data', 'quirky.hosting', file)).toString('utf8'))
    expect(storedFiles.join('')).not.toContain('fixture-alice-token')
    await expect(host.call('configure', { account: { host: 'github.com', user: 'missing-user' } })).rejects.toMatchObject({
      data: { reason: 'bound_account_unavailable' }
    })
  })

  test('GH05 coalesces concurrent reads and observes a repointed remote without reusing stale identity', async () => {
    const host = await boot()
    // Delay is inside a real fixture process so the daemon requests genuinely overlap.
    host.writeState({ responses: { user: { delayMs: 60, stdout: { login: 'one' } } } })
    const values = await Promise.all(Array.from({ length: 8 }, () => host.call('viewer')))
    expect(values).toHaveLength(8)
    expect(host.invocations().filter((item) => item.args.includes('user'))).toHaveLength(1)

    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/changed-owner/changed-repo.git'], { cwd: host.repoPath })
    expect(await host.call('repository')).toMatchObject({ origin: { owner: 'changed-owner', repo: 'changed-repo' } })
  })

  test('GH05 limits real concurrent gh processes to four', async () => {
    const host = await boot()
    // Hold real gh fixture processes long enough for the runner's admission queue to fill.
    host.writeState({ responses: { auth_status: { delayMs: 200 } } })
    const results = await Promise.all(Array.from({ length: 8 }, () => host.call('accounts')))
    expect(results).toHaveLength(8)
    const events = readFileSync(join(host.root, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { event: string })
    let active = 0
    let maximum = 0
    for (const event of events) {
      active += event.event === 'start' ? 1 : -1
      maximum = Math.max(maximum, active)
    }
    expect(maximum).toBeLessThanOrEqual(4)
    expect(maximum).toBeGreaterThan(1)
  })

  test('GH06 bounds a hung child and oversized output, then permits a later request', async () => {
    const previous = process.env.ORCA_GH_EXEC_TIMEOUT_MS
    process.env.ORCA_GH_EXEC_TIMEOUT_MS = '60'
    try {
      const host = await boot()
      host.writeState({ responses: { user: { hang: true } } })
      await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'timeout' } })
      const started = readFileSync(join(host.root, 'activity.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { event: string; pid?: number })
        .find((event) => event.event === 'start')
      if (typeof started?.pid !== 'number') throw new Error('fixture process ID was not recorded')
      expect(() => process.kill(started.pid, 0)).toThrow()
      host.writeState({ responses: { user: { stdout: { login: 'recovered' } } } })
      expect(await host.call('viewer')).toMatchObject({ login: 'recovered' })
      await host.cleanup()
      running = running.filter((candidate) => candidate !== host)
    } finally {
      if (previous === undefined) delete process.env.ORCA_GH_EXEC_TIMEOUT_MS
      else process.env.ORCA_GH_EXEC_TIMEOUT_MS = previous
    }

    const oversized = await boot()
    oversized.writeState({ responses: { user: { repeatBytes: 11 * 1024 * 1024 } } })
    await expect(oversized.call('viewer')).rejects.toMatchObject({ data: { reason: 'output_limit' } })
  })

  test('GH07 retries transient idempotent reads at most twice, without exposing fixture stderr', async () => {
    const host = await boot()
    host.writeState({
      responses: {
        user: {
          attempts: [
            { exitCode: 1, stderr: 'HTTP 502: transient upstream failure' },
            { exitCode: 1, stderr: 'HTTP 503: transient upstream failure' },
            { stdout: { login: 'recovered' } }
          ]
        }
      }
    })
    expect(await host.call('viewer')).toMatchObject({ login: 'recovered' })
    expect(host.invocations().filter((item) => item.args.includes('user'))).toHaveLength(3)
  })

  test('GH08 rate-limit snapshots and circuit gates remain scoped to host/account', async () => {
    const host = await boot()
    const reset = Math.floor(Date.now() / 1000) + 600
    host.writeState({
      rateLimit: { resources: { core: { limit: 5000, remaining: 1, reset }, search: { limit: 30, remaining: 20, reset }, graphql: { limit: 5000, remaining: 500, reset } } },
      responses: { user: { exitCode: 1, stderr: 'API rate limit exceeded for user; Retry-After: 4' } }
    })
    expect(await host.call('rateLimit')).toMatchObject({ core: { remaining: 1 } })
    await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'rate_limited' } })
    const countAtPause = host.invocations().length
    await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'rate_limited' } })
    expect(host.invocations()).toHaveLength(countAtPause)

    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.enterprise.test/org/private.git'], { cwd: host.repoPath })
    host.writeState({ authStatus: 'Logged in to github.enterprise.test account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n' })
    expect(await host.call('viewer')).toMatchObject({ login: 'fixture-user' })
    expect(host.invocations().length).toBeGreaterThan(countAtPause)
  })
  test('GH08 honors Retry-After and isolates circuit gates between repository account bindings', async () => {
    const host = await boot()
    host.writeState({
      authStatus: 'Logged in to github.com account alice (keyring)\nActive account: true\nToken scopes: repo\nLogged in to github.com account bob (keyring)\nActive account: false\nToken scopes: repo\n',
      responses: {
        user: {
          attempts: [
            { exitCode: 1, stderr: 'API rate limit exceeded; Retry-After: 10' },
            { stdout: { login: 'bob' } }
          ]
        }
      }
    })
    await host.call('configure', { account: { host: 'github.com', user: 'alice' } })
    await expect(host.call('viewer')).rejects.toMatchObject({
      data: { reason: 'rate_limited', retryDisabledUntil: expect.any(Number) }
    })
    const pausedCount = host.invocations().length
    await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'rate_limited' } })
    expect(host.invocations()).toHaveLength(pausedCount)

    await host.call('configure', { account: { host: 'github.com', user: 'bob' } })
    expect(await host.call('viewer')).toMatchObject({ login: 'bob' })
  })
})
