import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { daemonEntryHash, isDaemonAlive, readRuntime } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope, type ProcessScopeSpawnOptions } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { createCliFixtures, installCliFixtureTools, type CliFixturePaths, type CliFixtureTools, type FixtureCommandResult } from './cli-fixtures'
import { buildCliActorCommand } from './cli-actor'

const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024
const COMMAND_TIMEOUT_MS = 15_000
const STARTUP_TIMEOUT_MS = 30_000
const PROCESS_TABLE_TIMEOUT_MS = 2_000
const PROCESS_TABLE_LIMIT_BYTES = 16 * 1024 * 1024

export type CliWorldExecuteOptions = { signal?: AbortSignal; timeoutMs?: number }
export type CliWorldHooks = {
  beforeStart?: () => Promise<void> | void
  afterReady?: (world: CliWorld) => Promise<void> | void
  onActorLive?: (world: CliWorld) => Promise<void> | void
}
export type CliWorldOptions = { signal?: AbortSignal; deadline?: number; hooks?: CliWorldHooks }
export type CliWorldPaths = CliFixturePaths & {
  repoRoot: string
  cliEntry: string
  daemonEntry: string
  actorCommand: string
}
export type CliWorldResult = {
  stdout: string
  stderr: string
  exitCode: number
  stdoutBytes: number
  elapsedMs: number
}
export type CliWorld = {
  home: string
  env: Record<string, string>
  daemonPid: number
  readonly ptyPid: number | undefined
  scope: ProcessScope
  paths: CliWorldPaths
  execute(argv: string[], options?: CliWorldExecuteOptions): Promise<CliWorldResult>
  actorLive(): Promise<void>
  cleanup(): Promise<void>
}

export class CliWorldError extends Error {
  cleanupError?: string
  constructor(
    readonly kind: string,
    message: string,
    readonly stderrTail?: string,
    readonly stdoutBytes?: number,
    readonly elapsedMs?: number,
    readonly exitCode?: number
  ) {
    super(message)
    this.name = 'CliWorldError'
  }
}

type ProcessIdentity = { pid: number; ppid: number; pgid: number; started: string; state: string; command: string }
type HeadCapture = { done: Promise<void>; text(): string; bytes(): number; overflow(): boolean; cancel(): Promise<void> }
type TailCapture = { done: Promise<void>; text(): string; cancel(): Promise<void> }
export type CliBoundedChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>
export type CliCaptureOptions = { signal?: AbortSignal; timeoutMs: number }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function checkInterrupted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error ? reason : new CliWorldError('interrupted', typeof reason === 'string' ? reason : 'CLI rehearsal was interrupted')
}

/** Keep the scope helper's implicit ps calls inside the same isolated environment as its guardian. */
function ownImplicitProcessCalls(env: Record<string, string>): () => void {
  const original = Bun.spawnSync
  Bun.spawnSync = new Proxy(original, {
    apply(target, receiver, args: unknown[]) {
      const [command, options] = args
      if (!Array.isArray(command)) throw new Error('scope process calls must use executable argv')
      const supplied = options && typeof options === 'object' ? options : {}
      const childEnv = 'env' in supplied ? supplied.env : env
      return Reflect.apply(target, receiver, [command, { ...supplied, env: childEnv }])
    }
  })
  return () => { Bun.spawnSync = original }
}

function withOwnedProcessEnvironment<T>(env: Record<string, string>, operation: () => T): T {
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const restoreProcessCalls = ownImplicitProcessCalls(env)
  try {
    return operation()
  } finally {
    restoreProcessCalls()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

async function withOwnedProcessEnvironmentAsync<T>(env: Record<string, string>, operation: () => Promise<T>): Promise<T> {
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const restoreProcessCalls = ownImplicitProcessCalls(env)
  try {
    return await operation()
  } finally {
    restoreProcessCalls()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

function safeProcessScope(scope: ProcessScope, env: Record<string, string>): ProcessScope {
  return {
    home: scope.home,
    env: scope.env,
    spawn<
      const In extends Bun.SpawnOptions.Writable = 'ignore',
      const Out extends Bun.SpawnOptions.Readable = 'pipe',
      const Err extends Bun.SpawnOptions.Readable = 'inherit'
    >(command: string[], options?: ProcessScopeSpawnOptions<In, Out, Err>) {
      return withOwnedProcessEnvironment(env, () => scope.spawn(command, { ...options, env: options?.env ?? env }))
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

function createHeadCapture(stream: ReadableStream<Uint8Array> | null, onOverflow: () => void): HeadCapture {
  const chunks: Buffer[] = []
  let keptBytes = 0
  let totalBytes = 0
  let didOverflow = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const done = (async () => {
    if (!stream) return
    reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        totalBytes += chunk.length
        const allowed = Math.max(0, Math.min(chunk.length, MAX_STDOUT_BYTES - keptBytes))
        if (allowed > 0) {
          chunks.push(allowed === chunk.length ? chunk : chunk.subarray(0, allowed))
          keptBytes += allowed
        }
        if (allowed < chunk.length && !didOverflow) {
          didOverflow = true
          onOverflow()
        }
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return {
    done,
    text: () => Buffer.concat(chunks, keptBytes).toString('utf8'),
    bytes: () => totalBytes,
    overflow: () => didOverflow,
    async cancel() { await reader?.cancel().catch(() => undefined) }
  }
}

function createTailCapture(stream: ReadableStream<Uint8Array> | null): TailCapture {
  const chunks: Buffer[] = []
  let keptBytes = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const done = (async () => {
    if (!stream) return
    reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        if (chunk.length >= MAX_STDERR_BYTES) {
          chunks.splice(0, chunks.length, chunk.subarray(chunk.length - MAX_STDERR_BYTES))
          keptBytes = MAX_STDERR_BYTES
          continue
        }
        chunks.push(chunk)
        keptBytes += chunk.length
        while (keptBytes > MAX_STDERR_BYTES) {
          const excess = keptBytes - MAX_STDERR_BYTES
          const first = chunks[0]!
          if (first.length <= excess) {
            chunks.shift()
            keptBytes -= first.length
          } else {
            chunks[0] = first.subarray(excess)
            keptBytes -= excess
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return {
    done,
    text: () => Buffer.concat(chunks, keptBytes).toString('utf8'),
    async cancel() { await reader?.cancel().catch(() => undefined) }
  }
}

function signalChildGroup(child: CliBoundedChild, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try { child.kill(signal) } catch {}
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return
    try { child.kill(signal) } catch {}
  }
}

async function terminateChildGroup(child: CliBoundedChild): Promise<number> {
  signalChildGroup(child, 'SIGTERM')
  const graceful = await Promise.race([child.exited.then(exit => ({ exit })), Bun.sleep(200).then(() => undefined)])
  signalChildGroup(child, 'SIGKILL')
  const reaped = graceful ?? await Promise.race([child.exited.then(exit => ({ exit })), Bun.sleep(500).then(() => undefined)])
  if (!reaped) throw new CliWorldError('child-reap-failed', `owned child ${child.pid} did not exit after SIGKILL`)
  return reaped.exit
}

async function drainCaptures(stdout: HeadCapture, stderr: TailCapture): Promise<void> {
  const drains = Promise.all([stdout.done, stderr.done])
  const finished = await Promise.race([drains.then(() => true), Bun.sleep(500).then(() => false)])
  if (finished) return
  await Promise.allSettled([stdout.cancel(), stderr.cancel()])
  await Promise.allSettled([stdout.done, stderr.done])
}

function boundedCommandError(
  kind: string,
  message: string,
  stderrTail: string,
  measurements?: { stdoutBytes: number; elapsedMs: number; exitCode: number }
): CliWorldError {
  return new CliWorldError(kind, message, stderrTail, measurements?.stdoutBytes, measurements?.elapsedMs, measurements?.exitCode)
}

export async function captureCliChild(child: CliBoundedChild, options: CliCaptureOptions): Promise<CliWorldResult> {
  const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, options.timeoutMs)
  checkInterrupted(options.signal)
  if (timeoutMs <= 0) throw new CliWorldError('deadline', 'No child command time remains')
  const failure = Promise.withResolvers<never>()
  const stdout = createHeadCapture(child.stdout, () => failure.reject(boundedCommandError('stdout-overflow', `Child stdout exceeded ${MAX_STDOUT_BYTES} bytes`, '')))
  const stderr = createTailCapture(child.stderr)
  const startedAt = Date.now()
  const onAbort = () => {
    const reason = options.signal?.reason
    const kind = reason && typeof reason === 'object' && 'kind' in reason && typeof reason.kind === 'string' ? reason.kind : 'interrupted'
    failure.reject(boundedCommandError(kind, errorText(reason ?? 'Child command was interrupted'), ''))
  }
  const timer = setTimeout(() => failure.reject(boundedCommandError('command-timeout', `Child command exceeded ${timeoutMs}ms`, '')), timeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  let exitCode: number
  try {
    exitCode = await Promise.race([child.exited, failure.promise])
  } catch (error) {
    let cleanupError: string | undefined
    let reapedCode: number | undefined
    try { reapedCode = await terminateChildGroup(child) } catch (stopError) { cleanupError = errorText(stopError) }
    await drainCaptures(stdout, stderr)
    const kind = error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string' ? error.kind : 'child-failed'
    const message = [errorText(error), cleanupError ? `child cleanup failed: ${cleanupError}` : ''].filter(Boolean).join('; ')
    throw boundedCommandError(kind, message, stderr.text(), {
      stdoutBytes: stdout.bytes(),
      elapsedMs: Date.now() - startedAt,
      exitCode: reapedCode ?? child.exitCode ?? -1
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  if (stdout.overflow()) {
    const reapedCode = await terminateChildGroup(child)
    await drainCaptures(stdout, stderr)
    throw boundedCommandError('stdout-overflow', `Child stdout exceeded ${MAX_STDOUT_BYTES} bytes`, stderr.text(), {
      stdoutBytes: stdout.bytes(),
      elapsedMs: Date.now() - startedAt,
      exitCode: reapedCode
    })
  }
  try {
    await terminateChildGroup(child)
    await drainCaptures(stdout, stderr)
  } catch (error) {
    throw boundedCommandError('child-reap-failed', errorText(error), stderr.text(), {
      stdoutBytes: stdout.bytes(),
      elapsedMs: Date.now() - startedAt,
      exitCode: child.exitCode ?? exitCode
    })
  }
  return { stdout: stdout.text(), stderr: stderr.text(), exitCode, stdoutBytes: stdout.bytes(), elapsedMs: Date.now() - startedAt }
}

async function runBoundedChild(scope: ProcessScope, env: Record<string, string>, argv: string[], options: {
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
}): Promise<CliWorldResult> {
  checkInterrupted(options.signal)
  const child = scope.spawn(argv, {
    cwd: options.cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  }) as CliBoundedChild
  return captureCliChild(child, options)
}

function parseProcessTable(text: string): Map<number, ProcessIdentity> {
  const rows = new Map<number, ProcessIdentity>()
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    const [pid, ppid, pgid] = columns.slice(0, 3).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || columns.length < 10) continue
    rows.set(pid, {
      pid,
      ppid,
      pgid,
      started: columns.slice(3, 8).join(' '),
      state: columns[8]!,
      command: columns.slice(9).join(' ')
    })
  }
  return rows
}

function processSnapshot(home: string): Map<number, ProcessIdentity> {
  const result = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,stat=,command='], {
    cwd: home,
    env: { HOME: home, QUIRKY_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: join(home, 'tmp'), LANG: 'C', TZ: 'UTC' },
    encoding: 'utf8',
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    maxBuffer: PROCESS_TABLE_LIMIT_BYTES,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new Error('could not inspect owned process identities')
  return parseProcessTable(result.stdout)
}

function processTree(snapshot: Map<number, ProcessIdentity>, rootPid: number): ProcessIdentity[] {
  const children = new Map<number, ProcessIdentity[]>()
  for (const row of snapshot.values()) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const seen = new Set<number>([rootPid])
  const pending = [rootPid]
  const found: ProcessIdentity[] = []
  const root = snapshot.get(rootPid)
  if (root) found.push(root)
  while (pending.length > 0) {
    const parent = pending.pop()!
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      pending.push(child.pid)
    }
  }
  return found
}

function processIdentityKey(identity: ProcessIdentity): string {
  return `${identity.pid}\0${identity.started}\0${identity.command}`
}

function sameProcess(identity: ProcessIdentity, current: ProcessIdentity | undefined): boolean {
  if (!current || current.pid !== identity.pid || current.started !== identity.started) return false
  return current.command === identity.command || current.state.includes('Z')
}

function readPtyPid(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, 'pty.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function checkReadyRuntime(home: string, daemonPid: number, entryHash: string): void {
  const runtime = readRuntime(home)
  if (!runtime || runtime.pid !== daemonPid || runtime.entryHash !== entryHash || runtime.port <= 0) {
    throw new CliWorldError('daemon-readiness', 'runtime readiness does not belong to the spawned daemon and owned home')
  }
}

async function healthCheck(home: string, daemonPid: number, env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  checkInterrupted(signal)
  const runtime = readRuntime(home)
  if (!runtime || runtime.pid !== daemonPid) return false
  return withOwnedProcessEnvironmentAsync(env, () => isDaemonAlive(runtime, 250))
}

function redactDiagnostic(text: string, home: string, tokens: readonly string[]): string {
  let safe = text.split(home).join('<cli-home>')
  for (const token of tokens) if (token) safe = safe.split(token).join('<redacted>')
  const bytes = Buffer.from(safe)
  return bytes.subarray(Math.max(0, bytes.byteLength - MAX_STDERR_BYTES)).toString('utf8')
}

function collectProcessIdentities(snapshot: Map<number, ProcessIdentity>, daemonPid: number, home: string, expectedDaemon?: ProcessIdentity): ProcessIdentity[] {
  const identities = new Map<string, ProcessIdentity>()
  const daemon = snapshot.get(daemonPid)
  if (daemon && (expectedDaemon ? sameProcess(expectedDaemon, daemon) : daemon.command.includes('daemon/src/main.ts'))) {
    for (const identity of processTree(snapshot, daemonPid)) identities.set(processIdentityKey(identity), identity)
  }
  const ptyPid = readPtyPid(home)
  if (ptyPid) {
    const pty = snapshot.get(ptyPid)
    if (pty?.command.includes('pty-host')) {
      identities.set(processIdentityKey(pty), pty)
      for (const child of processTree(snapshot, ptyPid)) identities.set(processIdentityKey(child), child)
    }
  }
  return [...identities.values()]
}

async function waitForProcessExit(identities: readonly ProcessIdentity[], home: string): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const snapshot = processSnapshot(home)
    const remaining = identities.filter((identity) => sameProcess(identity, snapshot.get(identity.pid)))
    if (remaining.length === 0) return []
    await Bun.sleep(75)
  }
  const finalSnapshot = processSnapshot(home)
  return identities.filter((identity) => sameProcess(identity, finalSnapshot.get(identity.pid)))
}

function createWorldScope(home: string, env: Record<string, string>): ProcessScope {
  return safeProcessScope(withOwnedProcessEnvironment(env, () => createProcessScope(home)), env)
}

function validateCliArgv(argv: string[], cliEntry: string): void {
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((argument) => typeof argument !== 'string')) {
    throw new CliWorldError('invalid-cli-arguments', 'CLI argv must contain literal string arguments')
  }
  if (argv[0] !== process.execPath || argv[1] !== cliEntry || !isAbsolute(argv[0])) {
    throw new CliWorldError('invalid-cli-arguments', 'only the checkout CLI under the absolute Bun executable is allowed')
  }
  let localRuntime = false
  let jsonOutput = false
  for (let index = 2; index < argv.length; index++) {
    if (argv[index] === '--runtime' && argv[index + 1] === 'local') localRuntime = true
    if (argv[index] === '--json') jsonOutput = true
  }
  if (!localRuntime || !jsonOutput) throw new CliWorldError('invalid-cli-arguments', 'CLI calls require explicit --runtime local --json')
}

function ensureWorldLive(daemon: CliBoundedChild, closed: boolean): void {
  if (closed) throw new CliWorldError('world-closed', 'CLI world has already been cleaned up')
  if (daemon.exitCode !== null) throw new CliWorldError('daemon-exited', 'owned daemon exited; refusing CLI auto-start')
}

function makeWorld(options: {
  home: string
  env: Record<string, string>
  scope: ProcessScope
  daemon: CliBoundedChild
  paths: CliWorldPaths
  defaultSignal?: AbortSignal
  hooks?: CliWorldHooks
  daemonIdentity: ProcessIdentity
  tokens: string[]
}): CliWorld {
  const observed = new Map<string, ProcessIdentity>()
  observed.set(processIdentityKey(options.daemonIdentity), options.daemonIdentity)
  let cleanupPromise: Promise<void> | undefined
  let closed = false
  let processCaptureError: string | undefined
  let world: CliWorld
  const captureProcesses = () => {
    try {
      const snapshot = processSnapshot(options.home)
      const identities = collectProcessIdentities(snapshot, options.daemon.pid, options.home, options.daemonIdentity)
      for (const identity of identities) observed.set(processIdentityKey(identity), identity)
      const ptyPid = readPtyPid(options.home)
      if (ptyPid && snapshot.get(ptyPid)?.command.includes('pty-host')) options.scope.track(ptyPid)
      processCaptureError = undefined
    } catch (error) {
      processCaptureError = errorText(error)
    }
  }
  world = {
    home: options.home,
    env: options.env,
    daemonPid: options.daemon.pid,
    get ptyPid() {
      const pid = readPtyPid(options.home)
      if (!pid) return undefined
      const snapshot = processSnapshot(options.home)
      const identity = snapshot.get(pid)
      if (!identity?.command.includes('pty-host')) return undefined
      options.scope.track(pid)
      observed.set(processIdentityKey(identity), identity)
      return pid
    },
    scope: options.scope,
    paths: options.paths,
    async execute(argv: string[], executeOptions: CliWorldExecuteOptions = {}) {
      const signal = executeOptions.signal ?? options.defaultSignal
      checkInterrupted(signal)
      ensureWorldLive(options.daemon, closed)
      validateCliArgv(argv, options.paths.cliEntry)
      captureProcesses()
      if (!(await healthCheck(options.home, options.daemon.pid, options.env, signal))) {
        throw new CliWorldError('daemon-exited', 'owned daemon is not healthy; refusing CLI auto-start')
      }
      const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, executeOptions.timeoutMs ?? COMMAND_TIMEOUT_MS)
      let result: CliWorldResult
      try {
        result = await runBoundedChild(options.scope, options.env, argv, {
          cwd: options.paths.repoRoot,
          signal,
          timeoutMs
        })
      } catch (error) {
        captureProcesses()
        if (error instanceof CliWorldError) throw error
        throw new CliWorldError('cli-failed', errorText(error))
      }
      captureProcesses()
      if (options.daemon.exitCode !== null || !(await healthCheck(options.home, options.daemon.pid, options.env, signal))) {
        throw new CliWorldError('daemon-exited', 'owned daemon exited during the CLI operation; refusing further CLI calls', result.stderr)
      }
      return result
    },
    async actorLive() {
      captureProcesses()
      await options.hooks?.onActorLive?.(world)
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise
      closed = true
      cleanupPromise = (async () => {
        captureProcesses()
        let cleanupError: string | undefined = processCaptureError
        const beforeCleanup = [...observed.values()]
        try {
          await options.scope.cleanup()
        } catch (error) {
          cleanupError = errorText(error)
        }
        let lingering: ProcessIdentity[] = []
        try {
          lingering = await waitForProcessExit(beforeCleanup, options.home)
        } catch (error) {
          cleanupError = [cleanupError, errorText(error)].filter(Boolean).join('; ')
        }
        if (lingering.length > 0) {
          cleanupError = [cleanupError, `owned processes remain: ${lingering.map((row) => `${row.pid} ${row.command}`).join(', ')}`].filter(Boolean).join('; ')
        }
        if (lingering.length === 0) {
          try {
            rmSync(options.home, { recursive: true, force: true })
            if (existsSync(options.home)) cleanupError = [cleanupError, 'owned home remains after removal'].filter(Boolean).join('; ')
          } catch (error) {
            cleanupError = [cleanupError, errorText(error)].filter(Boolean).join('; ')
          }
        }
        if (cleanupError) throw new CliWorldError('cleanup-failed', redactDiagnostic(cleanupError, options.home, options.tokens))
      })()
      return cleanupPromise
    }
  }
  return world
}

export function createCliEnvironment(home: string, repoRoot: string, fixtureBin: string, fetchPreload: string): Record<string, string> {
  const root = realpathSync(resolve(home))
  const checkout = resolve(repoRoot)
  const bin = resolve(fixtureBin)
  const preload = resolve(fetchPreload)
  const base = createIsolatedRuntimeEnvironment(root, { repoRoot: checkout })
  for (const key of ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
    const directory = base[key]
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const environment: Record<string, string> = {
    ...base,
    PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    SHELL: join(bin, 'cli-shell'),
    QUIRKY_HOME: root,
    QUIRKY_PORT: '0',
    QUIRKY_AGENT_SEARCH_DIRS: '',
    QUIRKY_CLI_ENTRY: join(checkout, 'packages/cli/src/main.ts'),
    QUIRKY_DAEMON_ENTRY: join(root, 'disabled-daemon-entry.ts'),
    QUIRKY_PTY_HOST_ENTRY: join(checkout, 'packages/pty-host/src/main.ts'),
    CODEX_HOME: join(root, 'codex'),
    CLI_PARITY_CLI_ENTRY: join(checkout, 'packages/cli/src/main.ts'),
    CLI_PARITY_CODEX_FIXTURE: join(root, 'fixtures/codex/codex-app-server-fixture'),
    NODE_OPTIONS: `--require=${preload}`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'
  }
  for (const key of [
    'QUIRKY_RUNTIME', 'QUIRKY_PAIRING', 'QUIRKY_PAIRING_CODE', 'QUIRKY_SESSION_ID', 'QUIRKY_SESSION_TOKEN', 'QUIRKY_WORKTREE_ID',
    'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_SSH', 'GIT_SSH_COMMAND'
  ]) delete environment[key]
  return environment
}

export async function createCliWorld(options: CliWorldOptions = {}): Promise<CliWorld> {
  checkInterrupted(options.signal)
  const startedAt = Date.now()
  const startupDeadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, startedAt + STARTUP_TIMEOUT_MS)
  const repoRoot = realpathSync(resolve(import.meta.dir, '../..'))
  const cliEntry = join(repoRoot, 'packages/cli/src/main.ts')
  const daemonEntry = join(repoRoot, 'packages/daemon/src/main.ts')
  const temporaryHome = mkdtempSync(join('/tmp', 'quirky-cli-world-'))
  const home = realpathSync(temporaryHome)
  let scope: ProcessScope | undefined
  let daemon: CliBoundedChild | undefined
  let env: Record<string, string> = {}
  let paths: CliWorldPaths | undefined
  const diagnostics: TailCapture[] = []
  const tokens: string[] = []

  const setupRun = async (argv: string[], cwd: string): Promise<FixtureCommandResult> => {
    checkInterrupted(options.signal)
    const remaining = Math.min(COMMAND_TIMEOUT_MS, startupDeadline - Date.now())
    if (remaining <= 0) throw new CliWorldError('startup-timeout', 'CLI world startup exceeded 30 seconds')
    const result = await runBoundedChild(scope!, env, argv, { cwd, signal: options.signal, timeoutMs: remaining })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }

  const cleanupFailedStartup = async (): Promise<string | undefined> => {
    if (!scope) {
      rmSync(home, { recursive: true, force: true })
      return undefined
    }
    let cleanupError: string | undefined
    let owned: ProcessIdentity[] = []
    if (daemon) {
      try { owned = collectProcessIdentities(processSnapshot(home), daemon.pid, home) } catch (error) { cleanupError = errorText(error) }
    }
    try {
      await scope.cleanup()
    } catch (error) {
      cleanupError = [cleanupError, errorText(error)].filter(Boolean).join('; ')
    }
    let lingering: ProcessIdentity[] = []
    try { lingering = await waitForProcessExit(owned, home) } catch (error) { cleanupError = [cleanupError, errorText(error)].filter(Boolean).join('; ') }
    if (lingering.length > 0) cleanupError = [cleanupError, `owned processes remain: ${lingering.map((row) => row.pid).join(', ')}`].filter(Boolean).join('; ')
    if (lingering.length === 0) {
      try { rmSync(home, { recursive: true, force: true }) }
      catch (error) { cleanupError = [cleanupError, errorText(error)].filter(Boolean).join('; ') }
    }
    return cleanupError
  }

  try {
    const tools = installCliFixtureTools(home)
    env = createCliEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload)
    scope = createWorldScope(home, env)
    tokens.push(scope.env.QUIRKY_TEST_SCOPE ?? '')
    const fixtures = await createCliFixtures({ home, repoRoot, tools, run: setupRun })
    paths = {
      ...fixtures,
      repoRoot,
      cliEntry,
      daemonEntry,
      actorCommand: buildCliActorCommand({ bunPath: process.execPath, actorEntry: fixtures.actorEntry })
    }
    if (!isAbsolute(process.execPath)) throw new CliWorldError('startup-failed', 'Bun executable path is not absolute')
    if (!existsSync(cliEntry) || !existsSync(daemonEntry) || !existsSync(paths.actorEntry)) {
      throw new CliWorldError('startup-failed', 'checkout CLI, daemon or actor entrypoint is missing')
    }
    await options.hooks?.beforeStart?.()
    checkInterrupted(options.signal)
    if (Date.now() >= startupDeadline) throw new CliWorldError('startup-timeout', 'CLI world startup exceeded 30 seconds')
    daemon = scope.spawn([process.execPath, daemonEntry], {
      cwd: repoRoot,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    }) as CliBoundedChild
    diagnostics.push(createTailCapture(daemon.stdout), createTailCapture(daemon.stderr))
    const expectedHash = daemonEntryHash(daemonEntry)
    const readinessDeadline = Math.min(startupDeadline, Date.now() + STARTUP_TIMEOUT_MS)
    while (Date.now() < readinessDeadline) {
      checkInterrupted(options.signal)
      if (daemon.exitCode !== null) {
        const tail = (await Promise.all(diagnostics.map((capture) => capture.done))).map((_, index) => diagnostics[index]!.text()).join('\n')
        throw new CliWorldError('daemon-exited', `daemon exited ${daemon.exitCode} before readiness`, tail)
      }
      const runtime = readRuntime(home)
      if (runtime) {
        if (!tokens.includes(runtime.token)) tokens.push(runtime.token)
        if (!tokens.includes(runtime.hookToken)) tokens.push(runtime.hookToken)
      }
      if (runtime) {
        if (runtime.pid !== daemon.pid) throw new CliWorldError('daemon-readiness', 'runtime.json belongs to a different process')
        if (runtime.entryHash !== expectedHash) throw new CliWorldError('daemon-readiness', 'runtime.json does not match the checkout daemon entrypoint')
        if (await healthCheck(home, daemon.pid, env, options.signal)) break
      }
      await Bun.sleep(50)
    }
    checkInterrupted(options.signal)
    if (!(await healthCheck(home, daemon.pid, env, options.signal))) {
      throw new CliWorldError('daemon-readiness-timeout', 'owned daemon did not become healthy within 30 seconds', diagnostics.map((capture) => capture.text()).join('\n'))
    }
    checkReadyRuntime(home, daemon.pid, expectedHash)
    const initial = processSnapshot(home).get(daemon.pid)
    if (!initial) throw new CliWorldError('daemon-readiness', 'spawned daemon process identity could not be captured')
    const world = makeWorld({
      home,
      env,
      scope,
      daemon,
      paths,
      defaultSignal: options.signal,
      hooks: options.hooks,
      daemonIdentity: initial,
      tokens
    })
    await options.hooks?.afterReady?.(world)
    if (!(await healthCheck(home, daemon.pid, env, options.signal))) {
      throw new CliWorldError('daemon-exited', 'owned daemon exited after readiness')
    }
    return world
  } catch (error) {
    const cleanupError = await cleanupFailedStartup()
    const drains = Promise.allSettled(diagnostics.map((capture) => capture.done))
    const drained = await Promise.race([drains.then(() => true), Bun.sleep(500).then(() => false)])
    if (!drained) await Promise.allSettled(diagnostics.map((capture) => capture.cancel()))
    const daemonTail = diagnostics.map((capture) => capture.text()).join('\n')
    const message = errorText(error)
    const stderrTail = redactDiagnostic([error && typeof error === 'object' && 'stderrTail' in error && typeof error.stderrTail === 'string' ? error.stderrTail : '', daemonTail].filter(Boolean).join('\n'), home, tokens)
    const kind = error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string' ? error.kind : 'startup-failed'
    const failure = new CliWorldError(kind, redactDiagnostic(message, home, tokens), stderrTail || undefined)
    if (cleanupError) failure.cleanupError = redactDiagnostic(cleanupError, home, tokens)
    throw failure
  }
}
