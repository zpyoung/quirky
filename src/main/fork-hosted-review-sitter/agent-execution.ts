import type {
  HostedReviewPreparedCommit,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  PublishConflictResolutionAction,
  PublishFixAction
} from '../../shared/fork-hosted-review-sitter/types'
import type { GitFileStatus, GitStatusEntry, GitStatusResult } from '../../shared/git-status-types'
import { inspectHostedReviewSitterPolicy } from './agent-policy'
import type { HostedReviewSitterGitExecution } from './provider-git'

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i
const HEIMDALL_ATTEMPT_TRAILER = 'Quirky-Heimdall-Attempt'

export type PublishAction = PublishFixAction | PublishConflictResolutionAction

export function assertCommitSha(sha: string, label: string): void {
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`Hosted review sitter ${label} is not a complete Git commit id.`)
  }
}

export async function assertBranchAndHead(
  git: HostedReviewSitterGitExecution,
  definition: HostedReviewSitterDefinition,
  expectedHeadSha: string,
  signal?: AbortSignal
): Promise<void> {
  const [headSha, branchResult] = await Promise.all([
    git.currentHeadSha(signal),
    git.exec(['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
  ])
  if (headSha !== expectedHeadSha) {
    throw new Error(`Local HEAD changed from ${expectedHeadSha} to ${headSha || '<unborn>'}.`)
  }
  if (branchResult.stdout.trim() !== definition.branch) {
    throw new Error(
      `Hosted review branch changed from ${definition.branch} to ${branchResult.stdout.trim() || '<detached>'}.`
    )
  }
}

export function assertPolicyAllows(status: GitStatusResult, patch: string): void {
  const violation = inspectHostedReviewSitterPolicy(status, patch)
  if (violation) {
    throw new Error(
      `Hosted review agent policy escalation: ${violation.reason}${violation.path ? ` (${violation.path})` : ''}.`
    )
  }
}

function gitStatusFromNameStatus(output: string): GitStatusResult {
  const fields = output.split('\0')
  const entries: GitStatusEntry[] = []
  const statusByCode: Record<string, GitFileStatus> = {
    A: 'added',
    D: 'deleted',
    M: 'modified',
    T: 'modified',
    U: 'modified'
  }
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index]?.charAt(0) ?? ''
    const path = fields[index + 1]
    const status = statusByCode[code]
    if (!path || !status) {
      throw new Error('Prepared commit returned an unsupported or malformed changed-path record.')
    }
    entries.push({ path, status, area: 'staged' })
  }
  return { entries, conflictOperation: 'unknown' }
}

export async function assertCommittedPolicy(
  git: HostedReviewSitterGitExecution,
  sourceHeadSha: string,
  preparedCommitSha: string,
  signal?: AbortSignal
): Promise<void> {
  const [names, patch] = await Promise.all([
    git.exec(
      ['diff', '--name-status', '--no-renames', '-z', sourceHeadSha, preparedCommitSha, '--'],
      signal
    ),
    git.exec(
      ['diff', '--no-ext-diff', '--unified=0', sourceHeadSha, preparedCommitSha, '--'],
      signal
    )
  ])
  assertPolicyAllows(gitStatusFromNameStatus(names.stdout), patch.stdout)
}

function attemptFingerprintFromMessage(message: string): string | null {
  const prefix = `${HEIMDALL_ATTEMPT_TRAILER}: `
  const lines = message.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const trailerIndexes = lines.flatMap((line, index) => (line.startsWith(prefix) ? [index] : []))
  if (trailerIndexes.length !== 1 || trailerIndexes[0] !== lines.length - 1) {
    return null
  }
  const fingerprint = lines.at(-1)!.slice(prefix.length).trim()
  return fingerprint || null
}

export async function readHostedReviewPreparedCommit(
  git: HostedReviewSitterGitExecution,
  providerHeadSha: string,
  signal?: AbortSignal
): Promise<HostedReviewPreparedCommit | null> {
  const preparedCommitSha = await git.currentHeadSha(signal)
  if (preparedCommitSha === providerHeadSha) {
    return null
  }
  assertCommitSha(preparedCommitSha, 'prepared commit')
  if (!(await git.worktreeIsClean(signal))) {
    throw new Error('Hosted review worker left uncommitted changes; publication is forbidden.')
  }
  const [parentsResult, messageResult] = await Promise.all([
    git.exec(['rev-list', '--parents', '-n', '1', preparedCommitSha], signal),
    git.exec(['show', '-s', '--format=%B', preparedCommitSha], signal)
  ])
  const [observedCommit, sourceHeadSha] = parentsResult.stdout.trim().split(/\s+/)
  const preparationAttemptFingerprint = attemptFingerprintFromMessage(messageResult.stdout)
  if (!preparationAttemptFingerprint) {
    return null
  }
  if (observedCommit !== preparedCommitSha || !sourceHeadSha) {
    throw new Error('Heimdall-owned prepared commit has malformed parent evidence.')
  }
  assertCommitSha(sourceHeadSha, 'prepared commit parent')
  return { sourceHeadSha, preparedCommitSha, preparationAttemptFingerprint }
}

export async function verifyPreparedCommit(
  git: HostedReviewSitterGitExecution,
  action: HostedReviewSitterAction,
  preparationAttemptFingerprint: string,
  preparedCommitSha: string,
  signal?: AbortSignal
): Promise<void> {
  if (
    action.kind !== 'prepare-fix' &&
    action.kind !== 'publish-fix' &&
    action.kind !== 'prepare-conflict-resolution' &&
    action.kind !== 'publish-conflict-resolution'
  ) {
    throw new Error(`Hosted review action ${action.kind} does not own a prepared commit.`)
  }
  assertCommitSha(preparedCommitSha, 'prepared commit')
  const [parentsResult, messageResult] = await Promise.all([
    git.exec(['rev-list', '--parents', '-n', '1', preparedCommitSha], signal),
    git.exec(['show', '-s', '--format=%B', preparedCommitSha], signal)
  ])
  const [observedCommit, ...parents] = parentsResult.stdout.trim().split(/\s+/)
  if (observedCommit !== preparedCommitSha || parents[0] !== action.headSha) {
    throw new Error(
      'Prepared commit does not descend directly from the expected hosted review head.'
    )
  }
  if (action.kind === 'prepare-fix' || action.kind === 'publish-fix') {
    if (parents.length !== 1) {
      throw new Error('Prepared checks fix must be a single-parent commit.')
    }
  } else if (parents.length !== 2 || parents[1] !== action.baseSha) {
    throw new Error('Prepared conflict resolution must merge the exact expected base commit.')
  }
  if (attemptFingerprintFromMessage(messageResult.stdout) !== preparationAttemptFingerprint) {
    throw new Error('Prepared commit is missing its exact Heimdall attempt ownership trailer.')
  }
  await assertCommittedPolicy(git, action.headSha, preparedCommitSha, signal)
}
