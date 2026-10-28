import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QuirkyClient, type ClientHello } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { restartDaemon as restartTestDaemon } from '../../quirky.session/test/support'

const PLUGIN_ROOT = resolve(import.meta.dir, '..')
const REPO_ROOT = resolve(PLUGIN_ROOT, '../..')
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts')
const TESTED_BUILTINS = [
  'quirky.orchestration',
  'quirky.session',
  'quirky.terminal',
  'quirky.agents',
  'quirky.worktree',
  'quirky.repo',
  'quirky.agent-status',
  'quirky.structured',
  'quirky.ask'
] as const
const LAUNCH_AGENT_MAIN = join(import.meta.dir, 'launch-agent.ts')
const FAKE_CLAUDE = `#!${process.execPath}
import ${JSON.stringify(LAUNCH_AGENT_MAIN)}
`

export type OrchestrationSession = { id: string; worktreeId: string; cwd: string }
type AuthenticatedHello = ClientHello & { sessionToken: string }
export type OrchestrationParty = OrchestrationSession & { client: QuirkyClient; sessionToken: string }
export type CliResult = { code: number; stdout: string; stderr: string }
export type CliProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>
function isCliResult(value: unknown): value is CliResult {
  if (typeof value !== 'object' || value === null) return false
  if (!('code' in value) || !('stdout' in value) || !('stderr' in value)) return false
  return typeof value.code === 'number' && typeof value.stdout === 'string' && typeof value.stderr === 'string'
}

export function readCliResult(path: string): CliResult | undefined {
  if (!existsSync(path)) return undefined
  const result: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isCliResult(result)) throw new Error('orchestration fixture returned an invalid CLI result')
  return result
}

export type OrchestrationFixture = {
  root: string
  home: string
  userHome: string
  readonly harness: Harness
  readonly setupClient: QuirkyClient
  createParty(name?: string, agent?: 'shell' | 'claude'): Promise<OrchestrationParty>
  reconnect(party: OrchestrationParty): Promise<OrchestrationParty>
  spawnCli(party: OrchestrationParty, args: string[], options?: { cwd?: string }): CliProcess
  runCli(party: OrchestrationParty, args: string[], options?: { cwd?: string; processTimeoutMs?: number }): Promise<CliResult>
  restart(): Promise<void>
  cleanup(): Promise<void>
}

function readSessionRow(value: unknown): OrchestrationSession {
  if (value === null || typeof value !== 'object' || !('id' in value) || !('worktreeId' in value) || !('cwd' in value)) {
    throw new Error('quirky.session/create returned an invalid session row')
  }
  const { id, worktreeId, cwd } = value
  if (typeof id !== 'string' || typeof worktreeId !== 'string' || typeof cwd !== 'string') {
    throw new Error('quirky.session/create returned an invalid session identity')
  }
  return { id, worktreeId, cwd }
}

export async function startOrchestrationFixture(): Promise<OrchestrationFixture> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-orchestration-'))
  const home = join(root, 'quirky-home')
  const userHome = join(root, 'cli-homes')
  const builtinPluginsDir = join(root, 'builtins')
  const fakeBin = join(root, 'fake-bin')
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 })
  const fakeClaude = join(fakeBin, 'claude')
  writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o700 })
  chmodSync(fakeClaude, 0o700)
  mkdirSync(userHome, { recursive: true, mode: 0o700 })
  mkdirSync(builtinPluginsDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(builtinPluginsDir, '.test-local-builtins'), '')
  for (const id of TESTED_BUILTINS) {
    symlinkSync(resolve(PLUGIN_ROOT, '../' + id), join(builtinPluginsDir, id))
  }
  const isolatedEnvKeys = [
    'HOME',
    'QUIRKY_HOME',
    'PATH',
    'ZDOTDIR',
    'ENV',
    'BASH_ENV',
    'QUIRKY_TEST_ENTER_DELAY_MS',
    'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'GROK_HOME',
    'GROK_CLI_CHAT_PROXY_BASE_URL',
    'KIMI_CODE_HOME',
    'KIMI_CODE_BASE_URL',
    'OPENCODE_API_KEY',
    'OPENCODE_AUTH_CONTENT',
    'OPENCODE_DB',
    'OPENCODE_CONFIG_DIR'
  ]
  const previousEnv = new Map(isolatedEnvKeys.map((key) => [key, process.env[key]]))
  process.env.HOME = userHome
  process.env.QUIRKY_HOME = home
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`
  process.env.XDG_CONFIG_HOME = join(root, 'xdg-config')
  process.env.XDG_DATA_HOME = join(root, 'xdg-data')
  process.env.XDG_CACHE_HOME = join(root, 'xdg-cache')
  for (const key of isolatedEnvKeys) {
    if (!['HOME', 'QUIRKY_HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].includes(key)) {
      delete process.env[key]
    }
  }
  const restoreEnvironment = () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  let environmentRestored = false
  const restoreOnce = () => {
    if (environmentRestored) return
    environmentRestored = true
    restoreEnvironment()
  }

  const processes = new Set<CliProcess>()
  let harness: Harness | undefined
  let setupClient: QuirkyClient | undefined
  let cliNumber = 0
  const startDaemon = async (): Promise<void> => {
    harness = await startHarness({ home, builtinPluginsDir })
    setupClient = await harness.connect('cli', 'orchestration-fixture')
  }
  const stopTransientProcesses = async (): Promise<void> => {
    for (const child of [...processes]) {
      try {
        child.kill()
      } catch {}
      await child.exited.catch(() => undefined)
      processes.delete(child)
    }
  }
  const restartWithLivePty = async (): Promise<void> => {
    if (harness === undefined) throw new Error('orchestration test daemon is not running')
    await stopTransientProcesses()
    await Promise.all(harness.clients.map(async (client) => client.close()))
    harness.clients.length = 0
    const restarted = await restartTestDaemon(harness, { builtinPluginsDir })
    harness.daemon = restarted.daemon
    harness.runtime = restarted.daemon.runtime
    harness.clients.push(restarted.client)
    setupClient = restarted.client
  }
  const stopForCleanup = async (): Promise<void> => {
    for (const child of [...processes]) {
      try {
        child.kill('SIGTERM')
      } catch {}
      await child.exited.catch(() => undefined)
      processes.delete(child)
    }
    if (harness === undefined) return
    await Promise.all(harness.clients.map(async (client) => client.close()))
    harness.clients.length = 0
    await harness.daemon.stop()
    harness.pty.stop()
    harness = undefined
    setupClient = undefined
  }
  const requireHarness = (): Harness => {
    if (harness === undefined) throw new Error('orchestration test daemon is not running')
    return harness
  }
  const connectParty = async (session: OrchestrationSession, sessionToken: string, name: string): Promise<OrchestrationParty> => {
    const currentHarness = requireHarness()
    const hello: AuthenticatedHello = {
      role: 'cli',
      name: `orchestration-${name}`,
      sessionId: session.id,
      worktreeId: session.worktreeId,
      sessionToken
    }
    const client = await QuirkyClient.connect(rpcUrl(currentHarness.runtime), hello)
    currentHarness.clients.push(client)
    return { ...session, client, sessionToken }
  }
  const spawn = (party: OrchestrationParty, args: string[], options: { cwd?: string } = {}): CliProcess => {
    const childHome = join(userHome, `cli-home-${++cliNumber}`)
    mkdirSync(childHome, { recursive: true, mode: 0o700 })
    const child = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
      cwd: options.cwd ?? party.cwd,
      stdin: 'ignore',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: childHome,
        QUIRKY_HOME: home,
        QUIRKY_SESSION_ID: party.id,
        QUIRKY_WORKTREE_ID: party.worktreeId,
        QUIRKY_SESSION_TOKEN: party.sessionToken
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    processes.add(child)
    void child.exited.then(() => processes.delete(child))
    return child
  }

  try {
    await startDaemon()
  } catch (error) {
    try {
      await harness?.cleanup()
    } catch {}
    restoreOnce()
    rmSync(root, { recursive: true, force: true })
    throw error
  }

  return {
    root,
    home,
    userHome,
    get harness() {
      return requireHarness()
    },
    get setupClient() {
      if (setupClient === undefined) throw new Error('orchestration setup client is not connected')
      return setupClient
    },
    async createParty(name = `party-${crypto.randomUUID()}`, agent: 'shell' | 'claude' = 'shell') {
      const currentHarness = requireHarness()
      if (setupClient === undefined) throw new Error('orchestration setup client is not connected')
      const cwd = join(root, `cwd-${crypto.randomUUID()}`)
      mkdirSync(cwd, { recursive: true, mode: 0o700 })
      const session = readSessionRow(await setupClient.callAny('quirky.session/create', {
        agent,
        worktree: 'floating',
        cwd
      }))
      const launched = currentHarness.pty.sessions.get(session.id)
      if (launched === undefined) throw new Error(`session ${session.id} has no fake PTY launch record`)
      const sessionToken = launched.env.QUIRKY_SESSION_TOKEN
      if (sessionToken === undefined || sessionToken.length === 0) {
        throw new Error(`session ${session.id} launch has no QUIRKY_SESSION_TOKEN`)
      }
      return connectParty(session, sessionToken, name)
    },
    async reconnect(party) {
      const launched = requireHarness().pty.sessions.get(party.id)
      if (launched === undefined) throw new Error(`session ${party.id} is no longer live`)
      const sessionToken = launched.env.QUIRKY_SESSION_TOKEN
      if (sessionToken === undefined || sessionToken.length === 0) {
        throw new Error(`session ${party.id} launch has no QUIRKY_SESSION_TOKEN`)
      }
      return connectParty(party, sessionToken, 'reconnected')
    },
    spawnCli: spawn,
    async runCli(party, args, options = {}) {
      const child = spawn(party, args, options)
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
      }, options.processTimeoutMs ?? 60_000)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited
        ])
        return { code, stdout, stderr }
      } finally {
        clearTimeout(timer)
        if (processes.has(child)) {
          try {
            child.kill()
          } catch {}
          await child.exited
          processes.delete(child)
        }
      }
    },
    async restart() {
      await restartWithLivePty()
    },
    async cleanup() {
      try {
        await stopForCleanup()
      } finally {
        restoreOnce()
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}

export function mutation(requestId: string = crypto.randomUUID()) {
  return { requestId, contractVersion: 1 as const }
}

export const call = <T>(party: OrchestrationParty, method: string, params: Record<string, unknown> = {}) =>
  party.client.callAny(method, params) as Promise<T>

export async function expectReason(promise: Promise<unknown>, reason: string): Promise<unknown> {
  let error: unknown
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  if (error === undefined) throw new Error(`expected orchestration error reason ${reason}`)
  let actual: unknown
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = error.data
    if (typeof data === 'object' && data !== null && 'reason' in data) actual = data.reason
  }
  if (actual !== reason) throw new Error(`expected orchestration error reason ${reason}, received ${String(actual)}`)
  return error
}

export const pause = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
