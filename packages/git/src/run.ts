import { GitError } from './index'

export type GitResult = { stdout: Uint8Array; stderr: string; exitCode: number; timedOut?: boolean }

export type RunGitOptions = { timeoutMs?: number }

/**
 * Runs `git` with an args array in `cwd`; never throws on a non-zero exit. With `timeoutMs` the
 * process is killed once it elapses and the result has `timedOut: true`.
 */
export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdin: 'ignore',
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
export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args)
  if (r.exitCode !== 0) {
    const detail = r.stderr.trim()
    throw new GitError(`git ${args[0]} failed (exit ${r.exitCode})${detail ? `: ${detail}` : ''}`, r.stderr, r.exitCode)
  }
  return new TextDecoder().decode(r.stdout)
}
