import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessRunner, RunResult } from '@quirky/protocol'

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const GIT_OPERATION_TIMEOUT_MS = 30_000
const GIT_TERMINATION_GRACE_MS = 2_000

type GitFailureReason = 'exit' | 'timeout' | 'aborted' | 'output-limit' | 'spawn'
type GitOperation = {
  callerSignal?: AbortSignal
  deadline: number
  signal: AbortSignal
  dispose(): void
}
type GitOptions = { env?: NodeJS.ProcessEnv; rerunnable?: boolean; operation: GitOperation }

class GitCommandError extends Error {
  constructor(message: string, readonly reason: GitFailureReason, readonly exitCode: number | null = null) {
    super(message)
    this.name = 'GitCommandError'
  }
}
const LOOP_NOTES = '.quirky/loops'

type GitOutput = { stdout: Uint8Array; stdoutText: string }

function createGitOperation(callerSignal?: AbortSignal, timeoutMs = GIT_OPERATION_TIMEOUT_MS): GitOperation {
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', onAbort, { once: true })
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  if (!controller.signal.aborted && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(onAbort, timeoutMs)
  }
  return {
    ...(callerSignal ? { callerSignal } : {}),
    deadline,
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutTimer)
      callerSignal?.removeEventListener('abort', onAbort)
    }
  }
}

async function runGit(runner: ProcessRunner, cwd: string, args: string[], options: GitOptions): Promise<GitOutput> {
  const { operation } = options
  if (operation.callerSignal?.aborted) throw new GitCommandError('aborted', 'aborted')
  if (operation.signal.aborted) throw new GitCommandError('git command timed out', 'timeout')
  const timeoutMs = operation.deadline - Date.now()
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new GitCommandError('git command timed out', 'timeout')
  const runOptions = {
    cwd,
    timeoutMs,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    killGraceMs: GIT_TERMINATION_GRACE_MS,
    signal: operation.signal,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.rerunnable === true ? { rerunnable: true } : {})
  }
  let result: RunResult
  try {
    result = await runner.run(['git', ...args], runOptions)
  } catch (error) {
    throw new GitCommandError(error instanceof Error ? error.message : String(error), 'spawn')
  }
  if (result.spawnError) throw new GitCommandError(result.spawnError.message, 'spawn')
  if (result.stopped === 'timeout') throw new GitCommandError('git command timed out', 'timeout')
  if (result.stopped === 'aborted') {
    const reason = operation.callerSignal?.aborted ? 'aborted' : 'timeout'
    throw new GitCommandError(reason === 'aborted' ? 'aborted' : 'git command timed out', reason)
  }
  if (result.stopped === 'overflow') throw new GitCommandError('git output exceeded its limit', 'output-limit')
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(-1000)
    throw new GitCommandError(detail || `git ${args[0] ?? ''} exited ${result.exitCode ?? 'unknown'}`, 'exit', result.exitCode)
  }
  return { stdout: result.stdout, stdoutText: result.stdoutText }
}

async function gitRoot(runner: ProcessRunner, cwd: string, operation: GitOperation): Promise<string | null> {
  try {
    const root = (await runGit(runner, cwd, ['rev-parse', '--show-toplevel'], { operation, rerunnable: true })).stdoutText.trim()
    return operation.signal.aborted ? null : root || null
  } catch {
    return null
  }
}

function isLoopNotes(path: string): boolean {
  const normalized = path.replace(/^\.\//, '')
  return normalized === LOOP_NOTES || normalized.startsWith(`${LOOP_NOTES}/`)
}

function emptyTreeEntry(path: string): boolean {
  return path === '' || isLoopNotes(path)
}

const numstatDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

function numstatRecords(output: Uint8Array): { added: number; removed: number; files: string[] } {
  let added = 0
  let removed = 0
  const files: string[] = []
  let start = 0
  while (start < output.length) {
    const end = output.indexOf(0, start)
    if (end < 0) break
    const record = output.subarray(start, end)
    start = end + 1
    const firstTab = record.indexOf(9)
    if (firstTab < 0) continue
    const secondTab = record.indexOf(9, firstTab + 1)
    if (secondTab < 0) continue
    const path = numstatDecoder.decode(record.subarray(secondTab + 1))
    if (emptyTreeEntry(path)) continue
    const addedText = numstatDecoder.decode(record.subarray(0, firstTab))
    const removedText = numstatDecoder.decode(record.subarray(firstTab + 1, secondTab))
    if (/^\d+$/.test(addedText)) added += Number(addedText)
    if (/^\d+$/.test(removedText)) removed += Number(removedText)
    files.push(path)
  }
  return { added, removed, files }
}

/** Builds a worktree tree with a disposable index; never reads or changes the user's index. */
export async function snapshotWorkingTree(
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = GIT_OPERATION_TIMEOUT_MS
): Promise<string | null> {
  const operation = createGitOperation(signal, timeoutMs)
  let directory: string | undefined
  try {
    if (signal?.aborted) return null
    const root = await gitRoot(runner, cwd, operation)
    if (!root || operation.signal.aborted) return null
    directory = mkdtempSync(join(tmpdir(), 'quirky-loop-index-'))
    const indexFile = join(directory, 'index')
    const env = { ...process.env, GIT_INDEX_FILE: indexFile, GIT_OPTIONAL_LOCKS: '0' }
    const privateIndexOptions: GitOptions = { operation, env }
    try {
      await runGit(runner, root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], { operation, rerunnable: true })
      await runGit(runner, root, ['read-tree', 'HEAD'], privateIndexOptions)
    } catch (error) {
      if (operation.signal.aborted || !(error instanceof GitCommandError && error.reason === 'exit')) return null
      let branch: string
      try {
        branch = (await runGit(runner, root, ['symbolic-ref', '--quiet', 'HEAD'], { operation, rerunnable: true })).stdoutText.trim()
      } catch {
        return null
      }
      if (branch === '') return null
      try {
        await runGit(runner, root, ['show-ref', '--verify', '--quiet', branch], { operation, rerunnable: true })
        return null
      } catch (refError) {
        if (!(refError instanceof GitCommandError && refError.reason === 'exit' && refError.exitCode === 1)) return null
      }
      try {
        await runGit(runner, root, ['read-tree', '--empty'], privateIndexOptions)
      } catch {
        return null
      }
    }
    try {
      await runGit(runner, root, ['add', '-A', '--', '.'], privateIndexOptions)
      const tree = (await runGit(runner, root, ['write-tree'], privateIndexOptions)).stdoutText.trim()
      return operation.signal.aborted || !/^[0-9a-f]{40,64}$/i.test(tree) ? null : tree
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    operation.dispose()
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {}
    }
  }
}

/** Compares two private tree objects using NUL-delimited numstat so unusual paths remain intact. */
export async function diffTrees(
  runner: ProcessRunner,
  cwd: string,
  before: string | null,
  after: string | null,
  signal?: AbortSignal
): Promise<{ added: number; removed: number; files: string[] } | null> {
  if (!before || !after || signal?.aborted) return null
  const operation = createGitOperation(signal)
  try {
    const root = await gitRoot(runner, cwd, operation)
    if (!root || operation.signal.aborted) return null
    const output = await runGit(runner, root, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', before, after], { operation })
    return operation.signal.aborted ? null : numstatRecords(output.stdout)
  } catch {
    return null
  } finally {
    operation.dispose()
  }
}

/** Commits only measured iteration-owned paths, leaving unrelated staged paths untouched. */
export async function checkpointChangedPaths(
  runner: ProcessRunner,
  cwd: string,
  loopName: string,
  iteration: number,
  files: string[],
  protectedPathHits: string[],
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted || protectedPathHits.length > 0) return null
  const paths = [...new Set(files.filter((path) => path !== '' && !isLoopNotes(path)))].sort()
  if (paths.length === 0) return null
  const operation = createGitOperation(signal)
  try {
    const root = await gitRoot(runner, cwd, operation)
    if (!root || operation.signal.aborted) return null
    const pathspecs = paths.map((path) => `:(literal)${path}`)
    await runGit(runner, root, ['add', '-A', '--', ...pathspecs], { operation })
    if (operation.signal.aborted) return null
    await runGit(runner, root, ['commit', '--only', '-m', `loop(${loopName}): iteration ${iteration}`, '--', ...pathspecs], { operation })
    if (operation.signal.aborted) return null
    const commit = (await runGit(runner, root, ['rev-parse', 'HEAD'], { operation, rerunnable: true })).stdoutText.trim()
    return operation.signal.aborted || !/^[0-9a-f]{40,64}$/i.test(commit) ? null : commit
  } catch {
    return null
  } finally {
    operation.dispose()
  }
}
