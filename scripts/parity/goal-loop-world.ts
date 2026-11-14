import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { get } from 'node:http'
import { daemonEntryHash, readRuntime } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope, type ProcessScopeSpawnOptions } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { captureCliChild, CliWorldError, type CliBoundedChild, type CliWorldResult } from './cli-world'
import { installGoalLoopFixtures, type GoalLoopFixtureFaults, type GoalLoopFixturePaths } from './goal-loop-fixtures'
import { installGoalLoopNetworkGuard } from './goal-loop-network'

const COMMAND_TIMEOUT_MS = 15_000
const STARTUP_TIMEOUT_MS = 30_000
const PROCESS_CHECK_TIMEOUT_MS = 250
const CLEANUP_DEFAULT_TIMEOUT_MS = 10_000
const PROCESS_REAP_TIMEOUT_MS = 2_000
const STREAM_DRAIN_TIMEOUT_MS = 500
const MAX_DIAGNOSTIC_BYTES = 8 * 1024
const PLUGIN_IDS = [
  'quirky.repo', 'quirky.cli', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal',
  'quirky.agent-status', 'quirky.ask', 'quirky.structured', 'quirky.checks', 'quirky.loops', 'quirky.accounts'
] as const
const ISOLATED_PATH_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
type ClaudeUsageListener = { url: string; stop(): Promise<void> }

function createClaudeUsageListener(logPath: string, malformed: boolean): ClaudeUsageListener {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const authorizationMatches = request.headers.get('authorization') === 'Bearer goal-loop-synthetic-access-token'
      const betaMatches = request.headers.get('anthropic-beta') === 'oauth-2025-04-20'
      const ok = request.method === 'GET' &&
        url.pathname === '/api/oauth/usage' &&
        authorizationMatches &&
        betaMatches &&
        !malformed
      appendFileSync(logPath, `${JSON.stringify({
        method: request.method,
        path: url.pathname,
        authorizationMatches,
        betaMatches,
        ok
      })}\n`, { mode: 0o600 })
      if (url.pathname !== '/api/oauth/usage') return new Response('not found', { status: 404 })
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
      if (request.headers.get('x-goal-loop-hold') === 'true') await Bun.sleep(250)
      const body = malformed
        ? '{malformed-claude-usage'
        : JSON.stringify({
            five_hour: { utilization: 17, resets_at: '2030-01-01T00:00:00.000Z' },
            seven_day: { utilization: 43, resets_at: '2030-01-01T00:00:00.000Z' }
          })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  const url = `http://127.0.0.1:${server.port}/api/oauth/usage`
  let stopPromise: Promise<void> | undefined
  return {
    url,
    stop() {
      stopPromise ??= server.stop(true)
      return stopPromise
    }
  }
}

export type GoalLoopLogName = 'omp' | 'omp-input' | 'omp-signal' | 'claude' | 'claude-usage' | 'loop-check' | 'codex' | 'agy' | 'security' | 'orca' | 'egress'
export type GoalLoopCliResult = { exitCode: number; stdout: string; stderr: string }
export type GoalLoopCliOptions = { signal?: AbortSignal; timeoutMs?: number }
export type GoalLoopWorldCleanupOptions = { signal?: AbortSignal; deadline?: number }
export type GoalLoopWorldHooks = {
  beforeStart?: (world: GoalLoopWorld) => Promise<void> | void
  afterReady?: (world: GoalLoopWorld) => Promise<void> | void
  onActiveTurn?: (world: GoalLoopWorld) => Promise<void> | void
}
export type GoalLoopWorldOptions = {
  signal?: AbortSignal
  deadline?: number
  hooks?: GoalLoopWorldHooks
  faults?: GoalLoopFixtureFaults
}
export type GoalLoopWorldPaths = GoalLoopFixturePaths & {
  repoRoot: string
  repoPath: string
  pluginDir: string
  cliEntry: string
  daemonEntry: string
  ptyHostEntry: string
  cliBootstrapEntry: string
  ptyBootstrapEntry: string
}
export type GoalLoopWorld = {
  root: string
  repoPath: string
  env: Record<string, string>
  scope: ProcessScope
  paths: GoalLoopWorldPaths
  readonly daemonPid: number
  readonly ptyPid: number | undefined
  start(): Promise<void>
  cli(args: string[], options?: GoalLoopCliOptions): Promise<GoalLoopCliResult>
  readLog(name: GoalLoopLogName): Promise<string>
  cleanup(options?: GoalLoopWorldCleanupOptions): Promise<void>
}

type DiagnosticCapture = { done: Promise<void>; cancel(): Promise<void>; text(): string }
type OwnedProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorKind(error: unknown): string {
  return error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string' ? error.kind : 'startup-failed'
}

function checkInterrupted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  const kind = reason && typeof reason === 'object' && 'kind' in reason && typeof reason.kind === 'string' ? reason.kind : 'interrupted'
  throw new CliWorldError(kind, errorText(reason ?? 'Goal-loop world operation was interrupted'))
}

function tailDiagnostic(current: string, added: string): string {
  return Buffer.from(current + added).subarray(-MAX_DIAGNOSTIC_BYTES).toString('utf8')
}

function captureTail(stream: ReadableStream<Uint8Array> | null): DiagnosticCapture {
  let value = ''
  let settled = false
  const reader = stream?.getReader()
  const done = (async () => {
    if (!reader) return
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        value = tailDiagnostic(value, decoder.decode(next.value, { stream: true }))
      }
      value = tailDiagnostic(value, decoder.decode())
    } finally {
      settled = true
      reader.releaseLock()
    }
  })()
  void done.catch(() => undefined)
  return {
    done,
    async cancel() {
      if (!reader || settled) return
      await reader.cancel()
    },
    text: () => value
  }
}

async function settlesBeforeDeadline(promise: Promise<unknown>, deadline: number, signal?: AbortSignal): Promise<boolean> {
  const settled = promise.then(() => true, () => true)
  const remaining = deadline - Date.now()
  if (remaining <= 0 || signal?.aborted) return false
  const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<void>()
  const timer = setTimeout(resolveTimeout, remaining)
  const abortWait = Promise.withResolvers<void>()
  const onAbort = () => abortWait.resolve()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    const waits = [settled, timeout.then(() => false)]
    if (signal) waits.push(abortWait.promise.then(() => false))
    return await Promise.race(waits)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function ownImplicitProcessCalls(env: Record<string, string>): () => void {
  const original = Bun.spawnSync
  Bun.spawnSync = new Proxy(original, {
    apply(target, receiver, args: unknown[]) {
      const [command, options] = args
      if (!Array.isArray(command)) throw new Error('owned process calls must use executable argv')
      const supplied = options && typeof options === 'object' ? options : {}
      const childEnv = 'env' in supplied ? supplied.env : env
      const timeout = command[0] === 'ps' ? PROCESS_CHECK_TIMEOUT_MS : COMMAND_TIMEOUT_MS
      return Reflect.apply(target, receiver, [command, { timeout, ...supplied, env: childEnv }])
    }
  })
  return () => { Bun.spawnSync = original }
}

function withOwnedProcessEnvironment<T>(env: Record<string, string>, operation: () => T): T {
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const restoreCalls = ownImplicitProcessCalls(env)
  try {
    return operation()
  } finally {
    restoreCalls()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

async function withOwnedProcessEnvironmentAsync<T>(env: Record<string, string>, operation: () => Promise<T>): Promise<T> {
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const restoreCalls = ownImplicitProcessCalls(env)
  try {
    return await operation()
  } finally {
    restoreCalls()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

function withGoalLoopPreload(command: string[], preload: string): string[] {
  const expected = `--preload=${preload}`
  let insertion = 1
  while (insertion < command.length) {
    const argument = command[insertion]
    if (argument === '--preload') {
      if (command[insertion + 1] === preload) return command
      insertion += 2
      continue
    }
    if (argument?.startsWith('--preload=')) {
      if (argument === expected) return command
      insertion += 1
      continue
    }
    break
  }
  return [...command.slice(0, insertion), expected, ...command.slice(insertion)]
}
function ownedScope(scope: ProcessScope, env: Record<string, string>): ProcessScope {
  return {
    home: scope.home,
    env: scope.env,
    spawn<
      const In extends Bun.SpawnOptions.Writable = 'ignore',
      const Out extends Bun.SpawnOptions.Readable = 'pipe',
      const Err extends Bun.SpawnOptions.Readable = 'inherit'
    >(command: string[], options?: ProcessScopeSpawnOptions<In, Out, Err>) {
      const childEnv = { ...env, ...(options?.env ?? {}) }
      const scopedCommand = command[0] === process.execPath ? withGoalLoopPreload(command, env.GOAL_LOOP_NETWORK_PRELOAD!) : command
      return withOwnedProcessEnvironment(env, () => scope.spawn(scopedCommand, { ...options, env: childEnv }))
    },
    track(pid: number) {
      withOwnedProcessEnvironment(env, () => scope.track(pid))
    },
    cleanup() {
      return withOwnedProcessEnvironmentAsync(env, () => scope.cleanup())
    },
    killNow() {
      withOwnedProcessEnvironment(env, () => scope.killNow())
    }
  }
}

function quoteNodeOption(path: string): string {
  return `--require="${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function writeCliBootstrap(path: string, cliEntry: string, preload: string): void {
  writeFileSync(path, `import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require(${JSON.stringify(preload)})
const child = spawn(process.execPath, [${JSON.stringify(`--preload=${preload}`)}, ${JSON.stringify(cliEntry)}, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { child.kill(signal) })
child.once('error', (error) => {
  process.stderr.write('goal-loop CLI bootstrap failed: ' + error.message + '\\\\n')
  process.exitCode = 1
})
child.once('close', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 1)
})
`, { mode: 0o600 })
}

function writePtyBootstrap(path: string, ptyEntry: string, preload: string): void {
  writeFileSync(path, `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require(${JSON.stringify(preload)})
await import(${JSON.stringify(ptyEntry)})
`, { mode: 0o600 })
}

function createWorldEnvironment(
  root: string,
  repoRoot: string,
  fixtures: GoalLoopFixturePaths,
  cliBootstrapEntry: string,
  ptyBootstrapEntry: string,
  claudeUsageUrl: string
): Record<string, string> {
  const base = createIsolatedRuntimeEnvironment(root, { repoRoot })
  for (const key of ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
    const directory = base[key]
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const pluginDir = join(root, 'builtin-plugins')
  mkdirSync(pluginDir, { recursive: true, mode: 0o700 })
  for (const pluginId of PLUGIN_IDS) {
    const source = join(repoRoot, 'plugins', pluginId)
    if (!existsSync(source)) throw new CliWorldError('fixture-setup', `required built-in plugin is missing: ${pluginId}`)
    symlinkSync(source, join(pluginDir, pluginId))
  }
  const env: Record<string, string> = {
    ...base,
    PATH: [fixtures.bin, ...ISOLATED_PATH_DIRECTORIES].join(delimiter),
    SHELL: fixtures.shell,
    QUIRKY_HOME: root,
    QUIRKY_PORT: '0',
    QUIRKY_AGENT_SEARCH_DIRS: '',
    QUIRKY_SHELL_INIT: '',
    QUIRKY_BUILTIN_PLUGINS_DIR: pluginDir,
    QUIRKY_UI_DIR: join(repoRoot, 'packages/ui/dist'),
    QUIRKY_CLI_ENTRY: cliBootstrapEntry,
    QUIRKY_DAEMON_ENTRY: join(root, 'disabled-daemon.ts'),
    QUIRKY_PTY_HOST_ENTRY: ptyBootstrapEntry,
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    GOAL_LOOP_CLAUDE_USAGE_URL: claudeUsageUrl,
    GEMINI_CLI_HOME: join(root, 'gemini'),
    KIMI_CODE_HOME: join(root, 'kimi'),
    AGY_HOME: join(root, 'agy'),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    CLOUDSDK_CONFIG: join(root, 'gcloud'),
    AWS_CONFIG_FILE: join(root, 'aws', 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(root, 'aws', 'credentials'),
    GH_CONFIG_DIR: join(root, 'gh'),
    GLAB_CONFIG_DIR: join(root, 'glab'),
    ANTHROPIC_CONFIG_DIR: join(root, 'claude'),
    GOOGLE_APPLICATION_CREDENTIALS: join(root, 'google', 'application_default_credentials.json'),
    GOAL_LOOP_CODEX_FIXTURE: fixtures.codexFixture,
    GOAL_LOOP_CODEX_BUN: process.execPath,
    GOAL_LOOP_NETWORK_PRELOAD: fixtures.networkPreload,
    NODE_OPTIONS: quoteNodeOption(fixtures.networkPreload),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'
  }
  for (const directory of [
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    env.ANTHROPIC_CONFIG_DIR,
    env.GEMINI_CLI_HOME,
    env.KIMI_CODE_HOME,
    env.AGY_HOME,
    env.CLOUDSDK_CONFIG,
    env.GH_CONFIG_DIR,
    env.GLAB_CONFIG_DIR,
    dirname(env.AWS_CONFIG_FILE!),
    dirname(env.AWS_SHARED_CREDENTIALS_FILE!),
    dirname(env.GOOGLE_APPLICATION_CREDENTIALS!)
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const key of [
    'QUIRKY_RUNTIME', 'QUIRKY_PAIRING', 'QUIRKY_PAIRING_CODE', 'QUIRKY_SESSION_ID', 'QUIRKY_SESSION_TOKEN', 'QUIRKY_WORKTREE_ID',
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GITHUB_TOKEN',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_SSH', 'GIT_SSH_COMMAND'
  ]) delete env[key]
  return env
}

function readPtyPid(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, 'pty.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

type PtyHostIdentity = { started: string; command: string }

function readPtyHostIdentity(pid: number, entry: string, env: Record<string, string>, timeoutMs = PROCESS_CHECK_TIMEOUT_MS): PtyHostIdentity | undefined {
  if (timeoutMs <= 0) throw new CliWorldError('deadline', 'owned PTY inspection exceeded its deadline')
  const result = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'lstart=,command='], {
    env, stdout: 'pipe', stderr: 'ignore', timeout: Math.max(1, Math.floor(timeoutMs))
  })
  if (result.exitCode === 1 && result.stdout.length === 0) return undefined
  if (result.exitCode !== 0) throw new CliWorldError('process-inspection', 'owned PTY inspection failed or timed out')
  const columns = result.stdout.toString().trim().split(/\s+/)
  if (columns.length < 6) throw new CliWorldError('process-inspection', 'owned PTY inspection returned incomplete identity')
  const started = columns.slice(0, 5).join(' ')
  const command = columns.slice(5).join(' ')
  return command.includes(entry) ? { started, command } : undefined
}

async function waitForPtyExit(
  pid: number,
  expected: PtyHostIdentity | undefined,
  entry: string,
  env: Record<string, string>,
  deadline: number,
  signal?: AbortSignal
): Promise<boolean> {
  while (!signal?.aborted && Date.now() < deadline) {
    const current = readPtyHostIdentity(pid, entry, env, Math.min(PROCESS_CHECK_TIMEOUT_MS, deadline - Date.now()))
    if (!current || (expected !== undefined && (current.started !== expected.started || current.command !== expected.command))) return true
    const remaining = deadline - Date.now()
    if (remaining > 0) await Bun.sleep(Math.min(25, remaining))
  }
  return false
}

function redactDiagnostic(text: string, root: string, tokens: readonly string[]): string {
  let safe = text.split(root).join('<goal-loop-home>')
  for (const token of tokens) if (token) safe = safe.split(token).join('<redacted>')
  return Buffer.from(safe).subarray(-MAX_DIAGNOSTIC_BYTES).toString('utf8')
}

function validateCliArgs(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length === 0 || args.some((argument) => typeof argument !== 'string')) {
    throw new CliWorldError('invalid-cli-arguments', 'world.cli requires literal product CLI argument strings')
  }
  const ownedFlags = args.some((argument) =>
    argument === '--runtime' || argument.startsWith('--runtime=') ||
    argument === '--pairing-code' || argument.startsWith('--pairing-code=') ||
    argument === '--json' || argument.startsWith('--json=')
  )
  if (ownedFlags) throw new CliWorldError('invalid-cli-arguments', 'world.cli owns --runtime local and --json')
}

function readActiveTurnCount(path: string): number {
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).reduce((count, line) => {
    try {
      const entry: unknown = JSON.parse(line)
      return typeof entry === 'object' && entry !== null && 'method' in entry && entry.method === 'turn/start' ? count + 1 : count
    } catch {
      return count
    }
  }, 0)
}

type PreparedWorld = {
  fixtures: GoalLoopFixturePaths
  env: Record<string, string>
  scope: ProcessScope
  claudeUsageListener: ClaudeUsageListener
  cliBootstrapEntry: string
  ptyBootstrapEntry: string
}

async function prepareWorld(root: string, repoRoot: string, faults?: GoalLoopFixtureFaults): Promise<PreparedWorld> {
  let scope: ProcessScope | undefined
  let claudeUsageListener: ClaudeUsageListener | undefined
  try {
    const fixtures = installGoalLoopFixtures(root, faults)
    claudeUsageListener = createClaudeUsageListener(fixtures.claudeUsageLog, faults?.malformedClaudeUsage === true)
    installGoalLoopNetworkGuard(fixtures.networkPreload, fixtures.egressLog, claudeUsageListener.url)
    const cliEntry = join(repoRoot, 'packages/cli/src/main.ts')
    const cliBootstrapEntry = join(root, 'fixtures', 'goal-loop-cli-bootstrap.ts')
    const ptyHostEntry = join(repoRoot, 'packages/pty-host/src/main.ts')
    const ptyBootstrapEntry = join(root, 'fixtures', 'goal-loop-pty-bootstrap.ts')
    writeCliBootstrap(cliBootstrapEntry, cliEntry, fixtures.networkPreload)
    writePtyBootstrap(ptyBootstrapEntry, ptyHostEntry, fixtures.networkPreload)
    const env = createWorldEnvironment(root, repoRoot, fixtures, cliBootstrapEntry, ptyBootstrapEntry, claudeUsageListener.url)
    const rawScope = withOwnedProcessEnvironment(env, () => createProcessScope(root))
    scope = ownedScope(rawScope, env)
    return { fixtures, env, scope, claudeUsageListener, cliBootstrapEntry, ptyBootstrapEntry }
  } catch (error) {
    let cleanupError: string | undefined
    try {
      await claudeUsageListener?.stop()
    } catch (failure) {
      cleanupError = `Claude usage listener cleanup failed: ${errorText(failure)}`
    }
    try {
      if (scope) await scope.cleanup()
    } catch (failure) {
      cleanupError = [cleanupError, errorText(failure)].filter(Boolean).join('; ')
    }
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (failure) {
      cleanupError = [cleanupError, errorText(failure)].filter(Boolean).join('; ')
    }
    const failure = error instanceof CliWorldError ? error : new CliWorldError('fixture-setup', errorText(error))
    if (cleanupError) failure.cleanupError = redactDiagnostic(cleanupError, root, [])
    throw failure
  }
}

export async function createGoalLoopWorld(options: GoalLoopWorldOptions = {}): Promise<GoalLoopWorld> {
  checkInterrupted(options.signal)
  const repoRoot = realpathSync(resolve(import.meta.dir, '../..'))
  const root = realpathSync(mkdtempSync(join('/tmp', "quirky goal-loop 'fixture' ")))
  const prepared = await prepareWorld(root, repoRoot, options.faults)
  const { fixtures, env, scope, claudeUsageListener, cliBootstrapEntry, ptyBootstrapEntry } = prepared
  const repoPath = join(root, 'repositories', "fixture's local repository")
  const cliEntry = join(repoRoot, 'packages/cli/src/main.ts')
  const daemonEntry = join(repoRoot, 'packages/daemon/src/main.ts')
  const ptyHostEntry = join(repoRoot, 'packages/pty-host/src/main.ts')
  const paths: GoalLoopWorldPaths = {
    ...fixtures,
    repoRoot,
    repoPath,
    pluginDir: env.QUIRKY_BUILTIN_PLUGINS_DIR!,
    cliEntry,
    cliBootstrapEntry,
    daemonEntry,
    ptyHostEntry,
    ptyBootstrapEntry
  }
  let daemon: OwnedProcess | undefined
  let daemonStdout: DiagnosticCapture | undefined
  let daemonStderr: DiagnosticCapture | undefined
  let startPromise: Promise<void> | undefined
  let cleanupPromise: Promise<void> | undefined
  let started = false
  let closed = false
  let activeTurnTimer: ReturnType<typeof setInterval> | undefined
  let activeTurnHook: Promise<void> | undefined
  let activeTurnHookError: unknown
  let observedTurnCount = 0
  const tokens: string[] = []
  let world: GoalLoopWorld

  const healthy = async (): Promise<boolean> => {
    const runtime = readRuntime(root)
    if (!runtime || !daemon || runtime.pid !== daemon.pid) return false
    const { promise, resolve } = Promise.withResolvers<boolean>()
    // Bun caches inherited proxy selection even after process.env is isolated
    const request = get({ hostname: '127.0.0.1', port: runtime.port, path: '/health', agent: false, timeout: PROCESS_CHECK_TIMEOUT_MS }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
        if (Buffer.byteLength(body) > MAX_DIAGNOSTIC_BYTES) {
          request.destroy()
          resolve(false)
        }
      })
      response.on('error', () => resolve(false))
      response.on('aborted', () => resolve(false))
      response.on('end', () => {
        try {
          const value: unknown = JSON.parse(body)
          resolve(response.statusCode === 200 && typeof value === 'object' && value !== null && 'pid' in value && value.pid === runtime.pid)
        } catch {
          resolve(false)
        }
      })
    })
    request.on('error', () => resolve(false))
    request.on('timeout', () => { request.destroy(); resolve(false) })
    return promise
  }

  const cleanupResources = (cleanupOptions: GoalLoopWorldCleanupOptions = {}): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    closed = true
    if (activeTurnTimer) clearInterval(activeTurnTimer)
    activeTurnTimer = undefined
    cleanupPromise = (async () => {
      const deadline = cleanupOptions.deadline ?? options.deadline ?? Date.now() + CLEANUP_DEFAULT_TIMEOUT_MS
      const signal = cleanupOptions.signal
      const cleanupErrors: string[] = []
      try {
        await claudeUsageListener.stop()
      } catch (error) {
        cleanupErrors.push(`Claude usage listener cleanup failed: ${errorText(error)}`)
      }
      const ptyPid = readPtyPid(root)
      let ptyIdentity: PtyHostIdentity | undefined
      try {
        ptyIdentity = ptyPid ? readPtyHostIdentity(ptyPid, paths.ptyBootstrapEntry, env) : undefined
      } catch (error) {
        cleanupErrors.push(`initial owned PTY inspection failed: ${errorText(error)}`)
      }
      if (ptyPid && ptyIdentity) {
        try {
          scope.track(ptyPid)
        } catch (error) {
          cleanupErrors.push(`initial owned PTY tracking failed: ${errorText(error)}`)
        }
      }
      const forcePtyHost = () => {
        if (!ptyPid || !ptyIdentity) return
        let current: PtyHostIdentity | undefined
        try {
          current = readPtyHostIdentity(ptyPid, paths.ptyBootstrapEntry, env)
        } catch (error) {
          cleanupErrors.push(`owned PTY identity check failed: ${errorText(error)}`)
          return
        }
        if (!current || current.started !== ptyIdentity.started || current.command !== ptyIdentity.command) return
        try {
          process.kill(ptyPid, 'SIGKILL')
        } catch {}
      }
      let forceRequested = false
      const forceOwnedScope = () => {
        if (forceRequested) return
        forceRequested = true
        try {
          scope.killNow()
        } catch (error) {
          cleanupErrors.push(`force process-scope cleanup failed: ${errorText(error)}`)
        }
        if (daemon && daemon.exitCode === null) {
          try {
            daemon.kill('SIGKILL')
          } catch (error) {
            cleanupErrors.push(`force owned daemon cleanup failed: ${errorText(error)}`)
          }
        }
        forcePtyHost()
      }
      const onAbort = () => forceOwnedScope()
      signal?.addEventListener('abort', onAbort, { once: true })
      // leave time to observe exits after forced termination
      const deadlineTimer = setTimeout(forceOwnedScope, Math.max(0, deadline - Date.now() - PROCESS_REAP_TIMEOUT_MS))
      let scopeReaped = false
      try {
        if (signal?.aborted || Date.now() >= deadline) forceOwnedScope()
        try {
          const scopeCleanup = scope.cleanup()
          if (!(await settlesBeforeDeadline(scopeCleanup, deadline, signal))) {
            cleanupErrors.push('process-scope cleanup exceeded the final teardown deadline')
            forceOwnedScope()
          } else {
            await scopeCleanup
            scopeReaped = true
          }
        } catch (error) {
          cleanupErrors.push(`process-scope cleanup failed: ${errorText(error)}`)
          forceOwnedScope()
        }

        const daemonExited = daemon
          ? daemon.exited.then(() => true, () => false)
          : Promise.resolve(true)
        const ptyExited = ptyPid
          ? waitForPtyExit(ptyPid, ptyIdentity, paths.ptyBootstrapEntry, env, deadline, signal)
              .catch((error) => {
                cleanupErrors.push(`owned PTY reaping failed: ${errorText(error)}`)
                return false
              })
          : Promise.resolve(true)
        let daemonReaped = false
        let ptyReaped = false
        const reaping = Promise.all([daemonExited, ptyExited]).then(([daemonDone, ptyDone]) => {
          daemonReaped = daemonDone
          ptyReaped = ptyDone
        })
        const reapGraceDeadline = Math.min(deadline, Date.now() + PROCESS_REAP_TIMEOUT_MS)
        if (!(await settlesBeforeDeadline(reaping, reapGraceDeadline, signal))) {
          forceOwnedScope()
          if (!(await settlesBeforeDeadline(reaping, deadline, signal))) {
            cleanupErrors.push('owned daemon or PTY host did not finish reaping before the hard deadline')
            forceOwnedScope()
          }
        }
        if (!daemonReaped || !ptyReaped) forceOwnedScope()
        if (!daemonReaped) cleanupErrors.push('owned daemon did not exit')
        if (!ptyReaped) cleanupErrors.push(`owned PTY host ${ptyPid} did not exit`)

        const captures = [daemonStdout, daemonStderr].filter((capture): capture is DiagnosticCapture => !!capture)
        let drainResults: PromiseSettledResult<void>[] | undefined
        const drains = Promise.allSettled(captures.map((capture) => capture.done)).then((results) => { drainResults = results })
        const drainDeadline = Math.min(deadline, Date.now() + STREAM_DRAIN_TIMEOUT_MS)
        if (!(await settlesBeforeDeadline(drains, drainDeadline, signal))) {
          forceOwnedScope()
          let cancellations: PromiseSettledResult<void>[] | undefined
          const cancelling = Promise.allSettled(captures.map((capture) => capture.cancel())).then((results) => { cancellations = results })
          if (!(await settlesBeforeDeadline(cancelling, deadline, signal))) {
            cleanupErrors.push('daemon output cancellation was not confirmed before the hard deadline')
          }
          for (const cancellation of cancellations ?? []) {
            if (cancellation.status === 'rejected') cleanupErrors.push(`daemon output cancellation failed: ${errorText(cancellation.reason)}`)
          }
        }
        if (!(await settlesBeforeDeadline(drains, deadline, signal))) {
          cleanupErrors.push('daemon output drain was not confirmed before the hard deadline')
        }
        for (const result of drainResults ?? []) {
          if (result.status === 'rejected') cleanupErrors.push(`daemon output drain failed: ${errorText(result.reason)}`)
        }
        if (signal?.aborted || Date.now() >= deadline) cleanupErrors.push('owned world cleanup exceeded the hard deadline')

        const resourcesReaped = scopeReaped && daemonReaped && ptyReaped && drainResults !== undefined && drainResults.every((result) => result.status === 'fulfilled')
        if (resourcesReaped) {
          try {
            rmSync(root, { recursive: true, force: true })
            if (existsSync(root)) cleanupErrors.push('owned root remains after removal')
          } catch (error) {
            cleanupErrors.push(errorText(error))
          }
        } else {
          cleanupErrors.push('owned root retained because process teardown was not confirmed')
        }
        if (cleanupErrors.length > 0) {
          throw new CliWorldError('cleanup-failed', redactDiagnostic(cleanupErrors.join('; '), root, tokens))
        }
      } finally {
        clearTimeout(deadlineTimer)
        signal?.removeEventListener('abort', onAbort)
      }
    })()
    return cleanupPromise
  }

  world = {
    root,
    repoPath,
    env,
    scope,
    paths,
    get daemonPid() {
      if (!daemon) throw new CliWorldError('world-not-started', 'owned daemon has not started')
      return daemon.pid
    },
    get ptyPid() {
      const pid = readPtyPid(root)
      if (!pid || !readPtyHostIdentity(pid, paths.ptyBootstrapEntry, env)) return undefined
      scope.track(pid)
      return pid
    },
    async start() {
      if (started) return
      if (startPromise) return startPromise
      if (closed) throw new CliWorldError('world-closed', 'goal-loop world has already been cleaned up')
      startPromise = (async () => {
        const startedAt = Date.now()
        const startupDeadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, startedAt + STARTUP_TIMEOUT_MS)
        try {
          checkInterrupted(options.signal)
          await options.hooks?.beforeStart?.(world)
          checkInterrupted(options.signal)
          if (!isAbsolute(process.execPath)) throw new CliWorldError('startup-failed', 'Bun executable path is not absolute')
          if (!existsSync(paths.cliEntry) || !existsSync(paths.cliBootstrapEntry) || !existsSync(paths.daemonEntry) ||
              !existsSync(paths.ptyHostEntry) || !existsSync(paths.ptyBootstrapEntry)) {
            throw new CliWorldError('startup-failed', 'checkout CLI, daemon, PTY host source or owned bootstrap is missing')
          }
          const daemonEntryForRun = options.faults?.failedStartup ? fixtures.failedDaemonEntry : paths.daemonEntry
          daemon = scope.spawn([process.execPath, daemonEntryForRun], {
            cwd: repoRoot,
            env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe'
          }) as OwnedProcess
          daemonStdout = captureTail(daemon.stdout)
          daemonStderr = captureTail(daemon.stderr)
          const expectedHash = daemonEntryHash(paths.daemonEntry)
          let ready = false
          while (Date.now() < startupDeadline) {
            checkInterrupted(options.signal)
            if (closed) throw new CliWorldError('world-closed', 'goal-loop world was cleaned up during startup')
            if (daemon.exitCode !== null) {
              await Promise.all([daemonStdout.done, daemonStderr.done])
              throw new CliWorldError('daemon-exited', `owned daemon exited ${daemon.exitCode} before readiness`, daemonStderr.text())
            }
            const runtime = readRuntime(root)
            if (runtime) {
              if (runtime.pid !== daemon.pid) throw new CliWorldError('daemon-readiness', 'runtime record belongs to a different process')
              if (runtime.entryHash !== expectedHash) throw new CliWorldError('daemon-readiness', 'runtime record does not match the checkout daemon entrypoint')
              if (runtime.port > 0 && await healthy()) {
                tokens.push(runtime.token, runtime.hookToken)
                ready = true
                break
              }
            }
            await Bun.sleep(40)
          }
          checkInterrupted(options.signal)
          if (!ready) throw new CliWorldError('daemon-readiness-timeout', 'owned daemon did not become healthy within 30 seconds', daemonStderr.text())
          const runtime = readRuntime(root)
          if (!runtime || runtime.pid !== daemon.pid || runtime.entryHash !== expectedHash || runtime.port <= 0) {
            throw new CliWorldError('daemon-readiness', 'runtime readiness does not belong to the spawned daemon and owned root')
          }
          started = true
          await options.hooks?.afterReady?.(world)
          if (!(await healthy())) throw new CliWorldError('daemon-exited', 'owned daemon exited after readiness')
          if (options.hooks?.onActiveTurn) {
            activeTurnTimer = setInterval(() => {
              if (closed || activeTurnHook) return
              const count = readActiveTurnCount(paths.codexLog)
              if (count <= observedTurnCount) return
              observedTurnCount = count
              activeTurnHook = (async () => { await options.hooks?.onActiveTurn?.(world) })().catch((error) => {
                activeTurnHookError = error
              }).finally(() => { activeTurnHook = undefined })
            }, 20)
          }
        } catch (error) {
          const cleanupError = await cleanupResources().then(() => undefined, (cleanupFailure) => errorText(cleanupFailure))
          const message = redactDiagnostic(errorText(error), root, tokens)
          const failure = new CliWorldError(errorKind(error), message, redactDiagnostic([
            error && typeof error === 'object' && 'stderrTail' in error && typeof error.stderrTail === 'string' ? error.stderrTail : '',
            daemonStderr?.text() ?? ''
          ].filter(Boolean).join('\n'), root, tokens))
          if (cleanupError) failure.cleanupError = redactDiagnostic(cleanupError, root, tokens)
          throw failure
        }
      })()
      return startPromise
    },
    async cli(args, cliOptions = {}) {
      if (closed) throw new CliWorldError('world-closed', 'goal-loop world has already been cleaned up')
      if (!started || !daemon) throw new CliWorldError('world-not-started', 'call start() before using the checkout CLI')
      if (daemon.exitCode !== null || !(await healthy())) throw new CliWorldError('daemon-exited', 'owned daemon is not healthy; refusing CLI auto-start')
      if (activeTurnHookError !== undefined) {
        const error = activeTurnHookError
        activeTurnHookError = undefined
        throw new CliWorldError('active-turn-hook-failed', redactDiagnostic(errorText(error), root, tokens))
      }
      checkInterrupted(cliOptions.signal ?? options.signal)
      validateCliArgs(args)
      const commandDeadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, Date.now() + Math.min(COMMAND_TIMEOUT_MS, cliOptions.timeoutMs ?? COMMAND_TIMEOUT_MS))
      const remaining = commandDeadline - Date.now()
      if (remaining <= 0) throw new CliWorldError('deadline', 'no CLI command time remains')
      let result: CliWorldResult
      try {
        const child = scope.spawn([process.execPath, paths.cliEntry, ...args, '--runtime', 'local', '--json'], {
          cwd: repoRoot,
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe'
        }) as CliBoundedChild
        result = await captureCliChild(child, { signal: cliOptions.signal ?? options.signal, timeoutMs: remaining })
      } catch (error) {
        if (error instanceof CliWorldError) {
          throw new CliWorldError(error.kind, redactDiagnostic(error.message, root, tokens), redactDiagnostic(error.stderrTail ?? '', root, tokens), error.stdoutBytes, error.elapsedMs, error.exitCode)
        }
        throw new CliWorldError('cli-failed', redactDiagnostic(errorText(error), root, tokens))
      }
      if (daemon.exitCode !== null || !(await healthy())) {
        throw new CliWorldError('daemon-exited', 'owned daemon exited during the CLI operation; refusing subsequent calls', redactDiagnostic(result.stderr, root, tokens))
      }
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
    async readLog(name) {
      const logs: Record<GoalLoopLogName, string> = {
        omp: fixtures.ompLog,
        'omp-input': fixtures.ompInputLog,
        'omp-signal': fixtures.ompSignalLog,
        claude: fixtures.claudeLog,
        'claude-usage': fixtures.claudeUsageLog,
        'loop-check': fixtures.loopCheckLog,
        codex: fixtures.codexLog,
        agy: fixtures.agyLog,
        security: fixtures.securityLog,
        orca: fixtures.orcaLog,
        egress: fixtures.egressLog
      }
      const path = logs[name]
      return existsSync(path) ? readFileSync(path, 'utf8') : ''
    },
    cleanup: cleanupResources
  }

  try {
    const commands = async (...args: string[]): Promise<CliWorldResult> => {
      checkInterrupted(options.signal)
      const child = scope.spawn(['git', ...args], {
        cwd: repoPath,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      }) as CliBoundedChild
      const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, (options.deadline ?? Number.POSITIVE_INFINITY) - Date.now())
      if (timeoutMs <= 0) throw new CliWorldError('deadline', 'fixture Git setup exceeded its time budget')
      const result = await captureCliChild(child, { signal: options.signal, timeoutMs })
      if (result.exitCode !== 0) {
        throw new CliWorldError('fixture-setup', `fixture Git command failed: git ${args.join(' ')}`, redactDiagnostic(result.stderr || result.stdout, root, tokens), result.stdoutBytes, result.elapsedMs, result.exitCode)
      }
      return result
    }
    mkdirSync(join(root, 'repositories'), { recursive: true, mode: 0o700 })
    mkdirSync(repoPath, { recursive: true, mode: 0o700 })
    writeFileSync(join(repoPath, 'fixture.txt'), 'goal-loop local fixture\n', { mode: 0o600 })
    await commands('init', '--initial-branch=main')
    for (const [key, value] of [
      ['user.name', 'Goal loop fixture'],
      ['user.email', 'goal-loop@example.invalid'],
      ['core.hooksPath', '/dev/null'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false']
    ]) await commands('config', '--local', key, value)
    await commands('add', '--', 'fixture.txt')
    await commands('commit', '--no-gpg-sign', '-m', 'goal-loop local fixture')
    const remotes = await commands('remote')
    if (remotes.stdout.trim() !== '') throw new CliWorldError('fixture-setup', 'fixture Git repository unexpectedly has a remote')
    return world
  } catch (error) {
    const cleanupError = await cleanupResources().then(() => undefined, (cleanupFailure) => errorText(cleanupFailure))
    const message = redactDiagnostic(errorText(error), root, tokens)
    const failure = error instanceof CliWorldError
      ? new CliWorldError(error.kind, message, redactDiagnostic(error.stderrTail ?? '', root, tokens), error.stdoutBytes, error.elapsedMs, error.exitCode)
      : new CliWorldError('fixture-setup', message)
    if (cleanupError) failure.cleanupError = redactDiagnostic(cleanupError, root, tokens)
    throw failure
  }
}
