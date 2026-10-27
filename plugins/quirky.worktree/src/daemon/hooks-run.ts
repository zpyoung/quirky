import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { gitApi } from '@quirky/git'

export const HOOK_TIMEOUT_MS = 2 * 60 * 1000
export const HOOK_KILL_GRACE_MS = 5000
export const HOOK_OUTPUT_LIMIT = 10 * 1024 * 1024
/** How long to keep reading output after the script exits, for a background process that holds the pipe open. */
const DRAIN_GRACE_MS = 1000

export type HookKind = 'setup' | 'archive'

/** The checkout a hook runs against: the project's primary folder and the workspace it acts on. */
export type HookTarget = { rootPath: string; worktreePath: string }

export type HookRunResult = {
  /** The script's exit status; null when it was killed by a signal. */
  exitCode: number | null
  output: string
  timedOut: boolean
}

export type HookRunOptions = {
  timeoutMs?: number
  killGraceMs?: number
  maxOutputBytes?: number
}

/** `text` as one shell word in single quotes, with embedded quotes escaped. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/** The environment every setup and archive script sees, under Quirky's names and the names of the tools whose hooks it reads. */
export function hookEnvironment(target: HookTarget): Record<string, string> {
  const name = basename(target.worktreePath)
  return {
    QUIRKY_ROOT_PATH: target.rootPath,
    QUIRKY_WORKTREE_PATH: target.worktreePath,
    QUIRKY_WORKSPACE_NAME: name,
    ORCA_ROOT_PATH: target.rootPath,
    ORCA_WORKTREE_PATH: target.worktreePath,
    ORCA_WORKSPACE_NAME: name,
    CONDUCTOR_ROOT_PATH: target.rootPath,
    CONDUCTOR_WORKSPACE_PATH: target.worktreePath,
    CONDUCTOR_WORKSPACE_NAME: name,
    GHOSTX_ROOT_PATH: target.rootPath
  }
}

/** Where a git worktree's runner for `kind` lives: inside its git dir, so it is never part of the checkout. */
export const gitRunnerPath = (worktreePath: string, kind: HookKind): Promise<string> => gitApi().gitPath(worktreePath, `quirky/${kind}-runner.sh`)

/** Where a folder workspace's runner lives, since it has no git dir. */
export const dataRunnerPath = (dataDir: string, worktreeId: string, kind: HookKind): string => join(dataDir, 'runners', worktreeId, `${kind}-runner.sh`)

/**
 * Writes the runner for `script`: it exports the hook environment, enters the worktree, then runs
 * the script text as written, so the script's exit status is the runner's. The file is mode 0755.
 */
export async function writeRunner(runner: string, target: HookTarget, script: string): Promise<void> {
  const exports = Object.entries(hookEnvironment(target)).map(([key, value]) => `export ${key}=${shellQuote(value)}`)
  const lines = ['#!/bin/bash', ...exports, `cd ${shellQuote(target.worktreePath)} || exit 1`, script.endsWith('\n') ? script : `${script}\n`]
  await mkdir(dirname(runner), { recursive: true })
  await writeFile(runner, lines.join('\n'))
  await chmod(runner, 0o755)
}

/** The command line for a session or shell that runs `runner`. */
export const runnerCommand = (runner: string): string => `/bin/bash ${shellQuote(runner)}`

/**
 * Runs an existing runner in the daemon with the hook environment, no stdin and its own process
 * group. After `timeoutMs` the group gets SIGTERM and, `killGraceMs` later, SIGKILL; output past
 * `maxOutputBytes` is discarded. Resolves when the script has exited.
 */
export async function runHookInDaemon(runner: string, target: HookTarget, options: HookRunOptions = {}): Promise<HookRunResult> {
  const limit = options.maxOutputBytes ?? HOOK_OUTPUT_LIMIT
  const proc = Bun.spawn(['/bin/bash', runner], {
    cwd: target.worktreePath,
    env: { ...process.env, ...hookEnvironment(target) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // the typed options omit `detached`; Bun starts the child in its own process group with it
    ...({ detached: true } as object)
  })
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // already gone
      }
    }
  }

  let timedOut = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    killGroup('SIGTERM')
    hardKill = setTimeout(() => killGroup('SIGKILL'), options.killGraceMs ?? HOOK_KILL_GRACE_MS)
  }, options.timeoutMs ?? HOOK_TIMEOUT_MS)

  const chunks: Uint8Array[] = []
  let size = 0
  const readers = [proc.stdout, proc.stderr].map((stream) => (stream as ReadableStream<Uint8Array>).getReader())
  const drains = readers.map(async (reader) => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        const room = limit - size
        if (room > 0) {
          const kept = value.length <= room ? value : value.subarray(0, room)
          chunks.push(kept)
          size += kept.length
        }
      }
    } catch {
      // the reader was cancelled
    }
  })

  await proc.exited
  clearTimeout(timer)
  clearTimeout(hardKill)
  let settled: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all(drains), new Promise((resolve) => (settled = setTimeout(resolve, DRAIN_GRACE_MS)))])
  clearTimeout(settled)
  for (const reader of readers) reader.cancel().catch(() => {})

  return { exitCode: proc.exitCode, output: Buffer.concat(chunks).toString('utf8'), timedOut }
}

/** Writes the runner for `script` and runs it in the daemon; the one call the archive hook needs too. */
export async function runHookScript(runner: string, target: HookTarget, script: string, options: HookRunOptions = {}): Promise<HookRunResult> {
  await writeRunner(runner, target, script)
  return runHookInDaemon(runner, target, options)
}
