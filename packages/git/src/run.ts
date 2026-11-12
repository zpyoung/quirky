import { resolve } from 'node:path'
import { GitError } from './index'
import { createGitScheduler } from './scheduler'

export { createGitScheduler, DEFAULT_GIT_CONCURRENCY, type GitScheduler, type GitSchedulerOptions, type GitSlotResult } from './scheduler'

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

export type GitResult = { stdout: Uint8Array; stderr: string; exitCode: number; timedOut?: boolean }

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
  /** How long git's output may stay unfinished after git exited before the run counts as stalled; default `PIPE_STALL_MS` (ten times that for a command that may write). */
  stallMs?: number
  /** Joins a post-arrival cohort for identical reads without stdin; defaults to true. */
  share?: boolean
}

/** Quiet time after git exited, or after its last chunk, past which a read of its output counts as stalled. */
export const PIPE_STALL_MS = 1000
const PIPE_STALL_ATTEMPTS = 3

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

/** All the bytes of a git pipe. */
async function drain(stream: ReadableStream<Uint8Array>, exited: Promise<unknown>, stallMs: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await readChunk(reader, exited, stallMs)
    if (done) break
    chunks.push(value)
    total += value.byteLength
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
 * Runs `attempt` again, up to three times in all, when git's output stalls after git exited; only
 * for work that reads and keeps no state between attempts. Fails with `GitError` when every
 * attempt stalls.
 */
export async function retryStalled<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tried = 1; ; tried++) {
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof PipeStalledError)) throw err
      if (tried >= PIPE_STALL_ATTEMPTS) throw new GitError(`${err.message} after ${tried} attempts`, '', -1)
    }
  }
}

const BASE_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

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

/** The environment every git child gets for `options`. */
export async function gitEnv(cwd: string, options: RunGitOptions = {}): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env, ...BASE_ENV }
  if (options.readOnly) env.GIT_OPTIONAL_LOCKS = '0'
  if (options.network) {
    const ssh = await batchSshCommand(cwd)
    if (ssh) env.GIT_SSH_COMMAND = ssh
    env.GIT_ASKPASS = ''
    env.SSH_ASKPASS = ''
  }
  return { ...env, ...options.env }
}

/**
 * Runs `git` with an args array in `cwd`; never throws on a non-zero exit. With `timeoutMs` the
 * process is killed once it elapses and the result has `timedOut: true`. Output that does not end
 * after git exited (see `PipeStalledError`) is run again when `readOnly`, else, and when every
 * attempt stalls, fails with `GitError`.
 */
export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  if (!options.readOnly) {
    return withGitWrite(async () => {
      const env = await resolvedGitEnv(cwd, options)
      return runGitOnce(cwd, args, options, env).catch((err) => {
        throw err instanceof PipeStalledError ? new GitError(`git ${args[0]}: ${err.message}`, '', -1) : err
      })
    })
  }
  const share = options.input === undefined && options.share !== false
  const deadline = share && options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined
  const env = await resolvedGitEnv(cwd, options)
  const run = () => {
    const remaining = deadline === undefined ? undefined : deadline - Date.now()
    if (remaining !== undefined && remaining <= 0) {
      return Promise.resolve<GitResult>({ stdout: new Uint8Array(0), stderr: '', exitCode: 143, timedOut: true })
    }
    const runOptions = remaining === undefined ? options : { ...options, timeoutMs: remaining }
    return retryStalled(() => runGitOnce(cwd, args, runOptions, env))
  }
  if (!share) return run()
  const entries = Object.entries(env).filter((entry) => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b))
  const key = JSON.stringify(['runGit', resolve(cwd), args, entries, options.timeoutMs ?? null, options.stallMs ?? null])
  return shareGitRead(key, run, (result) => ({ ...result, stdout: result.stdout.slice() }))
}

async function resolvedGitEnv(cwd: string, options: RunGitOptions): Promise<Record<string, string | undefined>> {
  try {
    return await gitEnv(cwd, options)
  } catch (err) {
    throw new GitError(`failed to run git: ${(err as Error).message}`, '', -1)
  }
}

async function runGitOnce(
  cwd: string,
  args: string[],
  options: RunGitOptions,
  env: Record<string, string | undefined>
): Promise<GitResult> {
  const input = typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input
  const slot = await gitScheduler.withSlot(options.readOnly ? 'read' : 'write', options.timeoutMs, async (remainingTimeoutMs) => {
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(['git', ...args], { cwd, env, stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe' })
    } catch (err) {
      throw new GitError(`failed to run git: ${(err as Error).message}`, '', -1)
    }
    let timedOut = false
    const timer = remainingTimeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      proc.kill()
    }, remainingTimeoutMs)
    try {
      const stallMs = options.stallMs ?? (options.readOnly ? PIPE_STALL_MS : PIPE_STALL_MS * 10)
      const [stdout, stderr, exitCode] = await Promise.all([
        drain(proc.stdout as ReadableStream<Uint8Array>, proc.exited, stallMs),
        drain(proc.stderr as ReadableStream<Uint8Array>, proc.exited, stallMs),
        proc.exited
      ])
      return { stdout, stderr: new TextDecoder().decode(stderr), exitCode, ...(timedOut ? { timedOut } : {}) }
    } finally {
      clearTimeout(timer)
      if (proc.exitCode === null) proc.kill()
      await proc.exited
    }
  })
  return slot.timedOut ? { stdout: new Uint8Array(0), stderr: '', exitCode: 143, timedOut: true } : slot.value
}

/** Like `runGit` but throws `GitError` on a non-zero exit; returns stdout as text. */
export async function git(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
  const r = await runGit(cwd, args, options)
  if (r.exitCode !== 0) {
    const detail = r.stderr.trim()
    throw new GitError(`git ${args[0]} failed (exit ${r.exitCode})${detail ? `: ${detail}` : ''}`, r.stderr, r.exitCode)
  }
  return new TextDecoder().decode(r.stdout)
}
