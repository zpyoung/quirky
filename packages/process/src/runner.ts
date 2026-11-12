import type { ProcessRunner, ProcessSpawner, RunOptions, RunResult, SpawnOptions } from '@quirky/protocol'
import { startChild, type StartChild } from './child'
import { ProcessRunnerDisposedError } from './errors'
import { executeRun, DEFAULT_TIMEOUT_MS, DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES } from './run'
import { DEFAULT_STDERR_TAIL_BYTES, executeSpawn, SPAWN_STALL_MS } from './spawn'
import { processesForRunner, registerProcess, stopProcesses, type LiveProcess } from './registry'

/** A runner whose children can be inspected, streamed and stopped together. */
export type OwnedProcessRunner = ProcessRunner & ProcessSpawner & {
  readonly owner: string
  /** This runner's children that have not finished. */
  live(): LiveProcess[]
  /** Kills this runner's children, waits for them, and refuses every later call. */
  dispose(): Promise<void>
}

/** Attributes children and optionally replaces the child and stall seams for tests. */
export type ProcessRunnerOptions = {
  /** Who the children are listed under, such as a plugin id. */
  owner: string
  /** For tests: replaces the stall wait of every run and spawn. */
  stallMs?: number
  /** For tests: stands in for the function that starts a child for every run and spawn. */
  start?: StartChild
}

/** Creates an isolated in-flight table and lifecycle for one owner's subprocesses. */
export function createProcessRunner({ owner, start = startChild, stallMs }: ProcessRunnerOptions): OwnedProcessRunner {
  if (typeof owner !== 'string' || owner.length === 0) throw new TypeError('owner must be a non-empty string')
  const identity = Symbol(owner)
  const shared = new Map<string, Promise<RunResult>>()
  const running = new Set<Promise<RunResult>>()
  let disposed = false
  let disposal: Promise<void> | undefined

  return {
    owner,
    live: () => processesForRunner(identity),
    dispose() {
      if (!disposal) {
        disposed = true
        disposal = (async () => {
          await stopProcesses(identity)
          await Promise.allSettled([...running])
        })()
      }
      return disposal
    },
    spawn(argv, options) {
      if (disposed) throw new ProcessRunnerDisposedError(owner)
      if (argv.length === 0 || !argv[0]) throw new TypeError('argv must name a command')
      const timeoutMs = options?.timeoutMs
      if (timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new RangeError('timeoutMs must be a positive finite number or null')
      }
      const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
      if (!Number.isFinite(killGraceMs) || killGraceMs < 0) {
        throw new RangeError('killGraceMs must be zero or a positive finite number')
      }
      const stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES
      if (!Number.isInteger(stderrTailBytes) || stderrTailBytes <= 0) {
        throw new RangeError('stderrTailBytes must be a positive integer')
      }
      const stdin = options.stdin ?? 'ignore'
      if (stdin !== 'pipe' && stdin !== 'ignore') throw new TypeError('stdin must be \"pipe\" or \"ignore\"')
      const stdout = options.stdout ?? 'pipe'
      if (stdout !== 'pipe' && stdout !== 'ignore') throw new TypeError('stdout must be \"pipe\" or \"ignore\"')
      const stderr = options.stderr ?? 'tail'
      if (stderr !== 'tail' && stderr !== 'ignore') throw new TypeError('stderr must be \"tail\" or \"ignore\"')

      const cwd = options.cwd ?? process.cwd()
      const env = { ...(options.env ?? process.env) }
      const normalized: SpawnOptions = {
        ...options,
        timeoutMs,
        killGraceMs,
        stderrTailBytes,
        stdin,
        stdout,
        stderr,
        cwd,
        env,
      }
      const command = argv[0]!
      return executeSpawn(start, [...argv], normalized, stallMs ?? SPAWN_STALL_MS, {
        onStart: (child, stop, finished) => registerProcess(identity, owner, command, child, stop, finished, true),
      })
    },
    async run(argv, options = {}) {
      if (disposed) throw new ProcessRunnerDisposedError(owner)
      if (argv.length === 0 || !argv[0]) throw new TypeError('argv must name a command')
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
      const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be a positive finite number')
      if (!Number.isFinite(killGraceMs) || killGraceMs < 0) throw new RangeError('killGraceMs must be zero or a positive finite number')
      if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new RangeError('maxOutputBytes must be a positive integer')
      if (options.share && (options.input !== undefined || options.signal !== undefined)) throw new TypeError('share cannot be combined with input or signal')
      const env = { ...(options.env ?? process.env) }
      const cwd = options.cwd ?? process.cwd()
      const normalized: RunOptions = { ...options, cwd, env, timeoutMs, killGraceMs, maxOutputBytes }
      const key = options.share ? JSON.stringify([
        argv, cwd, Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)),
        timeoutMs, killGraceMs, maxOutputBytes, options.rerunnable ?? false
      ]) : undefined
      if (key !== undefined) {
        const existing = shared.get(key)
        if (existing) return existing
      }
      const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
      const command = argv[0]!
      const pending = executeRun([...argv], normalized, {
        start,
        stallMs,
        isDisposed: () => disposed,
        onStart: (child, stop) => registerProcess(identity, owner, command, child, stop, finished)
      })
      running.add(pending)
      if (key !== undefined) shared.set(key, pending)
      const cleanup = () => {
        running.delete(pending)
        if (key !== undefined) shared.delete(key)
        finish()
      }
      void pending.then(cleanup, cleanup)
      return pending
    }
  }
}
