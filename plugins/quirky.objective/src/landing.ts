import { Buffer } from 'node:buffer'
import type { PluginContext, RunOptions } from '@quirky/protocol'
import type { CheckRecord, Issued, LandingRecord, VerdictRecord } from './store'
import type { ObjectiveRuntime } from './checks'
import type { ObjectiveProgress } from './decide'

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

function passedCheck(
  checks: CheckRecord[],
  revision: number,
  contentIdentity: string,
  kind: CheckRecord['kind'],
  targetKey: string
): CheckRecord | undefined {
  return checks.find(row => row.revision === revision && row.kind === kind && row.targetKey === targetKey &&
    row.contentIdentity === contentIdentity && row.status === 'passed')
}

function approvalFor(
  verdicts: VerdictRecord[],
  issued: Issued[],
  role: VerdictRecord['role'],
  revision: number,
  contentIdentity: string
): VerdictRecord | undefined {
  return verdicts.find(row => row.revision === revision && row.role === role && row.verdict === 'approve' &&
    row.contentIdentity === contentIdentity && issued.some(issue => issue.attemptId === row.attemptId &&
      issue.role === role && issue.revision === revision && issue.contentIdentity === contentIdentity))
}

interface LandingEvidence {
  checks: CheckRecord[]
  verdicts: VerdictRecord[]
}

function requiredLandingEvidence(runtime: ObjectiveRuntime, revisionNumber: number, contentIdentity: string): LandingEvidence | null {
  const watcherId = runtime.enrollment.watcherId
  const revision = runtime.store.revision(watcherId)
  if (!revision || revision.number !== revisionNumber) return null

  const checks = runtime.store.checks(watcherId)
  const requiredChecks: CheckRecord[] = []
  for (const task of revision.plan.plan.tasks) {
    for (let criterionIndex = 0; criterionIndex < task.criteria.length; criterionIndex++) {
      const criterion = task.criteria[criterionIndex]!
      if (!criterion.shellCheckable) continue
      const row = passedCheck(checks, revisionNumber, contentIdentity, 'criterion', `${task.taskKey}:${criterionIndex}`)
      if (!row) return null
      requiredChecks.push(row)
    }
  }
  for (const gate of runtime.enrollment.kindPayload.gates) {
    const row = passedCheck(checks, revisionNumber, contentIdentity, 'gate', gate.name)
    if (!row) return null
    requiredChecks.push(row)
  }

  const verdicts = runtime.store.verdicts(watcherId).filter(row => row.revision === revisionNumber && row.contentIdentity === contentIdentity)
  if (verdicts.some(row => row.verdict === 'block')) return null
  const needsRoles: VerdictRecord['role'][] = runtime.enrollment.kindPayload.tier === 'full'
    ? ['reviewer', 'integrator']
    : runtime.enrollment.kindPayload.tier === 'standard' ? ['reviewer'] : []
  const issued = runtime.store.issued(watcherId)
  const approvals: VerdictRecord[] = []
  for (const role of needsRoles) {
    const verdict = approvalFor(verdicts, issued, role, revisionNumber, contentIdentity)
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
  tasks?: ObjectiveProgress['tasks']
): Promise<{ effect: 'landed' | 'not-landed'; reason?: string }> {
  let beforeIdentity: string
  try {
    beforeIdentity = await runtime.captureContentIdentity()
  } catch {
    return landingResult('not-landed', 'landing-evidence-unavailable')
  }
  if (beforeIdentity !== action.contentIdentity) return landingResult('not-landed', 'landing-evidence-stale')

  const evidence = requiredLandingEvidence(runtime, action.revision, action.contentIdentity)
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

async function statusPaths(context: PluginContext, workspacePath: string): Promise<string[]> {
  const result = await git(context, workspacePath, ['status', '--porcelain=v1', '-z', '-uall'])
  if (failed(result)) throw new Error(`git status failed: ${result.stderr}`)
  return parseStatusPaths(result.stdoutText)
}
async function attemptTrailer(context: PluginContext, workspacePath: string, attemptId: string): Promise<boolean | null> {
  try {
    const result = await git(context, workspacePath, ['log', '-1', '--format=%B'])
    if (failed(result)) return null
    return result.stdoutText.split(/\r?\n/).includes(`Quirky-Objective-Attempt: ${attemptId}`)
  } catch {
    return null
  }
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

export async function commitLocalBranch(
  runtime: ObjectiveRuntime,
  action: { revision: number; contentIdentity: string; branch: string; headSha: string },
  attemptId: string
): Promise<{ effect: 'landed' | 'not-landed' | 'indeterminate'; reason?: string }> {
  const beforeIdentity = await currentContentIdentity(runtime)
  if (beforeIdentity === null) return { effect: 'not-landed', reason: 'landing-evidence-unavailable' }
  if (beforeIdentity !== action.contentIdentity) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  const filesLanding = runtime.store.landings(runtime.enrollment.watcherId).find(row =>
    row.rung === 'files-on-disk' && row.contentIdentity === action.contentIdentity)
  if (!filesLanding) return { effect: 'not-landed', reason: 'files-on-disk-not-recorded' }

  let currentHead: { branch: string | null; headSha: string | null }
  try {
    currentHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
  } catch {
    return { effect: 'not-landed', reason: 'git-head-unavailable' }
  }
  if (currentHead.branch === null) return { effect: 'not-landed', reason: 'branch-not-attached' }
  if (currentHead.branch !== action.branch) return { effect: 'not-landed', reason: 'head-moved' }

  let paths: string[]
  try {
    paths = await statusPaths(runtime.context, runtime.enrollment.workspacePath)
  } catch {
    return { effect: 'not-landed', reason: 'git-status-failed' }
  }
  const insideTerritory = paths.filter(path => inTerritory(path, runtime.enrollment.kindPayload.writeTerritory))
  const outsideTerritoryPaths = paths.filter(path => !inTerritory(path, runtime.enrollment.kindPayload.writeTerritory))

  if (insideTerritory.length === 0) {
    try {
      currentHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
    } catch {
      return { effect: 'not-landed', reason: 'git-head-unavailable' }
    }
    if (currentHead.branch === null) return { effect: 'not-landed', reason: 'branch-not-attached' }
    if (currentHead.branch !== action.branch) return { effect: 'not-landed', reason: 'head-moved' }
    if (currentHead.headSha !== action.headSha) {
      const recovered = await attemptTrailer(runtime.context, runtime.enrollment.workspacePath, attemptId)
      if (recovered === null) return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
      if (!recovered) return { effect: 'not-landed', reason: 'head-moved' }
    }
    if (!currentHead.headSha) return { effect: 'not-landed', reason: 'head-moved' }
    const noOpHeadSha = currentHead.headSha
    const noOpIdentity = await currentContentIdentity(runtime)
    if (noOpIdentity === null) return { effect: 'not-landed', reason: 'landing-evidence-unavailable' }
    if (noOpIdentity !== action.contentIdentity) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
    try {
      currentHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
    } catch {
      return { effect: 'not-landed', reason: 'git-head-unavailable' }
    }
    if (currentHead.branch === null) return { effect: 'not-landed', reason: 'branch-not-attached' }
    if (currentHead.branch !== action.branch || currentHead.headSha !== noOpHeadSha) {
      return { effect: 'not-landed', reason: 'head-moved' }
    }
    if (!currentHead.headSha) return { effect: 'not-landed', reason: 'head-moved' }
    saveCommittedLanding(runtime, action, attemptId, currentHead.headSha, [], outsideTerritoryPaths)
    return { effect: 'landed' }
  }
  if (currentHead.headSha !== action.headSha) return { effect: 'not-landed', reason: 'head-moved' }

  const pathspecs = Buffer.from(`${insideTerritory.join('\0')}\0`)
  const literalEnv = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
  let addResult: GitResult
  try {
    addResult = await git(runtime.context, runtime.enrollment.workspacePath,
      ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: literalEnv, input: pathspecs })
  } catch {
    return { effect: 'not-landed', reason: 'commit-stage-failed' }
  }
  if (failed(addResult)) return { effect: 'not-landed', reason: 'commit-stage-failed' }

  try {
    currentHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
  } catch {
    return { effect: 'not-landed', reason: 'git-head-unavailable' }
  }
  if (currentHead.branch !== action.branch || currentHead.headSha !== action.headSha) {
    return { effect: 'not-landed', reason: 'head-moved' }
  }

  const objectiveFirstLine = runtime.enrollment.kindPayload.objectiveText.split(/\r?\n/, 1)[0] ?? ''
  const message = `${objectiveFirstLine}\n\nQuirky-Objective-Attempt: ${attemptId}`
  let commitResult: GitResult
  try {
    commitResult = await git(runtime.context, runtime.enrollment.workspacePath, [
      'commit', '--pathspec-from-file=-', '--pathspec-file-nul', '-m', message
    ], { env: literalEnv, input: pathspecs })
  } catch (error) {
    commitResult = { stdoutText: '', stderr: String(error), exitCode: null, signal: null, spawnError: error }
  }

  let committedHead: { branch: string | null; headSha: string | null }
  try {
    committedHead = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath)
  } catch {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  const moved = committedHead.headSha !== action.headSha
  const afterIdentity = await currentContentIdentity(runtime)
  if (!moved) {
    if (afterIdentity === null) return { effect: 'not-landed', reason: 'landing-evidence-unavailable' }
    if (afterIdentity !== action.contentIdentity) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
    if (failed(commitResult)) {
      return commitResult.exitCode !== null && commitResult.exitCode !== 0
        ? { effect: 'not-landed', reason: 'commit-hook-failed' }
        : { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
    }
  }

  let commitMessage: string
  try {
    const logResult = await git(runtime.context, runtime.enrollment.workspacePath, ['log', '-1', '--format=%B'])
    if (failed(logResult)) return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
    commitMessage = logResult.stdoutText
  } catch {
    return { effect: 'indeterminate', reason: 'commit-state-indeterminate' }
  }
  if (!commitMessage.split(/\r?\n/).includes(`Quirky-Objective-Attempt: ${attemptId}`)) {
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

  saveCommittedLanding(runtime, action, attemptId, committedHead.headSha, insideTerritory, outsideTerritoryPaths)
  return { effect: 'landed' }
}
