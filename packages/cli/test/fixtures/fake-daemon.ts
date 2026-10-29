import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_THEME,
  CATALOG_SCHEMA_VERSION,
  PLUGIN_API_VERSION,
  PROTOCOL_VERSION,
  type ClientRole,
  RpcErrorCode,
  type ApiMethodEntry,
  type ApiCliCommandEntry,
  type ApiDescription,
  type ContributionInfo,
  type JobInfo,
  type JobRun,
  type PluginInfo,
  type SettingInfo,
  type ThemeInfo,
  type UiCommandEntry,
  type UiKeybinding,
  type UiModel,
  type UiSlotEntry
} from '@quirky/protocol'
import { writePrivateJson, runtimeFilePath, type RuntimeInfo } from '@quirky/protocol/node'

export type FakeCall = { method: string; params: any; requestId?: string; transport?: 'socket' | 'websocket' }

class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

/** One client connection, whichever transport carried it. */
type Conn = { transport: 'socket' | 'websocket'; id: object; send(value: unknown): void; close(): void }

type Outcome = { ok: true; value: unknown } | { ok: false; error: FakeRpcError }

/** A method that answers ConfirmationRequired until called with `yes` or its `confirmation`. */
export type ConfirmationGate = {
  askId: string
  action: string
  /** How the ask ends once `quirky.ask/wait` stops answering `pending`. */
  answer: 'answered' | 'declined'
  /** How many `quirky.ask/wait` calls answer `pending` before the final status. */
  pendingWaits: number
  waits: number
}

const READ_ONLY_NAME = /(^|[./])(list|get|describe|state|read|wait|inspect)$/

/** What a seeded plugin method does when called: return `result`, or fail with `error`. */
export type MethodBehavior = { result?: unknown; error?: { code: number; message: string; data?: unknown } }

/**
 * A stand-in for quirkyd: serves `/health` and the `/rpc` WebSocket on a free loopback port, and
 * writes `runtime.json` into a private temp `QUIRKY_HOME`. Records every call for assertions.
 */
export class FakeDaemon {
  readonly home = realpathSync(mkdtempSync('/tmp/qcli-'))
  readonly token = 'fake-token'
  readonly calls: FakeCall[] = []
  /** Methods that ran, as opposed to being answered from a recorded request ID. */
  readonly executions: string[] = []
  readonly plugins: PluginInfo[] = []
  readonly contributions: ContributionInfo[] = []
  readonly jobs: JobInfo[] = []
  readonly jobRuns = new Map<string, JobRun>()
  readonly ui: UiModel = {
    sidebarSections: [],
    activityItems: [],
    statusBars: [],
    panels: [],
    views: [],
    overlays: [],
    commands: [],
    keybindings: [],
    settings: [],
    settingsSections: [],
    menuItems: [],
    themes: [DEFAULT_THEME],
    theme: { chosen: 'default', active: 'default' },
    modules: {}
  }
  readonly settings: SettingInfo[] = []
  /** Errors `setting.set` throws for a setting ID, to exercise error exit codes. */
  readonly settingErrors = new Map<string, { code: number; message: string }>()
  /** Plugin methods served through `api.describe` and answerable by name. */
  readonly methods = new Map<string, { entry: ApiMethodEntry; behavior: MethodBehavior }>()
  /** Served as `api.describe`'s `cli` part. */
  readonly cli: ApiDescription['cli'] = { groups: [], commands: [] }
  /** Fixed results for methods the fake has no behavior for, such as `ui.state` or `plugin.inspect`. */
  readonly results = new Map<string, unknown>()
  /** Errors a method answers with, whatever its params. */
  readonly errors = new Map<string, { code: number; message: string }>()
  readonly confirmations = new Map<string, ConfirmationGate>()
  connections = 0
  socketConnections = 0
  private server!: ReturnType<typeof Bun.serve>
  private listener!: ReturnType<typeof Bun.listen>
  private readonly outcomes = new Map<string, Outcome>()
  private readonly drops = new Map<string, number>()
  private readonly withheldReplies = new Map<string, number>()
  private readonly connectedClients = new Map<object, { role: ClientRole; name?: string }>()

  get port(): number {
    return this.server.port as number
  }

  get socketPath(): string {
    return join(this.home, 'quirkyd.sock')
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
        message(ws, raw) {
          const conn: Conn = {
            transport: 'websocket',
            id: ws,
            send: (value) => ws.send(JSON.stringify(value)),
            close: () => ws.close()
          }
          void daemon.onRequest(conn, JSON.parse(String(raw)))
        },
        close(ws) {
          daemon.connectedClients.delete(ws)
        }
      }
    })
    this.listener = Bun.listen<{ buffer: string; authed: boolean }>({
      unix: this.socketPath,
      socket: {
        open(socket) {
          socket.data = { buffer: '', authed: false }
          daemon.connections++
          daemon.socketConnections++
        },
        data(socket, chunk) {
          socket.data.buffer += chunk.toString()
          for (let end = socket.data.buffer.indexOf('\n'); end !== -1; end = socket.data.buffer.indexOf('\n')) {
            const line = socket.data.buffer.slice(0, end)
            socket.data.buffer = socket.data.buffer.slice(end + 1)
            const conn: Conn = {
              transport: 'socket',
              id: socket,
              send: (value) => void socket.write(`${JSON.stringify(value)}\n`),
              close: () => void socket.end()
            }
            const request = JSON.parse(line)
            if (!socket.data.authed) {
              if (request.method !== 'client.hello' || request.params?.token !== daemon.token) {
                daemon.calls.push({ method: request.method, params: request.params ?? {}, transport: 'socket' })
                conn.send({
                  jsonrpc: '2.0',
                  id: request.id,
                  error: { code: RpcErrorCode.Unauthorized, message: 'the first message must be client.hello with the token' }
                })
                conn.close()
                return
              }
              socket.data.authed = true
            }
            void daemon.onRequest(conn, request)
          }
        },
        close(socket) {
          daemon.connectedClients.delete(socket)
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
      startedAt: Date.now(),
      socket: this.socketPath
    }
    writePrivateJson(runtimeFilePath(this.home), info)
    return this
  }

  stop(): void {
    this.server.stop(true)
    this.listener.stop(true)
    rmSync(this.home, { recursive: true, force: true })
  }

  /** Makes the next `times` calls to `method` run and then lose the connection before the reply. */
  dropAfter(method: string, times = 1): void {
    this.drops.set(method, times)
  }

  /** Leaves the next `times` calls to `method` unanswered without closing the client connection. */
  withholdNextReply(method: string, times = 1): void {
    this.withheldReplies.set(method, times)
  }

  /**
   * Makes `method` answer ConfirmationRequired until it is called with `yes`, or with `confirmation`
   * naming this gate's ask; `quirky.ask/wait` on that ask ends as `answer`.
   */
  requireConfirmation(
    method: string,
    gate: Partial<Omit<ConfirmationGate, 'waits'>> & { action: string }
  ): ConfirmationGate {
    const full: ConfirmationGate = { askId: 'ask_c1', answer: 'answered', pendingWaits: 0, ...gate, waits: 0 }
    this.confirmations.set(method, full)
    return full
  }

  addCliCommand(entry: Partial<ApiCliCommandEntry> & Pick<ApiCliCommandEntry, 'id' | 'plugin' | 'words'>): ApiCliCommandEntry {
    const full: ApiCliCommandEntry = {
      apiVersion: PLUGIN_API_VERSION,
      aliasWords: [],
      summary: '',
      positionals: [],
      flags: [],
      method: null,
      methods: entry.method ? [entry.method] : [],
      module: null,
      ...entry
    }
    this.cli.commands.push(full)
    return full
  }

  methodCalls(method: string): any[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params)
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
    const list =
      kind === 'sidebar-section'
        ? this.ui.sidebarSections
        : kind === 'activity-item'
          ? this.ui.activityItems
        : kind === 'status-bar'
          ? this.ui.statusBars
          : kind === 'panel'
            ? this.ui.panels
            : kind === 'overlay'
              ? this.ui.overlays
              : this.ui.views
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
    this.ui.settings.push({
      id: setting.id,
      plugin,
      type: setting.type,
      title: setting.title,
      default: setting.default,
      ...(setting.category !== undefined ? { category: setting.category } : {}),
      ...(setting.section !== undefined ? { section: setting.section } : {})
    })
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

  private describe(): ApiDescription {
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      daemonVersion: '0.0.0-fake',
      protocolVersion: PROTOCOL_VERSION,
      pluginApiVersion: PLUGIN_API_VERSION,
      methods: [...this.methods.values()].map(({ entry }) => entry).sort((a, b) => (a.name < b.name ? -1 : 1)),
      events: [],
      uiCommands: [],
      cli: this.cli
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

  private async onRequest(
    conn: Conn,
    request: { id: number; method: string; params?: any; requestId?: string }
  ): Promise<void> {
    try {
      const result = await this.handle(request.method, request.params ?? {}, conn, request.requestId)
      if (result === DROP) return
      const withheld = this.withheldReplies.get(request.method) ?? 0
      if (withheld > 0) {
        this.withheldReplies.set(request.method, withheld - 1)
        return
      }
      conn.send({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      const code = error instanceof FakeRpcError ? error.code : RpcErrorCode.Internal
      const data = error instanceof FakeRpcError ? error.data : undefined
      conn.send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code, message: (error as Error).message, ...(data !== undefined ? { data } : {}) }
      })
    }
  }

  /** Runs a call the way the real dispatcher records it: a repeated request ID returns the first outcome. */
  private async handle(method: string, params: any, conn: Conn, requestId?: string): Promise<unknown> {
    this.calls.push({ method, params, ...(requestId ? { requestId } : {}), transport: conn.transport })
    const recordable = requestId !== undefined && method !== 'client.hello' && !READ_ONLY_NAME.test(method)
    let outcome = recordable ? this.outcomes.get(requestId) : undefined
    if (!outcome) {
      outcome = await this.settle(method, params, conn)
      if (recordable) this.outcomes.set(requestId, outcome)
    }
    const remaining = this.drops.get(method) ?? 0
    if (remaining > 0) {
      this.drops.set(method, remaining - 1)
      conn.close()
      return DROP
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  private async settle(method: string, params: any, conn: Conn): Promise<Outcome> {
    this.executions.push(method)
    try {
      return { ok: true, value: await this.dispatch(method, params, conn) }
    } catch (error) {
      if (error instanceof FakeRpcError) return { ok: false, error }
      throw error
    }
  }

  private async dispatch(method: string, params: any, conn: Conn): Promise<unknown> {
    const failure = this.errors.get(method)
    if (failure) throw new FakeRpcError(failure.code, failure.message)
    const gate = this.confirmations.get(method)
    if (gate && params.yes !== true && params.confirmation !== gate.askId) {
      throw new FakeRpcError(RpcErrorCode.ConfirmationRequired, 'confirmation required', {
        askId: gate.askId,
        action: gate.action
      })
    }
    switch (method) {
      case 'client.hello':
        this.connectedClients.set(conn.id, {
          role: params.role as ClientRole,
          ...(typeof params.name === 'string' ? { name: params.name } : {})
        })
        return { protocolVersion: PROTOCOL_VERSION, daemonVersion: '0.0.0-fake' }
      case 'status.get':
        return {
          daemonVersion: '0.0.0-fake',
          pid: process.pid,
          startedAt: 1_700_000_000_000,
          home: this.home,
          ptyHost: { pid: 4242, alive: true },
          clients: [...this.connectedClients.values()],
          safeMode: false,
          socket: null
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
      case 'quirky.ask/wait': {
        const gate = [...this.confirmations.values()].find((candidate) => candidate.askId === params.askId)
        if (!gate) throw new FakeRpcError(RpcErrorCode.NotFound, `ask not found: ${params.askId}`)
        gate.waits++
        const status = gate.waits <= gate.pendingWaits ? 'pending' : gate.answer
        return { status, askId: gate.askId, answers: {}, skipped: [] }
      }
      case 'daemon.stop':
        setTimeout(() => {
          this.server.stop(true)
          this.listener.stop(true)
        }, 30)
        return { ok: true }
      default: {
        if (this.results.has(method)) return this.results.get(method)
        const seeded = this.methods.get(method)
        if (seeded?.behavior.error) throw new FakeRpcError(seeded.behavior.error.code, seeded.behavior.error.message, seeded.behavior.error.data)
        if (seeded) return seeded.behavior.result === undefined ? { ok: true } : seeded.behavior.result
        throw new FakeRpcError(RpcErrorCode.MethodNotFound, `method not found: ${method}`)
      }
    }
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
