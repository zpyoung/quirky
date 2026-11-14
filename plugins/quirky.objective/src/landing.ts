import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import type { PluginContext, RunOptions } from '@quirky/protocol'
import type { CheckRecord, LandingRecord, VerdictRecord } from './store'
import { readIndexSuppressionFlags, type ObjectiveRuntime } from './checks'
import { currentChecks, currentVerdicts, latestAttempts } from './decide'
import type { ObjectiveJournalEntry, ObjectiveProgress } from './decide'

interface GitResult {
  stdoutText: string
  stderr: string
  exitCode: number | null
  signal: string | null
  stopped?: string
  spawnError?: unknown
}

function failed(result: GitResult): boolean {
  return result.exitCode !== 0 || result.signal !== null || result.stopped !== undefined || result.spawnError !== undefined
}

async function git(
  context: PluginContext,
  workspacePath: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = {}
): Promise<GitResult> {
  return context.process.run(['git', ...args], { ...options, cwd: workspacePath })
}

export async function readLocalGitHead(
  context: PluginContext,
  workspacePath: string
): Promise<{ branch: string | null; headSha: string | null }> {
  const branchResult = await git(context, workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  let branch: string | null
  if (!failed(branchResult)) {
    branch = branchResult.stdoutText.trim() || null
  } else if (branchResult.exitCode === 1 && branchResult.signal === null && branchResult.stopped === undefined && branchResult.spawnError === undefined) {
    branch = null
  } else {
    throw new Error(`git symbolic-ref failed: ${branchResult.stderr}`)
  }

  const headResult = await git(context, workspacePath, ['rev-parse', '--verify', 'HEAD'])
  if (failed(headResult)) {
    if (headResult.exitCode !== 0 && headResult.signal === null && headResult.stopped === undefined && headResult.spawnError === undefined) {
      return { branch, headSha: null }
    }
    throw new Error(`git rev-parse failed: ${headResult.stderr}`)
  }
  return { branch, headSha: headResult.stdoutText.trim() || null }
}

function inTerritory(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => new Bun.Glob(pattern).match(path))
}

function isPrivateObjectivePath(path: string): boolean {
  return path === '.quirky/objective' || path.startsWith('.quirky/objective/')
}



interface LandingEvidence {
  checks: CheckRecord[]
  verdicts: VerdictRecord[]
}

function requiredLandingEvidence(
  runtime: ObjectiveRuntime,
  revisionNumber: number,
  contentIdentity: string,
  journal: ObjectiveJournalEntry[]
): LandingEvidence | null {
  const watcherId = runtime.enrollment.watcherId
  const revision = runtime.store.revision(watcherId)
  if (!revision || revision.number !== revisionNumber) return null

  const evidenceWorld = {
    checks: runtime.store.checks(watcherId),
    verdicts: runtime.store.verdicts(watcherId),
    issued: runtime.store.issued(watcherId),
    repairs: runtime.store.repairs(watcherId)
  }
  const attempts = latestAttempts(journal)
  const requiredChecks: CheckRecord[] = []
  for (const task of revision.plan.plan.tasks) {
    for (let criterionIndex = 0; criterionIndex < task.criteria.length; criterionIndex++) {
      const criterion = task.criteria[criterionIndex]!
      if (!criterion.shellCheckable) continue
      if (!criterion.checkCommand) return null
      const row = currentChecks(
        evidenceWorld, attempts, revisionNumber, 'criterion', `${task.taskKey}:${criterionIndex}`,
        criterion.checkCommand, contentIdentity
      ).find(check => check.status === 'passed')
      if (!row) return null
      requiredChecks.push(row)
    }
  }
  for (const gate of runtime.enrollment.kindPayload.gates) {
    const row = currentChecks(
      evidenceWorld, attempts, revisionNumber, 'gate', gate.name, gate.command, contentIdentity
    ).find(check => check.status === 'passed')
    if (!row) return null
    requiredChecks.push(row)
  }

  const reviewerVerdicts = currentVerdicts(evidenceWorld, attempts, revisionNumber, 'reviewer', contentIdentity)
  const integratorVerdicts = currentVerdicts(evidenceWorld, attempts, revisionNumber, 'integrator', contentIdentity)
  if (reviewerVerdicts.some(row => row.verdict === 'block') ||
    integratorVerdicts.some(row => row.verdict === 'block')) return null
  const needsRoles: VerdictRecord['role'][] = runtime.enrollment.kindPayload.tier === 'full'
    ? ['reviewer', 'integrator']
    : runtime.enrollment.kindPayload.tier === 'standard' ? ['reviewer'] : []
  const approvals: VerdictRecord[] = []
  for (const role of needsRoles) {
    const verdict = (role === 'reviewer' ? reviewerVerdicts : integratorVerdicts)
      .find(row => row.verdict === 'approve')
    if (!verdict) return null
    approvals.push(verdict)
  }
  return { checks: requiredChecks, verdicts: approvals }
}

function landingResult(effect: 'landed' | 'not-landed', reason?: string): { effect: 'landed' | 'not-landed'; reason?: string } {
  return reason === undefined ? { effect } : { effect, reason }
}

export async function recordFilesOnDisk(
  runtime: ObjectiveRuntime,
  action: { revision: number; contentIdentity: string },
  attemptId: string,
  journal: ObjectiveJournalEntry[],
  tasks?: ObjectiveProgress['tasks']
): Promise<{ effect: 'landed' | 'not-landed'; reason?: string }> {
  let beforeIdentity: string
  try {
    beforeIdentity = await runtime.captureContentIdentity()
  } catch {
    return landingResult('not-landed', 'landing-evidence-unavailable')
  }
  if (beforeIdentity !== action.contentIdentity) return landingResult('not-landed', 'landing-evidence-stale')

  const evidence = requiredLandingEvidence(runtime, action.revision, action.contentIdentity, journal)
  if (!evidence) return landingResult('not-landed', 'landing-evidence-incomplete')

  let afterIdentity: string
  try {
    afterIdentity = await runtime.captureContentIdentity()
  } catch {
    return landingResult('not-landed', 'landing-evidence-unavailable')
  }
  if (afterIdentity !== action.contentIdentity) return landingResult('not-landed', 'landing-evidence-stale')

  const existing = runtime.store.landings(runtime.enrollment.watcherId).find(row =>
    row.rung === 'files-on-disk' && row.contentIdentity === action.contentIdentity)
  if (existing) return { effect: 'landed' }

  const landing: LandingRecord = {
    watcherId: runtime.enrollment.watcherId,
    rung: 'files-on-disk',
    contentIdentity: action.contentIdentity,
    attemptId,
    payload: {
      revision: action.revision,
      checkAttempts: evidence.checks.map(row => row.attemptId),
      verdictAttempts: evidence.verdicts.map(row => row.attemptId),
      ...(tasks ? { tasks } : {})
    },
    recordedAtMs: Date.now()
  }
  runtime.store.recordLanding(landing)
  return { effect: 'landed' }
}

function parseStatusPaths(raw: string): string[] {
  const fields = raw.split('\0')
  const paths = new Set<string>()
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (!field) continue
    if (field.length < 4) throw new Error('Git returned malformed porcelain status')
    const status = field.slice(0, 2)
    const path = field.slice(3)
    if (!isPrivateObjectivePath(path)) paths.add(path)
    if (status.includes('R') || status.includes('C')) {
      const previousPath = fields[++index]
      if (previousPath === undefined) throw new Error('Git returned malformed rename status')
      if (previousPath && !isPrivateObjectivePath(previousPath)) paths.add(previousPath)
    }
  }
  return [...paths].sort()
}


async function treeDiffPaths(
  context: PluginContext,
  workspacePath: string,
  leftTree: string,
  rightTree: string
): Promise<string[]> {
  const result = await git(context, workspacePath, [
    'diff-tree', '--no-commit-id', '-r', '--no-renames', '-z', '--name-only', leftTree, rightTree
  ])
  if (failed(result)) throw new Error(`git diff-tree failed: ${result.stderr}`)
  return result.stdoutText.split('\0').filter(Boolean)
}

async function statusPaths(context: PluginContext, workspacePath: string): Promise<string[]> {
  const result = await git(context, workspacePath, ['status', '--porcelain=v1', '-z', '-uall'])
  if (failed(result)) throw new Error(`git status failed: ${result.stderr}`)
  return parseStatusPaths(result.stdoutText)
}

async function attemptTrailer(
  context: PluginContext,
  workspacePath: string,
  headSha: string,
  attemptId: string
): Promise<boolean | null> {
  try {
    const result = await git(context, workspacePath, ['show', '-s', '--format=%B', headSha])
    if (failed(result)) return null
    return result.stdoutText.split(/\r?\n/).includes(`Quirky-Objective-Attempt: ${attemptId}`)
  } catch {
    return null
  }
}

async function territoryMatchesHead(
  context: PluginContext,
  workspacePath: string,
  headSha: string,
  reviewedTree: string,
  territory: string[]
): Promise<boolean | null> {
  try {
    const differences = await treeDiffPaths(context, workspacePath, headSha, reviewedTree)
    return !differences.some(path => inTerritory(path, territory))
  } catch {
    return null
  }
}

async function updateIndexPaths(
  context: PluginContext,
  workspacePath: string,
  flag: string,
  paths: string[]
): Promise<boolean> {
  if (!paths.length) return true
  try {
    const result = await git(context, workspacePath, ['update-index', '-z', flag, '--stdin'], {
      input: Buffer.from(`${paths.join('\0')}\0`)
    })
    return !failed(result)
  } catch {
    return false
  }
}

async function restoreIndexSuppressionFlags(
  context: PluginContext,
  workspacePath: string,
  flags: { assumeUnchanged: string[]; skipWorktree: string[] }
): Promise<boolean> {
  try {
    const trackedResult = await git(context, workspacePath, ['ls-files', '-z'])
    if (failed(trackedResult)) return false
    const trackedPaths = new Set(trackedResult.stdoutText.split('\0').filter(Boolean))
    const assumeUnchanged = flags.assumeUnchanged.filter(path => trackedPaths.has(path))
    const skipWorktree = flags.skipWorktree.filter(path => trackedPaths.has(path))
    if (!await updateIndexPaths(context, workspacePath, '--assume-unchanged', assumeUnchanged)) return false
    return updateIndexPaths(context, workspacePath, '--skip-worktree', skipWorktree)
  } catch {
    return false
  }
}

function workspacePathExists(workspacePath: string, path: string): boolean {
  try {
    lstatSync(join(workspacePath, path))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

type LandingOutcome = { effect: 'landed' | 'not-landed' | 'indeterminate'; reason?: string }

type CommitAttempt =
  | { kind: 'failed'; result: LandingOutcome }
  | {
    kind: 'completed'
    commitResult: GitResult
    committedHead: { branch: string | null; headSha: string | null }
    trailer: boolean | null
  }

async function commitReviewedPaths(
  runtime: ObjectiveRuntime,
  action: { revision: number; contentIdentity: string; branch: string; headSha: string },
  attemptId: string,
  insideTerritory: string[],
  reviewedTree: string
): Promise<CommitAttempt> {
  const workspacePath = runtime.enrollment.workspacePath
  const beforeStageIdentity = await currentContentIdentity(runtime)
  if (beforeStageIdentity === null) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'landing-evidence-unavailable' } }
  }
  if (beforeStageIdentity !== action.contentIdentity) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'landing-evidence-stale' } }
  }
  let head: { branch: string | null; headSha: string | null }
  try {
    head = await readLocalGitHead(runtime.context, workspacePath)
  } catch {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'git-head-unavailable' } }
  }
  if (head.branch !== action.branch || head.headSha !== action.headSha) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'head-moved' } }
  }

  const pathspecs = Buffer.from(`${insideTerritory.join('\0')}\0`)
  const literalEnv = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
  let addResult: GitResult
  try {
    addResult = await git(runtime.context, workspacePath,
      ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: literalEnv, input: pathspecs })
  } catch {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-stage-failed' } }
  }
  if (failed(addResult)) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-stage-failed' } }
  }

  const afterStageIdentity = await currentContentIdentity(runtime)
  if (afterStageIdentity === null) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'landing-evidence-unavailable' } }
  }
  if (afterStageIdentity !== action.contentIdentity) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'landing-evidence-stale' } }
  }
  try {
    head = await readLocalGitHead(runtime.context, workspacePath)
  } catch {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'git-head-unavailable' } }
  }
  if (head.branch !== action.branch || head.headSha !== action.headSha) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'head-moved' } }
  }

  let indexTree: string
  try {
    const indexTreeResult = await git(runtime.context, workspacePath, ['write-tree'])
    if (failed(indexTreeResult)) {
      return { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-index-unavailable' } }
    }
    indexTree = indexTreeResult.stdoutText.trim()
  } catch {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-index-unavailable' } }
  }
  let indexDifferences: string[]
  try {
    indexDifferences = await treeDiffPaths(runtime.context, workspacePath, indexTree, reviewedTree)
  } catch {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-index-unavailable' } }
  }
  if (indexDifferences.some(path => inTerritory(path, runtime.enrollment.kindPayload.writeTerritory))) {
    return { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-index-mismatch' } }
  }

  const objectiveFirstLine = runtime.enrollment.kindPayload.objectiveText.split(/\r?\n/, 1)[0] ?? ''
  const message = `${objectiveFirstLine}\n\nQuirky-Objective-Attempt: ${attemptId}`
  let commitResult: GitResult
  try {
    commitResult = await git(runtime.context, workspacePath, [
      'commit', '--pathspec-from-file=-', '--pathspec-file-nul', '-m', message
    ], { env: literalEnv, input: pathspecs })
  } catch (error) {
    commitResult = { stdoutText: '', stderr: String(error), exitCode: null, signal: null, spawnError: error }
  }

  let committedHead: { branch: string | null; headSha: string | null }
  try {
    committedHead = await readLocalGitHead(runtime.context, workspacePath)
  } catch {
    return { kind: 'failed', result: { effect: 'indeterminate', reason: 'commit-state-indeterminate' } }
  }
  const trailer = committedHead.headSha
    ? await attemptTrailer(runtime.context, workspacePath, committedHead.headSha, attemptId)
    : null
  return { kind: 'completed', commitResult, committedHead, trailer }
}

export async function commitLocalBranch(
  runtime: ObjectiveRuntime,
  action: { revision: number; contentIdentity: string; branch: string; headSha: string },
  attemptId: string
): Promise<LandingOutcome> {
  const beforeIdentity = await currentContentIdentity(runtime)
  if (beforeIdentity === null) return { effect: 'not-landed', reason: 'landing-evidence-unavailable' }
  if (beforeIdentity !== action.contentIdentity) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  const filesLanding = runtime.store.landings(runtime.enrollment.watcherId).find(row =>
    row.rung === 'files-on-disk' && row.contentIdentity === action.contentIdentity)
  if (!filesLanding) return { effect: 'not-landed', reason: 'files-on-disk-not-recorded' }

  const treeMatch = /^objective-tree:([0-9a-f]{40}|[0-9a-f]{64})$/i.exec(action.contentIdentity)
  if (!treeMatch) return { effect: 'not-landed', reason: 'landing-evidence-unavailable' }
  const reviewedTree = treeMatch[1]!
  let currentHead: { branch: string | null; headSha: string | null }
  try {
    currentHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
  } catch {
    return { effect: 'not-landed', reason: 'git-head-unavailable' }
  }
  if (currentHead.branch === null) return { effect: 'not-landed', reason: 'branch-not-attached' }
  if (currentHead.branch !== action.branch) return { effect: 'not-landed', reason: 'head-moved' }
  if (!currentHead.headSha) return { effect: 'not-landed', reason: 'head-moved' }

  let reviewedPaths: string[]
  let status: string[]
  try {
    reviewedPaths = await treeDiffPaths(
      runtime.context, runtime.enrollment.workspacePath, currentHead.headSha, reviewedTree
    )
    status = await statusPaths(runtime.context, runtime.enrollment.workspacePath)
  } catch {
    return { effect: 'not-landed', reason: 'git-status-failed' }
  }
  const relevantPaths = reviewedPaths.filter(path => !isPrivateObjectivePath(path))
  const insideTerritory = relevantPaths
    .filter(path => inTerritory(path, runtime.enrollment.kindPayload.writeTerritory))
    .sort()
  const outsideTerritoryPaths = [...new Set([
    ...relevantPaths.filter(path => !inTerritory(path, runtime.enrollment.kindPayload.writeTerritory)),
    ...status.filter(path => !inTerritory(path, runtime.enrollment.kindPayload.writeTerritory))
  ])].sort()

  if (insideTerritory.length === 0) {
    if (currentHead.headSha !== action.headSha) {
      const recovered = await attemptTrailer(
        runtime.context, runtime.enrollment.workspacePath, currentHead.headSha, attemptId
      )
      if (recovered === null) return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
      if (!recovered) return { effect: 'not-landed', reason: 'head-moved' }
    }
    const noOpIdentity = await currentContentIdentity(runtime)
    if (noOpIdentity === null) return { effect: 'not-landed', reason: 'landing-evidence-unavailable' }
    if (noOpIdentity !== action.contentIdentity) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
    let finalHead: { branch: string | null; headSha: string | null }
    try {
      finalHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
    } catch {
      return { effect: 'not-landed', reason: 'git-head-unavailable' }
    }
    if (finalHead.branch !== action.branch || finalHead.headSha !== currentHead.headSha) {
      return { effect: 'not-landed', reason: 'head-moved' }
    }
    if (!finalHead.headSha) return { effect: 'not-landed', reason: 'head-moved' }
    const matchesReviewedContent = await territoryMatchesHead(
      runtime.context, runtime.enrollment.workspacePath, finalHead.headSha, reviewedTree,
      runtime.enrollment.kindPayload.writeTerritory
    )
    if (matchesReviewedContent !== true) {
      return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
    }
    saveCommittedLanding(runtime, action, attemptId, finalHead.headSha, [], outsideTerritoryPaths)
    return { effect: 'landed' }
  }

  if (currentHead.headSha !== action.headSha) return { effect: 'not-landed', reason: 'head-moved' }

  let flags: { assumeUnchanged: string[]; skipWorktree: string[] }
  try {
    const currentFlags = await readIndexSuppressionFlags(runtime.context, runtime.enrollment.workspacePath)
    const insidePaths = new Set(insideTerritory)
    flags = {
      assumeUnchanged: currentFlags.assumeUnchanged.filter(path => insidePaths.has(path)),
      skipWorktree: currentFlags.skipWorktree.filter(path => insidePaths.has(path))
    }
  } catch {
    return { effect: 'not-landed', reason: 'index-flags-unavailable' }
  }
  try {
    if (flags.skipWorktree.some(path => !workspacePathExists(runtime.enrollment.workspacePath, path))) {
      return { effect: 'not-landed', reason: 'sparse-path-unavailable' }
    }
  } catch {
    return { effect: 'not-landed', reason: 'workspace-path-unavailable' }
  }

  let normalizationAttempted = false
  let attempt: CommitAttempt | null = null
  try {
    if (flags.assumeUnchanged.length || flags.skipWorktree.length) {
      normalizationAttempted = true
      if (flags.assumeUnchanged.length && !await updateIndexPaths(
        runtime.context, runtime.enrollment.workspacePath, '--no-assume-unchanged', flags.assumeUnchanged
      )) {
        attempt = { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-index-normalization-failed' } }
      }
      if (!attempt && flags.skipWorktree.length && !await updateIndexPaths(
        runtime.context, runtime.enrollment.workspacePath, '--no-skip-worktree', flags.skipWorktree
      )) {
        attempt = { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-index-normalization-failed' } }
      }
    }
    if (!attempt) {
      attempt = await commitReviewedPaths(runtime, action, attemptId, insideTerritory, reviewedTree)
    }
  } catch {
    attempt = { kind: 'failed', result: { effect: 'not-landed', reason: 'commit-index-normalization-failed' } }
  }
  if (normalizationAttempted && !await restoreIndexSuppressionFlags(
    runtime.context, runtime.enrollment.workspacePath, flags
  )) {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  if (!attempt) return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  if (attempt.kind === 'failed') return attempt.result

  const committedHead = attempt.committedHead
  const moved = committedHead.headSha !== action.headSha
  const afterIdentity = await currentContentIdentity(runtime)
  if (!moved) {
    if (afterIdentity === null) return { effect: 'not-landed', reason: 'landing-evidence-unavailable' }
    if (afterIdentity !== action.contentIdentity) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
    if (failed(attempt.commitResult)) {
      return attempt.commitResult.exitCode !== null && attempt.commitResult.exitCode !== 0
        ? { effect: 'not-landed', reason: 'commit-hook-failed' }
        : { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
    }
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  if (attempt.trailer === null || !attempt.trailer) {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  if (committedHead.branch !== action.branch || afterIdentity === null || afterIdentity !== action.contentIdentity) {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  if (!committedHead.headSha) return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  let finalHead: { branch: string | null; headSha: string | null }
  try {
    finalHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
  } catch {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  if (finalHead.branch !== action.branch || finalHead.headSha !== committedHead.headSha) {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  const matchesReviewedContent = await territoryMatchesHead(
    runtime.context, runtime.enrollment.workspacePath, committedHead.headSha, reviewedTree,
    runtime.enrollment.kindPayload.writeTerritory
  )
  if (matchesReviewedContent !== true) {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }

  saveCommittedLanding(runtime, action, attemptId, committedHead.headSha, insideTerritory, outsideTerritoryPaths)
  return { effect: 'landed' }
}

function saveCommittedLanding(
  runtime: ObjectiveRuntime,
  action: { revision: number; contentIdentity: string },
  attemptId: string,
  headSha: string,
  committedPaths: string[],
  outsideTerritoryPaths: string[]
): void {
  const landing: LandingRecord = {
    watcherId: runtime.enrollment.watcherId,
    rung: 'committed-local-branch',
    contentIdentity: action.contentIdentity,
    attemptId,
    payload: { revision: action.revision, headSha, committedPaths, outsideTerritoryPaths },
    recordedAtMs: Date.now()
  }
  runtime.store.recordLanding(landing)
}

async function currentContentIdentity(runtime: ObjectiveRuntime): Promise<string | null> {
  try {
    return await runtime.captureContentIdentity()
  } catch {
    return null
  }
}

