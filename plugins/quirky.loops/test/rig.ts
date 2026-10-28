import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { QuirkyClient, type CliContext, type QuirkyEvent, type Session, type Worktree } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { formatRecord, formatTable } from '../../../packages/cli/src/output'
import { startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import type { LoopConfig, LoopSnapshot } from '../src/types'
import type { CodexAppServerFixture } from '../../quirky.structured/test/fakes/codex-app-server'

const PLUGINS_ROOT = resolve(import.meta.dir, '../..')
const PLUGINS = [
  'quirky.repo',
  'quirky.worktree',
  'quirky.agents',
  'quirky.ask',
  'quirky.session',
  'quirky.structured',
  'quirky.checks',
  'quirky.notifications',
  'quirky.loops'
]
const ENV_KEYS = ['HOME', 'PATH', 'QUIRKY_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QUIRKY_AGENT_SEARCH_DIRS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const

type RunnerContext = {
  appendMessage(input: { sessionId: string; role: 'user' | 'assistant' | 'system' | 'tool' | 'result'; text: string; data?: unknown }): unknown
  setStatus(sessionId: string, status: 'running' | 'working' | 'waiting' | 'done' | 'exited'): void
  setProviderSession(sessionId: string, session: { id: string; transcriptPath?: string | null }): Promise<void>
  createAsk?(spec: unknown, sessionId: string): Promise<unknown>
}

export type TurnResult = { text?: string; status?: 'waiting' | 'done'; error?: Error }
export type ScriptedTurn = (turn: { session: Session; text: string; context: RunnerContext; count: number }) => string | TurnResult | void | Promise<string | TurnResult | void>

type Controller = {
  starts: { session: Session; prompt?: string }[]
  sends: { sessionId: string; text: string }[]
  script?: ScriptedTurn
  onStop?: (sessionId: string) => void
}

class ScriptedRunner {
  private readonly sessions = new Map<string, Session>()
  private readonly turnCounts = new Map<string, number>()

  constructor(private readonly context: RunnerContext, private readonly controller: Controller) {}

  async start(session: Session, prompt?: string, options?: { providerSession?: { id: string; transcriptPath?: string | null } }): Promise<void> {
    this.sessions.set(session.id, session)
    this.controller.starts.push({ session, ...(prompt === undefined ? {} : { prompt }) })
    const providerSession = options?.providerSession
    await this.context.setProviderSession(session.id, {
      id: providerSession?.id ?? `scripted-${session.id}`,
      transcriptPath: providerSession?.transcriptPath ?? null
    })
    if (prompt === undefined || prompt === '') {
      this.context.setStatus(session.id, 'running')
      return
    }
    await this.turn(session.id, prompt)
  }

  async send(sessionId: string, text: string): Promise<void> {
    this.controller.sends.push({ sessionId, text })
    this.context.appendMessage({ sessionId, role: 'user', text })
    this.context.setStatus(sessionId, 'working')
    await this.turn(sessionId, text)
  }

  async stop(sessionId: string): Promise<void> {
    this.controller.onStop?.(sessionId)
    this.context.setStatus(sessionId, 'exited')
  }

  private async turn(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`no scripted session ${sessionId}`)
    const count = (this.turnCounts.get(sessionId) ?? 0) + 1
    this.turnCounts.set(sessionId, count)
    try {
      const result = await this.controller.script?.({ session, text, context: this.context, count })
      const details = typeof result === 'string' ? { text: result } : result
      if (details?.text) this.context.appendMessage({ sessionId, role: 'assistant', text: details.text })
      if (details?.error) {
        this.context.setStatus(sessionId, 'exited')
        throw details.error
      }
      this.context.setStatus(sessionId, details?.status ?? 'done')
    } catch (error) {
      this.context.setStatus(sessionId, 'exited')
      throw error
    }
  }
}

export const loopConfig = (body: string, patch: Partial<LoopConfig> = {}): LoopConfig => ({
  promptSource: { kind: 'repeat', body },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: {},
  caps: {},
  noProgress: false,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false,
  ...patch
})

export type LoopRigOptions = { script?: ScriptedTurn; onStop?: (sessionId: string) => void; extraPlugins?: string[]; nativeCodex?: boolean }
export type LoopRig = {
  home: string
  cwd: string
  worktree: Worktree
  client: QuirkyClient
  harness: Harness
  events: QuirkyEvent[]
  starts: Controller['starts']
  sends: Controller['sends']
  nativeFixture?: CodexAppServerFixture
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  snapshot(loopId: string): Promise<LoopSnapshot>
  waitForLoop(loopId: string, predicate: (snapshot: LoopSnapshot) => boolean, timeoutMs?: number): Promise<LoopSnapshot>
  cliContext(json?: boolean): { context: CliContext; lines: string[] }
  restart(beforeStart?: () => void): Promise<void>
  cleanup(): Promise<void>
}

export async function startLoopRig(options: LoopRigOptions = {}): Promise<LoopRig> {
  const priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<(typeof ENV_KEYS)[number], string | undefined>
  const globals = globalThis as typeof globalThis & { __QUIRKY_TEST_STRUCTURED_RUNNER__?: (context: RunnerContext) => unknown }
  const hadRunnerFactory = Object.hasOwn(globals, '__QUIRKY_TEST_STRUCTURED_RUNNER__')
  const previousRunnerFactory = globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-loop-home-')))
  const builtinPluginsDir = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-loop-builtins-')))
  const providerHomes = ['claude', 'codex'].map((name) => join(home, 'providers', name))
  const providerBin = join(home, 'providers', 'bin')
  mkdirSync(providerBin, { recursive: true })
  for (const executable of ['claude', 'codex']) {
    const path = join(providerBin, executable)
    writeFileSync(path, `#!/bin/sh
printf '%s\\n' 'VERDICT: not-met' 'REASON: isolated evaluator fixture'
`)
    chmodSync(path, 0o700)
  }
  for (const providerHome of providerHomes) mkdirSync(providerHome, { recursive: true })
  process.env.HOME = home
  process.env.PATH = `${providerBin}${process.env.PATH ? `:${process.env.PATH}` : ''}`
  process.env.QUIRKY_AGENT_SEARCH_DIRS = providerBin
  // Login shells may replace inherited PATH; the disposable provider fixture must remain discoverable there too.
  writeFileSync(join(home, '.bash_profile'), `export PATH='${process.env.PATH.replaceAll("'", "'\\''")}'\n`, { mode: 0o600 })
  process.env.QUIRKY_HOME = home
  process.env.CLAUDE_CONFIG_DIR = providerHomes[0]
  process.env.CODEX_HOME = providerHomes[1]
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'

  const controller: Controller = { starts: [], sends: [], script: options.script, onStop: options.onStop }
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = (context) => new ScriptedRunner(context, controller)
  let harness: Harness | undefined
  let disposed = false

  const restoreEnvironment = (): void => {
    for (const key of ENV_KEYS) {
      const value = priorEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (hadRunnerFactory) globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = previousRunnerFactory
    else delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  }

  try {
    for (const pluginId of new Set([...PLUGINS, ...(options.extraPlugins ?? [])])) symlinkSync(join(PLUGINS_ROOT, pluginId), join(builtinPluginsDir, pluginId))
    const start = async () => startHarness({ home, builtinPluginsDir, shell: '/bin/bash' })
    harness = await start()
    const setupClient = await harness.connect('cli')
    await setupClient.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: join(home, 'worktrees') })
    const cwd = join(home, 'projects', 'loop-workspace')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'README.txt'), 'isolated loop workspace\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd, env: process.env, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Quirky Loop Test')
    git('config', 'user.email', 'loop-test@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('add', '.')
    git('commit', '-q', '-m', 'initial')
    const repo = await setupClient.callAny('quirky.repo/add', { path: cwd }) as { id: string }
    const worktrees = await setupClient.callAny('quirky.worktree/list', { repo: repo.id }) as Worktree[]
    const worktree = worktrees.find((candidate) => candidate.isMain)
    if (!worktree) throw new Error('test workspace did not register a main worktree')
    await setupClient.close()

    const events: QuirkyEvent[] = []
    let client!: QuirkyClient
    const connect = async (): Promise<void> => {
      client = await QuirkyClient.connect(rpcUrl(harness!.runtime), { role: 'cli', cwd, worktreeId: worktree.id })
      harness!.clients.push(client)
      client.onEvent((event) => events.push(event))
      await client.callAny('events.subscribe', {})
    }
    await connect()

    const rig: LoopRig = {
      home,
      cwd,
      worktree,
      get client() { return client },
      harness: harness!,
      events,
      starts: controller.starts,
      sends: controller.sends,
      call<T = unknown>(method: string, params: Record<string, unknown> = {}) { return client.callAny(method, params) as Promise<T> },
      snapshot(loopId) { return rig.call<LoopSnapshot>('quirky.loops/get', { loopId }) },
      waitForLoop(loopId, predicate, timeoutMs = 10_000) {
        return waitForAsync(async () => {
          const snapshot = await rig.snapshot(loopId)
          return predicate(snapshot) ? snapshot : undefined
        }, timeoutMs)
      },
      cliContext(json = false) {
        const lines: string[] = []
        const context: CliContext = {
          requestBase: crypto.randomUUID(),
          call: (method, params = {}) => client.callAny(method, params),
          out: {
            json,
            result: (value, text) => lines.push(json ? JSON.stringify(value) : text()),
            line: (text) => lines.push(text),
            jsonLine: (value) => lines.push(JSON.stringify(value))
          },
          format: { table: formatTable, record: formatRecord },
          env: {},
          cwd,
          readFile: async (path) => Bun.file(path).text(),
          sleep: (ms) => Bun.sleep(ms),
          now: () => Date.now(),
          usage: (message) => new Error(`usage: ${message}`),
          fail: (message) => new Error(message),
          reconnect: async () => {}
        }
        return { context, lines }
      },
      async restart(beforeStart) {
        const old = harness!
        for (const open of old.clients) await open.close()
        await old.daemon.stop()
        old.pty.stop()
        beforeStart?.()
        harness = await start()
        await connect()
        rig.harness = harness!
      },
      async cleanup() {
        if (disposed) return
        disposed = true
        try {
          await harness?.cleanup()
        } finally {
          rmSync(builtinPluginsDir, { recursive: true, force: true })
          restoreEnvironment()
        }
      }
    }
    return rig
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      rmSync(builtinPluginsDir, { recursive: true, force: true })
      restoreEnvironment()
    }
    throw error
  }
}
