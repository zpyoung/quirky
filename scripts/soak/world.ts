import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { connectDaemon, isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'
import { createProcessScope } from '../test-support/process-scope'
import {
  createIsolatedRuntimeEnvironment,
  prepareCaptureFixtureHome,
  registerCaptureFixtures,
  type RegisteredCaptureFixtures
} from '../ui-review/fixtures'
import type { FaultKind } from './contracts.ts'
import { FAULT_ENV, FAULT_PLUGIN_ID, SLOW_GIT_PIDS, installFaultPlugin, installSlowGit } from './faults.ts'

type Worker = { worktree: string; path: string; session: string }

type DaemonProcess = Pick<Bun.Subprocess, 'pid' | 'exited' | 'kill'>

type StartWorldOptions = {
  out: string
  repoRoot: string
  signal?: AbortSignal
  fault?: FaultKind
  windows?: number
  slowGit?: boolean
  workers?: boolean
}

export type DaemonSpawn = { spawnedAt: number; pid: number }
export type DaemonRestart = { spawnedAt: number }

export type SoakWorld = {
  home: string
  runtime: RuntimeInfo
  daemonPid: number
  ptyHostPid(): number | null
  updatePtyHostPid(pid: number | null): void
  control: QuirkyClient
  fixtures: RegisteredCaptureFixtures
  workers: Worker[]
  env: Record<string, string>
  preserveSessions(sessionIds: readonly string[]): void
  restartDaemon(signal?: AbortSignal, onSpawn?: (spawn: DaemonSpawn) => void): Promise<DaemonRestart>
  track(pid: number): void
  stop(): Promise<void>
}

export type StartWorldDependencies = {
  createScope?: typeof createProcessScope
  prepareCaptureFixtureHome?: typeof prepareCaptureFixtureHome
  registerCaptureFixtures?: typeof registerCaptureFixtures
  connectDaemon?: typeof connectDaemon
  waitForDaemon?: (home: string, process: DaemonProcess, signal?: AbortSignal) => Promise<RuntimeInfo>
  waitForShutdown?: (process: DaemonProcess, signal?: AbortSignal) => Promise<void>
}

function aborted(): Error {
  return new Error('soak setup was interrupted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted()
}

function waitWithAbort<T>(
  task: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  onLateValue?: (value: T) => void
): Promise<T> {
  const closeLateValue = (value: T) => {
    try {
      onLateValue?.(value)
    } catch {
      return
    }
  }
  if (signal?.aborted) {
    if (onLateValue) void task.then(closeLateValue, () => undefined)
    return Promise.reject(aborted())
  }
  if (!signal && timeoutMs === undefined) return task
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = () => {
    signal?.removeEventListener('abort', onAbort)
    clearTimeout(timer)
  }
  const onAbort = () => {
    if (settled) return
    settled = true
    cleanup()
    reject(aborted())
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`soak setup timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  }
  task.then(
    (value) => {
      if (settled) {
        closeLateValue(value)
        return
      }
      settled = true
      cleanup()
      resolve(value)
    },
    (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
  )
  return promise
}

function safeMessage(error: unknown, home: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(home, '<soak-home>')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function pidOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Keeps detached PTY hosts owned by the soak even before the probe connects. */
export function createPtyHostTracker(
  track: (pid: number) => void,
  initialPid?: unknown
): { current(): number | null; update(pid: unknown): void } {
  const tracked = new Set<number>()
  let currentPid: number | null = null
  const update = (pid: unknown) => {
    currentPid = pidOf(pid)
    if (currentPid === null || tracked.has(currentPid)) return
    tracked.add(currentPid)
    track(currentPid)
  }
  update(initialPid)
  return { current: () => currentPid, update }
}

async function waitForDaemon(home: string, process: Pick<Bun.Subprocess, 'pid' | 'exited'>, signal?: AbortSignal): Promise<RuntimeInfo> {
  const deadline = performance.now() + 30_000
  const exited = process.exited.then((code) => ({ kind: 'exit' as const, code }))

  while (performance.now() < deadline) {
    throwIfAborted(signal)
    const runtime = readRuntime(home)
    if (runtime && await isDaemonAlive(runtime, Math.max(1, Math.min(500, Math.ceil(deadline - performance.now()))))) {
      throwIfAborted(signal)
      if (runtime.pid !== process.pid) throw new Error('runtime.json belongs to a different daemon process')
      if (performance.now() <= deadline) return runtime
    }

    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    const outcome = await Promise.race([
      exited,
      Bun.sleep(Math.max(1, Math.min(100, Math.ceil(remaining)))).then(() => ({ kind: 'sleep' as const }))
    ])
    if (outcome.kind === 'exit') throw new Error(`daemon exited with code ${outcome.code} before becoming healthy`)
  }

  throwIfAborted(signal)
  throw new Error('daemon did not become healthy within 30 seconds')
}

async function waitForDaemonShutdown(process: DaemonProcess, signal?: AbortSignal): Promise<void> {
  await waitWithAbort(process.exited, signal, 10_000)
}

async function assertSessionsAlive(
  client: QuirkyClient,
  sessionIds: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  if (sessionIds.length === 0) return
  const status = asRecord(await waitWithAbort(
    client.callAny('quirky.terminal/sessions', {}, { timeoutMs: 30_000 }),
    signal,
    30_000
  ))
  const rows = Array.isArray(status.sessions) ? status.sessions.map(asRecord) : []
  const live = new Set(rows.filter((row) => row.alive === true).map((row) => row.sessionId).filter((id): id is string => typeof id === 'string'))
  const missing = sessionIds.filter((id) => !live.has(id))
  if (missing.length > 0) throw new Error(`fixture terminal sessions are no longer alive: ${missing.join(', ')}`)
}

function closeClient(client: QuirkyClient | undefined): void {
  try {
    client?.close()
  } catch {
    return
  }
}

/** Starts the isolated fixture world and its existing soak workers unless explicitly suppressed. */
export async function startWorld(options: StartWorldOptions, dependencies: StartWorldDependencies = {}): Promise<SoakWorld> {
  throwIfAborted(options.signal)
  const scope = (dependencies.createScope ?? createProcessScope)()
  const home = scope.home
  let control: QuirkyClient | undefined
  let runtime: RuntimeInfo | undefined
  let daemonPid: number | undefined
  let daemonProcess: DaemonProcess | undefined
  let cleanupPromise: Promise<void> | undefined
  let preservedSessions: string[] = []

  const stop = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    closeClient(control)
    cleanupPromise = Promise.resolve().then(() => scope.cleanup()).catch((error: unknown) => {
      throw new Error(safeMessage(error, home))
    })
    return cleanupPromise
  }

  try {
    const out = resolve(options.out)
    const repoRoot = resolve(options.repoRoot)
    mkdirSync(out, { recursive: true })
    const uiDir = options.windows ? join(home, 'ui-dist') : undefined
    const env = createIsolatedRuntimeEnvironment(home, { repoRoot, uiDir })
    const prepared = await (dependencies.prepareCaptureFixtureHome ?? prepareCaptureFixtureHome)(
      home,
      { timeoutMs: 30_000, signal: options.signal, env }
    )
    throwIfAborted(options.signal)
    if (options.slowGit || options.fault === 'slow-git') {
      const fakebin = join(home, 'fakebin')
      const path = env.PATH.split(delimiter).filter((entry) => resolve(entry) !== fakebin).join(delimiter)
      installSlowGit(home, path, join(out, SLOW_GIT_PIDS))
    }
    delete env[FAULT_ENV]
    if (options.fault) {
      installFaultPlugin(home, repoRoot)
      env[FAULT_ENV] = '1'
    }

    if (uiDir) {
      const buildFd = openSync(join(out, 'ui-build.log'), 'w')
      const build = (() => {
        try {
          return scope.spawn([process.execPath, 'packages/ui/build.ts'], {
            cwd: repoRoot,
            env: { ...env, QUIRKY_UI_OUT: uiDir },
            stdin: 'ignore',
            stdout: buildFd,
            stderr: buildFd
          })
        } finally {
          closeSync(buildFd)
        }
      })()
      const code = await waitWithAbort(build.exited, options.signal, 180_000)
      if (code !== 0) throw new Error(`UI build exited with code ${code}; see ${join(out, 'ui-build.log')}`)
      throwIfAborted(options.signal)
    }

    const spawnDaemon = async (signal?: AbortSignal, onSpawn?: (spawn: DaemonSpawn) => void) => {
      throwIfAborted(signal)
      const logPath = join(out, 'daemon.log')
      const logFd = openSync(logPath, 'a')
      let spawnedAt = 0
      let daemon: DaemonProcess
      try {
        spawnedAt = performance.now()
        daemon = scope.spawn([process.execPath, 'packages/daemon/src/main.ts'], {
          cwd: repoRoot,
          env,
          stdin: 'ignore',
          stdout: logFd,
          stderr: logFd
        })
      } finally {
        closeSync(logFd)
      }
      daemonProcess = daemon
      onSpawn?.({ spawnedAt, pid: daemon.pid })
      const healthy = await (dependencies.waitForDaemon ?? waitForDaemon)(home, daemon, signal)
      writeFileSync(join(out, 'daemon.pid'), String(healthy.pid))
      throwIfAborted(signal)

      let candidate: QuirkyClient | undefined
      try {
        const connecting = (dependencies.connectDaemon ?? connectDaemon)({
          home,
          role: 'cli',
          name: 'soak-control',
          autostart: false
        })
        candidate = await waitWithAbort(connecting, signal, 30_000, closeClient)
        const status = asRecord(await waitWithAbort(candidate.callAny('status.get', {}, { timeoutMs: 30_000 }), signal))
        if (status.home !== home) throw new Error('the fixture daemon reports a different home')
        return { process: daemon, runtime: healthy, control: candidate, status, spawnedAt }
      } catch (error) {
        closeClient(candidate)
        throw error
      }
    }

    const initial = await spawnDaemon(options.signal)
    runtime = initial.runtime
    daemonPid = initial.runtime.pid
    const activeControl = initial.control
    control = activeControl
    if (options.fault) {
      const report = asRecord(await waitWithAbort(activeControl.callAny(`${FAULT_PLUGIN_ID}/report`, {}, { timeoutMs: 30_000 }), options.signal))
      if (Object.keys(report).length !== 4 || !Array.isArray(report.leaked) || report.leaked.length !== 0
        || !Array.isArray(report.holders) || report.holders.length !== 0 || report.refreshes !== 0 || report.blockedMs !== null) {
        throw new Error('soak.faults did not report a clean initial state')
      }
    }
    const ptyHost = createPtyHostTracker((pid) => scope.track(pid), asRecord(initial.status.ptyHost).pid)
    const fixtures = await (dependencies.registerCaptureFixtures ?? registerCaptureFixtures)(
      activeControl,
      prepared,
      { timeoutMs: 30_000, signal: options.signal }
    )
    const workerScript = resolve(repoRoot, 'scripts/soak/worker.ts')
    const workers: Worker[] = []

    if (options.workers !== false) {
      for (let index = 0; index < fixtures.worktrees.length; index++) {
        throwIfAborted(options.signal)
        const worktree = fixtures.worktrees[index]!
        const command = `${shellQuote(process.execPath)} ${shellQuote(workerScript)} ${index}`
        const response = asRecord(await waitWithAbort(activeControl.callAny('quirky.terminal/newTab', {
          workspace: worktree.id,
          cwd: worktree.path,
          agent: 'shell',
          command,
          title: `soak worker ${index}`,
          activate: false
        }, { timeoutMs: 30_000 }), options.signal))
        if (typeof response.session !== 'string' || response.session.length === 0) {
          throw new Error('quirky.terminal/newTab did not return a session id')
        }
        workers.push({ worktree: worktree.id, path: worktree.path, session: response.session })
      }
    }

    const preserveSessions = (sessionIds: readonly string[]) => {
      const ids = [...sessionIds]
      if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
        throw new Error('preserved terminal session IDs must be non-empty and unique')
      }
      preservedSessions = ids
    }

    const restartDaemon = async (signal?: AbortSignal, onSpawn?: (spawn: DaemonSpawn) => void): Promise<DaemonRestart> => {
      throwIfAborted(signal)
      const oldProcess = daemonProcess
      const oldControl = control
      if (!oldProcess || !oldControl) throw new Error('the fixture daemon is not available to restart')
      await assertSessionsAlive(oldControl, preservedSessions, signal)
      closeClient(oldControl)
      control = undefined
      oldProcess.kill('SIGTERM')
      await (dependencies.waitForShutdown ?? waitForDaemonShutdown)(oldProcess, signal)

      const replacement = await spawnDaemon(signal, onSpawn)
      try {
        await assertSessionsAlive(replacement.control, preservedSessions, signal)
      } catch (error) {
        closeClient(replacement.control)
        throw error
      }
      runtime = replacement.runtime
      daemonPid = replacement.runtime.pid
      control = replacement.control
      ptyHost.update(asRecord(replacement.status.ptyHost).pid)
      return { spawnedAt: replacement.spawnedAt }
    }

    throwIfAborted(options.signal)
    const world: SoakWorld = {
      home,
      get runtime() { return runtime! },
      get daemonPid() { return daemonPid! },
      ptyHostPid: ptyHost.current,
      updatePtyHostPid: ptyHost.update,
      get control() { return control! },
      fixtures,
      workers,
      env,
      preserveSessions,
      restartDaemon,
      track: (pid) => scope.track(pid),
      stop
    }
    return world
  } catch (error) {
    closeClient(control)
    try {
      await scope.cleanup()
    } catch (cleanupError) {
      throw new Error(`${safeMessage(error, home)}; cleanup failed: ${safeMessage(cleanupError, home)}`)
    }
    throw new Error(safeMessage(error, home))
  }
}
