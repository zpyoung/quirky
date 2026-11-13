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
type StartupProcess = {
  home: string
  servePid: number
  daemonPid?: number
  ptyHostPid?: number | null
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
    trackOwnedPid(context, value.pid)
  }
  if (typeof value.ptyHostPid === 'number' && Number.isInteger(value.ptyHostPid) && value.ptyHostPid > 0) {
    actor.record.ptyHostPid = value.ptyHostPid
    trackOwnedPid(context, value.ptyHostPid)
  } else if (value.ptyHostPid === null) {
    actor.record.ptyHostPid = null
  }
}

function startServe(context: CliCheckContext, home: string, flags: string[]): StartupActor {
  const argv = [process.execPath, context.world.paths.cliEntry, 'serve', ...flags, '--runtime', 'local', '--json']
  const child = Bun.spawn(argv, {
    cwd: context.world.paths.repoRoot,
    env: context.world.serveEnvironment(home),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  }) as ServeSubprocess
  const record: StartupProcess = { home, servePid: child.pid, child }
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

async function verifyStatusReadiness(home: string, runtime: RuntimeInfo, deadline: number): Promise<ObjectValue> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('serve readiness deadline expired before status.get')
  const socket = runtime.socket ?? socketPath(home, 'quirkyd.sock')
  const connecting = QuirkyClient.connectSocket(socket, {
    role: 'cli', name: 'quirky CLI parity startup', token: runtime.token
  })
  let client: QuirkyClient
  try {
    client = await awaitWithin(connecting, remaining, 'serve status socket connection')
  } catch (error) {
    void connecting.then(lateClient => lateClient.close(), () => {})
    throw error
  }
  try {
    const callRemaining = deadline - Date.now()
    if (callRemaining <= 0) throw new Error('serve readiness deadline expired before status.get')
    const status = object(await awaitWithin(
      client.call('status.get', {}, { timeoutMs: callRemaining }),
      callRemaining,
      'serve status.get readiness probe'
    ), 'serve status.get result')
    equal(status.pid, runtime.pid, 'serve status.get PID and runtime.json PID')
    equal(status.home, home, 'serve status.get home')
    const ptyHost = object(status.ptyHost, 'serve status.get PTY host')
    ensure(ptyHost.pid === null || validPid(ptyHost.pid), 'serve status.get PTY host PID must be a positive integer or null')
    ensure(typeof status.safeMode === 'boolean', 'serve status.get safe-mode value must be a boolean')
    return status
  } finally {
    client.close()
  }
}

async function firstResponse(context: CliCheckContext, actor: StartupActor, timeoutMs: number): Promise<StartupResponse> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`serve process ${actor.child.pid} did not respond within ${timeoutMs}ms`)
    const line = await actor.stdout.nextLine(remaining)
    if (line === undefined) throw new Error(`serve process ${actor.child.pid} did not respond within ${timeoutMs}ms`)
    if (line.length === 0) continue
    const value = object(parseJson(line, `serve process ${actor.child.pid} output`), 'serve response')
    if (value.event === 'ready') {
      recordReadinessPids(context, actor, value)
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
        isDaemonAlive(runtime, Math.min(1_500, healthRemaining)),
        healthRemaining,
        'serve /health readiness probe'
      ))) throw new Error(`serve daemon ${runtime.pid} did not answer /health`)
      const status = await verifyStatusReadiness(actor.record.home, runtime, deadline)
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

async function awaitWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

async function actorReceipt(actor: StartupActor, id: string, timeoutMs = 15_000): Promise<CliActorReceipt> {
  const [exitCode, stderr] = await Promise.all([
    awaitWithin(actor.child.exited, timeoutMs, `serve actor ${id} exit`),
    actor.stderr
  ])
  await actor.stdout.done
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

async function requireExit(actor: StartupActor, expected: number, timeoutMs: number, label: string): Promise<number> {
  const exitCode = await awaitWithin(actor.child.exited, timeoutMs, label)
  equal(exitCode, expected, `${label} exit code`)
  return exitCode
}


async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  const listening = Promise.withResolvers<void>()
  const onError = (error: Error) => listening.reject(error)
  server.once('error', onError)
  server.once('listening', () => listening.resolve())
  try {
    server.listen(0, '127.0.0.1')
    await listening.promise
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

function signalPid(pid: number, signal: NodeJS.Signals, child?: ServeSubprocess): void {
  if (child) child.kill(signal)
  else process.kill(pid, signal)
}

async function waitForPidExit(pid: number, child: ServeSubprocess | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isPidAlive(pid, child)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await Bun.sleep(Math.min(100, remaining))
  }
  return true
}

async function stopReadyActor(
  context: CliCheckContext,
  actor: StartupActor,
  ready: ServeReady,
  runtime: RuntimeInfo,
  receiptId: string
): Promise<{ stop: ServeStopped; runtimeRemoved: true; daemonGone: true; ptyHostAfterStop: 'alive' | 'absent' }> {
  if (protectedWorldPids(context.world).has(actor.child.pid)) throw new Error('refusing to signal a world-owned serve process')
  actor.child.kill('SIGTERM')
  await Bun.sleep(50)
  if (actor.child.exitCode === null) actor.child.kill('SIGINT')
  await requireExit(actor, 0, 15_000, `serve actor ${receiptId} stop`)
  await actor.stdout.done
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
  if (!(await waitForPidExit(ready.pid, undefined, 15_000))) throw new Error(`serve daemon ${ready.pid} remained alive after a clean stop`)
  const ptyHostAfterStop = typeof ready.ptyHostPid === 'number' && isPidAlive(ready.ptyHostPid) ? 'alive' : 'absent'
  const receipt = await actorReceipt(actor, receiptId)
  equal(receipt.exitCode, 0, `serve actor ${receiptId} exit code`)
  context.importActor([receipt])
  return { stop: parsed.stopped, runtimeRemoved: true, daemonGone: true, ptyHostAfterStop }
}

function statusPidAndHome(value: unknown, context: CliCheckContext, label: string): void {
  const status = object(value, label)
  equal(status.pid, context.world.daemonPid, `${label} PID`)
  equal(status.home, context.world.home, `${label} home`)
}

async function assertWorldUnchanged(context: CliCheckContext, id: string): Promise<void> {
  const status = await context.call(id, ['status'])
  statusPidAndHome(status, context, `${id} status`)
  const runtime = readRuntime(context.world.home)
  if (!runtime || runtime.pid !== context.world.daemonPid || !(await isDaemonAlive(runtime))) {
    throw new Error(`${id} changed or stopped the world daemon`)
  }
}

async function checkAlreadyRunning(context: CliCheckContext): Promise<void> {
  context.check('startup-already-running')
  const runtime = readRuntime(context.world.home)
  if (!runtime) throw new Error('world daemon runtime.json is missing')
  const refusal = await context.refuse('startup-already-running-refusal', ['serve'])
  assertServeRefusal(refusal, 'already-running', {
    pid: context.world.daemonPid,
    port: runtime.port,
    home: context.world.home
  })
  await assertWorldUnchanged(context, 'startup-already-running')
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
  const actor = startServe(context, home, ['--port', String(worldRuntime.port)])
  const response = await firstResponse(context, actor, 15_000)
  if (response.kind !== 'refusal') throw new Error('serve accepted the world daemon port')
  await requireExit(actor, 1, 15_000, 'serve port-in-use refusal')
  const receipt = await actorReceipt(actor, 'startup-port-in-use-refusal')
  const refusal = context.importActorRefusal(receipt)
  assertServeRefusal(refusal, 'port-in-use', { port: worldRuntime.port })
  if (existsSync(join(home, 'runtime.json')) || existsSync(join(home, 'logs/daemon.log'))) {
    throw new Error('serve port-in-use created a runtime file or daemon log')
  }
  await assertWorldUnchanged(context, 'startup-port-in-use')
  context.prove('startup-port-in-use', { refusal: 'port-in-use', started: false, worldDaemonUnchanged: true })
}

async function checkReady(context: CliCheckContext): Promise<void> {
  context.check('startup-ready')
  const home = join(context.world.home, 'serve-ready')
  const port = await freeLoopbackPort()
  const actor = startServe(context, home, ['--port', String(port)])
  const response = await firstResponse(context, actor, 30_000)
  if (response.kind !== 'ready') throw new Error('serve refused its free readiness port')
  assertOwnedReadiness(response.ready, {
    home,
    servePid: actor.child.pid,
    runtime: { pid: response.runtime.pid, port: response.runtime.port },
    port
  })
  if (!(await isDaemonAlive(response.runtime))) throw new Error(`serve daemon ${response.runtime.pid} is not healthy`)
  const stopped = await stopReadyActor(context, actor, response.ready, response.runtime, 'startup-ready')
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
  const actors = [startServe(context, home, []), startServe(context, home, [])]
  const responses = await Promise.all(actors.map(actor => firstResponse(context, actor, 30_000)))
  const readyIndices = responses.flatMap((response, index) => response.kind === 'ready' ? [index] : [])
  const refusalIndices = responses.flatMap((response, index) => response.kind === 'refusal' ? [index] : [])
  if (readyIndices.length !== 1 || refusalIndices.length !== 1) throw new Error(`serve race returned ${readyIndices.length} ready and ${refusalIndices.length} refused processes`)
  const winnerIndex = readyIndices[0]!
  const loserIndex = refusalIndices[0]!
  const winner = actors[winnerIndex]!
  const loser = actors[loserIndex]!
  const winnerResponse = responses[winnerIndex]!
  if (winnerResponse.kind !== 'ready') throw new Error('serve race winner did not return readiness')
  await requireExit(loser, 1, 15_000, 'serve concurrency refusal')
  const refusalReceipt = await actorReceipt(loser, 'startup-concurrent-refusal')
  const refusal = context.importActorRefusal(refusalReceipt)
  assertServeRefusal(refusal, 'already-running', { pid: winnerResponse.ready.pid, home })
  if (!(await isDaemonAlive(winnerResponse.runtime))) throw new Error('serve race winner is not healthy')
  const stopped = await stopReadyActor(context, winner, winnerResponse.ready, winnerResponse.runtime, 'startup-concurrent')
  context.prove('startup-concurrent', {
    readyCount: 1,
    loserReason: 'already-running',
    loserNamedWinner: refusal.data && object(refusal.data, 'concurrent refusal data').pid === winnerResponse.ready.pid,
    winnerStoppedClean: stopped.stop.reason === 'signal' && stopped.stop.daemonExitCode === 0 && !stopped.stop.killed
  })
}

async function waitForOrphanRelease(home: string, pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const runtime = readRuntime(home)
    if (!isPidAlive(pid) && (!runtime || runtime.pid !== pid)) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`orphaned serve daemon ${pid} did not exit and release runtime.json within ${timeoutMs}ms`)
    await Bun.sleep(Math.min(100, remaining))
  }
}

async function checkParentLoss(context: CliCheckContext): Promise<void> {
  context.check('startup-parent-loss')
  const home = join(context.world.home, 'serve-race')
  const orphan = startServe(context, home, [])
  const orphanResponse = await firstResponse(context, orphan, 30_000)
  if (orphanResponse.kind !== 'ready') throw new Error('serve refused after the concurrency winner stopped')
  const orphanPid = orphanResponse.ready.pid
  const orphanStartedAt = Date.now()
  if (protectedWorldPids(context.world).has(orphan.child.pid)) throw new Error('refusing to kill a world-owned serve process')
  orphan.child.kill('SIGKILL')
  await awaitWithin(orphan.child.exited, 5_000, 'SIGKILLed serve process exit')
  await waitForOrphanRelease(home, orphanPid, 15_000)
  const orphanExitMs = Date.now() - orphanStartedAt

  const restarted = startServe(context, home, [])
  const restartedResponse = await firstResponse(context, restarted, 30_000)
  if (restartedResponse.kind !== 'ready') throw new Error('serve did not restart after its parent was killed')
  if (restartedResponse.ready.pid === orphanPid) throw new Error('serve restart reused the orphan daemon PID')
  const stopped = await stopReadyActor(context, restarted, restartedResponse.ready, restartedResponse.runtime, 'startup-parent-loss')
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

function ptyPidForCleanup(record: StartupProcess, protectedPids: ReadonlySet<number>): number | undefined {
  if (typeof record.ptyHostPid === 'number') return protectedPids.has(record.ptyHostPid) ? undefined : record.ptyHostPid
  const pid = readPtyPid(record.home)
  if (!pid || protectedPids.has(pid)) return undefined
  return ptyHostCommand(record.home, pid).includes('pty-host') ? pid : undefined
}

export async function cleanupStartupChecks(
  context: Pick<CliCheckContext, 'state' | 'world'>,
  errors: string[]
): Promise<void> {
  const records = recordsForCleanup(context, errors)
  const protectedPids = protectedWorldPids(context.world)
  const serves = new Map<number, StartupProcess>()
  for (const record of records) {
    if (protectedPids.has(record.servePid)) {
      errors.push(`startup cleanup refused to signal protected world PID ${record.servePid}`)
      continue
    }
    serves.set(record.servePid, record)
  }

  for (const [pid, record] of serves) {
    await attemptCleanup(errors, `serve ${pid} SIGTERM`, () => {
      if (isPidAlive(pid, record.child)) signalPid(pid, 'SIGTERM', record.child)
    })
  }
  for (const [pid, record] of serves) {
    await attemptCleanup(errors, `serve ${pid} graceful wait`, async () => {
      if (await waitForPidExit(pid, record.child, 12_000)) return
      signalPid(pid, 'SIGKILL', record.child)
      if (!(await waitForPidExit(pid, record.child, 2_000))) throw new Error('process remained alive after SIGKILL')
    })
  }

  const daemons = new Map<number, StartupProcess>()
  for (const record of records) {
    if (!validPid(record.daemonPid) || protectedPids.has(record.daemonPid)) continue
    daemons.set(record.daemonPid, record)
  }
  for (const [pid, record] of daemons) {
    await attemptCleanup(errors, `serve-home daemon ${pid} wait`, async () => {
      if (await waitForPidExit(pid, undefined, 10_000)) return
      signalPid(pid, 'SIGKILL')
      if (!(await waitForPidExit(pid, undefined, 2_000))) throw new Error('daemon remained alive after SIGKILL')
      throw new Error('daemon survived cleanup and was sent SIGKILL')
    })
  }

  const ptyHosts = new Map<number, string>()
  for (const record of records) {
    const pid = ptyPidForCleanup(record, protectedPids)
    if (pid) ptyHosts.set(pid, record.home)
  }
  for (const [pid, home] of ptyHosts) {
    await attemptCleanup(errors, `serve-home PTY host ${pid} SIGTERM`, () => {
      if (isPidAlive(pid)) signalPid(pid, 'SIGTERM')
    })
  }
  for (const [pid] of ptyHosts) {
    await attemptCleanup(errors, `serve-home PTY host ${pid} graceful wait`, async () => {
      if (await waitForPidExit(pid, undefined, 5_000)) return
      signalPid(pid, 'SIGKILL')
      if (!(await waitForPidExit(pid, undefined, 2_000))) throw new Error('PTY host remained alive after SIGKILL')
    })
  }
}
