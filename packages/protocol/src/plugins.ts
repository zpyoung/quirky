import type { ExitCause, PtyFact, PtyHistoryPage, PtySessionInfo, PtySnapshot, PtySubscription } from './pty'
import type { ClientRole, QuirkyEvent } from './rpc'

/** Where a plugin was found: shipped with Quirky, or installed by the user. */
export type PluginSource = 'builtin' | 'installed'

export type PluginState = 'inactive' | 'activating' | 'active' | 'failed' | 'disabled' | 'invalid'

export type PluginDiagnostic = { level: 'error' | 'warning'; message: string }

export type PluginInfo = {
  id: string
  name: string
  version: string
  description?: string
  source: PluginSource
  dir: string
  activation: 'lazy' | 'startup'
  dependencies: string[]
  state: PluginState
  /** Relative path of the webview ES module. */
  ui?: string
  /** Registry diagnostics, then the last activation error if the plugin failed. */
  diagnostics: PluginDiagnostic[]
  /** Extra CLI group words, after collision checks. */
  cliAliases?: string[]
  /** Why a `disabled` plugin is off. */
  disabledReason?: 'user' | 'distro' | 'safe-mode' | 'dependency'
}

export type ContributionStatus = 'effective' | 'overridden' | 'disabled' | 'rejected'

export type ContributionInfo = {
  id: string
  kind: string
  name: string
  /** The declaring plugin. */
  plugin: string
  override: boolean
  status: ContributionStatus
  overriddenBy?: string
  disabledBy?: 'user' | 'plugin' | 'owner' | 'distro'
  disablingPlugin?: string
  conflictWith?: string
  data: Record<string, unknown>
}

/** What a plugin's `activate` receives. */
export type PluginContext = {
  readonly pluginId: string
  readonly dir: string
  /** The plugin's private data directory, `<home>/plugin-data/<pluginId>`; it exists (mode 0700). */
  readonly dataDir: string
  /** Writes to the daemon log, prefixed with the plugin ID. */
  log(message: string): void
  /** Registers the implementation of a contribution this plugin declares; throws for any other ID. */
  provide(contributionId: string, implementation: unknown): void
  /** Broadcasts `<pluginId>/<event>` to subscribed clients and plugins; false when it was not delivered. */
  emit(event: string, data?: unknown): boolean
  /** Listens to every daemon event; the returned function unsubscribes. */
  subscribe(listener: (event: QuirkyEvent) => void | Promise<void>): () => void
  /** Invokes a daemon or plugin method as this plugin. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Opens this plugin's private SQLite store, applying any migrations it has not yet run. */
  openStore(migrations: StoreMigration[]): PluginStore
  /** The current value of a setting: a short name in this plugin's own namespace, or a full setting ID. */
  getSetting(name: string): unknown
  /** The raw stored value of any setting ID, declared or not, or undefined when none is stored. */
  storedSettingValue(id: string): unknown
  /** Builds an Error that the RPC layer reports with the code for `kind`. */
  error(kind: PluginErrorKind, message: string): Error
  /** The Quirky home directory. */
  readonly home: string
  /** The PTY host connection; listeners registered through it are removed when the plugin is revoked. */
  readonly pty: PluginPty
  /** Broadcasts `notify` with `desktop` defaulting to true; with no desktop client connected, runs the kernel notifier. */
  notify(notification: PluginNotification): void
  /** The kernel's session launch environment and launch-hook pipeline. */
  readonly launch: PluginLaunch
}

/** The PTY host operations a plugin may use. */
export type PluginPty = {
  readonly connected: boolean
  spawn(
    sessionId: string,
    options: {
      argv: string[]
      cwd: string
      env: Record<string, string>
      cols: number
      rows: number
      shellReady?: boolean
      /** Restart the stored session of this id; `cwd`, `cols` and `rows` are fallbacks for what the host recovered. */
      restore?: boolean
    }
  ): Promise<{ pid: number; restored: boolean; cwd: string; cols: number; rows: number }>
  write(sessionId: string, data: string | Uint8Array): void
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  read(sessionId: string, lines: number): Promise<{ lines: string[]; cols: number; rows: number; alt: boolean }>
  /** A `reason` records the exit as requested (cause `killed`) and defaults the signal to SIGKILL. */
  kill(sessionId: string, signal?: string, options?: { reason?: 'killed' }): Promise<void>
  forget(sessionId: string): Promise<void>
  list(): Promise<PtySessionInfo[]>
  /** `replay` is base64 ending exactly at `offset`; see `PtySubscription`. */
  subscribe(sessionId: string, options?: { mode?: 'screen' | 'raw'; historyLines?: number }): Promise<PtySubscription>
  snapshot(sessionId: string): Promise<PtySnapshot>
  history(
    sessionId: string,
    options?: { lines?: number; before?: string; format?: 'text' | 'ansi' }
  ): Promise<PtyHistoryPage>
  /** Drops the scrollback and keeps the cursor's line, in every attached viewer and in later restores. */
  clear(sessionId: string): Promise<void>
  /** Turns mouse tracking, bracketed paste and application cursor off and shows the cursor; nothing reaches the process. */
  resetModes(sessionId: string): Promise<void>
  /** Replaces the PTY host process and returns the new host's pid. */
  restartHost(): Promise<{ pid: number }>
  unsubscribe(sessionId: string): Promise<void>
  onData(listener: (sessionId: string, bytes: Uint8Array) => void): () => void
  onExit(
    listener: (
      sessionId: string,
      exitCode: number | null,
      exit: { exitSignal: string | null; exitCause: ExitCause }
    ) => void
  ): () => void
  onFact(listener: (sessionId: string, fact: PtyFact) => void): () => void
  /** Hears every write any plugin makes to a session, as text (invalid UTF-8 decodes lossily). */
  onInput(listener: (sessionId: string, data: string) => void): () => void
  onReconnect(listener: () => void): () => void
}

/** A notification a plugin asks the kernel to show. */
export type PluginNotification = {
  title: string
  body: string
  sessionId?: string
  worktreeId?: string
  /** A view for the window to open when the notification is clicked. */
  open?: { view: string; input?: unknown }
  /** Whether the desktop shell shows a native notification; defaults to true. */
  desktop?: boolean
  /** A sound to play; `file: null` is the system sound, `volume` is 0-100. Absent means silent. */
  sound?: { file: string | null; volume: number }
  /** Whether the webview shows a toast; defaults to true. */
  toast?: boolean
}

/** The kernel half of launching a session. */
export type PluginLaunch = {
  readonly shell: string
  readonly binDir: string
  /** The `QUIRKY_*` and PATH environment for a session; reserved names in `envPatch` are dropped and a `null` value removes the variable. */
  env(input: {
    sessionId: string
    worktreeId: string
    agent: string
    envPatch?: Record<string, string | null>
    /** Absolute path to the trusted plugin shell init file for an interactive shell session. */
    shellInit?: string
  }): Record<string, string>
  shellArgv(): string[]
  /** True when the configured shell gets Quirky's ready-marker wrapper (zsh or bash). */
  shellReady(): boolean
  commandArgv(command: string): string[]
  /** Runs the launch hooks for a session about to start. */
  hooks(input: {
    sessionId: string
    worktreeId: string
    repoId: string
    cwd: string
    agent: string
    prompt?: string
  }): Promise<{ env: Record<string, string | null>; args: string[] }>
}

/** A binary stream to one client connection, opened by a `connection: true` method. */
export type ClientStream = {
  readonly streamId: number
  send(bytes: Uint8Array): void
  onClose(callback: () => void): void
  close(): void
}

/** The client connection behind a call to a `connection: true` method. */
export type CallerConnection = {
  id: number
  transport: 'websocket' | 'socket'
  /** Throws InvalidParams on a socket connection. */
  openStream(): ClientStream
}

/** How a plugin method failure maps to an RPC error code. */
export type PluginErrorKind = 'invalid-params' | 'not-found' | 'conflict'

/** Who invoked a plugin method: a connected client, or another plugin. */
export type PluginCaller =
  | {
      role: ClientRole
      name?: string
      cwd?: string
      sessionId?: string
      worktreeId?: string
      /** Set only for `connection: true` methods. */
      connection?: CallerConnection
    }
  | { role: 'plugin'; pluginId: string }

/** A value that can be bound as an SQL parameter. */
export type StoreValue = string | number | bigint | boolean | null | Uint8Array

/** A plugin's private synchronous SQLite database. */
export type PluginStore = {
  /** The number of migrations applied so far. */
  readonly version: number
  /** Runs one statement that modifies data. */
  run(sql: string, ...params: StoreValue[]): { changes: number; lastInsertRowid: number }
  /** The first matching row, or null. */
  get<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T | null
  /** Every matching row. */
  all<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T[]
  /** Runs one or more statements without parameters. */
  exec(sql: string): void
  /** Runs `work` atomically and synchronously; rolls back if it throws. */
  transaction<T>(work: () => T): T
}

/** One schema step: SQL to execute, or a function that migrates with the store. */
export type StoreMigration = string | ((store: PluginStore) => void)

/** Implements a plugin-provided RPC method. */
export type MethodHandler = (params: Record<string, unknown>, caller: PluginCaller) => unknown

/** Runs one scheduled job; `signal` aborts when the job times out. */
export type JobHandler = (run: { jobId: string; signal: AbortSignal }) => void | Promise<void>

/** What a launch hook is told about the session about to start. */
export type LaunchHookInput = {
  sessionId: string
  worktreeId: string
  repoId: string
  cwd: string
  agent: string
  prompt?: string
  /** Additions from earlier hooks only. */
  env: Readonly<Record<string, string>>
  /** Extra args from earlier hooks. */
  args: readonly string[]
}

/** What a launch hook changes: env additions (null removes a name) and extra agent args. */
export type LaunchPatch = { env?: Record<string, string | null>; args?: string[] }

/** Adjusts a session's launch environment and args before the agent starts. */
export type LaunchHook = (launch: LaunchHookInput) => LaunchPatch | void | Promise<LaunchPatch | void>

export type JobRunStatus = 'running' | 'ok' | 'failed' | 'timed-out'

/** One execution of a job. */
export type JobRun = { startedAt: number; finishedAt: number | null; status: JobRunStatus; error?: string }

/** A scheduled job as listed by `job.list`. */
export type JobInfo = {
  id: string
  plugin: string
  intervalMs: number
  timeoutMs: number
  state: 'idle' | 'running'
  /** Null while running. */
  nextRunAt: number | null
  lastRun: JobRun | null
}

/** An event a plugin emitted, named `<pluginId>/<event>`. */
export type PluginEvent = { type: `${string}/${string}`; data: unknown }

/** Launch env names a hook may not set: these two plus every name starting `QUIRKY_`. */
export const RESERVED_LAUNCH_ENV = ['PATH', 'ZDOTDIR'] as const

/** True when a launch hook may not set or remove env var `name`. */
export function isReservedLaunchEnv(name: string): boolean {
  return (RESERVED_LAUNCH_ENV as readonly string[]).includes(name) || name.startsWith('QUIRKY_')
}

export const MIN_JOB_INTERVAL_MS = 1000
export const MAX_JOB_DURATION_MS = 86_400_000
export const DEFAULT_JOB_TIMEOUT_MS = 300_000

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/
const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
type DurationUnit = keyof typeof DURATION_UNIT_MS

/** Parses `<integer><ms|s|m|h|d>` to milliseconds; null for any other text. Range checks are the caller's. */
export function parseDuration(text: string): number | null {
  const match = DURATION_RE.exec(text)
  if (!match) return null
  return Number(match[1]) * DURATION_UNIT_MS[match[2] as DurationUnit]
}

/** The shortest exact duration string: the largest unit that divides `ms` evenly. */
export function formatDuration(ms: number): string {
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const size = DURATION_UNIT_MS[unit]
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`
  }
  return `${ms}ms`
}

/** The shape a plugin's `main` module must export. */
export type PluginModule = {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/** The parsed contents of a `quirky-plugin.json`. */
export type PluginManifest = {
  id: string
  name: string
  version: string
  description?: string
  /** Relative path inside the plugin directory. */
  main?: string
  /** Relative path of the webview ES module. */
  ui?: string
  /** Relative path of the CLI module. */
  cli?: string
  /** Extra words that reach this plugin's CLI group. */
  cliAliases?: string[]
  /** Defaults to `lazy`. */
  activation?: 'lazy' | 'startup'
  dependencies?: string[]
  /** Contributions by kind; `id` is the name within the plugin's own namespace. */
  contributes?: Record<string, Array<{ id: string } & Record<string, unknown>>>
  /** Replacements for contributions in other plugins' namespaces; `id` is a full contribution ID. */
  overrides?: Array<{ id: string } & Record<string, unknown>>
  /** Full contribution IDs to switch off. */
  disables?: string[]
}

/** Plugin IDs starting with this prefix are reserved for built-in plugins. */
export const BUILTIN_PLUGIN_PREFIX = 'quirky.'

export const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
export const KIND_RE = /^[a-z]+(?:[.-][a-z]+)*$/
export const CONTRIBUTION_NAME_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/

export const MAX_PLUGIN_ID_LENGTH = 64
export const MAX_KIND_LENGTH = 64
export const MAX_CONTRIBUTION_NAME_LENGTH = 128

/** True for a valid plugin ID; a contribution ID (which contains `:`) is never one. */
export function isPluginId(value: string): boolean {
  return value.length <= MAX_PLUGIN_ID_LENGTH && PLUGIN_ID_RE.test(value)
}

/** True for a valid contribution kind such as `command` or `ui.panel`. */
export function isKind(value: string): boolean {
  return value.length <= MAX_KIND_LENGTH && KIND_RE.test(value)
}

/** True for a valid contribution name, the part after `/` in a contribution ID. */
export function isContributionName(value: string): boolean {
  return value.length <= MAX_CONTRIBUTION_NAME_LENGTH && CONTRIBUTION_NAME_RE.test(value)
}

/** Splits `<kind>:<pluginId>/<name>`; null unless every part is valid. */
export function parseContributionId(id: string): { kind: string; namespace: string; name: string } | null {
  const colon = id.indexOf(':')
  if (colon < 0) return null
  const slash = id.indexOf('/', colon + 1)
  if (slash < 0) return null
  const kind = id.slice(0, colon)
  const namespace = id.slice(colon + 1, slash)
  const name = id.slice(slash + 1)
  if (!isKind(kind) || !isPluginId(namespace) || !isContributionName(name)) return null
  return { kind, namespace, name }
}

/** Builds `<kind>:<namespace>/<name>`; throws an Error naming the first invalid part. */
export function formatContributionId(kind: string, namespace: string, name: string): string {
  if (!isKind(kind)) throw new Error(`invalid contribution kind: ${JSON.stringify(kind)}`)
  if (!isPluginId(namespace)) throw new Error(`invalid plugin ID: ${JSON.stringify(namespace)}`)
  if (!isContributionName(name)) throw new Error(`invalid contribution name: ${JSON.stringify(name)}`)
  return `${kind}:${namespace}/${name}`
}
