import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { daemonEntryHash, isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope, type ProcessScopeSpawnOptions } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment, prepareCaptureFixtureHome, type FixtureWorktree } from '../ui-review/fixtures'
import type { Page } from 'playwright'
import type { StartWorldDependencies, SoakWorld } from '../soak/world'
import type { SoakWindows } from '../soak/windows'
import type { WindowRecord } from '../soak/contracts'
import { createCliFixtures, installCliFixtureTools, type CliFixturePaths, type CliFixtureTools, type FixtureCommandResult } from './cli-fixtures'
import { buildCliActorCommand } from './cli-actor'

const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024
const COMMAND_TIMEOUT_MS = 15_000
const STARTUP_TIMEOUT_MS = 30_000
const PROCESS_TABLE_TIMEOUT_MS = 2_000
const PROCESS_TABLE_LIMIT_BYTES = 16 * 1024 * 1024

export type CliWorldExecuteOptions = { signal?: AbortSignal; timeoutMs?: number; cwd?: string }
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
  coordinatorCommand: string
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
  serveEnvironment(home: string): Record<string, string>
  execute(argv: string[], options?: CliWorldExecuteOptions): Promise<CliWorldResult>
  actorLive(): Promise<void>
  cleanup(): Promise<void>
}

export type CliFilesWorldOptions = { signal?: AbortSignal; deadline?: number }
export type CliFilesTrackedIdentity = {
  kind: string
  pid: number
  ppid: number
  pgid: number
  started: string
  command: string
  gone: boolean
}
export type CliFilesCleanupEvidence = {
  trackedIdentities: readonly CliFilesTrackedIdentity[]
  identities: readonly { kind: string; pid: number; gone: boolean }[]
  processIdentitiesGone: boolean
  homeRemoved: boolean
}
export type CliFilesWorld = {
  home: string
  env: Record<string, string>
  daemonPid: number
  cliEntry: string
  pages: readonly Page[]
  records: readonly WindowRecord[]
  worktrees: readonly FixtureWorktree[]
  tools: CliFixtureTools
  buildElapsedMs: number
  assertLive(options?: CliWorldExecuteOptions): Promise<void>
  execute(argv: string[], options?: CliWorldExecuteOptions): Promise<CliWorldResult>
  prepare(argv: string[], cwd: string, options?: CliWorldExecuteOptions): Promise<CliWorldResult>
  cleanup(): Promise<void>
  readonly cleanupEvidence: CliFilesCleanupEvidence
}

type CliFilesStartWorldOptions = {
  out: string
  repoRoot: string
  signal?: AbortSignal
  windows: 2
  workers: false
}
type CliFilesWorldDependencies = {
  createScope?: () => ProcessScope
  installCliFixtureTools?: typeof installCliFixtureTools
  createCliEnvironment?: typeof createCliEnvironment
  startWorld?: (options: CliFilesStartWorldOptions, dependencies: StartWorldDependencies) => Promise<SoakWorld>
  prepareCaptureFixtureHome?: typeof prepareCaptureFixtureHome
  registerCaptureFixtures?: StartWorldDependencies['registerCaptureFixtures']
  openWindows?: (options: {
    world: SoakWorld
    count: number
    executable: string
    out: string
    signal: AbortSignal
  }) => Promise<SoakWindows>
  findChrome?: () => string | undefined
  readRuntime?: typeof readRuntime
  isDaemonAlive?: typeof isDaemonAlive
  processSnapshot?: typeof processSnapshot
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  verifyEgressGuard?: (options: {
    env: Record<string, string>
    tools: CliFixtureTools
    repoRoot: string
  }) => Promise<void>
  runCli?: (argv: string[], options: CliWorldExecuteOptions & { cwd: string; timeoutMs: number }) => Promise<CliWorldResult>
  runPreparation?: (argv: string[], options: CliWorldExecuteOptions & { cwd: string; timeoutMs: number }) => Promise<CliWorldResult>
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

function safeProcessScope(
  scope: ProcessScope,
  env: Record<string, string>,
  onSpawn?: (command: string[], child: { pid: number; exited: Promise<number> }, spawnedAt: number) => void
): ProcessScope {
  return {
    home: scope.home,
    env: scope.env,
    spawn<
      const In extends Bun.SpawnOptions.Writable = 'ignore',
      const Out extends Bun.SpawnOptions.Readable = 'pipe',
      const Err extends Bun.SpawnOptions.Readable = 'inherit'
    >(command: string[], options?: ProcessScopeSpawnOptions<In, Out, Err>) {
      let spawnedAt = 0
      const child = withOwnedProcessEnvironment(env, () => {
        spawnedAt = performance.now()
        return scope.spawn(command, { ...options, env: options?.env ?? env })
      })
      onSpawn?.(command, child, spawnedAt)
      return child
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

async function waitForCliFilesDaemonHealth(options: {
  home: string
  daemonPid: number
  expectedRuntime: RuntimeInfo
  processIdentity?: ProcessIdentity
  env: Record<string, string>
  signal: AbortSignal
  deadline: number
  readOwnedRuntime: typeof readRuntime
  probe: typeof isDaemonAlive
  processTable: typeof processSnapshot
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<boolean> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
  const retryDeadline = now() + Math.max(0, Math.min(5_000, options.deadline - Date.now()))
  let processIdentity = options.processIdentity
  let aborted = options.signal.aborted
  const stopped = Promise.withResolvers<void>()
  const onAbort = () => {
    aborted = true
    stopped.resolve()
  }
  const matchesExpectedRuntime = (runtime: RuntimeInfo | null | undefined): runtime is RuntimeInfo => {
    const expected = options.expectedRuntime
    return runtime != null
      && runtime.pid === options.daemonPid
      && runtime.pid === expected.pid
      && runtime.port === expected.port
      && runtime.token === expected.token
      && runtime.hookToken === expected.hookToken
      && runtime.daemonVersion === expected.daemonVersion
      && runtime.protocolVersion === expected.protocolVersion
      && runtime.startedAt === expected.startedAt
      && runtime.socket === expected.socket
      && runtime.entryHash === expected.entryHash
      && runtime.port > 0
  }
  const hasLiveProcessIdentity = () => {
    const current = options.processTable(options.home).get(options.daemonPid)
    if (!current || current.state.includes('Z')) return false
    if (!processIdentity) processIdentity = current
    return sameProcess(processIdentity, current)
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) onAbort()
  try {
    while (now() < retryDeadline) {
      if (aborted || options.signal.aborted || Date.now() >= options.deadline) return false
      const runtime = options.readOwnedRuntime(options.home)
      if (!matchesExpectedRuntime(runtime) || !hasLiveProcessIdentity()) return false
      const remaining = Math.min(retryDeadline - now(), options.deadline - Date.now())
      if (remaining <= 0) return false
      const alive = await Promise.race([
        withOwnedProcessEnvironmentAsync(options.env, () => options.probe(runtime, Math.max(1, Math.min(300, remaining)))),
        stopped.promise.then(() => false)
      ])
      if (aborted || options.signal.aborted || Date.now() >= options.deadline || now() >= retryDeadline) return false
      const afterProbe = options.readOwnedRuntime(options.home)
      if (!matchesExpectedRuntime(afterProbe) || !hasLiveProcessIdentity()) return false
      if (alive) return true
      const pause = Math.min(50, retryDeadline - now(), options.deadline - Date.now())
      if (pause <= 0) return false
      await Promise.race([sleep(pause), stopped.promise])
    }
    return false
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
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

async function waitForProcessExit(
  identities: readonly ProcessIdentity[],
  home: string,
  snapshotReader: typeof processSnapshot = processSnapshot
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const snapshot = snapshotReader(home)
    const remaining = identities.filter((identity) => sameProcess(identity, snapshot.get(identity.pid)))
    if (remaining.length === 0) return []
    await Bun.sleep(75)
  }
  const finalSnapshot = snapshotReader(home)
  return identities.filter((identity) => sameProcess(identity, finalSnapshot.get(identity.pid)))
}

function createWorldScope(
  home: string,
  env: Record<string, string>,
  onSpawn?: (command: string[], child: { pid: number; exited: Promise<number> }, spawnedAt: number) => void
): ProcessScope {
  return safeProcessScope(withOwnedProcessEnvironment(env, () => createProcessScope(home)), env, onSpawn)
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


function isWithinDirectory(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function resolveCliCwd(cwd: string | undefined, repoRoot: string, home: string): string {
  if (cwd === undefined) return repoRoot
  if (!isAbsolute(cwd)) throw new CliWorldError('invalid-cli-arguments', 'CLI cwd must be absolute')
  let realCwd: string
  try {
    realCwd = realpathSync(cwd)
  } catch {
    throw new CliWorldError('invalid-cli-arguments', 'CLI cwd must resolve inside the owned home or checkout root')
  }
  if (realCwd !== repoRoot && !isWithinDirectory(home, realCwd)) {
    throw new CliWorldError('invalid-cli-arguments', 'CLI cwd must resolve inside the owned home or checkout root')
  }
  return realCwd
}

export function createServeEnvironment(
  home: string,
  worldHome: string,
  worldEnv: Record<string, string>,
  repoRoot: string
): Record<string, string> {
  const lexicalRoot = resolve(worldHome)
  const candidate = resolve(home)
  const lexicalRelative = relative(lexicalRoot, candidate)
  if (lexicalRelative === '' || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new CliWorldError('invalid-serve-home', 'serve home must be inside the CLI world home')
  }
  const root = realpathSync(lexicalRoot)
  let existing = candidate
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new CliWorldError('invalid-serve-home', 'serve home has no existing parent')
    existing = parent
  }
  const canonicalCandidate = resolve(realpathSync(existing), relative(existing, candidate))
  const relativeHome = relative(root, canonicalCandidate)
  if (relativeHome === '' || relativeHome === '..' || relativeHome.startsWith(`..${sep}`) || isAbsolute(relativeHome)) {
    throw new CliWorldError('invalid-serve-home', 'serve home resolves outside the CLI world home')
  }

  return {
    ...worldEnv,
    QUIRKY_HOME: candidate,
    QUIRKY_DAEMON_ENTRY: join(resolve(repoRoot), 'packages/daemon/src/main.ts')
  }
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
    serveEnvironment(home) {
      return createServeEnvironment(home, options.home, { ...options.env, ...options.scope.env }, options.paths.repoRoot)
    },
    async execute(argv: string[], executeOptions: CliWorldExecuteOptions = {}) {
      const signal = executeOptions.signal ?? options.defaultSignal
      checkInterrupted(signal)
      ensureWorldLive(options.daemon, closed)
      validateCliArgv(argv, options.paths.cliEntry)
      const cwd = resolveCliCwd(executeOptions.cwd, options.paths.repoRoot, options.home)
      captureProcesses()
      if (!(await healthCheck(options.home, options.daemon.pid, options.env, signal))) {
        throw new CliWorldError('daemon-exited', 'owned daemon is not healthy; refusing CLI auto-start')
      }
      const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, executeOptions.timeoutMs ?? COMMAND_TIMEOUT_MS)
      let result: CliWorldResult
      try {
        result = await runBoundedChild(options.scope, options.env, argv, {
          cwd,
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
    BUN_OPTIONS: `--preload=${preload}`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'
  }
  for (const key of [
    'QUIRKY_RUNTIME', 'QUIRKY_PAIRING', 'QUIRKY_PAIRING_CODE', 'QUIRKY_SESSION_ID', 'QUIRKY_SESSION_TOKEN', 'QUIRKY_WORKTREE_ID',
    'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_OPTIONS',
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
      actorCommand: buildCliActorCommand({ bunPath: process.execPath, actorEntry: fixtures.actorEntry }),
      coordinatorCommand: `${buildCliActorCommand({ bunPath: process.execPath, actorEntry: fixtures.workerActorEntry })} coordinator`
    }
    if (!isAbsolute(process.execPath)) throw new CliWorldError('startup-failed', 'Bun executable path is not absolute')
    if (!existsSync(cliEntry) || !existsSync(daemonEntry) || !existsSync(paths.actorEntry) || !existsSync(paths.workerActorEntry)) {
      throw new CliWorldError('startup-failed', 'checkout CLI, daemon or actor entrypoint is missing')
    }
    await options.hooks?.beforeStart?.()
    checkInterrupted(options.signal)
    if (Date.now() >= startupDeadline) throw new CliWorldError('startup-timeout', 'CLI world startup exceeded 30 seconds')
    const selfTestUrl = 'https://cli-parity-guard.invalid/self-test'
    const selfTestSentinel = 'CLI_PARITY_EGRESS_GUARD_ACTIVE\n'
    let guardTest: FixtureCommandResult
    try {
      guardTest = await setupRun([
        process.execPath,
        '-e',
        `fetch(${JSON.stringify(selfTestUrl)}).then(() => { process.exitCode = 3 }, (error) => { if (error instanceof Error && error.message.includes('non-loopback')) process.stdout.write(${JSON.stringify(selfTestSentinel)}); else process.exitCode = 4 })`
      ], repoRoot)
    } catch {
      if (options.signal?.aborted) checkInterrupted(options.signal)
      throw new CliWorldError('egress-guard-inactive', 'fetch egress guard self-test could not be run')
    }
    let egressLog = ''
    try {
      egressLog = readFileSync(paths.egressLog, 'utf8')
    } catch {}
    if (guardTest.exitCode !== 0 || guardTest.stdout !== selfTestSentinel || egressLog !== `${selfTestUrl}\n`) {
      throw new CliWorldError('egress-guard-inactive', 'fetch egress guard self-test failed')
    }
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

const CLI_FILES_WORK_TIMEOUT_MS = 330_000
const CLI_FILES_RENDERER_TIMEOUT_MS = 5_000

function replaceCliFilesEnvironment(
  target: Record<string, string>,
  home: string,
  repoRoot: string,
  tools: CliFixtureTools,
  uiDir: string,
  createEnvironment: typeof createCliEnvironment
): Record<string, string> {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, createEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload), { QUIRKY_UI_DIR: uiDir })
  return target
}

function findInstalledMacChrome(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
  ]
  for (const candidate of candidates) {
    try {
      const executable = realpathSync(candidate)
      if (!statSync(executable).isFile()) continue
      accessSync(executable, constants.X_OK)
      return executable
    } catch {}
  }
  return undefined
}

function ensureCliFilesWork(signal: AbortSignal, deadline: number): void {
  checkInterrupted(signal)
  if (Date.now() >= deadline) throw new CliWorldError('deadline', 'CLI files work deadline reached')
}

function cliFilesRemaining(signal: AbortSignal, deadline: number): number {
  ensureCliFilesWork(signal, deadline)
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new CliWorldError('deadline', 'CLI files work deadline reached')
  return remaining
}

async function waitForCliFilesOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadline: number,
  timeoutMs: number,
  label: string
): Promise<T> {
  const remaining = cliFilesRemaining(signal, deadline)
  const timeout = Math.min(timeoutMs, remaining)
  if (timeout <= 0) throw new CliWorldError('deadline', `${label} has no time remaining`)
  const timedOut = Promise.withResolvers<never>()
  const interrupted = Promise.withResolvers<never>()
  const timer = setTimeout(() => timedOut.reject(new CliWorldError('deadline', `${label} exceeded its deadline`)), timeout)
  const abort = () => {
    const reason = signal.reason
    interrupted.reject(reason instanceof Error ? reason : new CliWorldError('interrupted', 'CLI files work was interrupted'))
  }
  signal.addEventListener('abort', abort, { once: true })
  const result = Promise.race([operation, timedOut.promise, interrupted.promise])
  if (signal.aborted) abort()
  try {
    return await result
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

function cliFilesWindowIds(value: unknown): number[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliWorldError('renderer-disconnected', 'ui.state returned an invalid response')
  }
  const state = value as Record<string, unknown>
  if (!Array.isArray(state.windows)) throw new CliWorldError('renderer-disconnected', 'ui.state returned no windows list')
  const ids: number[] = []
  for (const entry of state.windows) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CliWorldError('renderer-disconnected', 'ui.state returned an invalid window record')
    }
    const connId = (entry as Record<string, unknown>).connId
    if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId <= 0) {
      throw new CliWorldError('renderer-disconnected', 'ui.state returned an invalid connection ID')
    }
    ids.push(connId)
  }
  if (new Set(ids).size !== ids.length) throw new CliWorldError('renderer-disconnected', 'ui.state returned duplicate connection IDs')
  return ids
}

function resolveOwnedHomeCwd(cwd: string, home: string): string {
  if (!isAbsolute(cwd)) throw new CliWorldError('invalid-cli-arguments', 'fixture cwd must be absolute')
  let realCwd: string
  try {
    realCwd = realpathSync(cwd)
  } catch {
    throw new CliWorldError('invalid-cli-arguments', 'fixture cwd must resolve inside the owned home')
  }
  if (!isWithinDirectory(realpathSync(home), realCwd)) {
    throw new CliWorldError('invalid-cli-arguments', 'fixture cwd must resolve inside the owned home')
  }
  return realCwd
}

function validateFixtureGitArgv(argv: string[]): void {
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new CliWorldError('invalid-cli-arguments', 'fixture Git argv must contain literal string arguments')
  }
  if (argv[0] !== '/usr/bin/git') {
    throw new CliWorldError('invalid-cli-arguments', 'fixture preparation permits only /usr/bin/git')
  }
}

function identityEvidence(
  observed: ReadonlyMap<string, { identity: ProcessIdentity; kind: string }>,
  gone: ReadonlySet<string>,
  home: string,
  tokens: readonly string[]
): CliFilesTrackedIdentity[] {
  return [...observed.entries()].map(([key, value]) => ({
    kind: value.kind,
    pid: value.identity.pid,
    ppid: value.identity.ppid,
    pgid: value.identity.pgid,
    started: value.identity.started,
    command: redactDiagnostic(value.identity.command, home, tokens),
    gone: gone.has(key)
  }))
}

function addObservedIdentity(
  observed: Map<string, { identity: ProcessIdentity; kind: string }>,
  identity: ProcessIdentity,
  kind: string
): void {
  const key = processIdentityKey(identity)
  if (!observed.has(key)) observed.set(key, { identity, kind })
}

function readBrowserPid(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, 'out', 'browser.pid'), 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export async function createCliFilesWorld(
  options: CliFilesWorldOptions = {},
  dependencies: CliFilesWorldDependencies = {}
): Promise<CliFilesWorld> {
  const startedAt = Date.now()
  const requestedDeadline = options.deadline ?? startedAt + CLI_FILES_WORK_TIMEOUT_MS
  if (!Number.isFinite(requestedDeadline) || requestedDeadline <= startedAt) {
    throw new CliWorldError('deadline', 'CLI files work deadline is invalid or expired')
  }
  const deadline = Math.min(requestedDeadline, startedAt + CLI_FILES_WORK_TIMEOUT_MS)
  checkInterrupted(options.signal)
  const repoRoot = realpathSync(resolve(import.meta.dir, '../..'))
  const cliEntry = join(repoRoot, 'packages/cli/src/main.ts')
  const daemonEntry = join(repoRoot, 'packages/daemon/src/main.ts')

  const deadlineController = new AbortController()
  const cleanupController = new AbortController()
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    deadlineController.signal,
    cleanupController.signal
  ])
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new CliWorldError('deadline', 'CLI files work deadline reached')),
    Math.max(1, deadline - Date.now())
  )

  const observed = new Map<string, { identity: ProcessIdentity; kind: string }>()
  const lateCleanupErrors: string[] = []
  let lateResourceUnresolved = false
  const tokens: string[] = []
  let home: string | undefined
  let env: Record<string, string> = {}
  let tools: CliFixtureTools | undefined
  let scope: ProcessScope | undefined
  let soakWorld: SoakWorld | undefined
  let windowSet: SoakWindows | undefined
  let browserPid: number | undefined
  let daemonPid: number | undefined
  let daemonIdentity: ProcessIdentity | undefined
  let browserIdentity: ProcessIdentity | undefined
  let expectedRuntime: RuntimeInfo | undefined
  let startupRecords: WindowRecord[] = []
  let selectedWorktrees: FixtureWorktree[] = []
  let buildElapsedMs = 0
  let cleanupPromise: Promise<void> | undefined
  let closed = false
  let cleanupEvidence: CliFilesCleanupEvidence = {
    trackedIdentities: [],
    identities: [],
    processIdentitiesGone: false,
    homeRemoved: false
  }

  const updateCleanupEvidence = (gone: ReadonlySet<string> = new Set()) => {
    if (!home) return
    const trackedIdentities = identityEvidence(observed, gone, home, tokens)
    cleanupEvidence = {
      trackedIdentities,
      identities: trackedIdentities
        .filter((identity) => identity.kind === 'daemon' || identity.kind === 'browser' || identity.kind === 'pty')
        .map(({ kind, pid, gone: hasGone }) => ({ kind, pid, gone: hasGone })),
      processIdentitiesGone: false,
      homeRemoved: !existsSync(home)
    }
  }

  const processTable = dependencies.processSnapshot ?? processSnapshot

  const captureOwnedProcessIdentities = (requireLive: boolean) => {
    if (!home) throw new CliWorldError('process-identity', 'owned process home is unavailable')
    const runtime = (dependencies.readRuntime ?? readRuntime)(home)
    if (runtime) {
      for (const token of [runtime.token, runtime.hookToken]) {
        if (token && !tokens.includes(token)) tokens.push(token)
      }
    }
    const selectedDaemonPid = daemonPid ?? soakWorld?.daemonPid ?? runtime?.pid
    const snapshot = processTable(home)
    if (selectedDaemonPid && Number.isSafeInteger(selectedDaemonPid) && selectedDaemonPid > 0) {
      const currentDaemon = snapshot.get(selectedDaemonPid)
      if (currentDaemon) {
        if (!daemonIdentity) daemonIdentity = currentDaemon
        if (requireLive && !sameProcess(daemonIdentity, currentDaemon)) {
          throw new CliWorldError('daemon-identity', 'owned daemon process identity changed')
        }
        const daemonAndPty = collectProcessIdentities(snapshot, selectedDaemonPid, home, daemonIdentity)
        const ptyPid = readPtyPid(home)
        const ptyTree = new Set(ptyPid ? processTree(snapshot, ptyPid).map((identity) => identity.pid) : [])
        for (const identity of daemonAndPty) {
          const kind = identity.pid === selectedDaemonPid ? 'daemon' : identity.pid === ptyPid ? 'pty' : ptyTree.has(identity.pid) ? 'pty-child' : 'daemon-child'
          addObservedIdentity(observed, identity, kind)
        }
      } else if (requireLive) {
        throw new CliWorldError('daemon-identity', 'owned daemon process is not present in the process table')
      } else if (!daemonIdentity && runtime) {
        const discovered = snapshot.get(runtime.pid)
        if (discovered?.command.includes('daemon/src/main.ts')) {
          daemonIdentity = discovered
          for (const identity of processTree(snapshot, runtime.pid)) {
            addObservedIdentity(observed, identity, identity.pid === runtime.pid ? 'daemon' : 'daemon-child')
          }
        }
      }
    } else if (requireLive) {
      throw new CliWorldError('daemon-identity', 'owned daemon PID is unavailable')
    }

    const selectedBrowserPid = browserPid ?? readBrowserPid(home)
    if (selectedBrowserPid) {
      const currentBrowser = snapshot.get(selectedBrowserPid)
      if (currentBrowser) {
        const sameBrowserIdentity = !browserIdentity || sameProcess(browserIdentity, currentBrowser)
        if (!sameBrowserIdentity && requireLive) {
          throw new CliWorldError('renderer-disconnected', 'owned browser process identity changed')
        }
        if (sameBrowserIdentity) {
          if (!browserIdentity) browserIdentity = currentBrowser
          for (const identity of processTree(snapshot, selectedBrowserPid)) {
            addObservedIdentity(observed, identity, identity.pid === selectedBrowserPid ? 'browser' : 'browser-child')
          }
        }
      } else if (requireLive) {
        throw new CliWorldError('renderer-disconnected', 'owned browser process is not present in the process table')
      }
    } else if (requireLive) {
      throw new CliWorldError('renderer-disconnected', 'owned browser PID is unavailable')
    }

    if (requireLive && (!daemonIdentity || !browserIdentity)) {
      throw new CliWorldError('process-identity', 'owned daemon and browser identities were not both captured')
    }
    updateCleanupEvidence()
    return snapshot
  }

  const verifyRuntime = async (activeSignal: AbortSignal = signal, activeDeadline = deadline) => {
    if (!home || !soakWorld || !daemonPid || !expectedRuntime) {
      throw new CliWorldError('daemon-identity', 'owned runtime is not ready')
    }
    ensureCliFilesWork(activeSignal, activeDeadline)
    if (soakWorld.home !== home || soakWorld.daemonPid !== daemonPid) {
      throw new CliWorldError('daemon-identity', 'soak world no longer identifies the owned home and daemon')
    }
    const alive = await waitForCliFilesOperation(
      waitForCliFilesDaemonHealth({
        home,
        daemonPid,
        expectedRuntime,
        ...(daemonIdentity ? { processIdentity: daemonIdentity } : {}),
        env,
        signal: activeSignal,
        deadline: activeDeadline,
        readOwnedRuntime: dependencies.readRuntime ?? readRuntime,
        probe: dependencies.isDaemonAlive ?? isDaemonAlive,
        processTable,
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {})
      }),
      activeSignal,
      activeDeadline,
      5_000,
      'owned daemon health check'
    )
    if (!alive) throw new CliWorldError('daemon-exited', 'owned daemon is not healthy; refusing CLI auto-start')
  }

  const verifyLiveRenderers = async (activeSignal: AbortSignal = signal, activeDeadline = deadline): Promise<WindowRecord[]> => {
    if (!soakWorld || !windowSet || startupRecords.length !== 2 || windowSet.pages.length !== 2) {
      throw new CliWorldError('renderer-disconnected', 'both owned renderer windows are required')
    }
    const [fresh, state] = await Promise.all([
      waitForCliFilesOperation(windowSet.finish(), activeSignal, activeDeadline, 15_000, 'renderer window snapshot'),
      waitForCliFilesOperation(
        soakWorld.control.callAny('ui.state', {}, { timeoutMs: Math.min(CLI_FILES_RENDERER_TIMEOUT_MS, cliFilesRemaining(activeSignal, activeDeadline)) }),
        activeSignal,
        activeDeadline,
        CLI_FILES_RENDERER_TIMEOUT_MS,
        'public renderer connection state'
      )
    ])
    if (!Array.isArray(fresh.records) || fresh.records.length !== 2) {
      throw new CliWorldError('renderer-disconnected', 'window finish records do not contain both owned renderers')
    }
    const current = [...fresh.records].sort((left, right) => left.index - right.index)
    const ids = new Set(cliFilesWindowIds(state))
    for (let index = 0; index < 2; index++) {
      const record = current[index]!
      const expected = startupRecords[index]!
      let pageClosed = true
      try {
        pageClosed = windowSet.pages[index]!.isClosed()
      } catch {}
      if (record.index !== index || record.connId !== expected.connId || record.worktree !== expected.worktree
        || record.open !== true || pageClosed || !ids.has(expected.connId)) {
        throw new CliWorldError('renderer-disconnected', `owned renderer ${index} is closed, stale, or disconnected`)
      }
    }
    return current
  }

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    closed = true
    clearTimeout(deadlineTimer)
    if (!cleanupController.signal.aborted) {
      cleanupController.abort(new CliWorldError('world-closed', 'CLI files world has been cleaned up'))
    }
    cleanupPromise = (async () => {
      const cleanupErrors: string[] = [...lateCleanupErrors]
      const recordCleanupError = (error: unknown) => {
        cleanupErrors.push(home ? redactDiagnostic(errorText(error), home, tokens) : errorText(error))
      }

      let processCaptureVerified = true
      if (home) {
        try {
          captureOwnedProcessIdentities(false)
        } catch (error) {
          processCaptureVerified = false
          recordCleanupError(error)
        }
      }
      if (windowSet) {
        try {
          await windowSet.stop()
        } catch (error) {
          recordCleanupError(error)
        }
      }
      if (soakWorld) {
        try {
          await soakWorld.stop()
        } catch (error) {
          recordCleanupError(error)
          try {
            scope?.killNow()
          } catch (killError) {
            recordCleanupError(killError)
          }
          try {
            await scope?.cleanup()
          } catch (scopeError) {
            recordCleanupError(scopeError)
          }
        }
      } else {
        try {
          await scope?.cleanup()
        } catch (error) {
          recordCleanupError(error)
        }
      }

      let processTableVerified = !home
      let lingering: ProcessIdentity[] = []
      if (home) {
        try {
          captureOwnedProcessIdentities(false)
        } catch (error) {
          processCaptureVerified = false
          recordCleanupError(error)
        }
        try {
          lingering = await waitForProcessExit([...observed.values()].map(({ identity }) => identity), home, processTable)
          processTableVerified = true
        } catch (error) {
          recordCleanupError(error)
        }
        if (processTableVerified && lingering.length > 0) {
          try {
            scope?.killNow()
          } catch (error) {
            recordCleanupError(error)
          }
          try {
            await scope?.cleanup()
          } catch (error) {
            recordCleanupError(error)
          }
          try {
            captureOwnedProcessIdentities(false)
            lingering = await waitForProcessExit([...observed.values()].map(({ identity }) => identity), home, processTable)
          } catch (error) {
            processTableVerified = false
            processCaptureVerified = false
            recordCleanupError(error)
          }
        }
      }
      const lingeringKeys = new Set(lingering.map(processIdentityKey))
      const gone = new Set([...observed.keys()].filter((key) => !lingeringKeys.has(key)))
      if (!processTableVerified || !processCaptureVerified) gone.clear()
      const processIdentitiesGone = processTableVerified && processCaptureVerified
        && !lateResourceUnresolved && gone.size === observed.size
      cleanupEvidence = {
        trackedIdentities: home ? identityEvidence(observed, gone, home, tokens) : [],
        identities: home
          ? identityEvidence(observed, gone, home, tokens)
            .filter(({ kind }) => kind === 'daemon' || kind === 'browser' || kind === 'pty')
            .map(({ kind, pid, gone: hasGone }) => ({ kind, pid, gone: hasGone }))
          : [],
        processIdentitiesGone,
        homeRemoved: !home
      }
      if (lingering.length > 0) {
        const detail = lingering.map((identity) => `${identity.pid} ${identity.command}`).join(', ')
        cleanupErrors.push(home ? redactDiagnostic(`owned processes remain: ${detail}`, home, tokens) : `owned processes remain: ${detail}`)
      }
      if (!processIdentitiesGone) {
        cleanupErrors.push('owned process identities could not be verified gone')
      } else if (home) {
        try {
          rmSync(home, { recursive: true, force: true })
          cleanupEvidence = { ...cleanupEvidence, homeRemoved: !existsSync(home) }
          if (!cleanupEvidence.homeRemoved) cleanupErrors.push('owned home remains after removal')
        } catch (error) {
          recordCleanupError(error)
        }
      }
      for (const lateError of lateCleanupErrors) {
        if (!cleanupErrors.includes(lateError)) cleanupErrors.push(lateError)
      }
      if (cleanupErrors.length > 0) {
        const message = cleanupErrors.join('; ')
        const failure = new CliWorldError('cleanup-failed', message)
        failure.cleanupError = message
        throw failure
      }
    })()
    return cleanupPromise
  }

  try {
    ensureCliFilesWork(signal, deadline)
    const injectedScope = dependencies.createScope?.()
    if (injectedScope) {
      home = realpathSync(injectedScope.home)
      scope = safeProcessScope(injectedScope, createIsolatedRuntimeEnvironment(home, { repoRoot }))
    } else {
      home = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-cli-files-')))
    }
    const installTools = dependencies.installCliFixtureTools ?? installCliFixtureTools
    tools = installTools(home)
    const createEnvironment = dependencies.createCliEnvironment ?? createCliEnvironment
    env = createEnvironment(home, repoRoot, tools.fixtureBin, tools.fetchPreload)
    const claudeHome = join(home, '.claude')
    mkdirSync(claudeHome, { recursive: true, mode: 0o700 })
    writeFileSync(join(claudeHome, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { refreshToken: 'cli-parity-fixture-refresh' }
    }), { mode: 0o600 })
    const observeSpawn = (command: string[], child: { pid: number; exited: Promise<number> }, spawnedAt: number) => {
      if (command[0] !== process.execPath) return
      if (command[1] === 'packages/ui/build.ts') {
        void child.exited.then(() => {
          buildElapsedMs = Math.max(0, Math.round(performance.now() - spawnedAt))
        }, () => {
          buildElapsedMs = Math.max(0, Math.round(performance.now() - spawnedAt))
        })
      }
      if (command[1] === 'packages/daemon/src/main.ts') {
        const identity = processTable(home!)
          .get(child.pid)
        if (!identity) throw new CliWorldError('daemon-identity', 'spawned daemon process identity could not be captured')
        if (daemonIdentity && !sameProcess(daemonIdentity, identity)) {
          throw new CliWorldError('daemon-identity', 'spawned daemon PID does not match its original process identity')
        }
        daemonIdentity = identity
        addObservedIdentity(observed, identity, 'daemon')
      }
    }
    scope = injectedScope
      ? safeProcessScope(injectedScope, env, observeSpawn)
      : createWorldScope(home, env, observeSpawn)
    if (scope.home !== home) throw new CliWorldError('startup-failed', 'owned process scope home does not match the allocated home')
    if (!isAbsolute(process.execPath)) throw new CliWorldError('startup-failed', 'Bun executable path is not absolute')
    if (!existsSync(cliEntry) || !existsSync(daemonEntry)) {
      throw new CliWorldError('startup-failed', 'checkout CLI or daemon entrypoint is missing')
    }
    if (scope.env.QUIRKY_TEST_SCOPE) tokens.push(scope.env.QUIRKY_TEST_SCOPE)

    const selfTestUrl = 'https://cli-parity-guard.invalid/self-test'
    const selfTestSentinel = 'CLI_PARITY_EGRESS_GUARD_ACTIVE\n'
    if (dependencies.verifyEgressGuard) {
      await dependencies.verifyEgressGuard({ env, tools: tools!, repoRoot })
    } else {
      let guardResult: CliWorldResult
      try {
        guardResult = await runBoundedChild(scope!, env, [
          process.execPath,
          '-e',
          `fetch(${JSON.stringify(selfTestUrl)}).then(() => { process.exitCode = 3 }, (error) => { if (error instanceof Error && error.message.includes('non-loopback')) process.stdout.write(${JSON.stringify(selfTestSentinel)}); else process.exitCode = 4 })`
        ], {
          cwd: repoRoot,
          signal,
          timeoutMs: Math.min(COMMAND_TIMEOUT_MS, cliFilesRemaining(signal, deadline))
        })
      } catch (error) {
        if (signal.aborted) checkInterrupted(signal)
        throw new CliWorldError('egress-guard-inactive', `fetch egress guard self-test could not be run: ${errorText(error)}`)
      }
      let egressLog = ''
      try {
        egressLog = readFileSync(tools!.egressLog, 'utf8')
      } catch {}
      if (guardResult.exitCode !== 0 || guardResult.stdout !== selfTestSentinel || egressLog !== `${selfTestUrl}\n`) {
        throw new CliWorldError('egress-guard-inactive', 'fetch egress guard self-test failed')
      }
    }

    const helperPrepare = dependencies.prepareCaptureFixtureHome ?? prepareCaptureFixtureHome
    const startDependencies: StartWorldDependencies = {
      createScope: () => scope!,
      prepareCaptureFixtureHome: async (fixtureHome, preparation) => {
        if (fixtureHome !== home) throw new CliWorldError('fixture-home', 'soak fixture preparation escaped the owned home')
        const mutableEnv = preparation.env
        if (!mutableEnv) throw new CliWorldError('environment', 'soak fixture preparation omitted its mutable environment')
        const uiDir = mutableEnv.QUIRKY_UI_DIR
        if (!uiDir || resolve(uiDir) !== join(home!, 'ui-dist')) {
          throw new CliWorldError('ui-build', 'soak helper did not target the owned ui-dist directory')
        }
        env = replaceCliFilesEnvironment(mutableEnv, home!, repoRoot, tools!, uiDir, createEnvironment)
        const remaining = cliFilesRemaining(signal, deadline)
        return helperPrepare(home!, {
          ...preparation,
          timeoutMs: Math.max(1, Math.min(preparation.timeoutMs ?? STARTUP_TIMEOUT_MS, remaining)),
          signal,
          env
        })
      },
      ...(dependencies.registerCaptureFixtures
        ? { registerCaptureFixtures: dependencies.registerCaptureFixtures }
        : {})
    }
    const startWorld = dependencies.startWorld ?? (await import('../soak/world')).startWorld
    soakWorld = await startWorld({
      out: join(home, 'out'),
      repoRoot,
      signal,
      windows: 2,
      workers: false
    }, startDependencies)
    ensureCliFilesWork(signal, deadline)
    if (soakWorld.home !== home || soakWorld.workers.length !== 0 || soakWorld.env.QUIRKY_HOME !== home
      || soakWorld.env.QUIRKY_PORT !== '0' || soakWorld.env.QUIRKY_UI_DIR !== join(home, 'ui-dist')) {
      throw new CliWorldError('daemon-identity', 'soak world is not the owned, worker-free UI runtime')
    }
    if (!existsSync(join(home, 'ui-dist')) || !statSync(join(home, 'ui-dist')).isDirectory()) {
      throw new CliWorldError('ui-build', 'owned UI build did not produce its ui-dist directory')
    }
    daemonPid = soakWorld.daemonPid
    const daemonIdentityAtSpawn = daemonIdentity
    if (daemonIdentity && daemonIdentity.pid !== daemonPid) {
      throw new CliWorldError('daemon-identity', 'runtime PID does not match the spawned daemon identity')
    }
    expectedRuntime = soakWorld.runtime
    if (!Number.isSafeInteger(daemonPid) || daemonPid <= 0 || expectedRuntime.pid !== daemonPid
      || expectedRuntime.port <= 0 || !expectedRuntime.entryHash) {
      throw new CliWorldError('daemon-identity', 'soak runtime does not belong to its reported daemon PID')
    }
    if (!dependencies.startWorld && expectedRuntime.entryHash !== daemonEntryHash(daemonEntry)) {
      throw new CliWorldError('daemon-identity', 'soak runtime entry hash does not match the checkout daemon')
    }
    const initialRuntime = (dependencies.readRuntime ?? readRuntime)(home)
    if (!initialRuntime || initialRuntime.pid !== daemonPid || initialRuntime.port !== expectedRuntime.port
      || initialRuntime.entryHash !== expectedRuntime.entryHash) {
      throw new CliWorldError('daemon-identity', 'runtime.json does not identify the started daemon in the owned home')
    }
    if (!await waitForCliFilesOperation(
      waitForCliFilesDaemonHealth({
        home,
        daemonPid,
        expectedRuntime,
        ...(daemonIdentityAtSpawn ? { processIdentity: daemonIdentityAtSpawn } : {}),
        env,
        signal,
        deadline,
        readOwnedRuntime: dependencies.readRuntime ?? readRuntime,
        probe: dependencies.isDaemonAlive ?? isDaemonAlive,
        processTable,
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {})
      }),
      signal,
      deadline,
      5_000,
      'owned daemon readiness check'
    )) {
      throw new CliWorldError('daemon-exited', 'owned daemon did not remain healthy after startup')
    }
    captureOwnedProcessIdentities(false)
    const daemonSnapshot = processTable(home)
    const currentDaemonIdentity = daemonSnapshot.get(daemonPid)
    if (!currentDaemonIdentity || (daemonIdentityAtSpawn && !sameProcess(daemonIdentityAtSpawn, currentDaemonIdentity))
      || (daemonIdentity && !sameProcess(daemonIdentity, currentDaemonIdentity))) {
      throw new CliWorldError('daemon-identity', 'owned daemon process identity could not be verified')
    }
    daemonIdentity = daemonIdentityAtSpawn ?? currentDaemonIdentity
    addObservedIdentity(observed, daemonIdentity, 'daemon')

    const chrome = (dependencies.findChrome ?? findInstalledMacChrome)()
    if (!chrome || !isAbsolute(chrome)) throw new CliWorldError('missing-chrome', 'an installed macOS Chrome or Chromium executable was not found')
    const openWindows = dependencies.openWindows ?? (await import('../soak/windows')).openWindows
    const rendererController = new AbortController()
    const rendererSignal = AbortSignal.any([signal, rendererController.signal])
    let abandoningWindowOpen = false
    let openingWindows: SoakWindows | undefined
    let lateWindowStop: Promise<void> | undefined
    const stopLateWindow = (opened: SoakWindows): Promise<void> => {
      if (!lateWindowStop) {
        lateWindowStop = Promise.resolve().then(() => opened.stop()).catch((error: unknown) => {
          lateCleanupErrors.push(redactDiagnostic(errorText(error), home!, tokens))
        })
      }
      return lateWindowStop
    }
    const pendingWindows = Promise.resolve().then(() => openWindows({
      world: soakWorld!,
      count: 2,
      executable: chrome,
      out: join(home!, 'out'),
      signal: rendererSignal
    })).then(async (opened) => {
      openingWindows = opened
      if (abandoningWindowOpen) await stopLateWindow(opened)
      else windowSet = opened
      return opened
    })
    let openedWindows: SoakWindows | undefined
    try {
      openedWindows = await waitForCliFilesOperation(
        pendingWindows,
        signal,
        deadline,
        Math.min(30_000, cliFilesRemaining(signal, deadline)),
        'renderer startup'
      )
      windowSet = openedWindows
    } catch (error) {
      rendererController.abort(error)
      abandoningWindowOpen = true
      if (openingWindows) await stopLateWindow(openingWindows)
      const settled = pendingWindows.then(() => undefined, () => undefined)
      const lateDeadline = Promise.withResolvers<never>()
      const lateTimer = setTimeout(
        () => lateDeadline.reject(new CliWorldError('late-resource-cleanup', 'late browser startup did not settle')),
        25_000
      )
      try {
        await Promise.race([settled, lateDeadline.promise])
      } catch (lateError) {
        lateResourceUnresolved = true
        lateCleanupErrors.push(redactDiagnostic(errorText(lateError), home, tokens))
      } finally {
        clearTimeout(lateTimer)
      }
      windowSet = undefined
      throw error
    }
    if (!openedWindows) throw new CliWorldError('renderer-disconnected', 'owned browser startup returned no window handle')
    if (openedWindows.browserPid <= 0 || !Number.isSafeInteger(openedWindows.browserPid)) {
      throw new CliWorldError('renderer-disconnected', 'owned browser did not report a valid process ID')
    }
    browserPid = openedWindows.browserPid
    const pages = openedWindows.pages
    if (pages.length !== 2) throw new CliWorldError('renderer-disconnected', 'owned browser did not open exactly two renderer pages')
    const initialWindowSnapshot = await waitForCliFilesOperation(
      openedWindows.finish(),
      signal,
      deadline,
      15_000,
      'initial window record capture'
    )
    if (!Array.isArray(initialWindowSnapshot.records) || initialWindowSnapshot.records.length !== 2) {
      throw new CliWorldError('renderer-disconnected', 'openWindows did not return two owned window records')
    }
    startupRecords = [...initialWindowSnapshot.records].sort((left, right) => left.index - right.index)
    const fixtureWorktrees = soakWorld.fixtures.worktrees
    const fixtureById = new Map(fixtureWorktrees.map((worktree) => [worktree.id, worktree]))
    if (fixtureById.size !== fixtureWorktrees.length) throw new CliWorldError('worktree-identity', 'soak fixtures contain duplicate worktree IDs')
    const recordConnIds = new Set<number>()
    const recordWorktrees = new Set<string>()
    selectedWorktrees = startupRecords.map((record, index) => {
      if (record.index !== index || !Number.isSafeInteger(record.connId) || record.connId <= 0
        || typeof record.worktree !== 'string' || !record.worktree || record.open !== true
        || recordConnIds.has(record.connId) || recordWorktrees.has(record.worktree)) {
        throw new CliWorldError('renderer-disconnected', 'openWindows records have duplicate, stale, or closed identities')
      }
      recordConnIds.add(record.connId)
      recordWorktrees.add(record.worktree)
      const worktree = fixtureById.get(record.worktree)
      if (!worktree) throw new CliWorldError('worktree-identity', `window record refers to unknown worktree ${record.worktree}`)
      return worktree
    })
    if (selectedWorktrees.length !== 2 || selectedWorktrees[0]!.id === selectedWorktrees[1]!.id) {
      throw new CliWorldError('worktree-identity', 'the two owned windows must use distinct worktrees')
    }
    const initialUiState = await waitForCliFilesOperation(
      soakWorld.control.callAny('ui.state', {}, { timeoutMs: Math.min(CLI_FILES_RENDERER_TIMEOUT_MS, cliFilesRemaining(signal, deadline)) }),
      signal,
      deadline,
      CLI_FILES_RENDERER_TIMEOUT_MS,
      'initial public renderer connection state'
    )
    const initialConnectionIds = new Set(cliFilesWindowIds(initialUiState))
    if (recordConnIds.size !== 2 || [...recordConnIds].some((id) => !initialConnectionIds.has(id))) {
      throw new CliWorldError('renderer-disconnected', 'openWindows records do not match public ui.state connection IDs')
    }
    for (let index = 0; index < pages.length; index++) {
      if (pages[index]!.isClosed()) throw new CliWorldError('renderer-disconnected', `renderer page ${index} closed during startup`)
    }
    captureOwnedProcessIdentities(true)

    const assertLive = async (liveOptions: CliWorldExecuteOptions = {}) => {
      if (closed) throw new CliWorldError('world-closed', 'CLI files world has already been cleaned up')
      const liveSignal = liveOptions.signal ?? signal
      const liveDeadline = liveOptions.signal ? Number.POSITIVE_INFINITY : deadline
      ensureCliFilesWork(liveSignal, liveDeadline)
      await verifyRuntime(liveSignal, liveDeadline)
      await verifyLiveRenderers(liveSignal, liveDeadline)
      captureOwnedProcessIdentities(true)
    }

    const world: CliFilesWorld = {
      home: home!,
      env,
      daemonPid: daemonPid!,
      cliEntry,
      pages,
      records: startupRecords,
      worktrees: selectedWorktrees,
      tools: tools!,
      get buildElapsedMs() {
        return buildElapsedMs
      },
      assertLive,
      async execute(argv, executeOptions = {}) {
        if (closed) throw new CliWorldError('world-closed', 'CLI files world has already been cleaned up')
        const executeSignal = executeOptions.signal ?? signal
        const executeDeadline = executeOptions.signal ? Number.POSITIVE_INFINITY : deadline
        ensureCliFilesWork(executeSignal, executeDeadline)
        validateCliArgv(argv, cliEntry)
        const cwd = resolveOwnedHomeCwd(executeOptions.cwd ?? home!, home!)
        await assertLive(executeOptions)
        const timeoutMs = Math.min(
          COMMAND_TIMEOUT_MS,
          executeOptions.timeoutMs ?? COMMAND_TIMEOUT_MS,
          cliFilesRemaining(executeSignal, executeDeadline)
        )
        const result = dependencies.runCli
          ? await dependencies.runCli(argv, { ...executeOptions, cwd, timeoutMs, signal: executeSignal })
          : await runBoundedChild(scope!, env, argv, { cwd, signal: executeSignal, timeoutMs })
        return result
      },
      async prepare(argv, cwdInput, prepareOptions = {}) {
        if (closed) throw new CliWorldError('world-closed', 'CLI files world has already been cleaned up')
        const prepareSignal = prepareOptions.signal ? AbortSignal.any([signal, prepareOptions.signal]) : signal
        ensureCliFilesWork(prepareSignal, deadline)
        validateFixtureGitArgv(argv)
        const cwd = resolveOwnedHomeCwd(cwdInput, home!)
        const timeoutMs = Math.min(
          COMMAND_TIMEOUT_MS,
          prepareOptions.timeoutMs ?? COMMAND_TIMEOUT_MS,
          cliFilesRemaining(prepareSignal, deadline)
        )
        return dependencies.runPreparation
          ? dependencies.runPreparation(argv, { ...prepareOptions, cwd, timeoutMs, signal: prepareSignal })
          : runBoundedChild(scope!, env, argv, { cwd, signal: prepareSignal, timeoutMs })
      },
      cleanup,
      get cleanupEvidence() {
        return cleanupEvidence
      }
    }
    clearTimeout(deadlineTimer)
    return world
  } catch (error) {
    let cleanupError: string | undefined
    try {
      await cleanup()
    } catch (failure) {
      cleanupError = errorText(failure)
    }
    const kind = error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string'
      ? error.kind
      : 'startup-failed'
    const original = error instanceof CliWorldError
      ? error
      : new CliWorldError(kind, home ? redactDiagnostic(errorText(error), home, tokens) : errorText(error))
    if (cleanupError) {
      const safeCleanupError = home ? redactDiagnostic(cleanupError, home, tokens) : cleanupError
      original.cleanupError = safeCleanupError
      original.message = `${original.message}; cleanup failed: ${safeCleanupError}`
    }
    throw original
  }
}
