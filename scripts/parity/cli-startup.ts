import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, socketPath, type RuntimeInfo } from '@quirky/protocol/node'
import type { CliActorReceipt } from './cli-actor'
import type { CliCheckContext } from './cli-checks'

export const STARTUP_CHECK_IDS = [
  'startup-ready',
  'startup-already-running',
  'startup-port-in-use',
  'startup-concurrent',
  'startup-parent-loss'
] as const

export type ServeReady = {
  event: 'ready'
  owned: true
  pid: number
  servePid: number
  port: number
  url: string
  socket: string
  home: string
  daemonVersion: string
  protocolVersion: number
  startedAt: number
  safeMode: boolean
  ptyHostPid: number | null
  log: string
}

export type ServeStopped = {
  event: 'stopped'
  reason: 'signal' | 'parent-exited' | 'daemon-exited'
  signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | null
  pid: number
  daemonExitCode: number | null
  daemonSignal: string | null
  killed: boolean
}

type ObjectValue = Record<string, unknown>
type ServeSubprocess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>
export type StartupProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  started: string
  command: string
}
type StartupProcess = {
  home: string
  servePid: number
  serveIdentity?: StartupProcessIdentity
  daemonPid?: number
  daemonIdentity?: StartupProcessIdentity
  ptyHostPid?: number | null
  ptyHostIdentity?: StartupProcessIdentity
  child?: ServeSubprocess
}
type LineCapture = {
  nextLine(timeoutMs: number): Promise<string | undefined>
  done: Promise<void>
  text(): string
}
type StartupActor = {
  record: StartupProcess
  argv: string[]
  child: ServeSubprocess
  stdout: LineCapture
  stderr: Promise<string>
  startedAt: number
}
type StartupResponse =
  | { kind: 'ready'; ready: ServeReady; runtime: RuntimeInfo }
  | { kind: 'refusal' }

type ExpectedReadiness = {
  home: string
  servePid: number
  runtime: { pid: number; port: number }
  port?: number
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): ObjectValue {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} did not match the expected value`)
}

function positivePid(value: unknown, label: string): number {
  ensure(typeof value === 'number' && Number.isInteger(value) && value > 0, `${label} must be a positive PID`)
  return value
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

export function parseServeLines(stdout: string): { ready?: ServeReady; stopped?: ServeStopped; lines: number } {
  const lines = stdout.split(/\r?\n/).filter(line => line.length > 0)
  if (lines.length > 2) throw new Error('serve returned more than two JSONL records')
  let ready: ServeReady | undefined
  let stopped: ServeStopped | undefined
  for (const [index, raw] of lines.entries()) {
    const value = object(parseJson(raw, `serve JSONL record ${index + 1}`), `serve JSONL record ${index + 1}`)
    if (value.event === 'ready') {
      if (ready || stopped) throw new Error('serve returned an unexpected ready record')
      ready = value as unknown as ServeReady
    } else if (value.event === 'stopped') {
      if (!ready || stopped) throw new Error('serve returned an unexpected stopped record')
      stopped = value as unknown as ServeStopped
    } else if (value.event === 'error' || 'error' in value) {
      throw new Error('serve returned an error record instead of a lifecycle record')
    } else {
      throw new Error(`serve returned an unknown event: ${String(value.event)}`)
    }
  }
  return { ...(ready ? { ready } : {}), ...(stopped ? { stopped } : {}), lines: lines.length }
}

export function assertOwnedReadiness(value: unknown, expected: ExpectedReadiness): void {
  const ready = object(value, 'serve ready record')
  equal(ready.event, 'ready', 'serve ready event')
  equal(ready.owned, true, 'serve ownership')
  positivePid(ready.pid, 'serve daemon PID')
  positivePid(ready.servePid, 'serve process PID')
  ensure(Number.isInteger(ready.port) && (ready.port as number) > 0, 'serve runtime port must be a positive integer')
  ensure(typeof ready.url === 'string' && ready.url.length > 0, 'serve URL must be a non-empty string')
  ensure(typeof ready.socket === 'string' && ready.socket.length > 0, 'serve socket must be a non-empty string')
  ensure(typeof ready.home === 'string', 'serve home must be a string')
  ensure(typeof ready.daemonVersion === 'string', 'serve daemon version must be a string')
  ensure(Number.isInteger(ready.protocolVersion), 'serve protocol version must be an integer')
  ensure(typeof ready.startedAt === 'number' && Number.isFinite(ready.startedAt), 'serve start time must be finite')
  ensure(typeof ready.safeMode === 'boolean', 'serve safe-mode value must be a boolean')
  ensure(ready.ptyHostPid === null || (typeof ready.ptyHostPid === 'number' && Number.isInteger(ready.ptyHostPid) && ready.ptyHostPid > 0), 'serve PTY host PID must be a positive integer or null')
  ensure(typeof ready.log === 'string' && ready.log.length > 0, 'serve log path must be a non-empty string')
  equal(ready.pid, expected.runtime.pid, 'serve PID and runtime.json PID')
  equal(ready.port, expected.runtime.port, 'serve port and runtime.json port')
  equal(ready.servePid, expected.servePid, 'serve PID')
  equal(ready.home, expected.home, 'serve home')
  if (expected.port !== undefined) equal(ready.port, expected.port, 'requested serve port')
}

export function assertNoSecrets(stdout: string, runtime: { token: string; hookToken: string }): void {
  if (runtime.token.length > 0 && stdout.includes(runtime.token)) throw new Error('serve output disclosed the runtime token')
  if (runtime.hookToken.length > 0 && stdout.includes(runtime.hookToken)) throw new Error('serve output disclosed the hook token')
}

export function assertCleanStop(value: unknown, expected: { pid: number; signal: 'SIGTERM' }): void {
  const stopped = object(value, 'serve stopped record')
  equal(stopped.event, 'stopped', 'serve stopped event')
  equal(stopped.reason, 'signal', 'serve stop reason')
  equal(stopped.signal, expected.signal, 'serve stop signal')
  equal(stopped.pid, expected.pid, 'stopped daemon PID')
  equal(stopped.daemonExitCode, 0, 'stopped daemon exit code')
  equal(stopped.daemonSignal, null, 'stopped daemon signal')
  equal(stopped.killed, false, 'serve killed daemon')
}

export function assertServeRefusal(
  value: { code: string; message: string; data?: unknown },
  reason: 'already-running' | 'port-in-use',
  expected: { pid?: number; port?: number; home?: string }
): void {
  equal(value.code, 'conflict', 'serve refusal code')
  ensure(typeof value.message === 'string', 'serve refusal message must be a string')
  const data = object(value.data, 'serve refusal data')
  equal(data.reason, reason, 'serve refusal reason')
  if (expected.pid !== undefined) equal(data.pid, expected.pid, 'serve refusal PID')
  if (expected.port !== undefined) equal(data.port, expected.port, 'serve refusal port')
  if (expected.home !== undefined) equal(data.home, expected.home, 'serve refusal home')
}

function makeLineCapture(stream: ReadableStream<Uint8Array>): LineCapture {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const lines: string[] = []
  let output = ''
  let buffered = ''
  let complete = false
  let failure: unknown
  let changed = Promise.withResolvers<void>()
  const notify = () => {
    changed.resolve()
    changed = Promise.withResolvers<void>()
  }
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const text = decoder.decode(chunk.value, { stream: true })
        output += text
        buffered += text
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          lines.push(buffered.slice(0, newline).replace(/\r$/, ''))
          buffered = buffered.slice(newline + 1)
          newline = buffered.indexOf('\n')
          notify()
        }
      }
      const finalText = decoder.decode()
      output += finalText
      buffered += finalText
      if (buffered.length > 0) lines.push(buffered.replace(/\r$/, ''))
    } catch (error) {
      failure = error
    } finally {
      complete = true
      notify()
    }
  })()

  return {
    async nextLine(timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (lines.length === 0 && !complete) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = Promise.withResolvers<'timeout'>()
        timer = setTimeout(() => timeout.resolve('timeout'), remaining)
        const result = await Promise.race([changed.promise.then(() => 'changed' as const), timeout.promise])
        clearTimeout(timer)
        if (result === 'timeout') return undefined
      }
      if (failure !== undefined) throw failure
      return lines.shift()
    },
    done,
    text() {
      return output
    }
  }
}

function startupProcesses(context: Pick<CliCheckContext, 'state'>): StartupProcess[] {
  const value = context.state.startupProcesses
  if (value === undefined) {
    const created: StartupProcess[] = []
    context.state.startupProcesses = created
    return created
  }
  if (!Array.isArray(value)) throw new Error('startup process state is malformed')
  return value as StartupProcess[]
}

function protectedWorldPids(world: CliCheckContext['world']): Set<number> {
  const pids = new Set<number>([world.daemonPid])
  try {
    if (typeof world.ptyPid === 'number') pids.add(world.ptyPid)
  } catch {}
  return pids
}

function trackOwnedPid(context: CliCheckContext, pid: number): void {
  if (protectedWorldPids(context.world).has(pid)) throw new Error(`serve readiness named protected world PID ${pid}`)
  context.world.scope.track(pid)
}

function recordReadinessPids(context: CliCheckContext, actor: StartupActor, value: ObjectValue): void {
  if (typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0) {
    actor.record.daemonPid = value.pid
    actor.record.daemonIdentity = captureStartupProcessIdentity(value.pid)
    trackOwnedPid(context, value.pid)
  }
  if (typeof value.ptyHostPid === 'number' && Number.isInteger(value.ptyHostPid) && value.ptyHostPid > 0) {
    actor.record.ptyHostPid = value.ptyHostPid
    actor.record.ptyHostIdentity = captureStartupProcessIdentity(value.ptyHostPid)
    trackOwnedPid(context, value.ptyHostPid)
  } else if (value.ptyHostPid === null) {
    actor.record.ptyHostPid = null
  }
}

function startServe(context: CliCheckContext, home: string, flags: string[], checkId: string): StartupActor {
  context.check(checkId)
  const argv = [process.execPath, context.world.paths.cliEntry, 'serve', ...flags, '--runtime', 'local', '--json']
  const child = Bun.spawn(argv, {
    cwd: context.world.paths.repoRoot,
    env: context.world.serveEnvironment(home),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  }) as ServeSubprocess
  const identity = captureStartupProcessIdentity(child.pid)
  const record: StartupProcess = {
    home, servePid: child.pid, child,
    ...(identity ? { serveIdentity: identity } : {})
  }
  startupProcesses(context).push(record)
  context.world.scope.track(child.pid)
  return {
    record,
    argv,
    child,
    stdout: makeLineCapture(child.stdout),
    stderr: new Response(child.stderr).text(),
    startedAt: Date.now()
  }
}

async function verifyStatusReadiness(
  context: CliCheckContext,
  home: string,
  runtime: RuntimeInfo,
  deadline: number,
  checkId: string
): Promise<ObjectValue> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('serve readiness deadline expired before status.get')
  const socket = runtime.socket ?? socketPath(home, 'quirkyd.sock')
  const controller = new AbortController()
  let connecting: Promise<QuirkyClient> | undefined
  let client: QuirkyClient
  try {
    client = await awaitWithin(context, () => {
      const connection = QuirkyClient.connectSocket(socket, {
        role: 'cli', name: 'quirky CLI parity startup', token: runtime.token
      }, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]) })
      connecting = connection
      return connection
    }, remaining, 'serve status socket connection', checkId)
  } catch (error) {
    controller.abort(error)
    if (connecting) void connecting.then(lateClient => lateClient.close(), () => {})
    throw error
  }
  try {
    const callRemaining = deadline - Date.now()
    if (callRemaining <= 0) throw new Error('serve readiness deadline expired before status.get')
    const status = object(await awaitWithin(
      context,
      () => client.call('status.get', {}, { timeoutMs: callRemaining }),
      callRemaining,
      'serve status.get readiness probe',
      checkId
    ), 'serve status.get result')
    equal(status.pid, runtime.pid, 'serve status.get PID and runtime.json PID')
    equal(status.home, home, 'serve status.get home')
    const ptyHost = object(status.ptyHost, 'serve status.get PTY host')
    ensure(ptyHost.pid === null || validPid(ptyHost.pid), 'serve status.get PTY host PID must be a positive integer or null')
    ensure(typeof status.safeMode === 'boolean', 'serve status.get safe-mode value must be a boolean')
    return status
  } finally {
    controller.abort()
    client.close()
  }
}

async function firstResponse(
  context: CliCheckContext,
  actor: StartupActor,
  timeoutMs: number,
  checkId: string
): Promise<StartupResponse> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    context.check(checkId)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`serve process ${actor.child.pid} did not respond within ${timeoutMs}ms`)
    const line = await actor.stdout.nextLine(Math.min(100, remaining))
    context.check(checkId)
    if (line === undefined) {
      if (actor.child.exitCode !== null || Date.now() >= deadline) {
        throw new Error(`serve process ${actor.child.pid} did not respond within ${timeoutMs}ms`)
      }
      continue
    }
    if (line.length === 0) continue
    const value = object(parseJson(line, `serve process ${actor.child.pid} output`), 'serve response')
    if (value.event === 'ready') {
      recordReadinessPids(context, actor, value)
      context.check(checkId)
      const ready = value as unknown as ServeReady
      const runtime = readRuntime(actor.record.home)
      if (!runtime) throw new Error(`serve home ${actor.record.home} did not produce runtime.json`)
      assertOwnedReadiness(ready, {
        home: actor.record.home,
        servePid: actor.child.pid,
        runtime: { pid: runtime.pid, port: runtime.port }
      })
      const healthRemaining = deadline - Date.now()
      if (healthRemaining <= 0) throw new Error('serve readiness deadline expired before /health')
      if (!(await awaitWithin(
        context,
        () => isDaemonAlive(runtime, Math.min(1_500, healthRemaining)),
        healthRemaining,
        'serve /health readiness probe',
        checkId
      ))) throw new Error(`serve daemon ${runtime.pid} did not answer /health`)
      const status = await verifyStatusReadiness(context, actor.record.home, runtime, deadline, checkId)
      const ptyHost = object(status.ptyHost, 'serve status.get PTY host')
      equal(ready.ptyHostPid, ptyHost.pid, 'serve readiness PTY host PID and status.get PID')
      equal(ready.safeMode, status.safeMode, 'serve readiness and status.get safe mode')
      equal(ready.daemonVersion, runtime.daemonVersion, 'serve readiness daemon version')
      equal(ready.protocolVersion, runtime.protocolVersion, 'serve readiness protocol version')
      equal(ready.startedAt, runtime.startedAt, 'serve readiness start time')
      equal(ready.socket, runtime.socket ?? socketPath(actor.record.home, 'quirkyd.sock'), 'serve readiness socket')
      equal(ready.url, `http://127.0.0.1:${runtime.port}`, 'serve readiness URL')
      return { kind: 'ready', ready, runtime }
    }
    if ('error' in value) return { kind: 'refusal' }
    throw new Error(`serve process ${actor.child.pid} returned an unexpected first event`)
  }
}

type CheckedPromiseResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }

type CheckedWaitResult<T> = CheckedPromiseResult<T> | { kind: 'tick' } | { kind: 'timeout' }

async function awaitWithin<T>(
  context: CliCheckContext,
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
  checkId: string
): Promise<T> {
  context.check(checkId)
  const observed: Promise<CheckedPromiseResult<T>> = Promise.resolve().then(operation).then(
    value => ({ kind: 'value' as const, value }),
    error => ({ kind: 'error' as const, error })
  )
  const timeout = Promise.withResolvers<CheckedWaitResult<T>>()
  const timer = setTimeout(() => timeout.resolve({ kind: 'timeout' }), timeoutMs)
  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      context.check(checkId)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`${label} exceeded ${timeoutMs}ms`)
      const result = await Promise.race([
        observed,
        timeout.promise,
        Bun.sleep(Math.min(100, remaining)).then(() => ({ kind: 'tick' } as const))
      ])
      context.check(checkId)
      if (result.kind === 'tick') continue
      if (result.kind === 'timeout') throw new Error(`${label} exceeded ${timeoutMs}ms`)
      if (result.kind === 'error') throw result.error
      return result.value
    }
  } finally {
    clearTimeout(timer)
  }
}

async function awaitWhileChecking<T>(
  context: CliCheckContext,
  operation: () => Promise<T>,
  checkId: string
): Promise<T> {
  context.check(checkId)
  const observed: Promise<CheckedPromiseResult<T>> = Promise.resolve().then(operation).then(
    value => ({ kind: 'value' as const, value }),
    error => ({ kind: 'error' as const, error })
  )
  for (;;) {
    context.check(checkId)
    const result = await Promise.race([
      observed,
      Bun.sleep(100).then(() => ({ kind: 'tick' } as const))
    ])
    context.check(checkId)
    if (result.kind === 'tick') continue
    if (result.kind === 'error') throw result.error
    if (result.kind === 'value') return result.value
  }
}

async function actorReceipt(
  context: CliCheckContext,
  actor: StartupActor,
  id: string,
  checkId: string,
  timeoutMs = 15_000
): Promise<CliActorReceipt> {
  const [exitCode, stderr] = await awaitWithin(
    context,
    () => Promise.all([actor.child.exited, actor.stderr]),
    timeoutMs,
    `serve actor ${id} exit`,
    checkId
  )
  await awaitWhileChecking(context, () => actor.stdout.done, checkId)
  const stdout = actor.stdout.text()
  return {
    id,
    argv: actor.argv,
    stdout,
    stderr,
    exitCode,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    elapsedMs: Date.now() - actor.startedAt,
    format: 'jsonl'
  }
}

async function requireExit(
  context: CliCheckContext,
  actor: StartupActor,
  expected: number,
  timeoutMs: number,
  label: string,
  checkId: string
): Promise<number> {
  const exitCode = await awaitWithin(context, () => actor.child.exited, timeoutMs, label, checkId)
  equal(exitCode, expected, `${label} exit code`)
  return exitCode
}



async function freeLoopbackPort(context: CliCheckContext, checkId: string): Promise<number> {
  const server = createServer()
  const listening = Promise.withResolvers<void>()
  const onError = (error: Error) => listening.reject(error)
  server.once('error', onError)
  server.once('listening', () => listening.resolve())
  try {
    server.listen(0, '127.0.0.1')
    await awaitWhileChecking(context, () => listening.promise, checkId)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('free-port probe did not receive a TCP address')
    return address.port
  } finally {
    server.off('error', onError)
    if (server.listening) {
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      await closed.promise
    }
  }
}

function isPidAlive(pid: number, child?: ServeSubprocess): boolean {
  if (child && child.exitCode !== null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') return true
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

function isOriginalPidAlive(pid: number, identity: unknown, child?: ServeSubprocess): boolean {
  return startupIdentityMatches(pid, identity) && isPidAlive(pid, child)
}

function signalPid(
  pid: number,
  signal: NodeJS.Signals,
  identity: unknown,
  child?: ServeSubprocess
): boolean {
  if (!startupIdentityMatches(pid, identity) || (child && child.exitCode !== null)) return false
  if (child) child.kill(signal)
  else process.kill(pid, signal)
  return true
}

async function waitForPidExit(
  pid: number,
  child: ServeSubprocess | undefined,
  timeoutMs: number,
  identity: unknown,
  context?: CliCheckContext,
  checkId?: string
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (context && checkId) context.check(checkId)
    if (!isOriginalPidAlive(pid, identity, child)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await Bun.sleep(Math.min(100, remaining))
    if (context && checkId) context.check(checkId)
  }
}

async function stopReadyActor(
  context: CliCheckContext,
  actor: StartupActor,
  ready: ServeReady,
  runtime: RuntimeInfo,
  receiptId: string
): Promise<{ stop: ServeStopped; runtimeRemoved: true; daemonGone: true; ptyHostAfterStop: 'alive' | 'absent' }> {
  if (protectedWorldPids(context.world).has(actor.child.pid)) throw new Error('refusing to signal a world-owned serve process')
  if (!signalPid(actor.child.pid, 'SIGTERM', actor.record.serveIdentity, actor.child)) {
    throw new Error(`serve process ${actor.child.pid} identity changed before SIGTERM`)
  }
  await awaitWhileChecking(context, () => Bun.sleep(50), receiptId)
  if (actor.child.exitCode === null && !signalPid(actor.child.pid, 'SIGINT', actor.record.serveIdentity, actor.child)) {
    throw new Error(`serve process ${actor.child.pid} identity changed before SIGINT`)
  }
  await requireExit(context, actor, 0, 15_000, `serve actor ${receiptId} stop`, receiptId)
  await awaitWhileChecking(context, () => actor.stdout.done, receiptId)
  const stdout = actor.stdout.text()
  const parsed = parseServeLines(stdout)
  if (parsed.lines !== 2 || !parsed.ready || !parsed.stopped) throw new Error(`serve actor ${receiptId} did not emit exactly ready and stopped records`)
  assertOwnedReadiness(parsed.ready, {
    home: actor.record.home,
    servePid: actor.child.pid,
    runtime: { pid: runtime.pid, port: runtime.port }
  })
  assertCleanStop(parsed.stopped, { pid: ready.pid, signal: 'SIGTERM' })
  assertNoSecrets(stdout, runtime)
  if (existsSync(join(actor.record.home, 'runtime.json'))) throw new Error(`serve actor ${receiptId} left runtime.json behind`)
  if (!actor.record.daemonIdentity) throw new Error(`serve daemon ${ready.pid} identity was not recorded`)
  if (!(await waitForPidExit(ready.pid, undefined, 15_000, actor.record.daemonIdentity, context, receiptId))) {
    throw new Error(`serve daemon ${ready.pid} remained alive after a clean stop`)
  }
  const ptyHostAfterStop = typeof ready.ptyHostPid === 'number' && isPidAlive(ready.ptyHostPid) ? 'alive' : 'absent'
  const receipt = await actorReceipt(context, actor, receiptId, receiptId)
  equal(receipt.exitCode, 0, `serve actor ${receiptId} exit code`)
  context.check(receiptId)
  context.importActor([receipt])
  return { stop: parsed.stopped, runtimeRemoved: true, daemonGone: true, ptyHostAfterStop }
}

function statusPidAndHome(value: unknown, context: CliCheckContext, label: string): void {
  const status = object(value, label)
  equal(status.pid, context.world.daemonPid, `${label} PID`)
  equal(status.home, context.world.home, `${label} home`)
}

async function assertWorldUnchanged(context: CliCheckContext, id: string): Promise<void> {
  const status = await awaitWithin(context, () => context.call(id, ['status']), 15_000, `${id} status`, id)
  statusPidAndHome(status, context, `${id} status`)
  const runtime = readRuntime(context.world.home)
  if (!runtime || runtime.pid !== context.world.daemonPid ||
      !(await awaitWithin(context, () => isDaemonAlive(runtime), 1_500, `${id} health`, id))) {
    throw new Error(`${id} changed or stopped the world daemon`)
  }
}

async function checkAlreadyRunning(context: CliCheckContext): Promise<void> {
  context.check('startup-already-running')
  const runtime = readRuntime(context.world.home)
  if (!runtime) throw new Error('world daemon runtime.json is missing')
  const refusal = await context.refuse('startup-already-running-refusal', ['serve'])
  context.check('startup-already-running')
  assertServeRefusal(refusal, 'already-running', {
    pid: context.world.daemonPid,
    port: runtime.port,
    home: context.world.home
  })
  await assertWorldUnchanged(context, 'startup-already-running')
  context.check('startup-already-running')
  context.prove('startup-already-running', {
    refusal: 'already-running', namedWorldDaemon: refusal.data && object(refusal.data, 'already-running refusal data').pid === context.world.daemonPid,
    worldDaemonUnchanged: true
  })
}

async function checkPortInUse(context: CliCheckContext): Promise<void> {
  context.check('startup-port-in-use')
  const worldRuntime = readRuntime(context.world.home)
  if (!worldRuntime) throw new Error('world daemon runtime.json is missing')
  const home = join(context.world.home, 'serve-port')
  const actor = startServe(context, home, ['--port', String(worldRuntime.port)], 'startup-port-in-use')
  const response = await firstResponse(context, actor, 15_000, 'startup-port-in-use')
  if (response.kind !== 'refusal') throw new Error('serve accepted the world daemon port')
  await requireExit(context, actor, 1, 15_000, 'serve port-in-use refusal', 'startup-port-in-use')
  const receipt = await actorReceipt(context, actor, 'startup-port-in-use-refusal', 'startup-port-in-use')
  context.check('startup-port-in-use')
  const refusal = context.importActorRefusal(receipt)
  assertServeRefusal(refusal, 'port-in-use', { port: worldRuntime.port })
  if (existsSync(join(home, 'runtime.json')) || existsSync(join(home, 'logs/daemon.log'))) {
    throw new Error('serve port-in-use created a runtime file or daemon log')
  }
  await assertWorldUnchanged(context, 'startup-port-in-use')
  context.check('startup-port-in-use')
  context.prove('startup-port-in-use', { refusal: 'port-in-use', started: false, worldDaemonUnchanged: true })
}

async function checkReady(context: CliCheckContext): Promise<void> {
  context.check('startup-ready')
  const home = join(context.world.home, 'serve-ready')
  const port = await freeLoopbackPort(context, 'startup-ready')
  const actor = startServe(context, home, ['--port', String(port)], 'startup-ready')
  const response = await firstResponse(context, actor, 30_000, 'startup-ready')
  if (response.kind !== 'ready') throw new Error('serve refused its free readiness port')
  assertOwnedReadiness(response.ready, {
    home,
    servePid: actor.child.pid,
    runtime: { pid: response.runtime.pid, port: response.runtime.port },
    port
  })
  if (!(await awaitWithin(context, () => isDaemonAlive(response.runtime), 1_500, 'serve readiness health', 'startup-ready'))) {
    throw new Error(`serve daemon ${response.runtime.pid} is not healthy`)
  }
  const stopped = await stopReadyActor(context, actor, response.ready, response.runtime, 'startup-ready')
  context.check('startup-ready')
  context.prove('startup-ready', {
    owned: true,
    portHonored: true,
    identity: ['runtime', 'health', 'status'],
    secretsInOutput: false,
    stop: {
      reason: stopped.stop.reason,
      signal: stopped.stop.signal,
      records: 1,
      daemonExitCode: stopped.stop.daemonExitCode
    },
    runtimeRemoved: stopped.runtimeRemoved,
    daemonGone: stopped.daemonGone,
    ptyHostAfterStop: stopped.ptyHostAfterStop
  })
}

async function checkConcurrent(context: CliCheckContext): Promise<void> {
  context.check('startup-concurrent')
  const home = join(context.world.home, 'serve-race')
  const actors = [
    startServe(context, home, [], 'startup-concurrent'),
    startServe(context, home, [], 'startup-concurrent')
  ]
  const responses = await Promise.all(actors.map(actor => firstResponse(context, actor, 30_000, 'startup-concurrent')))
  context.check('startup-concurrent')
  const readyIndices = responses.flatMap((response, index) => response.kind === 'ready' ? [index] : [])
  const refusalIndices = responses.flatMap((response, index) => response.kind === 'refusal' ? [index] : [])
  if (readyIndices.length !== 1 || refusalIndices.length !== 1) throw new Error(`serve race returned ${readyIndices.length} ready and ${refusalIndices.length} refused processes`)
  const winnerIndex = readyIndices[0]!
  const loserIndex = refusalIndices[0]!
  const winner = actors[winnerIndex]!
  const loser = actors[loserIndex]!
  const winnerResponse = responses[winnerIndex]!
  if (winnerResponse.kind !== 'ready') throw new Error('serve race winner did not return readiness')
  await requireExit(context, loser, 1, 15_000, 'serve concurrency refusal', 'startup-concurrent')
  const refusalReceipt = await actorReceipt(context, loser, 'startup-concurrent-refusal', 'startup-concurrent')
  context.check('startup-concurrent')
  const refusal = context.importActorRefusal(refusalReceipt)
  assertServeRefusal(refusal, 'already-running', { pid: winnerResponse.ready.pid, home })
  if (!(await awaitWithin(context, () => isDaemonAlive(winnerResponse.runtime), 1_500, 'serve race health', 'startup-concurrent'))) {
    throw new Error('serve race winner is not healthy')
  }
  const stopped = await stopReadyActor(context, winner, winnerResponse.ready, winnerResponse.runtime, 'startup-concurrent')
  context.check('startup-concurrent')
  context.prove('startup-concurrent', {
    readyCount: 1,
    loserReason: 'already-running',
    loserNamedWinner: refusal.data && object(refusal.data, 'concurrent refusal data').pid === winnerResponse.ready.pid,
    winnerStoppedClean: stopped.stop.reason === 'signal' && stopped.stop.daemonExitCode === 0 && !stopped.stop.killed
  })
}

async function waitForOrphanRelease(
  context: CliCheckContext,
  home: string,
  pid: number,
  identity: unknown,
  timeoutMs: number,
  checkId: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    context.check(checkId)
    const runtime = readRuntime(home)
    if (!isOriginalPidAlive(pid, identity) && (!runtime || runtime.pid !== pid)) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`orphaned serve daemon ${pid} did not exit and release runtime.json within ${timeoutMs}ms`)
    await Bun.sleep(Math.min(100, remaining))
    context.check(checkId)
  }
}

async function checkParentLoss(context: CliCheckContext): Promise<void> {
  context.check('startup-parent-loss')
  const home = join(context.world.home, 'serve-race')
  const orphan = startServe(context, home, [], 'startup-parent-loss')
  const orphanResponse = await firstResponse(context, orphan, 30_000, 'startup-parent-loss')
  if (orphanResponse.kind !== 'ready') throw new Error('serve refused after the concurrency winner stopped')
  const orphanPid = orphanResponse.ready.pid
  const orphanStartedAt = Date.now()
  if (protectedWorldPids(context.world).has(orphan.child.pid)) throw new Error('refusing to kill a world-owned serve process')
  if (!signalPid(orphan.child.pid, 'SIGKILL', orphan.record.serveIdentity, orphan.child)) {
    throw new Error(`serve process ${orphan.child.pid} identity changed before SIGKILL`)
  }
  await awaitWithin(context, () => orphan.child.exited, 5_000, 'SIGKILLed serve process exit', 'startup-parent-loss')
  await waitForOrphanRelease(
    context, home, orphanPid, orphan.record.daemonIdentity, 15_000, 'startup-parent-loss'
  )
  const orphanExitMs = Date.now() - orphanStartedAt

  context.check('startup-parent-loss')
  const restarted = startServe(context, home, [], 'startup-parent-loss')
  const restartedResponse = await firstResponse(context, restarted, 30_000, 'startup-parent-loss')
  if (restartedResponse.kind !== 'ready') throw new Error('serve did not restart after its parent was killed')
  if (restartedResponse.ready.pid === orphanPid) throw new Error('serve restart reused the orphan daemon PID')
  const stopped = await stopReadyActor(context, restarted, restartedResponse.ready, restartedResponse.runtime, 'startup-parent-loss')
  context.check('startup-parent-loss')
  context.prove('startup-parent-loss', {
    serveKilled: 'SIGKILL',
    orphanExited: true,
    runtimeReleased: true,
    restarted: true,
    orphanExitMs,
    ptyHostAdopted: typeof orphanResponse.ready.ptyHostPid === 'number' &&
      restartedResponse.ready.ptyHostPid === orphanResponse.ready.ptyHostPid,
    stop: { reason: stopped.stop.reason, signal: stopped.stop.signal, daemonExitCode: stopped.stop.daemonExitCode }
  })
}

export async function runStartupChecks(context: CliCheckContext): Promise<void> {
  await checkAlreadyRunning(context)
  await checkPortInUse(context)
  await checkReady(context)
  await checkConcurrent(context)
  await checkParentLoss(context)
}

function processErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function attemptCleanup(errors: string[], label: string, operation: () => Promise<void> | void): Promise<void> {
  try {
    await operation()
  } catch (error) {
    errors.push(`${label}: ${processErrorText(error)}`)
  }
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function startupProcessSnapshot(): Map<number, StartupProcessIdentity> {
  try {
    const result = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const processes = new Map<number, StartupProcessIdentity>()
    for (const line of result.split('\n')) {
      const columns = line.trim().split(/\s+/)
      const [pid, ppid, pgid] = columns.slice(0, 3).map(Number)
      if (!validPid(pid) || !Number.isInteger(ppid) || ppid < 0 || !Number.isInteger(pgid) || pgid < 0 || columns.length < 9) continue
      processes.set(pid, {
        pid, ppid, pgid,
        started: columns.slice(3, 8).join(' '),
        command: columns.slice(8).join(' ')
      })
    }
    return processes
  } catch {
    return new Map()
  }
}

export function captureStartupProcessIdentity(pid: number): StartupProcessIdentity | undefined {
  return validPid(pid) ? startupProcessSnapshot().get(pid) : undefined
}

function validStartupProcessIdentity(value: unknown): value is StartupProcessIdentity {
  return isObject(value) && validPid(value.pid) &&
    Number.isInteger(value.ppid) && (value.ppid as number) >= 0 &&
    Number.isInteger(value.pgid) && (value.pgid as number) >= 0 &&
    typeof value.started === 'string' && value.started.length > 0 &&
    typeof value.command === 'string' && value.command.length > 0
}

function sameStartupProcess(left: unknown, right: StartupProcessIdentity | undefined): boolean {
  if (!validStartupProcessIdentity(left) || !right) return false
  return left.pid === right.pid && left.started === right.started &&
    (left.command === right.command || (left.ppid === right.ppid && left.pgid === right.pgid))
}

function startupIdentityMatches(pid: number, identity: unknown): identity is StartupProcessIdentity {
  return validStartupProcessIdentity(identity) && identity.pid === pid &&
    sameStartupProcess(identity, startupProcessSnapshot().get(pid))
}

function recordsForCleanup(context: Pick<CliCheckContext, 'state' | 'world'>, errors: string[]): StartupProcess[] {
  const value = context.state.startupProcesses
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push('startup cleanup state is malformed')
    return []
  }
  return value.flatMap((entry, index) => {
    if (!isObject(entry) || !validPid(entry.servePid) || typeof entry.home !== 'string') {
      errors.push(`startup cleanup record ${index} is malformed`)
      return []
    }
    try {
      context.world.serveEnvironment(entry.home)
    } catch (error) {
      errors.push(`startup cleanup record ${index} has an unowned home: ${processErrorText(error)}`)
      return []
    }
    return [entry as StartupProcess]
  })
}

function readPtyPid(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, 'pty.pid'), 'utf8').trim())
    return validPid(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function ptyHostCommand(home: string, pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
      cwd: home,
      env: { HOME: home, QUIRKY_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: join(home, 'tmp'), LANG: 'C', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function ptyHostHasHomeAssociation(home: string, pid: number, command: string): boolean {
  if (command.includes(home)) return true
  try {
    const processInfo = execFileSync('/bin/ps', ['eww', '-p', String(pid)], {
      cwd: home,
      env: { HOME: home, QUIRKY_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: join(home, 'tmp'), LANG: 'C', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return processInfo.includes(`QUIRKY_HOME=${home}`) || processInfo.includes(`HOME=${home}`)
  } catch {
    return false
  }
}

function ptyPidForCleanup(
  record: StartupProcess,
  protectedPids: ReadonlySet<number>
): { pid: number; identity: StartupProcessIdentity } | undefined {
  if (typeof record.ptyHostPid === 'number') {
    const identity = record.ptyHostIdentity
    return protectedPids.has(record.ptyHostPid) ||
      !validStartupProcessIdentity(identity) ||
      identity.pid !== record.ptyHostPid
      ? undefined
      : { pid: record.ptyHostPid, identity }
  }
  const pid = readPtyPid(record.home)
  if (!pid || protectedPids.has(pid)) return undefined
  const identity = captureStartupProcessIdentity(pid)
  if (!identity) return undefined
  const command = ptyHostCommand(record.home, pid)
  if (!command.includes('pty-host') || !ptyHostHasHomeAssociation(record.home, pid, command) ||
      !startupIdentityMatches(pid, identity)) return undefined
  record.ptyHostPid = pid
  record.ptyHostIdentity = identity
  return { pid, identity }
}

export async function cleanupStartupChecks(
  context: Pick<CliCheckContext, 'state' | 'world'>,
  errors: string[]
): Promise<void> {
  const records = recordsForCleanup(context, errors)
  const protectedPids = protectedWorldPids(context.world)
  const serves = new Map<number, StartupProcess[]>()
  for (const record of records) {
    if (protectedPids.has(record.servePid)) {
      errors.push(`startup cleanup refused to signal protected world PID ${record.servePid}`)
      continue
    }
    const candidates = serves.get(record.servePid)
    if (candidates) candidates.push(record)
    else serves.set(record.servePid, [record])
  }

  for (const [pid, candidates] of serves) {
    await attemptCleanup(errors, `serve ${pid} SIGTERM`, () => {
      const record = candidates.find(candidate => startupIdentityMatches(pid, candidate.serveIdentity))
      if (record) signalPid(pid, 'SIGTERM', record.serveIdentity, record.child)
    })
  }
  for (const [pid, candidates] of serves) {
    await attemptCleanup(errors, `serve ${pid} graceful wait`, async () => {
      const record = candidates.find(candidate => startupIdentityMatches(pid, candidate.serveIdentity))
      if (!record || await waitForPidExit(pid, record.child, 12_000, record.serveIdentity)) return
      if (!signalPid(pid, 'SIGKILL', record.serveIdentity, record.child)) return
      if (!(await waitForPidExit(pid, record.child, 2_000, record.serveIdentity))) {
        throw new Error('process remained alive after SIGKILL')
      }
    })
  }

  const daemons = new Map<number, StartupProcess[]>()
  for (const record of records) {
    if (!validPid(record.daemonPid) || protectedPids.has(record.daemonPid)) continue
    const candidates = daemons.get(record.daemonPid)
    if (candidates) candidates.push(record)
    else daemons.set(record.daemonPid, [record])
  }
  for (const [pid, candidates] of daemons) {
    await attemptCleanup(errors, `serve-home daemon ${pid} wait`, async () => {
      const record = candidates.find(candidate => startupIdentityMatches(pid, candidate.daemonIdentity))
      if (!record || await waitForPidExit(pid, undefined, 10_000, record.daemonIdentity)) return
      if (!signalPid(pid, 'SIGKILL', record.daemonIdentity)) return
      if (!(await waitForPidExit(pid, undefined, 2_000, record.daemonIdentity))) {
        throw new Error('daemon remained alive after SIGKILL')
      }
      throw new Error('daemon survived cleanup and was sent SIGKILL')
    })
  }

  type PtyCleanupTarget = { home: string; identity: StartupProcessIdentity }
  const ptyHosts = new Map<number, PtyCleanupTarget[]>()
  for (const record of records) {
    const target = ptyPidForCleanup(record, protectedPids)
    if (!target) continue
    const candidates = ptyHosts.get(target.pid)
    if (candidates) candidates.push({ home: record.home, identity: target.identity })
    else ptyHosts.set(target.pid, [{ home: record.home, identity: target.identity }])
  }
  for (const [pid, candidates] of ptyHosts) {
    await attemptCleanup(errors, `serve-home PTY host ${pid} SIGTERM`, () => {
      const target = candidates.find(candidate => startupIdentityMatches(pid, candidate.identity))
      if (target) signalPid(pid, 'SIGTERM', target.identity)
    })
  }
  for (const [pid, candidates] of ptyHosts) {
    await attemptCleanup(errors, `serve-home PTY host ${pid} graceful wait`, async () => {
      const target = candidates.find(candidate => startupIdentityMatches(pid, candidate.identity))
      if (!target || await waitForPidExit(pid, undefined, 5_000, target.identity)) return
      if (!signalPid(pid, 'SIGKILL', target.identity)) return
      if (!(await waitForPidExit(pid, undefined, 2_000, target.identity))) {
        throw new Error('PTY host remained alive after SIGKILL')
      }
    })
  }
}
