import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import { OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE } from '../../shared/fork-heimdall/objective-git-exec-shapes'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from '../../shared/fork-heimdall-objective/contract-types'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import { extractExecError } from '../git/exec-error'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import { runCriterionCheck, type CriterionCheckResult } from './check-runner'
import { findIntegratedObjectiveCommit } from './merge-train-recovery'
import { findReportedIgnoredPaths } from './merge-train-ignored-paths'
import {
  isObjectiveMetadataPath,
  objectiveGitCommandForTarget,
  parseObjectiveDirtyPaths,
  type ObjectiveGitCommand,
  type ObjectiveWorkspaceTarget
} from './content-identity'

const NODE_TASK_TRAILER = 'Quirky-Heimdall-Task'

/**
 * Thrown when a node's ingested report fails a deterministic Git invariant — the dispatch baseline
 * is not an ancestor of HEAD, or the normalized commit's own shape is wrong — that replaying the
 * same ingest cannot pass without new evidence. Callers route this to the failed-node path instead
 * of retrying.
 */
export class ObjectiveNodeIngestRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObjectiveNodeIngestRejectedError'
  }
}

export const OBJECTIVE_MERGE_TRAIN_MAX_PATHS = 256

/** Inputs that identify the clean dispatch baseline and the node owning the normalized commit. */
export type CreateObjectiveNodeCommitInput = {
  baseCommit: string
  taskKey: string
  title: string
  reportedPaths: readonly string[]
}

/** The single commit replacing every commit and worktree change made by one dispatched node. */
export type ObjectiveNodeCommitResult = {
  commitSha: string
}

/** A bounded path report retains the total so callers can tell whether the displayed paths truncate. */
export type ObjectiveMergeTrainPathReport = {
  paths: string[]
  pathCount: number
  pathsTruncated: boolean
}

/** Outcomes of one serial application attempt against the enrolled worktree. */
export type ObjectiveNodeApplyResult =
  | { kind: 'applied'; appliedCommitSha: string }
  | ({ kind: 'paused-dirty' } & ObjectiveMergeTrainPathReport)
  | ({ kind: 'conflict'; allConflictPaths: string[] } & ObjectiveMergeTrainPathReport)

export type ObjectiveNodeRecoveryResult = ObjectiveNodeApplyResult | { kind: 'not-applied' }

/** Every check is retained in command order; a failed result also exposes the first and all failures. */
export type ObjectiveConflictChecksResult =
  | { kind: 'passed'; checks: CriterionCheckResult[] }
  | {
      kind: 'failed'
      checks: CriterionCheckResult[]
      firstFailure: CriterionCheckResult
      failures: CriterionCheckResult[]
    }

function assertObjectId(value: string, label: string): void {
  if (!isObjectiveGitObjectId(value)) {
    throw new ObjectiveNodeIngestRejectedError(`${label} must be a Git object id`)
  }
}

function assertMessageField(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || /[\r\n\0]/u.test(normalized)) {
    throw new ObjectiveNodeIngestRejectedError(`${label} must be a non-empty single line`)
  }
  return normalized
}

function gitExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }
  const code = error.code
  if (typeof code === 'number') {
    return code
  }
  if (typeof code === 'string' && /^\d+$/u.test(code)) {
    return Number(code)
  }
  return null
}

async function readOptionalCommit(
  runGit: ObjectiveGitCommand,
  revision: string
): Promise<string | null> {
  try {
    const sha = (
      await runGit(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
    ).stdout.trim()
    if (!isObjectiveGitObjectId(sha)) {
      throw new Error(`Git returned an invalid object id for ${revision}`)
    }
    return sha
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return null
    }
    throw error
  }
}

async function readRequiredCommit(
  runGit: ObjectiveGitCommand,
  revision: string,
  buildMissingError: (revision: string) => Error = (rev) =>
    new Error(`Git commit ${rev} does not exist`)
): Promise<string> {
  const sha = await readOptionalCommit(runGit, revision)
  if (!sha) {
    throw buildMissingError(revision)
  }
  return sha
}

async function isAncestor(
  runGit: ObjectiveGitCommand,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return false
    }
    throw error
  }
}

function caseInsensitivePaths(target: ObjectiveWorkspaceTarget): boolean {
  return resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
}

async function objectiveDirtyPaths(
  runGit: ObjectiveGitCommand,
  target: ObjectiveWorkspaceTarget
): Promise<string[]> {
  const { stdout } = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--'])
  const insensitive = caseInsensitivePaths(target)
  return [
    ...new Set(
      parseObjectiveDirtyPaths(stdout, insensitive)
        .entries.map((entry) => entry.path)
        .filter((path) => !isObjectiveMetadataPath(path, insensitive))
    )
  ].sort()
}

async function rawUnmergedPaths(runGit: ObjectiveGitCommand): Promise<string[]> {
  const { stdout } = await runGit(['ls-files', '--unmerged', '-z'])
  const records = stdout.split('\0')
  if (records.at(-1) === '') {
    records.pop()
  }
  const paths = records.map((record) => {
    const pathSeparator = record.indexOf('\t')
    if (pathSeparator === -1 || pathSeparator === record.length - 1) {
      throw new Error('Git returned malformed unmerged index output')
    }
    return record.slice(pathSeparator + 1)
  })
  return [...new Set(paths)].sort()
}

function visibleObjectivePaths(
  target: ObjectiveWorkspaceTarget,
  paths: readonly string[]
): string[] {
  const insensitive = caseInsensitivePaths(target)
  return paths.filter((path) => !isObjectiveMetadataPath(path, insensitive)).sort()
}

function boundedPaths(paths: readonly string[]): ObjectiveMergeTrainPathReport {
  return {
    paths: paths.slice(0, OBJECTIVE_MERGE_TRAIN_MAX_PATHS),
    pathCount: paths.length,
    pathsTruncated: paths.length > OBJECTIVE_MERGE_TRAIN_MAX_PATHS
  }
}

async function readCherryPickHead(runGit: ObjectiveGitCommand): Promise<string | null> {
  return readOptionalCommit(runGit, 'CHERRY_PICK_HEAD')
}

// a nonexistent hooksPath is a no-op hook lookup for Git, so this needs no directory to be created;
// resolving it via the repository's own git-dir keeps it correct for worktrees and portable across
// native, WSL and SSH hosts without touching the filesystem directly. the name carries a fresh
// random component so a worker cannot pre-plant a hook at a path it can predict
async function normalizationCommitHooksPath(runGit: ObjectiveGitCommand): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--absolute-git-dir'])
  return `${stdout.trim()}/quirky-objective-empty-hooks-${randomUUID()}`
}

function withoutTaskTrailerLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(`${NODE_TASK_TRAILER}:`))
    .join('\n')
}

function boundedCommitBody(value: string): string {
  return value.length > OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH
    ? value.slice(0, OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH)
    : value
}

/** Carries the dispatched worker's own commit messages into the normalized commit, minus any trailer it already wrote. */
async function readWorkerCommitBodies(
  runGit: ObjectiveGitCommand,
  baseCommit: string,
  headCommit: string
): Promise<string> {
  const { stdout } = await runGit(['log', '--format=%B', `${baseCommit}..${headCommit}`])
  return boundedCommitBody(withoutTaskTrailerLines(stdout).trim())
}

async function assertNoInProgressOperation(runGit: ObjectiveGitCommand): Promise<void> {
  for (const revision of ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
    if (await readOptionalCommit(runGit, revision)) {
      throw new ObjectiveNodeIngestRejectedError(
        `Cannot mutate an objective worktree during ${revision}`
      )
    }
  }
  if ((await rawUnmergedPaths(runGit)).length > 0) {
    throw new ObjectiveNodeIngestRejectedError(
      'Cannot mutate an objective worktree with unresolved Git conflicts'
    )
  }
}

async function assertCleanAfterCherryPickAbort(
  runGit: ObjectiveGitCommand,
  target: ObjectiveWorkspaceTarget
): Promise<void> {
  const [dirty, unmerged, cherryPickHead] = await Promise.all([
    objectiveDirtyPaths(runGit, target),
    rawUnmergedPaths(runGit),
    readCherryPickHead(runGit)
  ])
  if (dirty.length > 0 || unmerged.length > 0 || cherryPickHead) {
    throw new Error('Cherry-pick abort did not restore a clean enrolled worktree')
  }
}

async function abortCherryPick(
  runGit: ObjectiveGitCommand,
  target: ObjectiveWorkspaceTarget,
  lease: LeaseGuard
): Promise<void> {
  await lease.assertHeld()
  await runGit(['cherry-pick', '--abort'])
  await assertCleanAfterCherryPickAbort(runGit, target)
}

/**
 * Replaces the dispatched node's commits and outstanding worktree changes with exactly one commit
 * whose parent is `baseCommit`. Watcher-owned `.quirky` artifacts remain untouched and uncommitted.
 * A successful node with no file changes is represented by one empty commit.
 */
export async function createObjectiveNodeCommit(
  target: ObjectiveWorkspaceTarget,
  input: CreateObjectiveNodeCommitInput,
  lease: LeaseGuard
): Promise<ObjectiveNodeCommitResult> {
  assertObjectId(input.baseCommit, 'baseCommit')
  const taskKey = assertMessageField(input.taskKey, 'taskKey')
  const title = assertMessageField(input.title, 'title')
  const runGit = objectiveGitCommandForTarget(target)
  await assertNoInProgressOperation(runGit)

  const [baseCommit, headCommit] = await Promise.all([
    readRequiredCommit(
      runGit,
      input.baseCommit,
      (revision) => new ObjectiveNodeIngestRejectedError(`Git commit ${revision} does not exist`)
    ),
    readRequiredCommit(runGit, 'HEAD')
  ])
  if (!(await isAncestor(runGit, baseCommit, headCommit))) {
    throw new ObjectiveNodeIngestRejectedError(
      'Objective node HEAD does not descend from its dispatch baseline'
    )
  }
  const workerBodies = await readWorkerCommitBodies(runGit, baseCommit, headCommit)

  await lease.assertHeld()
  await runGit(['reset', '--mixed', baseCommit])
  const [paths, ignoredPaths] = await Promise.all([
    objectiveDirtyPaths(runGit, target),
    findReportedIgnoredPaths({
      runGit,
      reportedPaths: input.reportedPaths,
      caseInsensitivePaths: caseInsensitivePaths(target)
    })
  ])
  for (let index = 0; index < paths.length; index += OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE) {
    await lease.assertHeld()
    await runGit([
      'add',
      '--all',
      '--',
      ...paths
        .slice(index, index + OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE)
        .map((path) => `:(literal)${path}`)
    ])
  }
  for (let index = 0; index < ignoredPaths.length; index += OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE) {
    await lease.assertHeld()
    await runGit([
      'add',
      '--all',
      '--force',
      '--',
      ...ignoredPaths
        .slice(index, index + OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE)
        .map((path) => `:(literal)${path}`)
    ])
  }

  const message = workerBodies
    ? `${title}\n\n${workerBodies}\n\n${NODE_TASK_TRAILER}: ${taskKey}`
    : `${title}\n\n${NODE_TASK_TRAILER}: ${taskKey}`
  const hooksPath = await normalizationCommitHooksPath(runGit)
  await lease.assertHeld()
  await runGit(['-c', `core.hooksPath=${hooksPath}`, 'commit', '--allow-empty', '-m', message])
  const [commitSha, parentSha, remainingDirty] = await Promise.all([
    readRequiredCommit(runGit, 'HEAD'),
    readRequiredCommit(runGit, 'HEAD^'),
    objectiveDirtyPaths(runGit, target)
  ])
  if (parentSha !== baseCommit) {
    throw new ObjectiveNodeIngestRejectedError(
      'Normalized objective node commit has the wrong parent'
    )
  }
  if (remainingDirty.length > 0) {
    throw new ObjectiveNodeIngestRejectedError(
      'Normalized objective node commit left objective changes uncommitted'
    )
  }
  return { commitSha }
}

async function applyCleanObjectiveNodeCommit(
  target: ObjectiveWorkspaceTarget,
  runGit: ObjectiveGitCommand,
  commitSha: string,
  lease: LeaseGuard
): Promise<ObjectiveNodeApplyResult> {
  let cherryPickError: unknown
  try {
    await lease.assertHeld()
    await runGit(['cherry-pick', '--keep-redundant-commits', commitSha])
  } catch (error) {
    cherryPickError = error
  }

  if (cherryPickError) {
    const [cherryPickHead, unmerged] = await Promise.all([
      readCherryPickHead(runGit),
      rawUnmergedPaths(runGit)
    ])
    if (!cherryPickHead && unmerged.length === 0) {
      throw cherryPickError
    }
    const paths = visibleObjectivePaths(target, unmerged)
    await abortCherryPick(runGit, target, lease)
    if (cherryPickHead && cherryPickHead !== commitSha) {
      throw new Error('Cherry-pick failed while applying a different objective node commit')
    }
    return { kind: 'conflict', allConflictPaths: paths, ...boundedPaths(paths) }
  }

  const remainingDirty = await objectiveDirtyPaths(runGit, target)
  if (remainingDirty.length > 0) {
    throw new Error('Successful objective node cherry-pick left the enrolled worktree dirty')
  }
  return { kind: 'applied', appliedCommitSha: await readRequiredCommit(runGit, 'HEAD') }
}

/**
 * Applies one normalized node commit to a clean enrolled worktree. Dirty operator files pause the
 * train. Conflicts are captured before abort, and a conflict result is returned only after Git has
 * proved the abort restored cleanliness.
 */
export async function applyObjectiveNodeCommit(
  enrolledTarget: ObjectiveWorkspaceTarget,
  commitSha: string,
  lease: LeaseGuard
): Promise<ObjectiveNodeApplyResult> {
  assertObjectId(commitSha, 'commitSha')
  const runGit = objectiveGitCommandForTarget(enrolledTarget)
  await readRequiredCommit(runGit, commitSha)
  await assertNoInProgressOperation(runGit)
  const dirty = await objectiveDirtyPaths(runGit, enrolledTarget)
  if (dirty.length > 0) {
    return { kind: 'paused-dirty', ...boundedPaths(dirty) }
  }
  return applyCleanObjectiveNodeCommit(enrolledTarget, runGit, commitSha, lease)
}

/**
 * Reconciles a crash around cherry-pick without applying a completed node twice. Exact ancestry is
 * authoritative; rewritten cherry-picks are searched on the enrolled first-parent history by exact
 * source attribution and patch (or matching empty commits), even behind later clean commits. With
 * retry disabled, absence is reported without starting a fresh cherry-pick. An interrupted
 * operation is aborted and verified clean before retry or conflict reporting.
 */
export async function recoverObjectiveNodeApply(
  enrolledTarget: ObjectiveWorkspaceTarget,
  commitSha: string,
  lease: LeaseGuard,
  options: { retry?: boolean } = {}
): Promise<ObjectiveNodeRecoveryResult> {
  assertObjectId(commitSha, 'commitSha')
  const runGit = objectiveGitCommandForTarget(enrolledTarget)
  await readRequiredCommit(runGit, commitSha)

  const cherryPickHead = await readCherryPickHead(runGit)
  if (cherryPickHead) {
    if (cherryPickHead !== commitSha) {
      throw new Error('Enrolled worktree is applying a different objective node commit')
    }
    const unmerged = await rawUnmergedPaths(runGit)
    const conflictPaths = visibleObjectivePaths(enrolledTarget, unmerged)
    await abortCherryPick(runGit, enrolledTarget, lease)
    if (unmerged.length > 0) {
      if (options.retry === false) {
        return { kind: 'not-applied' }
      }
      return {
        kind: 'conflict',
        allConflictPaths: conflictPaths,
        ...boundedPaths(conflictPaths)
      }
    }
  }
  await assertNoInProgressOperation(runGit)

  const dirty = await objectiveDirtyPaths(runGit, enrolledTarget)
  if (dirty.length > 0) {
    return { kind: 'paused-dirty', ...boundedPaths(dirty) }
  }

  const headSha = await readRequiredCommit(runGit, 'HEAD')
  if (await isAncestor(runGit, commitSha, headSha)) {
    return { kind: 'applied', appliedCommitSha: commitSha }
  }

  const mergeBase = (await runGit(['merge-base', headSha, commitSha])).stdout.trim()
  if (!isObjectiveGitObjectId(mergeBase)) {
    throw new Error('Objective node commit and enrolled HEAD have no valid merge base')
  }
  const integratedCommitSha = await findIntegratedObjectiveCommit({
    runGit,
    sourceCommitSha: commitSha,
    mergeBase,
    headSha
  })
  if (integratedCommitSha) {
    return { kind: 'applied', appliedCommitSha: integratedCommitSha }
  }
  if (options.retry === false) {
    return { kind: 'not-applied' }
  }
  return applyCleanObjectiveNodeCommit(enrolledTarget, runGit, commitSha, lease)
}

function checkFailureFromError(
  command: string,
  error: unknown,
  startedAtMs: number
): CriterionCheckResult {
  const completedAtMs = Date.now()
  const output = extractExecError(error)
  const diagnostic = output.stderr || output.stdout || String(error)
  return {
    command: command.trim(),
    pass: false,
    exitCode: null,
    timedOut: false,
    stdoutTail: output.stdout,
    stderrTail: output.stderr,
    error: diagnostic,
    startedAtMs,
    completedAtMs,
    durationMs: Math.max(0, completedAtMs - startedAtMs)
  }
}

/** Runs every command serially and reports results in input order, even when earlier checks fail. */
export async function runObjectiveConflictChecks(
  target: ObjectiveWorkspaceTarget,
  commands: readonly string[],
  lease: LeaseGuard
): Promise<ObjectiveConflictChecksResult> {
  const checks: CriterionCheckResult[] = []
  for (const command of commands) {
    const startedAtMs = Date.now()
    await lease.assertHeld()
    try {
      checks.push(await runCriterionCheck({ command, target }))
    } catch (error) {
      checks.push(checkFailureFromError(command, error, startedAtMs))
    }
  }
  const failures = checks.filter((check) => !check.pass)
  const firstFailure = failures[0]
  return firstFailure
    ? { kind: 'failed', checks, firstFailure, failures }
    : { kind: 'passed', checks }
}
