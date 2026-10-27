import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { QuirkyClient, type ClientRole } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { startHarness } from '../../../packages/daemon/test/helpers'

type GitHubInvocation = { args: string[]; input: string; env: Record<string, string> }
export type HostingTest = {
  root: string
  home: string
  repoPath: string
  worktree: string
  client: QuirkyClient
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  pluginCall(name: string, params?: Record<string, unknown>): Promise<unknown>
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  writeState(value: unknown): void
  readState(): unknown
  invocations(): GitHubInvocation[]
  connect(role?: ClientRole): Promise<QuirkyClient>
  cleanup(): Promise<void>
}
export type HostingTestOptions = {
  remote?: string
  upstream?: string
  branch?: string
  tracked?: boolean
  /** Additional built-in plugins for downstream feature integration tests. */
  extraBuiltins?: string[]
}

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const PLUGINS_ROOT = join(WORKSPACE_ROOT, 'plugins')
const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/main.ts')
const ENVIRONMENT_KEYS = [
  'HOME', 'QUIRKY_HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'PATH', 'GH_TOKEN', 'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_TERMINAL_PROMPT',
  'QUIRKY_TEST_FIXTURE_DIR', 'QUIRKY_TEST_GH_SOURCE', 'QUIRKY_TEST_GH_LOG', 'QUIRKY_TEST_GH_ACTIVITY',
  'QUIRKY_TEST_SSH_CONFIG'
] as const
const CONNECTION_SCOPED_METHODS: Record<string, true> = {
  refresh: true,
  enqueueRefresh: true,
  visibleRefreshCandidates: true,
  refreshState: true
}

function withWorktreeContext(method: string, worktree: string, params: Record<string, unknown>): Record<string, unknown> {
  const methodName = method.slice(method.lastIndexOf('/') + 1)
  if (method.startsWith('quirky.hosting/') && CONNECTION_SCOPED_METHODS[methodName] === true) return params
  return { worktree, ...params }
}
const UPSTREAM_SOURCE = `
import { appendFileSync } from 'node:fs'
const input = await new Response(Bun.stdin.stream()).text()
const args = process.argv.slice(2)
const env = {}
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
  if (process.env[key] !== undefined) env[key] = process.env[key]
}
appendFileSync(process.env.QUIRKY_TEST_GH_LOG, JSON.stringify({ args, input, env }) + '\\n')
const source = process.env.QUIRKY_TEST_GH_SOURCE
if (typeof source !== 'string' || source.length === 0) throw new Error('missing fixture source')
const child = Bun.spawn([process.execPath, source, ...args], {
  cwd: process.cwd(),
  env: { ...process.env, QUIRKY_TEST_GH_INPUT: input },
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit'
})
const forwardSignal = (signal) => {
  try {
    child.kill(signal)
  } catch {
    return
  }
}
const onTerminate = () => forwardSignal('SIGTERM')
const onInterrupt = () => forwardSignal('SIGINT')
const onHangup = () => forwardSignal('SIGHUP')
process.on('SIGTERM', onTerminate)
process.on('SIGINT', onInterrupt)
process.on('SIGHUP', onHangup)
process.exitCode = await child.exited
process.off('SIGTERM', onTerminate)
process.off('SIGINT', onInterrupt)
process.off('SIGHUP', onHangup)
`

const SSH_SOURCE = `#!/usr/bin/env bun
const config = process.env.QUIRKY_TEST_SSH_CONFIG
if (typeof config !== 'string' || config.length === 0) throw new Error('missing isolated SSH config')
const child = Bun.spawnSync(['/usr/bin/ssh', '-F', config, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe'
})
process.stdout.write(child.stdout)
process.stderr.write(child.stderr)
process.exitCode = child.exitCode ?? 1
`
const BRIDGE_MANIFEST = {
  id: 'quirky.hosting-test-bridge',
  name: 'Hosting test caller bridge',
  version: '0.1.0',
  main: 'main.ts',
  contributes: {
    method: [{
      id: 'call',
      readOnly: true,
      params: { type: 'object', properties: { method: { type: 'string' }, params: {} }, required: ['method'] },
      result: { type: 'object', properties: { ok: { type: 'boolean' }, rejected: { type: 'boolean' }, value: {}, error: { type: 'object' } }, required: ['ok'] }
    }]
  }
}
const BRIDGE_SOURCE = `export function activate(context) {
  context.provide('method:' + context.pluginId + '/call', async (params) => {
    try {
      return { ok: true, value: await context.call(params.method, params.params || {}) }
    } catch (error) {
      const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
      return {
        ok: false,
        rejected: true,
        error: {
          code: error && typeof error === 'object' && 'code' in error ? error.code : null,
          message: error instanceof Error ? error.message : 'plugin call failed',
          ...(data !== undefined ? { data } : {})
        }
      }
    }
  })
}
`

export async function bootHosting(ghSource: string, options: HostingTestOptions = {}): Promise<HostingTest> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-hosting-')))
  const home = join(root, 'home')
  const repoPath = join(root, 'repo')
  const fakebin = join(root, 'fakebin')
  const builtinPluginsDir = join(root, 'builtins')
  const statePath = join(root, 'state.json')
  const invocationPath = join(root, 'invocations.jsonl')
  const activityPath = join(root, 'activity.jsonl')
  const sourcePath = join(root, 'upstream.mjs')
  const ghPath = join(fakebin, 'gh')
  const sshPath = join(fakebin, 'ssh')
  const gitConfig = join(home, '.gitconfig')
  const sshConfig = join(home, '.ssh', 'config')
  const previousEnvironment = new Map<string, string | undefined>(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  const branch = options.branch ?? 'feature'
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('invalid hosting test branch')
  }

  mkdirSync(home, { recursive: true })
  mkdirSync(fakebin, { recursive: true })
  mkdirSync(builtinPluginsDir, { recursive: true })
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(sshConfig, 'Host github-work\n  HostName github.com\n  User git\n', { mode: 0o600 })
  writeFileSync(gitConfig, '')
  writeFileSync(statePath, JSON.stringify({}))
  writeFileSync(invocationPath, '')
  writeFileSync(activityPath, '')
  writeFileSync(sourcePath, ghSource)
  writeFileSync(ghPath, `#!/usr/bin/env bun\n${UPSTREAM_SOURCE}`)
  chmodSync(ghPath, 0o755)
  writeFileSync(sshPath, SSH_SOURCE)
  chmodSync(sshPath, 0o755)
  symlinkSync(join(PLUGINS_ROOT, 'quirky.hosting'), join(builtinPluginsDir, 'quirky.hosting'))
  symlinkSync(join(PLUGINS_ROOT, 'quirky.repo'), join(builtinPluginsDir, 'quirky.repo'))
  symlinkSync(join(PLUGINS_ROOT, 'quirky.worktree'), join(builtinPluginsDir, 'quirky.worktree'))
  for (const id of options.extraBuiltins ?? []) {
    if (!/^quirky\.[a-z0-9-]+$/.test(id)) throw new Error('invalid additional built-in plugin ID')
    if (['quirky.hosting', 'quirky.repo', 'quirky.worktree'].includes(id)) continue
    symlinkSync(join(PLUGINS_ROOT, id), join(builtinPluginsDir, id))
  }
  const bridgeDirectory = join(builtinPluginsDir, 'quirky.hosting-test-bridge')
  mkdirSync(bridgeDirectory, { recursive: true })
  writeFileSync(join(bridgeDirectory, 'quirky-plugin.json'), JSON.stringify(BRIDGE_MANIFEST, null, 2))
  writeFileSync(join(bridgeDirectory, 'main.ts'), BRIDGE_SOURCE)

  process.env.HOME = home
  process.env.GIT_CONFIG_GLOBAL = gitConfig
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  delete process.env.GIT_CONFIG_COUNT
  delete process.env.GIT_CONFIG_PARAMETERS
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  delete process.env.GIT_INDEX_FILE
  process.env.GIT_TERMINAL_PROMPT = '0'
  process.env.QUIRKY_HOME = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.GH_CONFIG_DIR = join(home, '.config', 'gh')
  process.env.PATH = `${fakebin}${delimiter}${previousEnvironment.get('PATH') ?? ''}`
  process.env.QUIRKY_TEST_SSH_CONFIG = sshConfig
  process.env.GH_TOKEN = 'fixture-ambient-token'
  process.env.GITHUB_TOKEN = 'fixture-github-token'
  delete process.env.GH_ENTERPRISE_TOKEN
  delete process.env.GITHUB_ENTERPRISE_TOKEN
  process.env.GH_HOST = 'ambient-redirect.invalid'
  process.env.GH_REPO = 'ambient/redirect'
  process.env.GH_PROMPT_DISABLED = '1'
  process.env.QUIRKY_TEST_FIXTURE_DIR = root
  process.env.QUIRKY_TEST_GH_SOURCE = sourcePath
  process.env.QUIRKY_TEST_GH_LOG = invocationPath
  process.env.QUIRKY_TEST_GH_ACTIVITY = activityPath

  let harness: Harness | undefined
  try {
    initializeRepository(repoPath, branch, options)
    harness = await startHarness({ home, builtinPluginsDir })
    const client = await harness.connect('cli')
    const repository = await client.callAny('quirky.repo/add', { path: repoPath })
    if (!isRecord(repository) || typeof repository.id !== 'string') throw new Error('repository registration returned an invalid result')
    const worktrees = await client.callAny('quirky.worktree/list', { repo: repository.id })
    if (!Array.isArray(worktrees)) throw new Error('worktree listing returned an invalid result')
    const worktree = worktrees.find((value) => isRecord(value) && value.path === repoPath && typeof value.id === 'string')
    if (!isRecord(worktree) || typeof worktree.id !== 'string') throw new Error('registered worktree was not found')

    let cleaned = false
    const hosting: HostingTest = {
      root,
      home,
      repoPath,
      worktree: worktree.id,
      client,
      async call(name, params = {}) {
        const method = name.includes('/') ? name : `quirky.hosting/${name}`
        return client.callAny(method, withWorktreeContext(method, hosting.worktree, params))
      },
      async pluginCall(name, params = {}) {
        const method = name.includes('/') ? name : `quirky.hosting/${name}`
        return client.callAny('quirky.hosting-test-bridge/call', {
          method,
          params: withWorktreeContext(method, hosting.worktree, params)
        })
      },
      async cli(args) {
        const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
          cwd: repoPath,
          env: process.env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe'
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited
        ])
        return { code, stdout, stderr }
      },
      writeState(value) {
        const temporaryStatePath = statePath + '.' + process.pid + '.tmp'
        writeFileSync(temporaryStatePath, JSON.stringify(value))
        renameSync(temporaryStatePath, statePath)
      },
      readState() {
        return JSON.parse(readFileSync(statePath, 'utf8')) as unknown
      },
      invocations() {
        const lines = readFileSync(invocationPath, 'utf8').split('\n').filter((line) => line.length > 0)
        return lines.map((line) => parseInvocation(JSON.parse(line) as unknown))
      },
      async connect(role: ClientRole = 'cli') {
        return harness!.connect(role)
      },
      async cleanup() {
        if (cleaned) return
        cleaned = true
        try {
          await harness?.cleanup()
        } finally {
          for (const key of ENVIRONMENT_KEYS) {
            const value = previousEnvironment.get(key)
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
    return hosting
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      for (const key of ENVIRONMENT_KEYS) {
        const value = previousEnvironment.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

function initializeRepository(path: string, branch: string, options: HostingTestOptions): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '--quiet', '--initial-branch', branch])
  git(path, ['config', 'user.name', 'Hosting Fixture'])
  git(path, ['config', 'user.email', 'hosting-fixture@example.test'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(path, 'README.md'), 'isolated hosting fixture\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '--quiet', '-m', 'fixture'])
  if (branch !== 'main') git(path, ['branch', 'main', 'HEAD'])
  git(path, ['remote', 'add', 'origin', options.remote ?? 'https://github.com/test-owner/test-repo.git'])
  git(path, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(path, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'])
  if (options.tracked !== false) {
    git(path, ['config', `branch.${branch}.remote`, 'origin'])
    git(path, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`])
  }
  if (options.upstream !== undefined) {
    git(path, ['remote', 'add', 'upstream', options.upstream])
    git(path, ['update-ref', 'refs/remotes/upstream/main', 'HEAD'])
    git(path, ['update-ref', `refs/remotes/upstream/${branch}`, 'HEAD'])
  }
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git fixture setup failed: ${new TextDecoder().decode(result.stderr)}`)
}

function parseInvocation(value: unknown): GitHubInvocation {
  if (!isRecord(value) || !Array.isArray(value.args) || typeof value.input !== 'string' || !isRecord(value.env)) {
    throw new Error('the GitHub fixture invocation log is invalid')
  }
  const args: string[] = []
  for (const arg of value.args) {
    if (typeof arg !== 'string') throw new Error('the GitHub fixture invocation arguments are invalid')
    args.push(arg)
  }
  const env: Record<string, string> = {}
  for (const [name, content] of Object.entries(value.env)) {
    if (typeof content !== 'string') throw new Error('the GitHub fixture invocation environment is invalid')
    env[name] = content
  }
  return { args, input: value.input, env }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
