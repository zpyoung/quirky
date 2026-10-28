import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const GIT_OPERATION_TIMEOUT_MS = 30_000
const GIT_TERMINATION_GRACE_MS = 2_000
const GIT_FINAL_WAIT_MS = 1_000

type GitFailureReason = 'exit' | 'timeout' | 'aborted' | 'output-limit' | 'spawn'
type GitOptions = { env?: NodeJS.ProcessEnv; signal?: AbortSignal; deadline?: number }

class GitCommandError extends Error {
  constructor(message: string, readonly reason: GitFailureReason, readonly exitCode: number | null = null) {
    super(message)
    this.name = 'GitCommandError'
  }
}
const LOOP_NOTES = '.quirky/loops'

type GitOutput = { stdout: Buffer; stderr: Buffer }

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    try { child.kill(signal) } catch { /* the child may already have exited */ }
  }
}

function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<GitOutput> {
  const deadline = options.deadline ?? Date.now() + GIT_OPERATION_TIMEOUT_MS
  if (options.signal?.aborted) return Promise.reject(new GitCommandError('aborted', 'aborted'))
  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) return Promise.reject(new GitCommandError('git command timed out', 'timeout'))
  const { promise, resolve, reject } = Promise.withResolvers<GitOutput>()
  let child: ChildProcess
  try {
    child = spawn('git', args, {
      cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return Promise.reject(new GitCommandError(error instanceof Error ? error.message : String(error), 'spawn'))
  }
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let failure: GitCommandError | undefined
  let exitCode: number | null = null
  let childClosed = false
  let terminating = false
  let killGraceComplete = false
  let settled = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let finalTimer: ReturnType<typeof setTimeout> | undefined
  const finish = (error?: GitCommandError, output?: GitOutput) => {
    if (settled) return
    settled = true
    clearTimeout(timeoutTimer)
    clearTimeout(graceTimer)
    clearTimeout(finalTimer)
    options.signal?.removeEventListener('abort', onAbort)
    if (!childClosed) {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    if (error) reject(error)
    else resolve(output!)
  }
  const finishAfterClose = () => {
    if (!childClosed) return
    if (failure) {
      if (!terminating || killGraceComplete) finish(failure)
      return
    }
    if (Date.now() >= deadline) {
      failure = new GitCommandError('git command timed out', 'timeout')
      terminating = true
      signalProcess(child, 'SIGTERM')
      graceTimer = setTimeout(() => {
        signalProcess(child, 'SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        killGraceComplete = true
        finish(failure)
      }, GIT_TERMINATION_GRACE_MS)
      return
    }
    const output = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
    if (exitCode !== 0) {
      const detail = output.stderr.toString('utf8').trim().slice(-1000)
      return finish(new GitCommandError(detail || `git ${args[0] ?? ''} exited ${exitCode ?? 'unknown'}`, 'exit', exitCode))
    }
    finish(undefined, output)
  }
  const requestTermination = (error: GitCommandError) => {
    if (settled) return
    failure ??= error
    if (terminating || childClosed) return
    terminating = true
    signalProcess(child, 'SIGTERM')
    graceTimer = setTimeout(() => {
      signalProcess(child, 'SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      killGraceComplete = true
      finishAfterClose()
      if (!settled) finalTimer = setTimeout(() => finish(failure ?? new GitCommandError('git process did not close', 'timeout')), GIT_FINAL_WAIT_MS)
    }, GIT_TERMINATION_GRACE_MS)
  }
  const onAbort = () => requestTermination(new GitCommandError('aborted', 'aborted'))
  const collect = (target: Buffer[], chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
    if (terminating) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const total = stream === 'stdout' ? stdoutBytes + bytes.length : stderrBytes + bytes.length
    if (total > MAX_GIT_OUTPUT_BYTES) {
      requestTermination(new GitCommandError(`git ${stream} exceeded its output limit`, 'output-limit'))
      return
    }
    target.push(bytes)
    if (stream === 'stdout') stdoutBytes = total
    else stderrBytes = total
  }
  child.stdout?.on('data', (chunk: Buffer | string) => collect(stdout, chunk, 'stdout'))
  child.stderr?.on('data', (chunk: Buffer | string) => collect(stderr, chunk, 'stderr'))
  child.stdout?.on('error', (error) => requestTermination(new GitCommandError(error.message, 'spawn')))
  child.stderr?.on('error', (error) => requestTermination(new GitCommandError(error.message, 'spawn')))
  child.once('error', (error) => {
    const spawnError = new GitCommandError(error.message, 'spawn')
    if (child.pid === undefined) finish(spawnError)
    else requestTermination(spawnError)
  })
  child.once('close', (code) => {
    childClosed = true
    exitCode = code
    if (!failure && code !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-1000)
      failure = new GitCommandError(detail || `git ${args[0] ?? ''} exited ${code ?? 'unknown'}`, 'exit', code)
    }
    finishAfterClose()
  })
  options.signal?.addEventListener('abort', onAbort, { once: true })
  timeoutTimer = setTimeout(() => requestTermination(new GitCommandError('git command timed out', 'timeout')), timeoutMs)
  if (options.signal?.aborted) onAbort()
  return promise
}

async function gitRoot(cwd: string, options: GitOptions = {}): Promise<string | null> {
  try {
    const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'], options)).stdout.toString('utf8').trim()
    return options.signal?.aborted ? null : root || null
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

function numstatRecords(output: Buffer): { added: number; removed: number; files: string[] } {
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
    const path = record.subarray(secondTab + 1).toString('utf8')
    if (emptyTreeEntry(path)) continue
    const addedText = record.subarray(0, firstTab).toString('ascii')
    const removedText = record.subarray(firstTab + 1, secondTab).toString('ascii')
    if (/^\d+$/.test(addedText)) added += Number(addedText)
    if (/^\d+$/.test(removedText)) removed += Number(removedText)
    files.push(path)
  }
  return { added, removed, files }
}

/** Builds a worktree tree with a disposable index; never reads or changes the user's index. */
export async function snapshotWorkingTree(cwd: string, signal?: AbortSignal, timeoutMs = GIT_OPERATION_TIMEOUT_MS): Promise<string | null> {
  if (signal?.aborted) return null
  const deadline = Date.now() + Math.max(1, timeoutMs)
  const options: GitOptions = { deadline, ...(signal ? { signal } : {}) }
  const root = await gitRoot(cwd, options)
  if (!root || signal?.aborted) return null
  let directory: string
  try {
    directory = mkdtempSync(join(tmpdir(), 'quirky-loop-index-'))
  } catch {
    return null
  }
  const indexFile = join(directory, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: indexFile, GIT_OPTIONAL_LOCKS: '0' }
  const gitOptions: GitOptions = { env, ...options }
  try {
    try {
      await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], options)
      await runGit(root, ['read-tree', 'HEAD'], gitOptions)
    } catch (error) {
      if (signal?.aborted || (error instanceof GitCommandError && error.reason !== 'exit')) return null
      let branch: string
      try {
        branch = (await runGit(root, ['symbolic-ref', '--quiet', 'HEAD'], options)).stdout.toString('utf8').trim()
      } catch {
        return null
      }
      if (branch === '') return null
      try {
        await runGit(root, ['show-ref', '--verify', '--quiet', branch], options)
        return null
      } catch (refError) {
        if (!(refError instanceof GitCommandError && refError.reason === 'exit' && refError.exitCode === 1)) return null
      }
      try {
        await runGit(root, ['read-tree', '--empty'], gitOptions)
      } catch {
        return null
      }
    }
    try {
      await runGit(root, ['add', '-A', '--', '.'], gitOptions)
      const tree = (await runGit(root, ['write-tree'], gitOptions)).stdout.toString('utf8').trim()
      return signal?.aborted || !/^[0-9a-f]{40,64}$/i.test(tree) ? null : tree
    } catch {
      return null
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Compares two private tree objects using NUL-delimited numstat so unusual paths remain intact. */
export async function diffTrees(
  cwd: string,
  before: string | null,
  after: string | null,
  signal?: AbortSignal
): Promise<{ added: number; removed: number; files: string[] } | null> {
  if (!before || !after || signal?.aborted) return null
  const deadline = Date.now() + GIT_OPERATION_TIMEOUT_MS
  const options: GitOptions = { deadline, ...(signal ? { signal } : {}) }
  const root = await gitRoot(cwd, options)
  if (!root || signal?.aborted) return null
  try {
    const output = await runGit(root, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', before, after], options)
    return signal?.aborted ? null : numstatRecords(output.stdout)
  } catch {
    return null
  }
}

/** Commits only measured iteration-owned paths, leaving unrelated staged paths untouched. */
export async function checkpointChangedPaths(
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
  const deadline = Date.now() + GIT_OPERATION_TIMEOUT_MS
  const gitOptions: GitOptions = { deadline, ...(signal ? { signal } : {}) }
  const root = await gitRoot(cwd, gitOptions)
  if (!root || signal?.aborted) return null
  const pathspecs = paths.map((path) => `:(literal)${path}`)
  try {
    await runGit(root, ['add', '-A', '--', ...pathspecs], gitOptions)
    if (signal?.aborted) return null
    await runGit(root, ['commit', '--only', '-m', `loop(${loopName}): iteration ${iteration}`, '--', ...pathspecs], gitOptions)
    if (signal?.aborted) return null
    const commit = (await runGit(root, ['rev-parse', 'HEAD'], gitOptions)).stdout.toString('utf8').trim()
    return signal?.aborted || !/^[0-9a-f]{40,64}$/i.test(commit) ? null : commit
  } catch {
    return null
  }
}
