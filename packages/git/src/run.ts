import { GitError } from './index'

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
 * process is killed once it elapses and the result has `timedOut: true`.
 */
export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  let proc: ReturnType<typeof Bun.spawn>
  const input = typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd,
      env: await gitEnv(cwd, options),
      stdin: input ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
  } catch (err) {
    throw new GitError(`failed to run git: ${(err as Error).message}`, '', -1)
  }
  let timedOut = false
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          proc.kill()
        }, options.timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).arrayBuffer(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited
    ])
    return { stdout: new Uint8Array(stdout), stderr, exitCode, ...(timedOut ? { timedOut } : {}) }
  } finally {
    if (timer) clearTimeout(timer)
  }
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
