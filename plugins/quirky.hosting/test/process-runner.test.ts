import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AuthAccount } from '../src/auth-inventory'
import { createEnv, type HostingEnv, type Identity } from '../src/env'
import { parseRemoteIdentity, resolveTrustedIdentity } from '../src/identity-remote'
import { createPRLookup } from '../src/pr-review'
import { pluginApiCompatibilityError } from '../../../packages/protocol/src/plugin-api'
import { scanSourceContent } from '../../../scripts/spawn-lint'
import type { PluginCaller, PluginContext, ProcessRunner, RunOptions, RunResult, Worktree } from '@quirky/protocol'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const WORKTREE: Worktree = {
  id: 'wt_000000000001',
  repoId: 'repo_1',
  path: '/fixture/repo',
  kind: 'git',
  instanceId: 'instance-1',
  branch: 'main',
  head: '0'.repeat(40),
  isMain: true,
  name: 'fixture',
  displayName: null,
  comment: '',
  status: 'todo',
  pinned: false,
  unread: false,
  parentId: null,
  projectGroupId: null,
  lastActivityAt: 0,
  createdAt: 0,
  createdBy: 'window',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null
}
const PLUGIN_CALLER = { role: 'plugin' } as PluginCaller
const GIT_OPTIONS: RunOptions = {
  cwd: WORKTREE.path,
  timeoutMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024
}
const REMOTE_OPTIONS: RunOptions = {
  cwd: WORKTREE.path,
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024
}
const SSH_OPTIONS: RunOptions = {
  timeoutMs: 5_000,
  killGraceMs: 2_000,
  maxOutputBytes: 64 * 1024
}

type RunBehavior = (argv: readonly string[], options?: RunOptions) => RunResult | Promise<RunResult>
type RunCall = { argv: string[]; options?: RunOptions }

function runResult(stdoutText = '', overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

function recordingRunner(respond: RunBehavior): { process: ProcessRunner; calls: RunCall[] } {
  const calls: RunCall[] = []
  return {
    process: {
      run: async (argv, options) => {
        calls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
        return respond(argv, options)
      }
    },
    calls
  }
}

function createContext(processRunner: ProcessRunner, worktree = WORKTREE): PluginContext {
  const store = { get: () => undefined, run: () => undefined, all: () => [] }
  return {
    pluginId: 'quirky.hosting',
    process: processRunner,
    openStore: () => store,
    error: (_kind: string, message: string) => new Error(message),
    log: () => undefined,
    emit: () => undefined,
    call: async (method: string): Promise<unknown> => {
      if (method === 'quirky.worktree/resolve') return worktree
      throw new Error(`Unexpected context call: ${method}`)
    }
  } as unknown as PluginContext
}

function createHostingEnv(processRunner: ProcessRunner, worktree = WORKTREE): HostingEnv {
  return createEnv(createContext(processRunner, worktree))
}

function remoteFor(alias: string) {
  const remote = parseRemoteIdentity(`git@${alias}:owner/repo.git`)
  if (!remote) throw new Error(`fixture alias did not parse: ${alias}`)
  return remote
}

async function trustedIdentity(
  processRunner: ProcessRunner,
  alias: string,
  accountsForHost: (host: string) => Promise<readonly AuthAccount[]> = async () => []
): Promise<Identity | null> {
  return resolveTrustedIdentity(processRunner, remoteFor(alias), accountsForHost)
}

function compareVersions(value: string, floor: string): number {
  const left = value.split('.').map(Number)
  const right = floor.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

let savedHome: string | undefined
let savedDateNow: typeof Date.now
const fixtureHomes: string[] = []

beforeEach(() => {
  savedHome = process.env.HOME
  savedDateNow = Date.now
  const home = mkdtempSync(join(tmpdir(), 'quirky-hosting-alias-home-'))
  fixtureHomes.push(home)
  process.env.HOME = home
})

afterEach(() => {
  Date.now = savedDateNow
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  for (const home of fixtureHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('hosting process runner boundaries', () => {
  test('gitWorktree uses the activation runner and exact Git policy', async () => {
    const fake = recordingRunner(() => runResult('  fixture-head\n'))
    const env = createHostingEnv(fake.process)
    try {
      expect(await env.gitWorktree(WORKTREE, ['rev-parse', 'HEAD'])).toBe('  fixture-head\n')
      expect(fake.calls).toEqual([{
        argv: ['git', 'rev-parse', 'HEAD'],
        options: GIT_OPTIONS
      }])
    } finally {
      await env.dispose()
    }
  })

  test('gitWorktree rejects invalid argv before calling the runner', async () => {
    const fake = recordingRunner(() => runResult())
    const env = createHostingEnv(fake.process)
    const invalidArgs: unknown[] = [
      [],
      ['rev-parse', 'bad\0arg'],
      ['x'.repeat(8_193)],
      Array.from({ length: 129 }, () => 'arg'),
      ['rev-parse', 1]
    ]
    try {
      for (const args of invalidArgs) {
        const failure = await env.gitWorktree(WORKTREE, args as string[]).then(() => undefined, (error: unknown) => error)
        expect(failure).toMatchObject({ data: { reason: 'invalid_git_args' } })
      }
      expect(fake.calls).toEqual([])
    } finally {
      await env.dispose()
    }
  })

  test('gitWorktree maps all failed runner outcomes, including stopped exit zero, to git_failed', async () => {
    const failures: Array<{ name: string; respond: RunBehavior }> = [
      { name: 'nonzero exit', respond: () => runResult('partial', { exitCode: 1 }) },
      { name: 'signal', respond: () => runResult('', { exitCode: null, signal: 'SIGTERM' }) },
      { name: 'timeout', respond: () => runResult('', { exitCode: null, stopped: 'timeout' }) },
      { name: 'synthetic stopped exit zero', respond: () => runResult('', { exitCode: 0, stopped: 'overflow' }) },
      { name: 'spawn failure', respond: () => runResult('', { exitCode: null, spawnError: { code: 'ENOENT', message: 'missing git' } }) },
      { name: 'rejected runner', respond: async () => { throw new Error('runner rejected') } }
    ]
    for (const { name, respond } of failures) {
      const fake = recordingRunner(respond)
      const env = createHostingEnv(fake.process)
      try {
        const failure = await env.gitWorktree(WORKTREE, ['rev-parse', 'HEAD']).then(() => undefined, (error: unknown) => error)
        expect(failure, name).toMatchObject({
          message: 'The local Git query failed.',
          data: { reason: 'git_failed' }
        })
        expect(fake.calls).toHaveLength(1)
      } finally {
        await env.dispose()
      }
    }
  })

  test('remote URL reads use the smaller runner cap and map failures or empty output to null', async () => {
    const failures: Array<{ name: string; respond: RunBehavior }> = [
      { name: 'nonzero exit', respond: () => runResult('partial', { exitCode: 1 }) },
      { name: 'signal', respond: () => runResult('', { exitCode: null, signal: 'SIGTERM' }) },
      { name: 'timeout', respond: () => runResult('', { exitCode: null, stopped: 'timeout' }) },
      { name: 'synthetic stopped exit zero', respond: () => runResult('https://github.com/owner/repo.git\n', { exitCode: 0, stopped: 'overflow' }) },
      { name: 'spawn failure', respond: () => runResult('', { exitCode: null, spawnError: { code: 'ENOENT', message: 'missing git' } }) },
      { name: 'rejected runner', respond: async () => { throw new Error('runner rejected') } },
      { name: 'empty output', respond: () => runResult('  \n') }
    ]
    for (const { name, respond } of failures) {
      const fake = recordingRunner(respond)
      const env = createHostingEnv(fake.process)
      try {
        expect(await env.remoteUrls(WORKTREE), name).toEqual({ origin: null, upstream: null })
        expect(fake.calls).toHaveLength(2)
        expect(fake.calls.map(({ options }) => options)).toEqual([REMOTE_OPTIONS, REMOTE_OPTIONS])
        expect(fake.calls.map(({ argv }) => argv).sort((left, right) => left.at(-1)!.localeCompare(right.at(-1)!))).toEqual([
          ['git', 'remote', 'get-url', 'origin'],
          ['git', 'remote', 'get-url', 'upstream']
        ])
      } finally {
        await env.dispose()
      }
    }
  })

  test('origin and upstream dotless aliases resolve through the supplied runner', async () => {
    const originUrl = 'git@fixture-origin-alias:owner/origin.git\n'
    const upstreamUrl = 'git@fixture-upstream-alias:owner/upstream.git\n'
    const fake = recordingRunner((argv) => {
      if (argv[0] === 'git' && argv[1] === 'remote' && argv[2] === 'get-url') {
        return runResult(argv[3] === 'origin' ? originUrl : upstreamUrl)
      }
      if (argv[0] === 'ssh') return runResult('hostname github.com\n')
      throw new Error(`unexpected command: ${argv.join(' ')}`)
    })
    const env = createHostingEnv(fake.process)
    try {
      const scope = await env.resolve({}, PLUGIN_CALLER)
      expect(scope.origin).toEqual({ host: 'github.com', owner: 'owner', repo: 'origin' })
      expect(scope.repository).toEqual({ host: 'github.com', owner: 'owner', repo: 'upstream' })
      const sshCalls = fake.calls.filter(({ argv }) => argv[0] === 'ssh')
      expect(sshCalls.map(({ argv }) => argv).sort((left, right) => left[3]!.localeCompare(right[3]!))).toEqual([
        ['ssh', '-G', '--', 'fixture-origin-alias'],
        ['ssh', '-G', '--', 'fixture-upstream-alias']
      ])
      expect(sshCalls.map(({ options }) => options)).toEqual([SSH_OPTIONS, SSH_OPTIONS])
      expect(fake.calls.filter(({ argv }) => argv[0] === 'git').map(({ options }) => options)).toEqual([REMOTE_OPTIONS, REMOTE_OPTIONS])
    } finally {
      await env.dispose()
    }
  })

  test('push URL alias verification uses the same activation runner', async () => {
    const pushUrl = 'git@fixture-push-alias:owner/push-repo.git\n'
    const fake = recordingRunner((argv) => {
      if (argv[0] === 'ssh') return runResult('hostname github.com\n')
      if (argv[0] !== 'git') throw new Error(`unexpected command: ${argv.join(' ')}`)
      if (argv.length === 2 && argv[1] === 'remote') return runResult('origin\n')
      if (argv[1] === 'remote' && argv[2] === 'get-url' && argv[3] === 'origin') {
        return runResult('https://github.com/owner/origin.git\n')
      }
      if (argv[1] === 'remote' && argv[2] === 'get-url' && argv[3] === 'upstream') return runResult('')
      if (argv[1] === 'remote' && argv[2] === 'get-url' && argv[3] === '--push') return runResult(pushUrl)
      throw new Error(`unexpected command: ${argv.join(' ')}`)
    })
    const env = createHostingEnv(fake.process)
    try {
      const result = await createPRLookup(env).pushRepository({ remote: 'origin' }, PLUGIN_CALLER)
      expect(result).toMatchObject({
        ready: true,
        repository: { host: 'github.com', owner: 'owner', repo: 'push-repo' }
      })
      const sshCalls = fake.calls.filter(({ argv }) => argv[0] === 'ssh')
      expect(sshCalls).toEqual([{
        argv: ['ssh', '-G', '--', 'fixture-push-alias'],
        options: SSH_OPTIONS
      }])
    } finally {
      await env.dispose()
    }
  })

  test('trusted alias resolution sends the exact ssh query and refreshes after the positive TTL', async () => {
    const fake = recordingRunner(() => runResult('hostname github.com\n'))
    const remote = remoteFor('fixture-success-alias')
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      expect(await resolveTrustedIdentity(fake.process, remote, async () => [])).toEqual({
        host: 'github.com', owner: 'owner', repo: 'repo'
      })
      expect(fake.calls).toEqual([{
        argv: ['ssh', '-G', '--', 'fixture-success-alias'],
        options: SSH_OPTIONS
      }])
      await resolveTrustedIdentity(fake.process, remote, async () => [])
      expect(fake.calls).toHaveLength(1)
      now += 60_001
      await resolveTrustedIdentity(fake.process, remote, async () => [])
      expect(fake.calls).toHaveLength(2)
    } finally {
      Date.now = realNow
    }
  })

  test('trusted alias failures and malformed host output resolve to null', async () => {
    const failures: Array<{ name: string; response: (alias: string) => RunBehavior }> = [
      { name: 'nonzero exit', response: () => () => runResult('hostname github.com\n', { exitCode: 1 }) },
      { name: 'signal', response: () => () => runResult('', { exitCode: null, signal: 'SIGTERM' }) },
      { name: 'stopped', response: () => () => runResult('', { exitCode: null, stopped: 'timeout' }) },
      { name: 'stopped including overflow with synthetic exit zero', response: () => () => runResult('hostname github.com\n', { exitCode: 0, stopped: 'overflow' }) },
      { name: 'spawn failure', response: () => () => runResult('', { exitCode: null, spawnError: { code: 'ENOENT', message: 'missing ssh' } }) },
      { name: 'rejected runner', response: () => async () => { throw new Error('runner rejected') } },
      { name: 'malformed hostname', response: () => () => runResult('not a hostname\n') },
      { name: 'unchanged alias', response: (alias) => () => runResult(`hostname ${alias}\n`) }
    ]
    for (const [index, { name, response }] of failures.entries()) {
      const alias = `fixture-failure-alias-${index}`
      const fake = recordingRunner(response(alias))
      let accountLookups = 0
      expect(await trustedIdentity(fake.process, alias, async () => {
        accountLookups += 1
        return []
      }), name).toBeNull()
      expect(accountLookups, name).toBe(0)
      expect(fake.calls).toEqual([{
        argv: ['ssh', '-G', '--', alias],
        options: SSH_OPTIONS
      }])
    }
  })

  test('failed aliases are cached for five seconds then retried', async () => {
    const fake = recordingRunner((_argv, _options) => fake.calls.length === 1
      ? runResult('', { exitCode: 255 })
      : runResult('hostname github.com\n'))
    const alias = 'fixture-negative-ttl-alias'
    const remote = remoteFor(alias)
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      expect(await resolveTrustedIdentity(fake.process, remote, async () => [])).toBeNull()
      expect(await resolveTrustedIdentity(fake.process, remote, async () => [])).toBeNull()
      expect(fake.calls).toHaveLength(1)
      now += 5_001
      expect(await resolveTrustedIdentity(fake.process, remote, async () => [])).toEqual({
        host: 'github.com', owner: 'owner', repo: 'repo'
      })
      expect(fake.calls).toHaveLength(2)
    } finally {
      Date.now = realNow
    }
  })

  test('alias caching is isolated by HOME and preserves the bounded LRU', async () => {
    const fake = recordingRunner(() => runResult('hostname github.com\n'))
    const alias = 'fixture-home-isolated-alias'
    expect(await trustedIdentity(fake.process, alias)).not.toBeNull()
    const otherHome = mkdtempSync(join(tmpdir(), 'quirky-hosting-alias-home-other-'))
    fixtureHomes.push(otherHome)
    process.env.HOME = otherHome
    expect(await trustedIdentity(fake.process, alias)).not.toBeNull()
    expect(fake.calls).toHaveLength(2)

    process.env.HOME = fixtureHomes[0]!
    for (let index = 0; index < 256; index += 1) {
      expect(await trustedIdentity(fake.process, `fixture-lru-alias-${index}`)).not.toBeNull()
    }
    await trustedIdentity(fake.process, 'fixture-lru-alias-0')
    await trustedIdentity(fake.process, 'fixture-lru-alias-256')
    const beforeEvictedRead = fake.calls.length
    await trustedIdentity(fake.process, 'fixture-lru-alias-1')
    expect(fake.calls).toHaveLength(beforeEvictedRead + 1)
  })

  test('enterprise SSH aliases still require a matching authenticated host', async () => {
    const fake = recordingRunner(() => runResult('hostname ghe.fixture.test\n'))
    const alias = 'fixture-enterprise-alias'
    const accounts: AuthAccount[] = [{
      host: 'ghe.fixture.test',
      user: 'fixture-user',
      source: 'keyring',
      active: true,
      scopes: []
    }]
    expect(await trustedIdentity(fake.process, alias, async (host) => {
      expect(host).toBe('ghe.fixture.test')
      return accounts
    })).toEqual({ host: 'ghe.fixture.test', owner: 'owner', repo: 'repo' })
    expect(await trustedIdentity(fake.process, alias, async () => [])).toBeNull()
    expect(fake.calls).toHaveLength(1)
  })

  test('migrated hosting files have zero spawns, clean baseline keys and a supported API floor', () => {
    const migratedFiles = [
      'plugins/quirky.hosting/src/env.ts',
      'plugins/quirky.hosting/src/identity-remote.ts'
    ]
    for (const file of migratedFiles) {
      expect(scanSourceContent(file, readFileSync(resolve(REPO_ROOT, file), 'utf8'))).toEqual([])
    }

    const baseline = JSON.parse(readFileSync(resolve(REPO_ROOT, 'scripts/spawn-lint-baseline.json'), 'utf8')) as Record<string, number>
    expect(baseline['plugins/quirky.hosting/src/env.ts']).toBeUndefined()
    expect(baseline['plugins/quirky.hosting/src/identity-remote.ts']).toBeUndefined()
    expect(baseline['plugins/quirky.hosting/src/runtime-runner.ts']).toBe(1)

    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/quirky.hosting/quirky-plugin.json'), 'utf8')) as { apiVersion?: unknown }
    expect(typeof manifest.apiVersion).toBe('string')
    expect(compareVersions(manifest.apiVersion as string, '1.9.0')).toBeGreaterThanOrEqual(0)
    expect(pluginApiCompatibilityError(manifest.apiVersion)).toBeNull()
  })
})
