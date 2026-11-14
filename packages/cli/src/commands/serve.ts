import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, RpcError, RpcErrorCode } from '@quirky/protocol'
import {
  defaultDaemonEntry,
  ensureHome,
  openPrivateLog,
  quirkyHome,
  readRuntime,
  watchParent,
  withoutAgentSessionMarkers,
  type RuntimeInfo
} from '@quirky/protocol/node'
import { CommandFailed, UsageError, flagBoolean, flagInt, takePositionals } from '../args'
import type { Command, Context } from './types'

const DEFAULT_READY_MS = 30_000
const DEFAULT_POLL_MS = 100
const DEFAULT_STOP_MS = 10_000
const DEFAULT_KILL_MS = 2_000
const DEFAULT_PARENT_POLL_MS = 250
const PROBE_MAX_MS = 500
const LOG_TAIL_BYTES = 8 * 1024

type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'
type StopTrigger = { reason: 'signal'; signal: Signal } | { reason: 'parent-exited'; signal: null }
type ChildEvent = { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'error'; error: Error }
type ProbeResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'stop'; trigger: StopTrigger }
  | { kind: 'exit'; event: ChildEvent }
type HealthResult = { answered: false } | { answered: true; pid: unknown }

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
  signal: Signal | null
  pid: number
  daemonExitCode: number | null
  daemonSignal: string | null
  killed: boolean
}

export type ServeSignals = {
  on(signal: Signal, handler: () => void): void
  off(signal: Signal, handler: () => void): void
}

export type ServeOptions = {
  timings?: {
    readyMs?: number
    pollMs?: number
    stopMs?: number
    killMs?: number
    parentPollMs?: number
  }
  signals?: ServeSignals
  readPpid?: () => number
}

export const SERVE_PORT_DESCRIPTION = 'listen on this loopback port; refuse to start when it is in use'

function rpcRefusal(code: number, reason: string, message: string, data: Record<string, unknown> = {}): RpcError {
  return new RpcError(code, message, { reason, ...data })
}

function seconds(milliseconds: number): string {
  return `${milliseconds / 1000}s`
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function assertPortAvailable(port: number): void {
  let probe: ReturnType<typeof Bun.serve> | undefined
  try {
    probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('probe') })
  } catch (error) {
    if (hasCode(error, 'EADDRINUSE')) {
      throw rpcRefusal(
        RpcErrorCode.Conflict,
        'port-in-use',
        `port ${port} is already in use; nothing was started`,
        { port }
      )
    }
    throw error
  } finally {
    probe?.stop(true)
  }
}

async function readHealth(port: number, timeoutMs: number): Promise<HealthResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(Math.max(1, timeoutMs))
    })
    if (!response.ok) return { answered: false }
    const body: unknown = await response.json()
    return {
      answered: true,
      pid: typeof body === 'object' && body !== null && 'pid' in body ? body.pid : undefined
    }
  } catch {
    return { answered: false }
  }
}

async function isHealthyRuntime(info: RuntimeInfo, timeoutMs = PROBE_MAX_MS): Promise<boolean> {
  if (!Number.isSafeInteger(info.pid) || info.pid <= 0 || !Number.isSafeInteger(info.port) || info.port < 1 || info.port > 65535) {
    return false
  }
  const health = await readHealth(info.port, timeoutMs)
  return health.answered && health.pid === info.pid
}

function validateRuntime(info: RuntimeInfo): string | undefined {
  const value = info as unknown as Record<string, unknown>
  if (!Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) {
    return `runtime port ${String(value.port)} is invalid`
  }
  if (typeof value.token !== 'string' || value.token.length === 0) return 'runtime token is invalid'
  if (typeof value.socket !== 'string' || value.socket.length === 0) return 'runtime socket is invalid'
  if (typeof value.daemonVersion !== 'string') return 'runtime daemonVersion is invalid'
  if (!Number.isSafeInteger(value.protocolVersion)) return 'runtime protocolVersion is invalid'
  if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return 'runtime startedAt is invalid'
  return undefined
}

function readinessError(home: string, detail: string): RpcError {
  return rpcRefusal(RpcErrorCode.Internal, 'readiness-invalid', `quirkyd readiness in ${home} was invalid: ${detail}`, { detail })
}

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  const timeout = Promise.withResolvers<{ timedOut: true }>()
  const timer = setTimeout(() => timeout.resolve({ timedOut: true }), Math.max(0, timeoutMs))
  try {
    const result = await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout.promise
    ])
    return result
  } finally {
    clearTimeout(timer)
  }
}

function raceProbe<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stop: Promise<StopTrigger>,
  childDone: Promise<ChildEvent>
): Promise<ProbeResult<T>> {
  const timeout = Promise.withResolvers<ProbeResult<T>>()
  const timer = setTimeout(() => timeout.resolve({ kind: 'timeout' }), Math.max(0, timeoutMs))
  const operation = promise.then<ProbeResult<T>, ProbeResult<T>>(
    (value) => ({ kind: 'value', value }),
    (error: unknown) => ({ kind: 'error', error })
  )
  const stopping = stop.then<ProbeResult<T>>((trigger) => ({ kind: 'stop', trigger }))
  const exiting = childDone.then<ProbeResult<T>>((event) => ({ kind: 'exit', event }))
  return Promise.race([operation, stopping, exiting, timeout.promise]).finally(() => {
    clearTimeout(timer)
  })
}

function logTail(path: string, offset: number): string {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(offset, size - LOG_TAIL_BYTES)
    const length = size - start
    if (length <= 0) return ''
    const contents = Buffer.alloc(length)
    const bytesRead = readSync(fd, contents, 0, length, start)
    return contents.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function daemonExitFields(event: ChildEvent): { daemonExitCode: number | null; daemonSignal: string | null } {
  if (event.kind === 'error') return { daemonExitCode: null, daemonSignal: null }
  return { daemonExitCode: event.code, daemonSignal: event.signal }
}

function safeStopResult(event: ChildEvent, pid: number, killed: boolean): Pick<ServeStopped, 'daemonExitCode' | 'daemonSignal' | 'killed'> & { pid: number } {
  return { ...daemonExitFields(event), pid, killed }
}

function getChildEvent(child: ChildProcess): Promise<ChildEvent> {
  const { promise, resolve } = Promise.withResolvers<ChildEvent>()
  child.once('error', (error) => resolve({ kind: 'error', error }))
  child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }))
  return promise
}

export function createServe(options: ServeOptions = {}): Command {
  const readyMs = options.timings?.readyMs ?? DEFAULT_READY_MS
  const pollMs = options.timings?.pollMs ?? DEFAULT_POLL_MS
  const stopMs = options.timings?.stopMs ?? DEFAULT_STOP_MS
  const killMs = options.timings?.killMs ?? DEFAULT_KILL_MS
  const parentPollMs = options.timings?.parentPollMs ?? DEFAULT_PARENT_POLL_MS
  const signals = options.signals ?? (process as unknown as ServeSignals)
  const readPpid = options.readPpid ?? (() => process.ppid)

  return {
    name: 'serve',
    summary: 'start and supervise an owned foreground quirkyd daemon',
    positionals: [],
    flags: {
      port: { type: 'integer', description: SERVE_PORT_DESCRIPTION },
      'disable-plugins': {
        type: 'boolean',
        description: 'safe mode: installed plugins, stored disables and the distro layer are off for this run'
      }
    },
    methods: ['status.get'],
    plugin: null,
    async run(args, ctx) {
      takePositionals(args, [])
      const parentPid = readPpid()
      const requestedPort = flagInt(args, 'port')
      if (requestedPort !== undefined && (requestedPort < 1 || requestedPort > 65535)) {
        throw new UsageError('--port must be between 1 and 65535')
      }
      const safeMode = flagBoolean(args, 'disable-plugins')
      const home = ensureHome(ctx.env.QUIRKY_HOME ?? quirkyHome())
      const running = readRuntime(home)
      if (running && await isHealthyRuntime(running)) {
        throw rpcRefusal(
          RpcErrorCode.Conflict,
          'already-running',
          `a daemon already owns ${home} (pid ${running.pid}); nothing was started`,
          { pid: running.pid, port: running.port, home }
        )
      }
      if (requestedPort !== undefined) assertPortAvailable(requestedPort)

      const entry = ctx.env.QUIRKY_DAEMON_ENTRY ?? defaultDaemonEntry()
      if (!existsSync(entry)) {
        throw rpcRefusal(RpcErrorCode.Internal, 'entry-missing', `quirkyd entry not found: ${entry}`)
      }

      const log = join(home, 'logs', 'daemon.log')
      let logOffset = 0
      try {
        logOffset = statSync(log).size
      } catch {}

      const daemonEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(withoutAgentSessionMarkers(ctx.env))) {
        if (value !== undefined) daemonEnv[key] = value
      }
      daemonEnv.QUIRKY_HOME = home
      if (requestedPort !== undefined) daemonEnv.QUIRKY_PORT = String(requestedPort)
      const daemonArgs = [`--exit-with-parent=${process.pid}`, ...(safeMode ? ['--disable-plugins'] : [])]
      const logFd = openPrivateLog(log)
      let child: ChildProcess
      try {
        child = spawn(process.execPath, [entry, ...daemonArgs], {
          cwd: home,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: daemonEnv
        })
      } catch (error) {
        closeSync(logFd)
        throw error
      }
      closeSync(logFd)
      const childDone = getChildEvent(child)
      const pid = child.pid
      if (pid === undefined) {
        const event = await childDone
        if (event.kind === 'error') throw event.error
        throw new Error('could not start quirkyd')
      }
      let childEvent: ChildEvent | undefined
      void childDone.then((event) => { childEvent = event })

      const stopRequested = Promise.withResolvers<StopTrigger>()
      let stopTrigger: StopTrigger | undefined
      const requestStop = (trigger: StopTrigger) => {
        if (stopTrigger !== undefined) return
        stopTrigger = trigger
        stopRequested.resolve(trigger)
      }
      const handlers: [Signal, () => void][] = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal): [Signal, () => void] => [
        signal,
        () => requestStop({ reason: 'signal', signal })
      ])
      for (const [signal, handler] of handlers) signals.on(signal, handler)
      const stopWatchingParent = watchParent({
        parentPid,
        intervalMs: parentPollMs,
        readPpid,
        onLost: () => requestStop({ reason: 'parent-exited', signal: null })
      })
      let watchersClosed = false
      const cleanupWatchers = () => {
        if (watchersClosed) return
        watchersClosed = true
        stopWatchingParent()
        for (const [signal, handler] of handlers) signals.off(signal, handler)
      }

      let terminationPromise: Promise<{ event: ChildEvent; killed: boolean }> | undefined
      const terminateChild = (): Promise<{ event: ChildEvent; killed: boolean }> => {
        if (terminationPromise) return terminationPromise
        terminationPromise = (async () => {
          let event = childEvent
          if (event !== undefined) return { event, killed: false }
          child.kill('SIGTERM')
          const graceful = await waitWithin(childDone, stopMs)
          if (!graceful.timedOut) return { event: graceful.value, killed: false }
          child.kill('SIGKILL')
          const forced = await waitWithin(childDone, killMs)
          if (forced.timedOut) throw new CommandFailed(`quirkyd (pid ${pid}) did not stop after SIGKILL`)
          event = forced.value
          return { event, killed: true }
        })()
        return terminationPromise
      }

      const alreadyRunning = async (info: RuntimeInfo): Promise<never> => {
        throw rpcRefusal(
          RpcErrorCode.Conflict,
          'already-running',
          `a daemon already owns ${home} (pid ${info.pid}); nothing was started`,
          { pid: info.pid, port: info.port, home }
        )
      }

      const handleStopBeforeReady = async (trigger: StopTrigger): Promise<never> => {
        await terminateChild()
        throw rpcRefusal(
          RpcErrorCode.Internal,
          'interrupted',
          'serve was interrupted before quirkyd became ready',
          { signal: trigger.signal, pid }
        )
      }

      const handleEarlyExit = async (event: ChildEvent): Promise<never> => {
        const candidate = readRuntime(home)
        if (candidate && candidate.pid !== pid && await isHealthyRuntime(candidate)) return alreadyRunning(candidate)
        const fields = daemonExitFields(event)
        throw rpcRefusal(
          RpcErrorCode.Internal,
          'daemon-exited-early',
          `quirkyd exited before becoming ready; see ${log}`,
          { ...fields, log, logTail: logTail(log, logOffset) }
        )
      }

      const stopForReadinessFailure = async (): Promise<void> => {
        await terminateChild()
      }

      const readinessDeadline = Date.now() + readyMs
      let ready: ServeReady | undefined
      try {
        while (Date.now() < readinessDeadline) {
          if (stopTrigger) await handleStopBeforeReady(stopTrigger)
          if (childEvent) await handleEarlyExit(childEvent)

          const info = readRuntime(home)
          if (info && info.pid === pid) {
            const invalid = validateRuntime(info)
            if (invalid) {
              await stopForReadinessFailure()
              throw readinessError(home, invalid)
            }
            if (requestedPort !== undefined && info.port !== requestedPort) {
              const detail = `runtime port ${info.port} does not match requested port ${requestedPort}`
              await stopForReadinessFailure()
              throw readinessError(home, detail)
            }

            const remaining = readinessDeadline - Date.now()
            const healthResult = await raceProbe(
              readHealth(info.port, Math.min(PROBE_MAX_MS, remaining)),
              Math.min(PROBE_MAX_MS, remaining),
              stopRequested.promise,
              childDone
            )
            if (healthResult.kind === 'stop') await handleStopBeforeReady(healthResult.trigger)
            if (healthResult.kind === 'exit') await handleEarlyExit(healthResult.event)
            if (Date.now() >= readinessDeadline) continue
            if (healthResult.kind === 'value' && healthResult.value.answered) {
              if (healthResult.value.pid !== pid) {
                const detail = `health pid ${String(healthResult.value.pid)} does not match ${pid}`
                await stopForReadinessFailure()
                throw readinessError(home, detail)
              }

              const statusPromise = (async () => {
                const connectionAbort = new AbortController()
                const connecting = QuirkyClient.connectSocket(info.socket as string, {
                  role: 'cli', name: 'quirky serve', token: info.token
                }, { signal: connectionAbort.signal })
                const connectResult = await raceProbe(
                  connecting,
                  Math.min(PROBE_MAX_MS, Math.max(1, readinessDeadline - Date.now())),
                  stopRequested.promise,
                  childDone
                )
                if (connectResult.kind !== 'value') {
                  connectionAbort.abort()
                  return connectResult
                }
                const client = connectResult.value
                try {
                  const call = client.call('status.get', {}, {
                    timeoutMs: Math.max(1, Math.min(PROBE_MAX_MS, readinessDeadline - Date.now()))
                  })
                  return await raceProbe(
                    call,
                    Math.min(PROBE_MAX_MS, Math.max(1, readinessDeadline - Date.now())),
                    stopRequested.promise,
                    childDone
                  )
                } finally {
                  client.close()
                }
              })()
              const statusResult = await statusPromise
              if (statusResult.kind === 'stop') await handleStopBeforeReady(statusResult.trigger)
              if (statusResult.kind === 'exit') await handleEarlyExit(statusResult.event)
              if (Date.now() >= readinessDeadline) continue
              if (statusResult.kind === 'value') {
                const status: unknown = statusResult.value
                if (typeof status === 'object' && status !== null) {
                  const value = status as Record<string, unknown>
                  if (value.pid !== pid) {
                    const detail = `status pid ${String(value.pid)} does not match ${pid}`
                    await stopForReadinessFailure()
                    throw readinessError(home, detail)
                  }
                  if (value.home !== home) {
                    const detail = `status home ${String(value.home)} does not match ${home}`
                    await stopForReadinessFailure()
                    throw readinessError(home, detail)
                  }
                  if (typeof value.safeMode !== 'boolean') {
                    await stopForReadinessFailure()
                    throw readinessError(home, 'status safeMode is invalid')
                  }
                  const host = value.ptyHost
                  const hostPid = typeof host === 'object' && host !== null && 'pid' in host && typeof host.pid === 'number'
                    ? host.pid
                    : null
                  ready = {
                    event: 'ready', owned: true, pid, servePid: process.pid,
                    port: info.port, url: `http://127.0.0.1:${info.port}`, socket: info.socket as string, home,
                    daemonVersion: info.daemonVersion, protocolVersion: info.protocolVersion, startedAt: info.startedAt,
                    safeMode: value.safeMode, ptyHostPid: hostPid, log
                  }
                  break
                }
              }
            }
          } else if (info && Number.isSafeInteger(info.pid) && info.pid > 0 && info.pid !== pid) {
            const foreignHealth = await raceProbe(
              readHealth(info.port, Math.min(PROBE_MAX_MS, Math.max(1, readinessDeadline - Date.now()))),
              Math.min(PROBE_MAX_MS, Math.max(1, readinessDeadline - Date.now())),
              stopRequested.promise,
              childDone
            )
            if (foreignHealth.kind === 'stop') await handleStopBeforeReady(foreignHealth.trigger)
            if (foreignHealth.kind === 'exit') await handleEarlyExit(foreignHealth.event)
            if (foreignHealth.kind === 'value' && foreignHealth.value.answered && foreignHealth.value.pid === info.pid) {
              await terminateChild()
              return alreadyRunning(info)
            }
          }

          const waitMs = Math.min(pollMs, readinessDeadline - Date.now())
          const wait = await raceProbe(Bun.sleep(Math.max(0, waitMs)), waitMs, stopRequested.promise, childDone)
          if (wait.kind === 'stop') await handleStopBeforeReady(wait.trigger)
          if (wait.kind === 'exit') await handleEarlyExit(wait.event)
        }

        if (ready === undefined) {
          await stopForReadinessFailure()
          throw rpcRefusal(
            RpcErrorCode.Timeout,
            'readiness-timeout',
            `quirkyd was not ready within ${seconds(readyMs)}; it was stopped; see ${log}`,
            { log }
          )
        }
      } catch (error) {
        if (ready === undefined && stopTrigger !== undefined && !(error instanceof RpcError && (error.data as { reason?: unknown } | undefined)?.reason === 'interrupted')) {
          await terminateChild()
        }
        throw error
      } finally {
        if (ready === undefined) cleanupWatchers()
      }

      try {
        if (!ready) throw new Error('quirkyd readiness completed without a record')
        ctx.out.json ? ctx.out.jsonLine(ready) : ctx.out.line(
          `quirkyd is ready on ${ready.url} (pid ${ready.pid}); logs in ${ready.log}; Ctrl-C stops it`
        )

        let ending: { trigger: StopTrigger } | { event: ChildEvent }
        if (stopTrigger) ending = { trigger: stopTrigger }
        else {
          ending = await Promise.race([
            stopRequested.promise.then((trigger) => ({ trigger })),
            childDone.then((event) => ({ event }))
          ])
        }

        let stopped: ServeStopped
        if ('trigger' in ending) {
          const result = await terminateChild()
          stopped = {
            event: 'stopped', reason: ending.trigger.reason, signal: ending.trigger.signal,
            ...safeStopResult(result.event, pid, result.killed)
          }
        } else {
          stopped = {
            event: 'stopped', reason: 'daemon-exited', signal: null,
            ...safeStopResult(ending.event, pid, false)
          }
        }
        ctx.out.json ? ctx.out.jsonLine(stopped) : ctx.out.line(`quirkyd stopped (pid ${pid})`)
        if (stopped.daemonExitCode !== 0 || stopped.killed) {
          throw new CommandFailed(`quirkyd exited ${stopped.daemonExitCode === null ? `from ${stopped.daemonSignal ?? 'a signal'}` : `with code ${stopped.daemonExitCode}`}`)
        }
      } finally {
        cleanupWatchers()
      }
    }
  }
}

export const serve: Command = createServe()
