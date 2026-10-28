import type { Worktree } from '@quirky/protocol'
import {
  buildBranchSummaryPrompt,
  buildPullRequestDetailsPrompt,
  buildPullRequestReviewPrompt,
  buildReviewConversationPrompt,
  type PullRequestCommentPrompt,
  type PullRequestFilePrompt,
  type PullRequestPromptSource
} from './ai-prompts'
import { readCompare } from './compare'
import type { DaemonEnv } from './env'
import { isRecord } from './validation'

export type SourceAction = 'branchSummary' | 'pullRequestDetails' | 'pullRequestReview' | 'reviewConversation'

function unavailable(env: DaemonEnv, reason: string, message: string): never {
  throw env.errors.reasoned('conflict', reason, message)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
}

async function branchSummary(env: DaemonEnv, worktree: Worktree): Promise<string> {
  const initial = await env.readStatus(worktree)
  if (typeof initial.branch !== 'string' || initial.branch === '' || typeof initial.head !== 'string' || initial.head === '') {
    return unavailable(env, 'branch-unavailable', 'A checked-out branch and current head are required to summarize this branch.')
  }
  const compare = await readCompare(env, worktree)
  if (compare.status !== 'ready') {
    return unavailable(env, 'branch-comparison-unavailable', compare.message ?? 'The current branch could not be compared with its base.')
  }
  const current = await env.readStatus(worktree)
  if (current.branch !== initial.branch || current.head !== initial.head || compare.headOid !== current.head) {
    return unavailable(env, 'stale-branch', 'The branch changed while its summary source was being read. Refresh and try again.')
  }
  return buildBranchSummaryPrompt({ worktreePath: worktree.path, branch: initial.branch, compare })
}

async function pullRequest(env: DaemonEnv, worktree: Worktree): Promise<PullRequestPromptSource> {
  const initial = await env.readStatus(worktree)
  if (typeof initial.branch !== 'string' || initial.branch === '' || typeof initial.head !== 'string' || initial.head === '') {
    return unavailable(env, 'branch-unavailable', 'A checked-out branch and current head are required to select a pull request.')
  }

  let lookup: unknown
  try {
    lookup = await env.context.call('quirky.hosting/forBranch', {
      worktree: worktree.id,
      branch: initial.branch,
      headOid: initial.head,
      fresh: true
    })
  } catch (error) {
    return unavailable(env, 'hosting-unavailable', error instanceof Error ? error.message : 'The public pull-request lookup is unavailable.')
  }
  if (!isRecord(lookup)) return unavailable(env, 'hosting-unavailable', 'The public pull-request lookup returned invalid data.')
  if (lookup.kind === 'no-review') return unavailable(env, 'no-pull-request', 'No pull request is linked to this exact branch and head.')
  if (lookup.kind !== 'found' || !isRecord(lookup.review)) {
    const message = typeof lookup.message === 'string' && lookup.message !== '' ? lookup.message : 'The pull-request lookup is unavailable for this exact branch and head.'
    return unavailable(env, 'hosting-unavailable', message)
  }

  const raw = lookup.review
  const repository = raw.repository
  if (
    !isRecord(repository) ||
    typeof repository.host !== 'string' ||
    typeof repository.owner !== 'string' ||
    typeof repository.repo !== 'string' ||
    typeof raw.number !== 'number' || !Number.isSafeInteger(raw.number) || raw.number < 1 ||
    typeof raw.url !== 'string' || typeof raw.title !== 'string' || typeof raw.body !== 'string' ||
    typeof raw.state !== 'string' || typeof raw.headRefName !== 'string' || typeof raw.headRefOid !== 'string' ||
    typeof raw.baseRefName !== 'string' || typeof raw.baseRefOid !== 'string' ||
    typeof raw.reviewDecision !== 'string' || typeof raw.checksStatus !== 'string'
  ) return unavailable(env, 'hosting-unavailable', 'The public pull-request lookup returned incomplete source data.')

  const current = await env.readStatus(worktree)
  if (current.branch !== initial.branch || current.head !== initial.head || raw.headRefName !== initial.branch || raw.headRefOid !== initial.head) {
    return unavailable(env, 'stale-branch', 'The local branch or pull-request head changed while source data was being read. Refresh and try again.')
  }
  return {
    repository: { host: repository.host, owner: repository.owner, repo: repository.repo },
    number: raw.number,
    url: raw.url,
    title: raw.title,
    body: raw.body,
    state: raw.state,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    baseRefName: raw.baseRefName,
    baseRefOid: raw.baseRefOid,
    reviewDecision: raw.reviewDecision,
    checksStatus: raw.checksStatus
  }
}

async function pullRequestComments(
  env: DaemonEnv,
  worktree: Worktree,
  review: PullRequestPromptSource
): Promise<{ comments: PullRequestCommentPrompt[]; partialFailures: string[] }> {
  let result: unknown
  try {
    result = await env.context.call('quirky.hosting/comments', {
      worktree: worktree.id,
      number: review.number,
      prRepo: review.repository,
      noCache: true
    })
  } catch (error) {
    return {
      comments: [],
      partialFailures: [error instanceof Error ? `Pull request comments unavailable: ${error.message}` : 'Pull request comments unavailable.']
    }
  }
  if (!isRecord(result) || !Array.isArray(result.comments)) {
    return { comments: [], partialFailures: ['The public pull-request comments API returned invalid data.'] }
  }
  const comments = result.comments.flatMap((value): PullRequestCommentPrompt[] => {
    if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.body !== 'string') return []
    return [{
      kind: value.kind,
      author: typeof value.author === 'string' ? value.author : null,
      body: value.body,
      path: typeof value.path === 'string' ? value.path : null,
      line: typeof value.line === 'number' ? value.line : null
    }]
  }).slice(0, 100)
  const partialFailures = strings(result.partialFailures)
  if (comments.length < result.comments.length) partialFailures.push('Some malformed pull-request comments were omitted.')
  if (result.partial === true && partialFailures.length === 0) partialFailures.push('Some pull-request comments were unavailable or truncated.')
  return { comments, partialFailures }
}

async function confirmPullRequest(env: DaemonEnv, worktree: Worktree, expected: PullRequestPromptSource): Promise<PullRequestPromptSource> {
  const current = await pullRequest(env, worktree)
  const sameRepository =
    current.repository.host === expected.repository.host &&
    current.repository.owner === expected.repository.owner &&
    current.repository.repo === expected.repository.repo
  if (!sameRepository || current.number !== expected.number || current.headRefOid !== expected.headRefOid) {
    return unavailable(env, 'stale-pull-request', 'The selected pull request changed while its source was being read. Refresh and try again.')
  }
  return current
}

async function pullRequestReview(env: DaemonEnv, worktree: Worktree, review: PullRequestPromptSource): Promise<string> {
  let result: unknown
  try {
    result = await env.context.call('quirky.hosting/files', {
      worktree: worktree.id,
      number: review.number,
      prRepo: review.repository,
      noCache: true
    })
  } catch (error) {
    return unavailable(env, 'hosting-unavailable', error instanceof Error ? error.message : 'The public pull-request files API is unavailable.')
  }
  if (!isRecord(result) || !Array.isArray(result.files)) {
    return unavailable(env, 'hosting-unavailable', 'The public pull-request files API returned invalid data.')
  }
  const files = result.files.flatMap((value): PullRequestFilePrompt[] => {
    if (!isRecord(value) || typeof value.path !== 'string' || typeof value.status !== 'string') return []
    return [{ path: value.path, status: value.status, patch: typeof value.patch === 'string' ? value.patch : null }]
  }).slice(0, 100)
  if (files.length === 0 || files.every((file) => file.patch === null)) {
    return unavailable(env, 'review-diff-unavailable', 'The public pull-request files API returned no readable patch for this review.')
  }
  const discussion = await pullRequestComments(env, worktree, review)
  const current = await confirmPullRequest(env, worktree, review)
  const partialFailures = [...discussion.partialFailures, ...strings(result.partialFailures)]
  if (result.truncated === true) partialFailures.push('The public files API truncated the changed-file list.')
  if (files.some((file) => file.patch === null)) partialFailures.push('Some changed files did not include a readable patch.')
  return buildPullRequestReviewPrompt({
    worktreePath: worktree.path,
    review: current,
    files,
    comments: discussion.comments,
    partialFailures
  })
}

async function conversationDraft(env: DaemonEnv, worktree: Worktree, review: PullRequestPromptSource): Promise<string> {
  const discussion = await pullRequestComments(env, worktree, review)
  const current = await confirmPullRequest(env, worktree, review)
  if (discussion.comments.length === 0) {
    return unavailable(env, 'no-conversation', 'This pull request has no readable conversation to draft a reply to.')
  }
  return buildReviewConversationPrompt({
    worktreePath: worktree.path,
    review: current,
    comments: discussion.comments,
    partialFailures: discussion.partialFailures
  })
}

/** Builds the branch or fresh public hosting context named by a recipe action. */
export async function sourcePrompt(env: DaemonEnv, worktree: Worktree, action: SourceAction): Promise<string> {
  if (action === 'branchSummary') return branchSummary(env, worktree)
  const review = await pullRequest(env, worktree)
  if (action === 'pullRequestDetails') return buildPullRequestDetailsPrompt({ worktreePath: worktree.path, review })
  if (action === 'pullRequestReview') return pullRequestReview(env, worktree, review)
  return conversationDraft(env, worktree, review)
}
