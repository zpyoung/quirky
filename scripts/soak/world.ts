import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
import { FAULT_ENV, FAULT_PLUGIN_ID, installFaultPlugin } from './faults.ts'

type Worker = { worktree: string; path: string; session: string }

type StartWorldOptions = { out: string; repoRoot: string; signal?: AbortSignal; fault?: FaultKind }

export type SoakWorld = {
  home: string
  runtime: RuntimeInfo
  daemonPid: number
  ptyHostPid(): number | null
  updatePtyHostPid(pid: number | null): void
  control: QuirkyClient
  fixtures: RegisteredCaptureFixtures
  workers: Worker[]
  stop(): Promise<void>
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

function closeClient(client: QuirkyClient | undefined): void {
  try {
    client?.close()
  } catch {
    return
  }
}

/** Starts the real daemon, fixture repositories, and one scripted shell in each fixture worktree. */
export async function startWorld(options: StartWorldOptions): Promise<SoakWorld> {
  throwIfAborted(options.signal)
  const scope = createProcessScope()
  const home = scope.home
  let control: QuirkyClient | undefined
  let cleanupPromise: Promise<void> | undefined

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
    const env = createIsolatedRuntimeEnvironment(home, { repoRoot })
    const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 30_000, signal: options.signal, env })
    throwIfAborted(options.signal)
    delete env[FAULT_ENV]
    if (options.fault) {
      installFaultPlugin(home, repoRoot)
      env[FAULT_ENV] = '1'
    }

    const logPath = join(out, 'daemon.log')
    const logFd = openSync(logPath, 'a')
    const daemon = (() => {
      try {
        return scope.spawn([process.execPath, 'packages/daemon/src/main.ts'], {
          cwd: repoRoot,
          env,
          stdin: 'ignore',
          stdout: logFd,
          stderr: logFd
        })
      } finally {
        closeSync(logFd)
      }
    })()

    const runtime = await waitForDaemon(home, daemon, options.signal)
    writeFileSync(join(out, 'daemon.pid'), String(runtime.pid))
    throwIfAborted(options.signal)

    const connecting = connectDaemon({ home, role: 'cli', name: 'soak-control', autostart: false })
    const activeControl = await waitWithAbort(connecting, options.signal, 30_000, closeClient)
    control = activeControl
    throwIfAborted(options.signal)

    const status = asRecord(await waitWithAbort(activeControl.callAny('status.get', {}, { timeoutMs: 30_000 }), options.signal))
    if (status.home !== home) throw new Error('the fixture daemon reports a different home')
    if (options.fault) {
      const report = asRecord(await waitWithAbort(activeControl.callAny(`${FAULT_PLUGIN_ID}/report`, {}, { timeoutMs: 30_000 }), options.signal))
      if (Object.keys(report).length !== 4 || !Array.isArray(report.leaked) || report.leaked.length !== 0
        || !Array.isArray(report.holders) || report.holders.length !== 0 || report.refreshes !== 0 || report.blockedMs !== null) {
        throw new Error('soak.faults did not report a clean initial state')
      }
    }
    let currentPtyHostPid = pidOf(asRecord(status.ptyHost).pid)
    const fixtures = await registerCaptureFixtures(activeControl, prepared, { timeoutMs: 30_000, signal: options.signal })
    const workerScript = resolve(repoRoot, 'scripts/soak/worker.ts')
    const workers: Worker[] = []

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

    throwIfAborted(options.signal)
    const world: SoakWorld = {
      home,
      runtime,
      daemonPid: runtime.pid,
      ptyHostPid: () => currentPtyHostPid,
      updatePtyHostPid(pid) {
        currentPtyHostPid = pidOf(pid)
      },
      control: activeControl,
      fixtures,
      workers,
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
