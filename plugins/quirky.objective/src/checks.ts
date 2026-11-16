import { Buffer } from 'node:buffer'
import { appendFileSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PluginContext, RunOptions } from '@quirky/protocol'
import type { ObjectivePayload } from './contract'
import { captureFolderObservation, isTaskBaseline } from './folder-workspace'
import type { FolderEntry, FolderObservation, TaskBaseline, WorkspaceKind } from './folder-workspace'
import type { Issued, ObjectiveStore, OverrunRecord } from './store'

export interface ObjectiveRuntime {
  context: PluginContext
  store: ObjectiveStore
  enrollment: { watcherId: string; workspacePath: string; kindPayload: ObjectivePayload }
  captureContentIdentity: () => Promise<string>
  workspaceKind?: WorkspaceKind
}

export interface IndexSuppressionFlags {
  assumeUnchanged: string[]
  skipWorktree: string[]
}

const privateIndexes = new Map<string, { source: string; stamp: string | null }>()
const privateCaptureQueues = new Map<string, Promise<void>>()

async function serializeCapture<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = privateCaptureQueues.get(key) ?? Promise.resolve()
  const { promise: turn, resolve: release } = Promise.withResolvers<void>()
  const current = previous.then(() => turn)
  privateCaptureQueues.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (privateCaptureQueues.get(key) === current) privateCaptureQueues.delete(key)
  }
}

function runFailed(result: Awaited<ReturnType<PluginContext['process']['run']>>): boolean {
  return result.exitCode !== 0 || result.signal !== null || result.stopped !== undefined || result.spawnError !== undefined
}

async function runGit(
  context: PluginContext,
  workspacePath: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = {}
): Promise<string> {
  const result = await context.process.run(['git', ...args], { ...options, cwd: workspacePath })
  if (runFailed(result)) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdoutText
}

export async function readIndexSuppressionFlags(
  context: PluginContext,
  workspacePath: string,
  env?: Record<string, string | undefined>
): Promise<IndexSuppressionFlags> {
  const output = await runGit(
    context,
    workspacePath,
    ['ls-files', '-v', '-z'],
    env === undefined ? {} : { env }
  )
  const assumeUnchanged = new Set<string>()
  const skipWorktree = new Set<string>()
  for (const entry of output.split('\0')) {
    if (entry.length < 3 || entry[1] !== ' ') continue
    const tag = entry[0]
    const path = entry.slice(2)
    if (tag >= 'a' && tag <= 'z') assumeUnchanged.add(path)
    if (tag === 'S' || tag === 's') skipWorktree.add(path)
  }
  return { assumeUnchanged: [...assumeUnchanged], skipWorktree: [...skipWorktree] }
}

async function ensurePrivateExclude(context: PluginContext, workspacePath: string): Promise<void> {
  const raw = (await runGit(context, workspacePath, ['rev-parse', '--git-path', 'info/exclude'])).trim()
  if (!raw) throw new Error('Git did not return a private exclude path')
  const path = isAbsolute(raw) ? raw : resolve(workspacePath, raw)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const contents = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (!contents.split(/\r?\n/).some(line => line.trim() === '/.quirky/objective/')) {
    appendFileSync(path, `${contents && !contents.endsWith('\n') ? '\n' : ''}/.quirky/objective/\n`, { mode: 0o600 })
  }
}

function trackedPathIsPresent(workspacePath: string, path: string): boolean {
  try {
    lstatSync(join(workspacePath, path))
    return true
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error
    const code = error.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function sparseExcludedPaths(
  context: PluginContext,
  workspacePath: string,
  paths: string[],
  env: Record<string, string | undefined>
): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const options = { cwd: workspacePath, env }
  const config = await context.process.run(['git', 'config', '--bool', '--get', 'core.sparseCheckout'], options)
  const missingSetting = config.exitCode === 1
    && config.signal === null
    && config.stopped === undefined
    && config.spawnError === undefined
    && config.stderr.length === 0
  if (missingSetting) return new Set()
  if (runFailed(config)) throw new Error(`git config --bool --get core.sparseCheckout failed: ${config.stderr}`)
  const enabled = config.stdoutText.trim()
  if (enabled === 'false') return new Set()
  if (enabled !== 'true') throw new Error('Git did not return a valid sparse-checkout setting')

  const matches = (await runGit(context, workspacePath, ['sparse-checkout', 'check-rules', '-z'], {
    env,
    input: `${paths.join('\0')}\0`
  })).split('\0')
  const includedPaths = new Set(matches)
  return new Set(paths.filter(path => !includedPaths.has(path)))
}

async function captureTreeOid(
  context: PluginContext,
  workspacePath: string,
  dataDir: string,
  watcherId: string
): Promise<string> {
  const identityDirectory = join(dataDir, 'identity')
  mkdirSync(identityDirectory, { recursive: true, mode: 0o700 })
  const index = join(identityDirectory, `${watcherId}.index`)
  return serializeCapture(index, () => serializeCapture(workspacePath, async () => {
    await ensurePrivateExclude(context, workspacePath)
    let cached = privateIndexes.get(index)
    if (!cached) {
      const raw = (await runGit(context, workspacePath, ['rev-parse', '--git-path', 'index'])).trim()
      if (!raw) throw new Error('Git did not return an index path')
      cached = { source: isAbsolute(raw) ? raw : resolve(workspacePath, raw), stamp: null }
      privateIndexes.set(index, cached)
    }
    const sourceStat = existsSync(cached.source) ? statSync(cached.source, { bigint: true }) : null
    const stamp = sourceStat
      ? `${sourceStat.dev}:${sourceStat.ino}:${sourceStat.size}:${sourceStat.mtimeNs}:${sourceStat.ctimeNs}`
      : 'missing'
    if (stamp !== cached.stamp) {
      if (sourceStat) copyFileSync(cached.source, index, constants.COPYFILE_FICLONE)
      else rmSync(index, { force: true })
      cached.stamp = stamp
    }
    const env = { ...process.env, GIT_INDEX_FILE: index }
    const suppressionFlags = await readIndexSuppressionFlags(context, workspacePath, env)
    const suppressedPaths = new Set([...suppressionFlags.assumeUnchanged, ...suppressionFlags.skipWorktree])
    const presentPaths = new Set([...suppressedPaths].filter(path => trackedPathIsPresent(workspacePath, path)))
    const absentSkipPaths = suppressionFlags.skipWorktree.filter(path => !presentPaths.has(path))
    const sparseExcluded = await sparseExcludedPaths(context, workspacePath, absentSkipPaths, env)
    const assumePathsToClear = suppressionFlags.assumeUnchanged
    const skipPathsToClear = suppressionFlags.skipWorktree.filter(path =>
      presentPaths.has(path) || !sparseExcluded.has(path)
    )
    if (assumePathsToClear.length > 0) {
      await runGit(context, workspacePath, [
        'update-index', '--no-assume-unchanged', '-z', '--stdin'
      ], { env, input: `${assumePathsToClear.join('\0')}\0` })
    }
    if (skipPathsToClear.length > 0) {
      await runGit(context, workspacePath, [
        'update-index', '--no-skip-worktree', '-z', '--stdin'
      ], { env, input: `${skipPathsToClear.join('\0')}\0` })
    }
    await runGit(context, workspacePath, ['add', '--sparse', '-A'], { env })
    const tree = (await runGit(context, workspacePath, ['write-tree'], { env })).trim()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) throw new Error('Git returned an invalid workspace tree OID')
    return tree
  }))
}

export async function captureContentIdentity(
  context: PluginContext,
  workspacePath: string,
  dataDir: string,
  watcherId: string,
  workspaceKind?: WorkspaceKind
): Promise<string> {
  if (workspaceKind === 'folder') {
    return (await captureFolderObservation(workspacePath)).contentIdentity
  }
  return `objective-tree:${await captureTreeOid(context, workspacePath, dataDir, watcherId)}`
}

export async function captureTaskBaseline(runtime: ObjectiveRuntime): Promise<TaskBaseline> {
  if (runtime.workspaceKind === 'folder') {
    return captureFolderObservation(runtime.enrollment.workspacePath)
  }
  const identity = await runtime.captureContentIdentity()
  const treeOid = /^objective-tree:([0-9a-f]{40}|[0-9a-f]{64})$/.exec(identity)?.[1]
  if (!treeOid) throw new Error('Git returned an invalid workspace content identity')
  return { kind: 'git', treeOid }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function inTerritory(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => new Bun.Glob(pattern).match(path))
}

function recordOverrun(
  runtime: ObjectiveRuntime,
  issued: Issued,
  observedPaths: string[],
  outsidePaths: string[],
  unreportedPaths: string[],
  code: string
): void {
  const row: OverrunRecord = {
    attemptId: issued.attemptId,
    watcherId: issued.watcherId,
    revision: issued.revision,
    taskKey: issued.taskKey,
    observedPaths,
    outsidePaths,
    unreportedPaths,
    code,
    recordedAtMs: Date.now()
  }
  runtime.store.recordOverrun(row)
}

function reportPathRelative(workspacePath: string, reportPath: string): string {
  return relative(workspacePath, reportPath).split(sep).join('/')
}

function issuedBaseline(runtime: ObjectiveRuntime, issued: Issued): TaskBaseline | null {
  const workspaceKind = runtime.workspaceKind ?? 'git'
  if (issued.baseline === null) return null

  let baseline: TaskBaseline
  if (issued.baseline === undefined) {
    if (workspaceKind !== 'git' ||
      typeof issued.baselineTree !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(issued.baselineTree)) return null
    baseline = { kind: 'git', treeOid: issued.baselineTree }
  } else {
    if (!isTaskBaseline(issued.baseline)) return null
    baseline = issued.baseline
  }

  if (baseline.kind !== workspaceKind) return null
  if (baseline.kind === 'git') {
    if (issued.baselineTree !== undefined && issued.baselineTree !== null &&
      (typeof issued.baselineTree !== 'string' || issued.baselineTree !== baseline.treeOid)) return null
    if (issued.contentIdentity !== undefined && issued.contentIdentity !== null &&
      issued.contentIdentity !== `objective-tree:${baseline.treeOid}`) return null
  } else {
    if (issued.baselineTree !== undefined && issued.baselineTree !== null) return null
    if (issued.contentIdentity !== undefined && issued.contentIdentity !== null &&
      issued.contentIdentity !== baseline.contentIdentity) return null
  }
  return baseline
}

function folderChangedPaths(before: FolderObservation, after: FolderObservation): string[] {
  const beforeByPath = new Map<string, FolderEntry>(before.entries.map(entry => [entry.path, entry]))
  const afterByPath = new Map<string, FolderEntry>(after.entries.map(entry => [entry.path, entry]))
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()])
  return [...paths].filter(path => {
    const previous = beforeByPath.get(path)
    const current = afterByPath.get(path)
    return previous === undefined || current === undefined ||
      previous.kind !== current.kind ||
      previous.executable !== current.executable ||
      previous.digest !== current.digest
  }).sort(compareUtf8)
}

export async function baselineProblems(
  runtime: ObjectiveRuntime,
  issued: Issued,
  filesModified?: string[],
  afterBaseline?: TaskBaseline
): Promise<string[]> {
  const baseline = issuedBaseline(runtime, issued)
  if (!baseline) {
    recordOverrun(runtime, issued, [], [], [], 'invalid-baseline-tree')
    return ['invalid-baseline-tree']
  }

  let observedPaths: string[]
  try {
    const after = afterBaseline === undefined ? await captureTaskBaseline(runtime) : afterBaseline
    if (!isTaskBaseline(after) || after.kind !== baseline.kind) {
      throw new Error('Workspace content observation did not match its baseline kind')
    }
    if (baseline.kind === 'folder' && after.kind === 'folder') {
      observedPaths = folderChangedPaths(baseline, after)
    } else if (baseline.kind === 'git' && after.kind === 'git') {
      const raw = await runGit(runtime.context, runtime.enrollment.workspacePath, [
        'diff-tree', '--no-commit-id', '-r', '-z', '--name-only', baseline.treeOid, after.treeOid
      ])
      observedPaths = raw.split('\0').filter(path => path.length > 0).sort(compareUtf8)
    } else {
      throw new Error('Workspace content observation did not match its baseline kind')
    }
  } catch {
    recordOverrun(runtime, issued, [], [], [], 'baseline-comparison-failed')
    return ['baseline-comparison-failed']
  }

  let violations = observedPaths
  if (issued.role === 'reviewer') {
    const reportPath = reportPathRelative(runtime.enrollment.workspacePath, issued.reportPath)
    violations = observedPaths.filter(path => path !== reportPath && path !== '.quirky/objective' && !path.startsWith('.quirky/objective/'))
    if (violations.length === 0) return []
    recordOverrun(runtime, issued, violations, violations, [], 'reviewer-modified-workspace')
    return [`reviewer-modified-workspace:${violations[0]}`]
  }
  if (issued.role !== 'implementer' && issued.role !== 'integrator') return []

  const territory = runtime.enrollment.kindPayload.writeTerritory
  const outsidePaths = observedPaths.filter(path => !inTerritory(path, territory)).sort(compareUtf8)
  const unreportedPaths = issued.role === 'implementer'
    ? observedPaths.filter(path => inTerritory(path, territory) && !(filesModified ?? []).includes(path)).sort(compareUtf8)
    : []
  if (outsidePaths.length === 0 && unreportedPaths.length === 0) return []

  const code = outsidePaths.length > 0 ? 'observed-change-outside-write-territory' : 'unreported-observed-change'
  recordOverrun(runtime, issued, observedPaths, outsidePaths, unreportedPaths, code)
  return [
    ...outsidePaths.map(path => `observed-change-outside-write-territory:${path}`),
    ...unreportedPaths.map(path => `unreported-observed-change:${path}`)
  ].sort(compareUtf8)
}

interface CheckAction {
  revision: number
  command: string
  contentIdentity: string
}

async function runCheck(
  runtime: ObjectiveRuntime,
  action: CheckAction & ({ kind: 'criterion'; taskKey: string; criterionIndex: number } | { kind: 'gate'; gateName: string; timeoutSeconds: number }),
  attemptId: string
): Promise<{ effect: 'landed' | 'not-landed'; reason?: string }> {
  const targetKey = action.kind === 'criterion' ? `${action.taskKey}:${action.criterionIndex}` : action.gateName
  const timeoutMs = action.kind === 'criterion' ? 300_000 : action.timeoutSeconds * 1000
  const record = (
    status: 'passed' | 'failed' | 'stale',
    exitCode: number | null,
    timedOut: boolean,
    stdoutTail: string,
    stderrTail: string
  ): void => runtime.store.recordCheck({
    attemptId,
    watcherId: runtime.enrollment.watcherId,
    revision: action.revision,
    kind: action.kind,
    targetKey,
    contentIdentity: action.contentIdentity,
    command: action.command,
    status,
    exitCode,
    timedOut,
    stdoutTail,
    stderrTail,
    checkedAtMs: Date.now()
  })

  const beforeIdentity = await runtime.captureContentIdentity()
  if (beforeIdentity !== action.contentIdentity) {
    record('stale', null, false, '', '')
    return { effect: 'not-landed', reason: 'check-evidence-stale' }
  }

  const result = await runtime.context.process.run(['sh', '-c', action.command], {
    cwd: runtime.enrollment.workspacePath,
    timeoutMs,
    maxOutputBytes: 1_048_576,
    overflow: 'truncate'
  })
  const stdoutTail = result.stdoutText.slice(-4096)
  const stderrTail = result.stderr.slice(-4096)
  const timedOut = result.stopped === 'timeout'
  const exitCode = result.exitCode
  const afterIdentity = await runtime.captureContentIdentity()
  if (afterIdentity !== action.contentIdentity) {
    record('stale', exitCode, timedOut, stdoutTail, stderrTail)
    return { effect: 'not-landed', reason: 'check-evidence-stale' }
  }
  if (exitCode === 0 && !timedOut && result.signal === null && result.spawnError === undefined && result.stopped === undefined) {
    record('passed', exitCode, false, stdoutTail, stderrTail)
    return { effect: 'landed' }
  }
  record('failed', exitCode, timedOut, stdoutTail, stderrTail)
  return { effect: 'not-landed', reason: timedOut ? 'check-timed-out' : 'check-failed' }
}

export function runCriterionCheck(
  runtime: ObjectiveRuntime,
  action: { revision: number; taskKey: string; criterionIndex: number; command: string; contentIdentity: string },
  attemptId: string
): Promise<{ effect: 'landed' | 'not-landed'; reason?: string }> {
  return runCheck(runtime, { ...action, kind: 'criterion' }, attemptId)
}

export function runEnrollmentGate(
  runtime: ObjectiveRuntime,
  action: { revision: number; gateName: string; command: string; timeoutSeconds: number; contentIdentity: string },
  attemptId: string
): Promise<{ effect: 'landed' | 'not-landed'; reason?: string }> {
  return runCheck(runtime, { ...action, kind: 'gate' }, attemptId)
}
