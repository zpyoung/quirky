import { constants as osConstants } from 'node:os'
import { resolve } from 'node:path'
import {
  createProcessRunner,
  DEFAULT_MAX_OUTPUT_BYTES,
  ProcessStalledError
} from '@quirky/process'
import type { OwnedProcessRunner, SpawnExit, SpawnedProcess } from '@quirky/process'
import { GitError } from './index'
import { createGitScheduler } from './scheduler'

export { createGitScheduler, DEFAULT_GIT_CONCURRENCY, type GitScheduler, type GitSchedulerOptions, type GitSlotResult } from './scheduler'

/** Default wall-clock deadline for read-only git commands when `timeoutMs` is omitted. */
export const DEFAULT_GIT_READ_TIMEOUT_MS = 30_000
/** Default wall-clock deadline for mutating git commands when `timeoutMs` is omitted. */
export const DEFAULT_GIT_WRITE_TIMEOUT_MS = 120_000
/** Default per-stream output byte cap inherited from `@quirky/process`. */
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES

/** Bounds git children and coalesces post-arrival reads across the package. */
export const gitScheduler = createGitScheduler()

/** Holds a read slot until a single leaf child has exited. */
export async function withGitReadSlot<T>(work: () => Promise<T>): Promise<T> {
  const result = await gitScheduler.withSlot('read', undefined, work)
  if (result.timedOut) throw new Error('git read slot expired without a deadline')
  return result.value
}

/** Shares a post-arrival read cohort without sharing mutable results. */
export function shareGitRead<T>(key: string, run: () => Promise<T>, clone: (value: T) => T): Promise<T> {
  return gitScheduler.shareRead(key, run, clone)
}

/** Invalidates read cohorts on entry and settlement of a repository mutation. */
export function withGitWrite<T>(work: () => Promise<T>): Promise<T> {
  return gitScheduler.withWrite(work)
}

export type GitResult = {
  stdout: Uint8Array
  stderr: string
  exitCode: number
  timedOut?: boolean
  overflow?: boolean
}

export type RunGitOptions = {
  timeoutMs?: number
  /** Written to git's stdin (for `--pathspec-from-file=-`); stdin is closed otherwise. */
  input?: Uint8Array | string
  /** A read that must not take optional locks (`GIT_OPTIONAL_LOCKS=0`), so it never blocks a concurrent write. */
  readOnly?: boolean
  /** A command that may talk to a remote: ssh runs in batch mode and no askpass helper is started. */
  network?: boolean
  /** Extra environment variables, applied last. */
  env?: Record<string, string>
  /** How long git's output may stay unfinished after git exited before the run counts as stalled. */
  stallMs?: number
  /** Joins a post-arrival cohort for identical reads without stdin; defaults to true. */
  share?: boolean
  /** Per-stream output byte limit; defaults to `DEFAULT_GIT_MAX_OUTPUT_BYTES` and is part of the read cohort key. */
  maxOutputBytes?: number
}

export type StreamNullRecordsOptions = {
  timeoutMs?: number
  stallMs?: number
}

/** Quiet time after git exited, or after its last chunk, past which a read of its output counts as stalled. */
export const PIPE_STALL_MS = 1000
const PIPE_STALL_ATTEMPTS = 3

/** Shared runners retain one-shot process ownership while the git scheduler remains the sole queue. */
export const readRunner: OwnedProcessRunner = createProcessRunner({ owner: 'git', stallMs: PIPE_STALL_MS })
export const writeRunner: OwnedProcessRunner = createProcessRunner({ owner: 'git', stallMs: PIPE_STALL_MS * 10 })

/**
 * Git exited but a pipe of its output never delivered its end. Bun 1.4.0 on Linux can lose the
 * epoll wakeup of a subprocess pipe when several children exit in one loop turn: the bytes stay
 * queued in the socket and the read stays pending for the life of the process. The stall guard
 * and retry built on this is a workaround for that Bun 1.4.0 bug and can go once Bun fixes it.
 */
class PipeStalledError extends Error {
  constructor(readonly exitedLongAgo: boolean) {
    super('git exited but its output did not end')
    this.name = 'PipeStalledError'
  }
}

/** `pending`, or a `PipeStalledError` once git has exited and `stallMs` passes before `pending` settles. */
export async function untilStalled<T>(exited: Promise<unknown>, pending: Promise<T>, stallMs: number = PIPE_STALL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const stalled = exited.then(
    () =>
      new Promise<never>((_, reject) => {
        if (finished) return
        timer = setTimeout(() => reject(new PipeStalledError(true)), stallMs)
      })
  )
  stalled.catch(() => {})
  try {
    return await Promise.race([pending, stalled])
  } finally {
    finished = true
    clearTimeout(timer)
  }
}

/** One read of a git pipe, abandoning the stream when it stalls. */
export async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, exited: Promise<unknown>, stallMs?: number) {
  try {
    return await untilStalled(exited, reader.read(), stallMs)
  } catch (err) {
    if (err instanceof PipeStalledError) void reader.cancel().catch(() => {})
    throw err
  }
}

/** All the bytes of a git pipe, rejecting an unfinished stream after the leader exits. */
async function drain(stream: ReadableStream<Uint8Array>, exited: Promise<unknown>, stallMs: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, exited, stallMs)
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

/** What `proc` writes to stderr, read in the background; a stall surfaces when the promise is awaited. */
export function drainText(proc: { stderr: unknown; exited: Promise<unknown> }, stallMs?: number): Promise<string> {
  const text = drain(proc.stderr as ReadableStream<Uint8Array>, proc.exited, stallMs ?? PIPE_STALL_MS).then((bytes) => new TextDecoder().decode(bytes))
  text.catch(() => {})
  return text
}

/**
 * Normalizes a non-stopped process exit into a numeric status. The caller must inspect spawn errors
 * and stopped results before calling this function.
 */
export function normalizeExitCode(exitCode: number | null, signal: string | null): number {
  if (exitCode !== null) return exitCode
  if (signal !== null) return 128 + ((osConstants.signals as Record<string, number>)[signal] ?? 15)
  throw new GitError('failed to run git: process exited without status or signal', '', -1)
}

/**
 * Runs `attempt` at most three times inside one wall-clock budget. Only pipe stalls are retried;
 * launch failures, aborts and every other failure propagate without another attempt.
 */
export function retryStalled<T>(attempt: (remainingTimeoutMs: number) => Promise<T>, timeoutMs = DEFAULT_GIT_READ_TIMEOUT_MS): Promise<T> {
  return retryStalledUntil(attempt, Date.now() + timeoutMs)
}

async function retryStalledUntil<T>(attempt: (remainingTimeoutMs: number) => Promise<T>, deadline: number): Promise<T> {
  let attempts = 0
  let lastStall: PipeStalledError | undefined
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new GitError(`${lastStall?.message ?? 'git output did not finish'} after ${attempts} attempts`, '', -1)
    attempts++
    try {
      return await attempt(remaining)
    } catch (error) {
      if (!(error instanceof PipeStalledError)) throw error
      lastStall = error
      if (attempts >= PIPE_STALL_ATTEMPTS || Date.now() >= deadline) {
        throw new GitError(`${error.message} after ${attempts} attempts`, '', -1)
      }
    }
  }
}

const BASE_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
const GIT_CONFIG_OVERRIDES = [
  ['core.fsmonitor', 'false'],
  ['gc.autoDetach', 'false'],
  ['maintenance.autoDetach', 'false']
] as const

/**
 * The ssh command a network call should use: the caller's `GIT_SSH_COMMAND` untouched when set,
 * else the repo's `core.sshCommand` (or `ssh`) with `-o BatchMode=yes`, so a password or host-key
 * question fails instead of waiting on a terminal nobody sees.
 */
async function batchSshCommand(cwd: string): Promise<string | null> {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return null
  const configured = await runGit(cwd, ['config', '--get', 'core.sshCommand'], { readOnly: true })
  const base = configured.exitCode === 0 ? new TextDecoder().decode(configured.stdout).trim() : ''
  return `${base || 'ssh'} -o BatchMode=yes`
}

/** The environment every git child gets, with daemon settings appended after caller configuration. */
export async function gitEnv(cwd: string, options: RunGitOptions = {}): Promise<Record<string, string>> {
  const env: Record<string, string | undefined> = { ...process.env, ...BASE_ENV }
  if (options.readOnly) env.GIT_OPTIONAL_LOCKS = '0'
  if (options.network) {
    const ssh = await batchSshCommand(cwd)
    if (ssh) env.GIT_SSH_COMMAND = ssh
    env.GIT_ASKPASS = ''
    env.SSH_ASKPASS = ''
  }
  Object.assign(env, options.env)

  const configuredCount = Number(env.GIT_CONFIG_COUNT ?? 0)
  const count = Number.isSafeInteger(configuredCount) && configuredCount >= 0 ? configuredCount : 0
  env.GIT_CONFIG_COUNT = String(count + GIT_CONFIG_OVERRIDES.length)
  for (let i = 0; i < GIT_CONFIG_OVERRIDES.length; i++) {
    const [key, value] = GIT_CONFIG_OVERRIDES[i]!
    env[`GIT_CONFIG_KEY_${count + i}`] = key
    env[`GIT_CONFIG_VALUE_${count + i}`] = value
  }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function failedToRunGit(error: unknown): GitError {
  return new GitError(`failed to run git: ${error instanceof Error ? error.message : String(error)}`, '', -1)
}

function timedOutResult(): GitResult {
  return { stdout: new Uint8Array(0), stderr: '', exitCode: 143, timedOut: true }
}


/**
 * Runs `git` through the shared process runner; never throws on a non-zero exit. Each attempt and
 * scheduler wait shares the deadline measured from this call's entry. Read-only runs retry
 * post-exit output stalls, failing with `GitError` after three attempts. Mutations never retry:
 * they preserve the child's exit status and bytes already drained if its output stalls.
 */
export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? (options.readOnly ? DEFAULT_GIT_READ_TIMEOUT_MS : DEFAULT_GIT_WRITE_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  const runOptions: RunGitOptions = { ...options, timeoutMs }

  if (!options.readOnly) {
    return withGitWrite(async () => {
      const env = await resolvedGitEnv(cwd, runOptions)
      return runGitOnce(cwd, args, runOptions, env, deadline).catch((error) => {
        throw error instanceof PipeStalledError ? new GitError(`git ${args[0]}: ${error.message}`, '', -1) : error
      })
    })
  }

  const env = await resolvedGitEnv(cwd, runOptions)
  if (Date.now() >= deadline) return timedOutResult()
  const share = options.input === undefined && options.share !== false
  const run = () => {
    if (Date.now() >= deadline) return Promise.resolve(timedOutResult())
    return retryStalledUntil(
      (remainingTimeoutMs) => runGitOnce(cwd, args, { ...runOptions, timeoutMs: remainingTimeoutMs }, env, deadline),
      deadline
    )
  }
  if (!share) return run()

  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
  const key = JSON.stringify([
    'runGit',
    resolve(cwd),
    args,
    entries,
    timeoutMs,
    options.stallMs ?? null,
    options.maxOutputBytes ?? null
  ])
  return shareGitRead(key, run, (result) => ({ ...result, stdout: result.stdout.slice() }))
}

async function resolvedGitEnv(cwd: string, options: RunGitOptions): Promise<Record<string, string>> {
  try {
    return await gitEnv(cwd, options)
  } catch (error) {
    throw failedToRunGit(error)
  }
}

async function runGitOnce(
  cwd: string,
  args: string[],
  options: RunGitOptions,
  env: Record<string, string>,
  deadline: number
): Promise<GitResult> {
  const input = typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input
  const scopedRunner = options.stallMs === undefined ? undefined : createProcessRunner({ owner: 'git', stallMs: options.stallMs })
  const runner = scopedRunner ?? (options.readOnly ? readRunner : writeRunner)
  try {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return timedOutResult()
    const slot = await gitScheduler.withSlot(options.readOnly ? 'read' : 'write', remaining, async (slotRemainingMs) => {
      try {
        const timeout = Math.min(deadline - Date.now(), slotRemainingMs ?? remaining)
        if (timeout <= 0) return timedOutResult()
        let result
        try {
          result = await runner.run(['git', ...args], {
            cwd,
            env,
            input,
            timeoutMs: timeout,
            maxOutputBytes: options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES,
            rerunnable: false
          })
        } catch (error) {
          if (error instanceof ProcessStalledError) {
            if (options.readOnly || !error.partialResult) throw new PipeStalledError(true)
            result = error.partialResult
          } else {
            throw failedToRunGit(error)
          }
        }

        if (result.spawnError !== undefined) throw failedToRunGit(result.spawnError.message)
        if (result.stopped === 'aborted') throw new GitError(`git ${args[0]} aborted`, result.stderr, -1)
        if (result.stopped === 'timeout') {
          return { stdout: result.stdout, stderr: result.stderr, exitCode: 143, timedOut: true }
        }
        if (result.stopped === 'overflow') {
          return { stdout: result.stdout, stderr: result.stderr, exitCode: 137, overflow: true }
        }
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: normalizeExitCode(result.exitCode, result.signal)
        }
      } finally {
        if (scopedRunner) await scopedRunner.dispose()
      }
    })
    return slot.timedOut ? timedOutResult() : slot.value
  } finally {
    if (scopedRunner) await scopedRunner.dispose()
  }
}

/**
 * Runs one read-only git command and consumes its stdout as NUL-separated records. The process is
 * stopped in `finally` when the consumer stops early or throws; retry ownership stays with callers.
 */
export async function streamNullRecords(
  cwd: string,
  args: string[],
  onRecord: (record: string) => boolean | Promise<boolean>,
  options: StreamNullRecordsOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_READ_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const env = await resolvedGitEnv(cwd, { readOnly: true })
  const scopedRunner = options.stallMs === undefined ? undefined : createProcessRunner({ owner: 'git', stallMs: options.stallMs })
  const runner = scopedRunner ?? readRunner
  const subcommand = args[0] ?? ''

  try {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new GitError(`git ${subcommand} timed out after ${timeoutMs}ms`, '', 143)
    const slot = await gitScheduler.withSlot('read', remaining, async (slotRemainingMs) => {
      let child: SpawnedProcess
      try {
        child = runner.spawn(['git', ...args], {
          cwd,
          env,
          timeoutMs: Math.min(deadline - Date.now(), slotRemainingMs ?? remaining),
          stdout: 'pipe',
          stderr: 'tail'
        })
      } catch (error) {
        if (error instanceof ProcessStalledError) throw new PipeStalledError(true)
        throw failedToRunGit(error)
      }

      let stoppedEarly = false
      let callbackFailed = false
      let stopInFinally = false
      let exit: SpawnExit | undefined
      let buffered = ''
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
      const consume = async (record: string): Promise<void> => {
        try {
          if (await onRecord(record)) stoppedEarly = true
        } catch (error) {
          callbackFailed = true
          throw error
        }
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffered += decoder.decode(value, { stream: true })
          for (;;) {
            const end = buffered.indexOf('\0')
            if (end < 0) break
            const record = buffered.slice(0, end)
            buffered = buffered.slice(end + 1)
            await consume(record)
            if (stoppedEarly) break
          }
          if (stoppedEarly) break
        }
        buffered += decoder.decode()
        if (!stoppedEarly && buffered.length > 0) await consume(buffered)
        if (stoppedEarly) stopInFinally = true
      } catch (error) {
        stopInFinally = true
        if (error instanceof ProcessStalledError && !callbackFailed) throw new PipeStalledError(true)
        throw error
      } finally {
        if (stopInFinally) exit = await child.stop({ signal: 'SIGKILL', graceMs: 0 })
        reader.releaseLock()
      }

      exit ??= await child.exited
      if (stoppedEarly) return
      const stderr = child.stderrTail()
      if (exit.spawnError !== undefined) throw failedToRunGit(exit.spawnError.message)
      if (exit.stopped === 'aborted') throw new GitError(`git ${subcommand} aborted`, stderr, -1)
      if (exit.stopped === 'timeout') throw new GitError(`git ${subcommand} timed out after ${timeoutMs}ms`, stderr, 143)
      const exitCode = normalizeExitCode(exit.exitCode, exit.signal)
      if (exitCode !== 0) {
        const detail = stderr.trim()
        throw new GitError(`git ${subcommand} failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`, stderr, exitCode)
      }
    })
    if (slot.timedOut) throw new GitError(`git ${subcommand} timed out after ${timeoutMs}ms`, '', 143)
  } finally {
    if (scopedRunner) await scopedRunner.dispose()
  }
}

/** Like `runGit`, including partial output on mutation pipe stalls; throws `GitError` on nonzero exit, otherwise returns stdout text. */
export async function git(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
  const r = await runGit(cwd, args, options)
  const timeoutMs = options.timeoutMs ?? (options.readOnly ? DEFAULT_GIT_READ_TIMEOUT_MS : DEFAULT_GIT_WRITE_TIMEOUT_MS)
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES
  if (r.timedOut) throw new GitError(`git ${args[0]} timed out after ${timeoutMs}ms`, r.stderr, 143)
  if (r.overflow) throw new GitError(`git ${args[0]} output exceeded ${maxOutputBytes} bytes`, r.stderr, 137)
  if (r.exitCode !== 0) {
    const detail = r.stderr.trim()
    throw new GitError(`git ${args[0]} failed (exit ${r.exitCode})${detail ? `: ${detail}` : ''}`, r.stderr, r.exitCode)
  }
  return new TextDecoder().decode(r.stdout)
}
