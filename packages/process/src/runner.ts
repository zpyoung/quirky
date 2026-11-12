import type { ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { startChild, type StartChild } from './child'
import { ProcessRunnerDisposedError } from './errors'
import { executeRun, DEFAULT_TIMEOUT_MS, DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES } from './run'
import { processesForRunner, registerProcess, stopProcesses, type LiveProcess } from './registry'

/** A runner whose children can be inspected and stopped together. */
export type OwnedProcessRunner = ProcessRunner & {
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
  /** For tests: replaces the stall wait of every run. */
  stallMs?: number
  /** For tests: stands in for the function that starts a child. */
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
