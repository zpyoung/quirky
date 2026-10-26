import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_THEME,
  CATALOG_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type AskEnvelope,
  type ApiMethodEntry,
  type AskSpec,
  type ContributionInfo,
  type JobInfo,
  type JobRun,
  type PluginInfo,
  type Repo,
  type Session,
  type SettingInfo,
  type ThemeInfo,
  type UiCommandEntry,
  type UiKeybinding,
  type UiModel,
  type UiSlotEntry,
  type Worktree
} from '@quirky/protocol'
import { writePrivateJson, runtimeFilePath, type RuntimeInfo } from '@quirky/protocol/node'

export type FakeCall = { method: string; params: any }

export type FakeDaemonOptions = {
  /** Delay before a pending ask is answered; `null` leaves asks pending until cancelled. */
  answerAfterMs?: number | null
  /** Close the socket on the first `ask.wait`, to exercise client reconnects. */
  dropFirstWait?: boolean
  /** Make `ask.cancel` fail with an internal error. */
  failCancel?: boolean
}

class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

/** What a seeded plugin method does when called: return `result`, or fail with `error`. */
export type MethodBehavior = { result?: unknown; error?: { code: number; message: string } }

type AskState = { envelope: AskEnvelope; spec: AskSpec; waiters: Set<() => void> }

/**
 * A stand-in for quirkyd: serves `/health` and the `/rpc` WebSocket on a free loopback port, and
 * writes `runtime.json` into a private temp `QUIRKY_HOME`. Records every call for assertions.
 */
export class FakeDaemon {
  readonly home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-cli-')))
  readonly token = 'fake-token'
  readonly calls: FakeCall[] = []
  readonly repos: Repo[] = []
  readonly worktrees: Worktree[] = []
  readonly sessions: Session[] = []
  readonly plugins: PluginInfo[] = []
  readonly contributions: ContributionInfo[] = []
  readonly jobs: JobInfo[] = []
  readonly jobRuns = new Map<string, JobRun>()
  readonly asks = new Map<string, AskState>()
  readonly ui: UiModel = {
    sidebarSections: [],
    panels: [],
    views: [],
    commands: [],
    keybindings: [],
    settings: [],
    themes: [DEFAULT_THEME],
    theme: { chosen: 'default', active: 'default' },
    modules: {}
  }
  readonly settings: SettingInfo[] = []
  /** Errors `setting.set` throws for a setting ID, to exercise error exit codes. */
  readonly settingErrors = new Map<string, { code: number; message: string }>()
  /** Plugin methods served through `api.describe` and answerable by name. */
  readonly methods = new Map<string, { entry: ApiMethodEntry; behavior: MethodBehavior }>()
  connections = 0
  private server!: ReturnType<typeof Bun.serve>
  private waitCalls = 0
  private nextAsk = 1
  private nextSession = 1

  constructor(private readonly options: FakeDaemonOptions = {}) {}

  get port(): number {
    return this.server.port as number
  }

  start(): this {
    const daemon = this
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname === '/health') {
          return Response.json({ ok: true, pid: process.pid, daemonVersion: '0.0.0-fake' })
        }
        if (url.pathname === '/rpc') {
          if (url.searchParams.get('token') !== daemon.token) return new Response('unauthorized', { status: 401 })
          return server.upgrade(request, { data: undefined }) ? undefined : new Response('upgrade failed', { status: 400 })
        }
        return new Response('not found', { status: 404 })
      },
      websocket: {
        open() {
          daemon.connections++
        },
        async message(ws, raw) {
          const request = JSON.parse(String(raw)) as { id: number; method: string; params: any }
          try {
            const result = await daemon.handle(request.method, request.params ?? {}, ws)
            if (result === DROP) return
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
          } catch (error) {
            const code = error instanceof FakeRpcError ? error.code : RpcErrorCode.Internal
            ws.send(
              JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: (error as Error).message } })
            )
          }
        }
      }
    })
    const info: RuntimeInfo = {
      pid: process.pid,
      port: this.port,
      token: this.token,
      hookToken: 'fake-hook-token',
      daemonVersion: '0.0.0-fake',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: Date.now()
    }
    writePrivateJson(runtimeFilePath(this.home), info)
    return this
  }

  stop(): void {
    this.server.stop(true)
    rmSync(this.home, { recursive: true, force: true })
  }

  methodCalls(method: string): any[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params)
  }

  addRepo(name: string): Repo {
    const path = join(this.home, 'repos', name)
    mkdirSync(path, { recursive: true })
    const repo: Repo = { id: `repo_${name}`, name, path, addedAt: 1 }
    this.repos.push(repo)
    return repo
  }

  addWorktree(repo: Repo, name: string, path = join(this.home, 'worktrees', repo.name, name)): Worktree {
    mkdirSync(path, { recursive: true })
    const worktree: Worktree = {
      id: `wt_${repo.name}_${name}`,
      repoId: repo.id,
      path,
      branch: name,
      head: 'abc1234',
      isMain: false,
      name
    }
    this.worktrees.push(worktree)
    return worktree
  }

  addPlugin(id: string, overrides: Partial<PluginInfo> = {}): PluginInfo {
    const plugin: PluginInfo = {
      id,
      name: id,
      version: '1.0.0',
      source: 'installed',
      dir: join(this.home, 'plugins', id),
      activation: 'lazy',
      dependencies: [],
      state: 'inactive',
      diagnostics: [],
      ...overrides
    }
    this.plugins.push(plugin)
    return plugin
  }

  addContribution(plugin: string, kind: string, name: string, overrides: Partial<ContributionInfo> = {}): ContributionInfo {
    const contribution: ContributionInfo = {
      id: `${plugin}:${kind}.${name}`,
      kind,
      name,
      plugin,
      override: false,
      status: 'effective',
      data: {},
      ...overrides
    }
    this.contributions.push(contribution)
    return contribution
  }

  addJob(id: string, overrides: Partial<JobInfo> = {}): JobInfo {
    const job: JobInfo = {
      id,
      plugin: id.slice(id.indexOf(':') + 1, id.indexOf('/')),
      intervalMs: 60_000,
      timeoutMs: 300_000,
      state: 'idle',
      nextRunAt: null,
      lastRun: null,
      ...overrides
    }
    this.jobs.push(job)
    return job
  }

  addUiSlot(
    kind: UiSlotEntry['kind'],
    plugin: string,
    name: string,
    overrides: Partial<UiSlotEntry> = {}
  ): UiSlotEntry {
    const entry: UiSlotEntry = {
      id: `${kind}:${plugin}/${name}`,
      kind,
      plugin,
      title: name,
      order: 100,
      module: null,
      ...overrides
    }
    const list = kind === 'sidebar-section' ? this.ui.sidebarSections : kind === 'panel' ? this.ui.panels : this.ui.views
    list.push(entry)
    return entry
  }

  addUiCommand(plugin: string, name: string, overrides: Partial<UiCommandEntry> = {}): UiCommandEntry {
    const entry: UiCommandEntry = { id: `command:${plugin}/${name}`, plugin, title: name, module: null, ...overrides }
    this.ui.commands.push(entry)
    return entry
  }

  addKeybinding(plugin: string, name: string, key: string, command: string, overrides: Partial<UiKeybinding> = {}): UiKeybinding {
    const entry: UiKeybinding = { id: `keybinding:${plugin}/${name}`, plugin, key, command, status: 'active', ...overrides }
    this.ui.keybindings.push(entry)
    return entry
  }

  /** Seeds a setting into both the UI model and `setting.*`; the value defaults to the declared default. */
  addSetting(plugin: string, name: string, overrides: Partial<SettingInfo> = {}): SettingInfo {
    const setting: SettingInfo = {
      id: `setting:${plugin}/${name}`,
      plugin,
      type: 'number',
      title: name,
      default: 13,
      value: overrides.default ?? 13,
      ...overrides
    }
    this.settings.push(setting)
    this.ui.settings.push({ id: setting.id, plugin, type: setting.type, title: setting.title, default: setting.default })
    return setting
  }

  /** Seeds a plugin method into the catalog; calling it records the params and answers per `behavior`. */
  addMethod(name: string, entry: Partial<ApiMethodEntry> = {}, behavior: MethodBehavior = {}): ApiMethodEntry {
    const full: ApiMethodEntry = {
      name,
      plugin: name.slice(0, name.indexOf('/')),
      params: { type: 'object' },
      result: {},
      ...entry
    }
    this.methods.set(name, { entry: full, behavior })
    return full
  }

  private describe() {
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      daemonVersion: '0.0.0-fake',
      protocolVersion: PROTOCOL_VERSION,
      methods: [...this.methods.values()].map(({ entry }) => entry).sort((a, b) => (a.name < b.name ? -1 : 1)),
      events: [],
      uiCommands: [],
      cli: { groups: [], commands: [] }
    }
  }

  addTheme(plugin: string, name: string, overrides: Partial<ThemeInfo> = {}): ThemeInfo {
    const theme: ThemeInfo = {
      id: `theme:${plugin}/${name}`,
      plugin,
      title: name,
      appearance: 'light',
      colors: DEFAULT_THEME.colors,
      ...overrides
    }
    this.ui.themes.push(theme)
    return theme
  }

  /** Chooses `id` the way the daemon does: the active theme falls back to the default when it is gone. */
  chooseTheme(id: string): void {
    const active = this.ui.themes.some((theme) => theme.id === id) ? id : 'default'
    this.ui.theme = { chosen: id, active }
  }

  private themeList() {
    return { ...this.ui.theme, themes: this.ui.themes }
  }

  private requireSetting(id: string): SettingInfo {
    const setting = this.settings.find((candidate) => candidate.id === id)
    if (!setting) throw new FakeRpcError(RpcErrorCode.NotFound, `no setting ${id}`)
    return setting
  }

  private async handle(method: string, params: any, ws: { close(): void }): Promise<unknown> {
    this.calls.push({ method, params })
    switch (method) {
      case 'client.hello':
        return { protocolVersion: PROTOCOL_VERSION, daemonVersion: '0.0.0-fake' }
      case 'status.get':
        return {
          daemonVersion: '0.0.0-fake',
          pid: process.pid,
          startedAt: 1_700_000_000_000,
          home: this.home,
          ptyHost: { pid: 4242, alive: true },
          clients: [{ role: 'cli', name: 'quirky' }],
          safeMode: false,
          socket: null
        }
      case 'repo.list':
        return this.repos
      case 'repo.add': {
        const repo: Repo = { id: `repo_${this.repos.length + 1}`, name: 'added', path: params.path, addedAt: 2 }
        this.repos.push(repo)
        return repo
      }
      case 'repo.remove': {
        const index = this.repos.findIndex((repo) => repo.id === params.repoId)
        if (index === -1) throw new FakeRpcError(RpcErrorCode.NotFound, `repo not found: ${params.repoId}`)
        this.repos.splice(index, 1)
        return { ok: true }
      }
      case 'worktree.list':
        return this.worktrees.filter((wt) => !params.repoId || wt.repoId === params.repoId)
      case 'worktree.create': {
        const repo = this.repos.find((candidate) => candidate.id === params.repoId)
        if (!repo) throw new FakeRpcError(RpcErrorCode.NotFound, `repo not found: ${params.repoId}`)
        return this.addWorktree(repo, params.name)
      }
      case 'worktree.remove':
        return { ok: true }
      case 'session.list':
        return this.sessions.filter((session) => !params.worktreeId || session.worktreeId === params.worktreeId)
      case 'session.create':
      case 'session.createStructured': {
        const session: Session = {
          id: `sess_${this.nextSession++}`,
          kind: method === 'session.create' ? 'terminal' : 'structured',
          agent: params.agent,
          worktreeId: params.worktreeId,
          cwd: '/tmp',
          title: params.agent,
          status: 'running',
          createdAt: 1,
          lastActivityAt: 1,
          exitCode: null
        }
        this.sessions.push(session)
        return session
      }
      case 'session.close':
        return { ok: true }
      case 'terminal.read':
        return { lines: ['first line', 'second line'], cols: 80, rows: 24, alt: false }
      case 'terminal.send':
        return { ok: true }
      case 'ask.create': {
        const askId = `ask_${this.nextAsk++}`
        const state: AskState = {
          envelope: { status: 'pending', askId, answers: {}, skipped: [] },
          spec: params.spec,
          waiters: new Set()
        }
        this.asks.set(askId, state)
        if (typeof this.options.answerAfterMs === 'number') {
          setTimeout(() => this.resolve(askId, 'answered'), this.options.answerAfterMs)
        } else if (this.options.answerAfterMs === undefined) {
          setTimeout(() => this.resolve(askId, 'answered'), 300)
        }
        return { askId }
      }
      case 'ask.wait': {
        this.waitCalls++
        if (this.options.dropFirstWait && this.waitCalls === 1) {
          ws.close()
          return DROP
        }
        const state = this.requireAsk(params.askId)
        if (state.envelope.status !== 'pending') return state.envelope
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            state.waiters.delete(done)
            resolve()
          }
          const timer = setTimeout(done, params.timeoutMs ?? 60000)
          state.waiters.add(done)
        })
        return state.envelope
      }
      case 'ask.cancel': {
        if (this.options.failCancel) throw new FakeRpcError(RpcErrorCode.Internal, 'cancel failed')
        const state = this.requireAsk(params.askId)
        if (state.envelope.status === 'pending') this.resolve(params.askId, 'declined')
        return state.envelope
      }
      case 'plugin.list':
        return this.plugins
      case 'plugin.contributions':
        return this.contributions.filter(
          (item) =>
            (params.all || item.status === 'effective') &&
            (!params.kind || item.kind === params.kind) &&
            (!params.pluginId || item.plugin === params.pluginId)
        )
      case 'plugin.enable':
      case 'plugin.disable':
        if (!this.plugins.some((p) => p.id === params.id) && !this.contributions.some((c) => c.id === params.id)) {
          throw new FakeRpcError(RpcErrorCode.NotFound, `unknown plugin or contribution ${params.id}`)
        }
        return { ok: true }
      case 'plugin.activate': {
        const plugin = this.plugins.find((p) => p.id === params.pluginId)
        if (!plugin) throw new FakeRpcError(RpcErrorCode.NotFound, `unknown plugin ${params.pluginId}`)
        plugin.state = 'active'
        return plugin
      }
      case 'job.list':
        return this.jobs
      case 'job.run': {
        if (!this.jobs.some((job) => job.id === params.id)) {
          throw new FakeRpcError(RpcErrorCode.NotFound, `unknown job ${params.id}`)
        }
        return this.jobRuns.get(params.id) ?? { startedAt: 1_000, finishedAt: 1_042, status: 'ok' }
      }
      case 'ui.contributions':
        return this.ui
      case 'setting.list':
        return this.settings.filter((setting) => !params.pluginId || setting.plugin === params.pluginId)
      case 'setting.get':
        return this.requireSetting(params.id)
      case 'setting.set': {
        const setting = this.requireSetting(params.id)
        const seeded = this.settingErrors.get(params.id)
        if (seeded) throw new FakeRpcError(seeded.code, seeded.message)
        setting.value = params.value
        setting.stored = { value: params.value, valid: true }
        return setting
      }
      case 'setting.reset': {
        const setting = this.requireSetting(params.id)
        setting.value = setting.default
        delete setting.stored
        return setting
      }
      case 'theme.list':
        return this.themeList()
      case 'theme.set':
        if (!this.ui.themes.some((theme) => theme.id === params.id)) {
          throw new FakeRpcError(RpcErrorCode.NotFound, `no theme ${params.id}`)
        }
        this.chooseTheme(params.id)
        return this.themeList()
      case 'api.describe':
        return this.describe()
      default: {
        const seeded = this.methods.get(method)
        if (seeded?.behavior.error) throw new FakeRpcError(seeded.behavior.error.code, seeded.behavior.error.message)
        if (seeded) return seeded.behavior.result === undefined ? { ok: true } : seeded.behavior.result
        throw new FakeRpcError(RpcErrorCode.MethodNotFound, `method not found: ${method}`)
      }
    }
  }

  private requireAsk(askId: string): AskState {
    const state = this.asks.get(askId)
    if (!state) throw new FakeRpcError(RpcErrorCode.NotFound, `ask not found: ${askId}`)
    return state
  }

  private resolve(askId: string, status: 'answered' | 'declined'): void {
    const state = this.asks.get(askId)
    if (!state || state.envelope.status !== 'pending') return
    const first = state.spec.questions[0]
    state.envelope = {
      status,
      askId,
      answers: status === 'answered' && first ? { [first.id]: { value: 'yes', source: 'input' } } : {},
      skipped: []
    }
    for (const wake of [...state.waiters]) wake()
  }
}

const DROP = Symbol('drop')

export type CliResult = { code: number; stdout: string; stderr: string }

const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts')

/** Runs the real CLI as a subprocess with a scrubbed environment pointing at `home`. */
export async function runCli(
  args: string[],
  options: { home: string; cwd?: string; env?: Record<string, string> }
): Promise<CliResult> {
  const proc = spawnCli(args, options)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { code, stdout, stderr }
}

export function spawnCli(
  args: string[],
  options: { home: string; cwd?: string; env?: Record<string, string> }
) {
  return Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: options.cwd ?? options.home,
    env: { PATH: process.env.PATH ?? '', HOME: options.home, QUIRKY_HOME: options.home, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe'
  })
}
