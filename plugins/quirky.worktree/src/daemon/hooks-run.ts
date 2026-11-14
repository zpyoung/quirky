import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { gitApi } from '@quirky/git'
import type { ProcessRunner } from '@quirky/protocol'
import { portEnvironment, type PortBlock } from './ports'

const PORT_ENV_NAMES = ['PORT', 'WORKTREE_PORT', 'WORKTREE_PORT_COUNT', 'CONDUCTOR_PORT']

export const HOOK_TIMEOUT_MS = 2 * 60 * 1000
export const HOOK_KILL_GRACE_MS = 5000
export const HOOK_OUTPUT_LIMIT = 10 * 1024 * 1024

export type HookKind = 'setup' | 'archive' | 'issue'

/** The checkout a hook runs against: the project's primary folder and the workspace it acts on. */
export type HookTarget = { rootPath: string; worktreePath: string; ports?: PortBlock | null }

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
    GHOSTX_ROOT_PATH: target.rootPath,
    ...(target.ports ? { ...portEnvironment(target.ports), CONDUCTOR_PORT: String(target.ports.base) } : {})
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
  const clearPorts = target.ports ? [] : [`unset ${PORT_ENV_NAMES.join(' ')}`]
  const lines = ['#!/bin/bash', ...clearPorts, ...exports, `cd ${shellQuote(target.worktreePath)} || exit 1`, script.endsWith('\n') ? script : `${script}\n`]
  await mkdir(dirname(runner), { recursive: true })
  await writeFile(runner, lines.join('\n'))
  await chmod(runner, 0o755)
}

/** The command line for a session or shell that runs `runner`. */
export const runnerCommand = (runner: string): string => `/bin/bash ${shellQuote(runner)}`

/**
 * Runs an existing runner through the activation-owned process runner with closed stdin and the
 * hook environment. Shared containment stops descendants on timeout and normal exit; output past
 * `maxOutputBytes` is discarded without interrupting the script.
 */
export async function runHookInDaemon(processRunner: ProcessRunner, runner: string, target: HookTarget, options: HookRunOptions = {}): Promise<HookRunResult> {
  const env = { ...process.env, ...hookEnvironment(target) }
  if (!target.ports) {
    for (const name of PORT_ENV_NAMES) delete env[name]
  }
  const result = await processRunner.run(['/bin/bash', runner], {
    cwd: target.worktreePath,
    env,
    timeoutMs: options.timeoutMs ?? HOOK_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? HOOK_KILL_GRACE_MS,
    maxOutputBytes: options.maxOutputBytes ?? HOOK_OUTPUT_LIMIT,
    outputMode: 'combined',
    overflow: 'truncate'
  })
  if (result.spawnError) throw new Error(result.spawnError.message)
  return {
    exitCode: result.stopped || result.signal ? null : result.exitCode,
    output: result.stdoutText,
    timedOut: result.stopped === 'timeout'
  }
}

/** Writes the runner for `script` and runs it in the daemon; the one call the archive hook needs too. */
export async function runHookScript(processRunner: ProcessRunner, runner: string, target: HookTarget, script: string, options: HookRunOptions = {}): Promise<HookRunResult> {
  await writeRunner(runner, target, script)
  return runHookInDaemon(processRunner, runner, target, options)
}
