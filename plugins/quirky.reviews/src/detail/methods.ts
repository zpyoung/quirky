import type { MethodHandler } from '@quirky/protocol'
import {
  REVIEW_VIEW,
  type JsonRecord,
  type MethodSpec,
  type ReviewData,
  type ReviewMethodTable,
  type ReviewTab,
  type ReviewsEnv,
  type ReviewsState,
} from '../contracts'
import {
  isRecord,
  parseCheckDetail,
  parseChecksResult,
  parseCommentsResult,
  parseFilesResult,
  parseRepoIdentity,
  parseReviewLookup,
  parseReviewStackResult,
  repoFromReviewUrl,
  sameRepo,
  type ChangedFile,
  type RepoIdentity,
  type ReviewComment,
  type ReviewStackEntry,
  type ReviewStackResult,
} from './data'

const tabs = ['conversation', 'checks', 'files'] as const
const audiences = ['all', 'humans', 'bots'] as const
const groupings = ['grouped', 'timeline'] as const
const mergeMethods = ['squash', 'merge', 'rebase'] as const
const reactions = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const
const sourceShape = {
  type: 'object',
  properties: { host: { type: 'string' }, owner: { type: 'string' }, repo: { type: 'string' } },
  required: ['host', 'owner', 'repo'],
  additionalProperties: false,
}
const surfaceShape = { type: 'string', enum: ['detail', 'checks'] }
const numberShape = { type: 'integer', minimum: 1 }
const stringShape = { type: 'string' }
const strictObject = (properties: JsonRecord, required: string[] = []): JsonRecord => {
  const requiredProperties = new Set(required)
  if (Object.hasOwn(properties, 'worktree')) requiredProperties.add('worktree')
  if (Object.hasOwn(properties, 'number')) requiredProperties.add('number')
  return { type: 'object', properties, required: [...requiredProperties], additionalProperties: false }
}
const arrayOfStrings = { type: 'array', items: { type: 'string' } }
const targetIdentity = { worktree: stringShape, number: numberShape, prRepo: sourceShape }
const draftIdentity = { ...targetIdentity, generation: { type: 'integer', minimum: 0 } }
const surfaceNumber = { surface: surfaceShape, ...targetIdentity }
const emptyResult = strictObject({ ok: { type: 'boolean' } }, ['ok'])

const callResult = strictObject({
  surface: surfaceShape,
  number: numberShape,
  ok: { type: 'boolean' },
  errors: { type: 'array', items: { type: 'string' } },
  loaded: strictObject({
    review: { type: 'boolean' }, details: { type: 'boolean' }, checks: { type: 'boolean' }, comments: { type: 'boolean' }, files: { type: 'boolean' },
  }, ['review', 'details', 'checks', 'comments', 'files']),
  fetchedAt: { type: 'integer', minimum: 0 },
}, ['surface', 'number', 'ok', 'errors', 'loaded', 'fetchedAt'])

export const detailSpecs: (MethodSpec & { description: string })[] = [
  {
    id: 'open',
    description: 'Open a pull request in the full review page.',
    params: strictObject({
      worktree: { type: 'string' }, number: numberShape,
      tab: { type: 'string', enum: tabs }, prRepo: sourceShape,
    }, ['worktree', 'number']),
    result: strictObject({ worktree: { type: 'string' }, number: numberShape, tab: { type: 'string', enum: tabs }, prRepo: sourceShape }, ['worktree', 'number', 'tab']),
  },
  {
    id: 'detailRefresh',
    description: 'Refresh a selected pull request and visible detail data.',
    params: strictObject({ surface: surfaceShape, ...targetIdentity }, ['surface']),
    result: callResult,
  },
  {
    id: 'detailSetTab',
    description: 'Select a conversation, checks, or files tab.',
    params: strictObject({ ...targetIdentity, tab: { type: 'string', enum: tabs } }, ['tab']),
    result: strictObject({ tab: { type: 'string', enum: tabs } }, ['tab']),
  },
  {
    id: 'detailSetAudience',
    description: 'Set the comments audience filter.',
    params: strictObject({ ...targetIdentity, surface: surfaceShape, audience: { type: 'string', enum: audiences } }, ['surface', 'audience']),
    result: strictObject({ surface: surfaceShape, audience: { type: 'string', enum: audiences } }, ['surface', 'audience']),
  },
  {
    id: 'detailSetGrouping',
    description: 'Set grouped or timeline comment ordering.',
    params: strictObject({ ...targetIdentity, surface: surfaceShape, grouping: { type: 'string', enum: groupings } }, ['surface', 'grouping']),
    result: strictObject({ surface: surfaceShape, grouping: { type: 'string', enum: groupings } }, ['surface', 'grouping']),
  },
  {
    id: 'detailSetCommentDraft',
    description: 'Save a comment draft on a review surface.',
    params: strictObject({ ...draftIdentity, surface: surfaceShape, body: stringShape, draftVersion: { type: 'integer', minimum: 0 } }, ['surface', 'body', 'generation']),
    result: strictObject({ surface: surfaceShape, body: stringShape, draftVersion: { type: 'integer', minimum: 0 }, applied: { type: 'boolean' } }, ['surface', 'body', 'draftVersion', 'applied']),
  },
  {
    id: 'detailSetBodyDraft',
    description: 'Save the pull request description draft.',
    params: strictObject({ ...draftIdentity, body: { anyOf: [{ type: 'string' }, { type: 'null' }] }, draftVersion: { type: 'integer', minimum: 0 } }, ['body', 'generation']),
    result: strictObject({ body: { anyOf: [{ type: 'string' }, { type: 'null' }] }, draftVersion: { type: 'integer', minimum: 0 }, applied: { type: 'boolean' } }, ['body', 'draftVersion', 'applied']),
  },
  {
    id: 'detailSetFilesView',
    description: 'Set file selection, filtering, collapse, and diff mode.',
    params: strictObject({ ...targetIdentity,
      fileFilter: stringShape,
      diffMode: { type: 'string', enum: ['inline', 'side-by-side'] },
      selectedFile: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      collapsedFiles: arrayOfStrings,
      treeVisible: { type: 'boolean' },
    }, ['fileFilter', 'diffMode', 'selectedFile', 'collapsedFiles', 'treeVisible']),
    result: strictObject({ fileFilter: stringShape, diffMode: { type: 'string', enum: ['inline', 'side-by-side'] }, selectedFile: { anyOf: [{ type: 'string' }, { type: 'null' }] }, collapsedFiles: arrayOfStrings, treeVisible: { type: 'boolean' } }, ['fileFilter', 'diffMode', 'selectedFile', 'collapsedFiles', 'treeVisible']),
  },
  {
    id: 'detailQueueComment',
    description: 'Queue or unqueue a review comment for agent work.',
    params: strictObject({ ...targetIdentity, surface: surfaceShape, commentId: stringShape, queued: { type: 'boolean' } }, ['surface', 'commentId', 'queued']),
    result: strictObject({ surface: surfaceShape, commentId: stringShape, queued: { type: 'boolean' } }, ['surface', 'commentId', 'queued']),
  },
  {
    id: 'detailSetBotOverride',
    description: 'Persist a manual bot-author override.',
    params: strictObject({ author: stringShape, bot: { type: 'boolean' } }, ['author', 'bot']),
    result: strictObject({ author: stringShape, bot: { type: 'boolean' }, overrides: arrayOfStrings }, ['author', 'bot', 'overrides']),
  },
  {
    id: 'detailPostComment',
    description: 'Post a pull request conversation comment or review reply.',
    params: strictObject({ ...surfaceNumber, body: stringShape, replyToId: numberShape }, ['surface', 'number', 'body']),
    result: strictObject({ number: numberShape, comment: strictObject({ id: numberShape, kind: { type: 'string', enum: ['issue_comment', 'review_comment'] }, body: stringShape, author: { anyOf: [{ type: 'string' }, { type: 'null' }] }, createdAt: { anyOf: [{ type: 'string' }, { type: 'null' }] }, url: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, ['id', 'kind', 'body', 'author', 'createdAt', 'url']) }, ['number', 'comment']),
  },
  {
    id: 'detailEditComment',
    description: 'Edit a top-level pull request conversation comment.',
    params: strictObject({ ...surfaceNumber, commentId: numberShape, body: stringShape }, ['surface', 'number', 'commentId', 'body']),
    result: strictObject({ number: numberShape, commentId: numberShape, body: stringShape, updated: { type: 'boolean' } }, ['number', 'commentId', 'body', 'updated']),
  },
  {
    id: 'detailDeleteComment',
    description: 'Delete a top-level pull request comment after confirmation.',
    destructive: true,
    confirm: 'Delete comment #{commentId} on pull request #{number}?',
    params: strictObject({ ...surfaceNumber, commentId: numberShape }, ['surface', 'number', 'commentId']),
    result: strictObject({ number: numberShape, commentId: numberShape, deleted: { type: 'boolean' } }, ['number', 'commentId', 'deleted']),
  },
  {
    id: 'detailResolveThread',
    description: 'Resolve or unresolve a review thread.',
    params: strictObject({ ...surfaceNumber, threadId: stringShape, resolved: { type: 'boolean' } }, ['surface', 'number', 'threadId', 'resolved']),
    result: strictObject({ number: numberShape, threadId: stringShape, resolved: { type: 'boolean' } }, ['number', 'threadId', 'resolved']),
  },
  {
    id: 'detailReact',
    description: 'Add or remove a reaction on a pull request comment.',
    params: strictObject({ ...surfaceNumber, subjectId: stringShape, content: { type: 'string', enum: reactions }, add: { type: 'boolean' } }, ['surface', 'number', 'subjectId', 'content', 'add']),
    result: strictObject({ number: numberShape, subjectId: stringShape, content: { type: 'string', enum: reactions }, add: { type: 'boolean' }, changed: { type: 'boolean' } }, ['number', 'subjectId', 'content', 'add', 'changed']),
  },
  {
    id: 'detailUpdateBody',
    description: 'Update the pull request description.',
    params: strictObject({ ...surfaceNumber, body: stringShape }, ['surface', 'number', 'body']),
    result: strictObject({ number: numberShape, body: stringShape, updated: { type: 'boolean' } }, ['number', 'body', 'updated']),
  },
  {
    id: 'detailUpdateReviewers',
    description: 'Add or remove requested reviewers.',
    params: strictObject({ ...surfaceNumber, action: { type: 'string', enum: ['add', 'remove'] }, logins: { type: 'array', minItems: 1, maxItems: 15, items: { type: 'string', minLength: 1, maxLength: 39 } } }, ['surface', 'number', 'action', 'logins']),
    result: strictObject({ number: numberShape, reviewers: arrayOfStrings, updated: { type: 'boolean' } }, ['number', 'reviewers', 'updated']),
  },
  {
    id: 'detailUpdateAssignees',
    description: 'Add, remove, or replace pull request assignees.',
    params: strictObject({ ...surfaceNumber, action: { type: 'string', enum: ['add', 'remove', 'set'] }, logins: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 } } }, ['surface', 'number', 'action', 'logins']),
    result: strictObject({ number: numberShape, assignees: arrayOfStrings }, ['number', 'assignees']),
  },
  {
    id: 'detailMarkReady',
    description: 'Mark a draft pull request ready for review.',
    params: strictObject(surfaceNumber, ['surface', 'number']),
    result: strictObject({ number: numberShape, state: { type: 'string', enum: ['open'] }, updated: { type: 'boolean' } }, ['number', 'state', 'updated']),
  },
  {
    id: 'detailCloseReview',
    description: 'Close an open pull request after confirmation.',
    destructive: true,
    confirm: 'Close pull request #{number}?',
    params: strictObject(surfaceNumber, ['surface', 'number']),
    result: strictObject({ number: numberShape, state: { type: 'string', enum: ['closed'] }, updated: { type: 'boolean' } }, ['number', 'state', 'updated']),
  },
  {
    id: 'detailReopenReview',
    description: 'Reopen a closed pull request after confirmation.',
    destructive: true,
    confirm: 'Reopen pull request #{number}?',
    params: strictObject(surfaceNumber, ['surface', 'number']),
    result: strictObject({ number: numberShape, state: { type: 'string', enum: ['open'] }, updated: { type: 'boolean' } }, ['number', 'state', 'updated']),
  },
  {
    id: 'detailMerge',
    description: 'Merge or queue a pull request after confirmation and an exact-head guard.',
    destructive: true,
    confirm: 'Confirm {action} for pull request #{number} using {method}?',
    describe: 'detailMergeConfirmation',
    params: strictObject({ ...surfaceNumber, expectedHead: { type: 'string', pattern: '^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$' }, method: { type: 'string', enum: mergeMethods }, action: { type: 'string', enum: ['direct', 'queue'] } }, ['surface', 'number', 'expectedHead', 'method', 'action']),
    result: strictObject({ number: numberShape, state: { type: 'string', enum: ['merged', 'enqueued', 'pending'] }, head: stringShape, operationId: stringShape }, ['number', 'state', 'head']),
  },
  {
    id: 'detailMergeConfirmation',
    description: 'Describe the exact pull request or stack membership before a merge confirmation.',
    readOnly: true,
    params: strictObject({ ...surfaceNumber, expectedHead: { type: 'string', pattern: '^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$' }, method: { type: 'string', enum: mergeMethods }, action: { type: 'string', enum: ['direct', 'queue'] } }, ['surface', 'number', 'expectedHead', 'method', 'action']),
    result: { type: 'string' },
  },
  {
    id: 'detailSetAutoMerge',
    description: 'Enable or disable auto-merge with an expected-head guard.',
    params: strictObject({ ...surfaceNumber, expectedHead: { type: 'string', pattern: '^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$' }, enabled: { type: 'boolean' }, method: { type: 'string', enum: mergeMethods } }, ['surface', 'number', 'expectedHead', 'enabled']),
    result: strictObject({ number: numberShape, enabled: { type: 'boolean' }, state: stringShape }, ['number', 'enabled', 'state']),
  },
  {
    id: 'detailExpandCheck',
    description: 'Expand or collapse a check.',
    params: strictObject({ ...targetIdentity, surface: surfaceShape, checkId: stringShape, expanded: { type: 'boolean' } }, ['surface', 'checkId', 'expanded']),
    result: strictObject({ surface: surfaceShape, checkId: stringShape, expanded: { type: 'boolean' } }, ['surface', 'checkId', 'expanded']),
  },
  {
    id: 'detailRefreshChecks',
    description: 'Refresh checks for a pull request without cache.',
    params: strictObject({ ...surfaceNumber }, ['surface', 'number']),
    result: strictObject({ surface: surfaceShape, number: numberShape, headSha: { anyOf: [{ type: 'string' }, { type: 'null' }] }, checks: { type: 'array', items: strictObject({ kind: { type: 'string' }, name: stringShape, status: stringShape, conclusion: { anyOf: [{ type: 'string' }, { type: 'null' }] }, url: { anyOf: [{ type: 'string' }, { type: 'null' }] }, checkRunId: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, workflowRunId: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, suiteId: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, ['kind', 'name', 'status', 'conclusion', 'url', 'checkRunId', 'workflowRunId', 'suiteId']) }, ['surface', 'number', 'headSha', 'checks']),
  },
  {
    id: 'detailLoadCheckDetails',
    description: 'Load bounded details and logs for one current check run.',
    params: strictObject({ ...surfaceNumber, expectedHead: { type: 'string', pattern: '^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$' }, checkRunId: numberShape, workflowRunId: numberShape, jobName: { type: 'string', maxLength: 200 } }, ['surface', 'number', 'expectedHead', 'checkRunId']),
    result: strictObject({ surface: surfaceShape, number: numberShape, checkRunId: numberShape, details: { type: 'object', additionalProperties: true } }, ['surface', 'number', 'checkRunId', 'details']),
  },
  {
    id: 'detailRerunChecks',
    description: 'Rerun actionable checks or failed checks.',
    params: strictObject({ ...surfaceNumber, failedOnly: { type: 'boolean' } }, ['surface', 'number', 'failedOnly']),
    result: strictObject({ surface: surfaceShape, number: numberShape, started: { type: 'integer', minimum: 0 }, targetCount: { type: 'integer', minimum: 0 }, completedSteps: arrayOfStrings, refreshed: { type: 'boolean' }, refreshError: stringShape }, ['surface', 'number', 'started', 'targetCount', 'completedSteps', 'refreshed']),
  },
  {
    id: 'detailSetFileViewed',
    description: 'Mark a changed pull request file viewed or unviewed.',
    params: strictObject({ ...surfaceNumber, path: stringShape, viewed: { type: 'boolean' } }, ['surface', 'number', 'path', 'viewed']),
    result: strictObject({ number: numberShape, path: stringShape, viewed: { type: 'boolean' } }, ['number', 'path', 'viewed']),
  },
  {
    id: 'detailInlineComment',
    description: 'Add a current-head inline or range review comment.',
    params: strictObject({ ...surfaceNumber, expectedHead: { type: 'string', pattern: '^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$' }, path: stringShape, line: { type: 'integer', minimum: 1 }, startLine: { type: 'integer', minimum: 1 }, body: stringShape }, ['surface', 'number', 'expectedHead', 'path', 'line', 'body']),
    result: strictObject({ number: numberShape, comment: strictObject({ id: numberShape, path: stringShape, line: { type: 'integer', minimum: 1 }, startLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }, body: stringShape }, ['id', 'path', 'line', 'startLine', 'body']) }, ['number', 'comment']),
  },
]

type Surface = 'detail' | 'checks'
type ReviewTargetWithRepo = ReviewsState['detail']['target'] & { prRepo?: RepoIdentity }
type Selection = {
  surface: Surface
  worktree: string
  number: number
  generation: number
  review: ReviewData | null
  repo: RepoIdentity | null
  head: string | null
  identity: string
}
type Ticket = { selection: Selection; operation: string; key: string; sequence: number }

type RepoLookupResult = { kind: 'found'; review: ReviewData; fetchedAt: number } | { kind: 'no-review'; fetchedAt: number } | { kind: 'unavailable'; message: string; reason: string; fetchedAt: number }

type SurfaceSnapshot = {
  worktree: string | null
  number: number | null
  generation: number
  review: ReviewData | null
  repo: RepoIdentity | null
}

function parseSurface(env: ReviewsEnv, value: unknown): Surface {
  if (value === 'detail' || value === 'checks') return value
  throw env.invalid('invalid_input', 'surface must be detail or checks.')
}
function selectionIdentity(worktree: string, number: number, repo: RepoIdentity | null): string {
  return `${worktree}\u0000${number}\u0000${repo?.host.toLowerCase() ?? ''}/${repo?.owner.toLowerCase() ?? ''}/${repo?.repo.toLowerCase() ?? ''}`
}



function selectionFromState(env: ReviewsEnv, state: ReviewsState, surface: Surface, needsReview: boolean): Selection {
  let worktree: string | null
  let number: number | null
  let generation: number
  let review: ReviewData | null
  if (surface === 'detail') {
    const target = state.detail.target
    worktree = target?.worktree ?? null
    number = target?.number ?? null
    generation = state.detail.generation
    review = state.detail.review
    const rawSource = (target as ReviewTargetWithRepo | null)?.prRepo
    if (rawSource !== undefined && parseRepoIdentity(rawSource) === null) throw env.invalid('invalid_state', 'The selected review repository source is invalid.')
  } else {
    worktree = state.checks.worktree
    review = state.checks.review
    number = review?.number ?? null
    generation = state.checks.generation
  }
  if (typeof worktree !== 'string' || worktree.length === 0 || number === null || !Number.isSafeInteger(number) || number < 1) {
    throw env.invalid('no_target', `No pull request is selected on the ${surface} surface.`)
  }
  if (needsReview && review === null) throw env.invalid('no_review', `Pull request #${number} is not available on the ${surface} surface.`)
  if (review !== null && review.number !== number) throw env.invalid('invalid_state', 'The selected pull request identity does not match its review data.')
  let repo: RepoIdentity | null
  const rawSource = surface === 'detail'
    ? (state.detail.target as ReviewTargetWithRepo | null)?.prRepo
    : review?.prRepo
  if (rawSource !== undefined) {
    repo = parseRepoIdentity(rawSource)
    if (repo === null) throw env.invalid('invalid_state', 'The selected review repository source is invalid.')
  } else {
    repo = review === null ? null : repoFromReviewUrl(review.url, number)
  }
  const urlRepo = review === null ? null : repoFromReviewUrl(review.url, number)
  if (repo !== null && urlRepo !== null && !sameRepo(repo, urlRepo)) {
    throw env.invalid('source_mismatch', 'The selected pull request URL does not match its trusted repository source.')
  }
  const identity = selectionIdentity(worktree, number, repo)
  return { surface, worktree, number, generation, review, repo: repo ?? urlRepo, head: review?.headRefOid ?? null, identity }
}

function selectionFromParams(env: ReviewsEnv, params: JsonRecord, surface: Surface, needsReview: boolean): Selection {
  let selected = selectionFromState(env, env.read(), surface, needsReview)
  if (params.worktree !== selected.worktree || params.number !== selected.number) {
    throw env.invalid('stale_target', 'The review method target does not match the selected surface.')
  }
  if (params.generation !== undefined && params.generation !== selected.generation) {
    throw env.invalid('stale_target', 'The selected review surface changed before this action.')
  }
  if (params.prRepo !== undefined) {
    const requestedRepo = parseRepoIdentity(params.prRepo)
    if (requestedRepo === null || selected.repo !== null && !sameRepo(selected.repo, requestedRepo)) {
      throw env.invalid('source_mismatch', 'The requested repository source does not match the selected review.')
    }
    selected = { ...selected, repo: requestedRepo, identity: selectionIdentity(selected.worktree, selected.number, requestedRepo) }
  }
  return selected
}

function snapshotFor(state: ReviewsState, surface: Surface): SurfaceSnapshot {
  if (surface === 'detail') {
    const target = state.detail.target
    return {
      worktree: target?.worktree ?? null,
      number: target?.number ?? null,
      generation: state.detail.generation,
      review: state.detail.review,
      repo: parseRepoIdentity((target as ReviewTargetWithRepo | null)?.prRepo) ?? (state.detail.review ? repoFromReviewUrl(state.detail.review.url, state.detail.review.number) : null),
    }
  }
  return {
    worktree: state.checks.worktree,
    number: state.checks.review?.number ?? null,
    generation: state.checks.generation,
    review: state.checks.review,
    repo: parseRepoIdentity(state.checks.review?.prRepo) ?? (state.checks.review ? repoFromReviewUrl(state.checks.review.url, state.checks.review.number) : null),
  }
}

function ownerMatches(state: ReviewsState, selection: Selection): boolean {
  const snapshot = snapshotFor(state, selection.surface)
  return snapshot.worktree === selection.worktree && snapshot.number === selection.number && snapshot.generation === selection.generation
    && (selection.repo === null || snapshot.repo === null || sameRepo(selection.repo, snapshot.repo))
}

function selectionMatches(state: ReviewsState, selection: Selection): boolean {
  if (!ownerMatches(state, selection)) return false
  const current = snapshotFor(state, selection.surface).review
  return selection.head === null || current === null || current.headRefOid.toLowerCase() === selection.head.toLowerCase()
}

function applyIfOwner(env: ReviewsEnv, selection: Selection, change: (state: ReviewsState) => void): boolean {
  let applied = false
  env.update((state) => {
    if (!ownerMatches(state, selection)) return
    change(state)
    applied = true
  })
  return applied
}

function surfaceError(env: ReviewsEnv, selection: Selection, message: string | null): void {
  applyIfOwner(env, selection, (state) => {
    if (selection.surface === 'detail') state.detail.error = message
    else state.checks.error = message
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveNumber(env: ReviewsEnv, value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw env.invalid('invalid_input', `${label} must be a positive integer.`)
}

function requireMatchingNumber(env: ReviewsEnv, selection: Selection, value: unknown): void {
  if (positiveNumber(env, value, 'number') !== selection.number) {
    throw env.invalid('target_mismatch', 'The requested pull request does not match the selected review surface.')
  }
}

function requireHead(env: ReviewsEnv, selection: Selection, value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
    throw env.invalid('invalid_input', 'A valid expected pull request head SHA is required.')
  }
  if (selection.review === null || selection.review.headRefOid.toLowerCase() !== value.toLowerCase()) {
    throw env.invalid('stale_head', 'The pull request head changed; refresh before acting.')
  }
  return value
}

function hostingParams(selection: Selection): JsonRecord {
  return {
    worktree: selection.worktree,
    number: selection.number,
    ...(selection.repo === null ? {} : { prRepo: selection.repo }),
  }
}

function surfaceReview(state: ReviewsState, surface: Surface): ReviewData | null {
  return surface === 'detail' ? state.detail.review : state.checks.review
}

function assignReview(state: ReviewsState, surface: Surface, review: ReviewData | null): void {
  if (surface === 'detail') state.detail.review = review
  else state.checks.review = review
}

function assignChecks(state: ReviewsState, surface: Surface, value: JsonRecord | null): void {
  if (surface === 'detail') state.detail.checks = value
  else state.checks.checks = value
}

function assignComments(state: ReviewsState, surface: Surface, value: JsonRecord | null): void {
  if (surface === 'detail') state.detail.comments = value
  else state.checks.comments = value
}

function assignFiles(state: ReviewsState, surface: Surface, value: JsonRecord | null): void {
  if (surface === 'detail') state.detail.files = value
}

function addPending(state: ReviewsState, surface: Surface, operation: string): void {
  if (surface !== 'detail' || state.detail.pending.includes(operation)) return
  state.detail.pending = [...state.detail.pending, operation]
}

function removePending(state: ReviewsState, surface: Surface, operation: string): void {
  if (surface === 'detail') state.detail.pending = state.detail.pending.filter((entry) => entry !== operation)
}

function commentState(state: ReviewsState, surface: Surface): JsonRecord | null {
  return surface === 'detail' ? state.detail.comments : state.checks.comments
}

function fileState(state: ReviewsState): JsonRecord | null {
  return state.detail.files
}

function checkState(state: ReviewsState, surface: Surface): JsonRecord | null {
  return surface === 'detail' ? state.detail.checks : state.checks.checks
}

function commentsFromState(env: ReviewsEnv, selection: Selection): ReviewComment[] {
  const value = commentState(env.read(), selection.surface)
  const parsed = value === null ? null : parseCommentsResult(value, selection.number)
  if (parsed === null || !Array.isArray(parsed.comments)) throw env.invalid('comments_unavailable', 'Comments have not been loaded for this pull request.')
  return parsed.comments as unknown as ReviewComment[]
}

function commentsEnvelope(number: number, comments: ReviewComment[], previous: JsonRecord | null): JsonRecord {
  const partial = previous?.partial === true || previous === null
  const previousFailures = Array.isArray(previous?.partialFailures)
    ? previous.partialFailures.filter((entry): entry is string => typeof entry === 'string')
    : []
  const distinct = new Map<string, ReviewComment>()
  for (const comment of comments) distinct.set(`${comment.kind}:${String(comment.id)}`, comment)
  const ordered = [...distinct.values()].slice(-100)
  const failures = previous === null && !previousFailures.includes('The comment list has not been loaded yet.')
    ? [...previousFailures, 'The comment list has not been loaded yet.']
    : previousFailures
  return { number, comments: ordered, partial, partialFailures: failures }
}

function withoutInlineComments(value: JsonRecord | null, number: number): JsonRecord | null {
  if (value === null) return null
  const parsed = parseCommentsResult(value, number)
  if (parsed === null) return null
  return { ...parsed, comments: (parsed.comments as unknown as ReviewComment[]).filter((comment) => comment.kind !== 'review_comment') }
}

function commentIdKey(comment: ReviewComment): string {
  return `${comment.kind}:${String(comment.id)}`
}

function targetCommentKey(selection: Selection): string {
  return `${selection.identity}\u0000comments`
}

function filesFromState(env: ReviewsEnv, selection: Selection): ChangedFile[] {
  const value = fileState(env.read())
  const parsed = value === null ? null : parseFilesResult(value, selection.number)
  if (parsed === null || !Array.isArray(parsed.files)) throw env.invalid('files_unavailable', 'Changed-file data is unavailable for this pull request.')
  return parsed.files as unknown as ChangedFile[]
}

function parseNumberResult(raw: unknown, number: number): raw is JsonRecord {
  return isRecord(raw) && raw.number === number
}


export function reviewMethods(review: ReviewData): { allowed: string[]; defaultMethod: string | null; known: boolean } {
  if (review.mergeMetadataKnown === false || !isRecord(review.mergeMethods)) return { allowed: [], defaultMethod: null, known: false }
  const allowedValue = review.mergeMethods.allowed
  const defaultValue = review.mergeMethods.default
  if (!Array.isArray(allowedValue) || !allowedValue.every((value) => typeof value === 'string' && mergeMethods.includes(value as typeof mergeMethods[number]))) {
    return { allowed: [], defaultMethod: null, known: false }
  }
  const defaultMethod = typeof defaultValue === 'string' && mergeMethods.includes(defaultValue as typeof mergeMethods[number])
    ? defaultValue
    : null
  return { allowed: allowedValue, defaultMethod, known: review.mergeMetadataKnown !== false }
}

export function directMergeAllowed(review: ReviewData): boolean {
  if (review.state !== 'open' || review.mergeable === 'CONFLICTING'
    || review.mergeStateStatus === 'CONFLICTING' || review.mergeStateStatus === 'DIRTY'
    || review.mergeStateStatus === 'BEHIND' || review.mergeStateStatus === 'BLOCKED'
    || review.mergeStateStatus === 'UNSTABLE'
    || review.reviewDecision === 'REVIEW_REQUIRED' || review.reviewDecision === 'CHANGES_REQUESTED') return false
  if (review.mergeable !== 'MERGEABLE' && review.mergeStateStatus !== 'CLEAN') return false
  const policy = reviewMethods(review)
  return policy.known && policy.allowed.length > 0
}

export function queueMergeAllowed(review: ReviewData): boolean {
  const policy = reviewMethods(review)
  return review.state === 'open' && review.mergeQueueRequired === true
    && review.mergeable !== 'CONFLICTING' && review.mergeStateStatus !== 'CONFLICTING'
    && review.mergeStateStatus !== 'DIRTY' && review.mergeStateStatus !== 'BEHIND'
    && review.mergeStateStatus !== 'BLOCKED' && review.mergeStateStatus !== 'UNSTABLE'
    && policy.known && policy.allowed.length > 0
}

function includedStackEntries(env: ReviewsEnv, selection: Selection): ReviewStackEntry[] {
  if (selection.review === null || selection.review.stack === null || selection.review.stack === undefined) return []
  const state = env.read()
  const details = selection.surface === 'detail' ? state.detail.details : state.checks.conflicts
  let raw = isRecord(details) ? details.reviewStack : undefined
  if (raw === undefined && isRecord(selection.review.stackDetails)) raw = selection.review.stackDetails
  const stack = parseReviewStackResult(raw, selection.number)
  if (stack === null || !stack.available || stack.truncated || stack.stack === null) {
    throw env.invalid('stack_unavailable', stack?.reason ?? 'Complete pull request stack membership is unavailable; use the provider merge box.')
  }
  const included = stack.stack.entries
    .filter((entry) => entry.position <= stack.stack!.position)
    .sort((left, right) => left.position - right.position)
  if (included.length !== stack.stack.position || !included.every((entry, index) => entry.position === index + 1)
    || !included.some((entry) => entry.number === selection.number)) {
    throw env.invalid('stack_incomplete', 'Complete stack membership could not be verified; use the provider merge box.')
  }
  return included
}


function parseReviewUpdate(raw: unknown, number: number, expectedState: 'open' | 'closed'): boolean {
  return isRecord(raw) && raw.number === number && raw.updated === true && raw.state === expectedState
}

function withReviewChange(review: ReviewData, change: Partial<ReviewData>): ReviewData {
  return { ...review, ...change }
}

function beginMutation(env: ReviewsEnv, selection: Selection, operation: string, counters: Map<string, number>, pendingCounts: Map<string, number>, writes: Map<string, number>): Ticket {
  const key = `${selection.identity}\u0000${operation}`
  const sequence = (counters.get(key) ?? 0) + 1
  counters.set(key, sequence)
  pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1)
  writes.set(selection.identity, (writes.get(selection.identity) ?? 0) + 1)
  applyIfOwner(env, selection, (state) => addPending(state, selection.surface, operation))
  return { selection, operation, key, sequence }
}

function finishMutation(env: ReviewsEnv, ticket: Ticket, counters: Map<string, number>, pendingCounts: Map<string, number>): void {
  const remaining = Math.max(0, (pendingCounts.get(ticket.key) ?? 1) - 1)
  if (remaining === 0) pendingCounts.delete(ticket.key)
  else pendingCounts.set(ticket.key, remaining)
  if (counters.get(ticket.key) !== ticket.sequence || remaining > 0) return
  applyIfOwner(env, ticket.selection, (state) => removePending(state, ticket.selection.surface, ticket.operation))
}

function isLatest(ticket: Ticket, counters: Map<string, number>): boolean {
  return counters.get(ticket.key) === ticket.sequence
}

function recordError(env: ReviewsEnv, selection: Selection, error: unknown): void {
  surfaceError(env, selection, errorMessage(error))
}

function validateBody(env: ReviewsEnv, value: unknown, label = 'body'): string {
  if (typeof value !== 'string' || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > 65_536) {
    throw env.invalid('invalid_input', `${label} must be non-empty and at most 64 KiB.`)
  }
  return value
}

function parseAssigneeList(raw: unknown, number: number): string[] | null {
  if (!isRecord(raw) || raw.number !== number || !Array.isArray(raw.assignees)
    || raw.assignees.length > 100 || !raw.assignees.every((login) => typeof login === 'string')) return null
  return raw.assignees
}

function parseReviewerList(raw: unknown, number: number): string[] | null {
  if (!isRecord(raw) || raw.number !== number || !Array.isArray(raw.reviewers)
    || !raw.reviewers.every((login) => typeof login === 'string')) return null
  return raw.reviewers
}

function commentIndex(comments: ReviewComment[], id: number): number {
  return comments.findIndex((comment) => typeof comment.id === 'number' && comment.id === id)
}

function updateCommentList(comments: ReviewComment[], id: number, change: (comment: ReviewComment) => ReviewComment | null): ReviewComment[] {
  return comments.flatMap((comment) => {
    if (typeof comment.id !== 'number' || comment.id !== id) return [comment]
    const updated = change(comment)
    return updated === null ? [] : [updated]
  })
}

function parseTopLevelIssueComment(env: ReviewsEnv, value: unknown, number: number, body: string): ReviewComment {
  if (!isRecord(value) || value.number !== number || value.action !== 'add' || !isRecord(value.comment)
    || value.comment.kind !== 'issue_comment' || typeof value.comment.id !== 'number' || !Number.isSafeInteger(value.comment.id) || value.comment.id < 1
    || typeof value.comment.body !== 'string' || typeof value.comment.url !== 'string'
    || !(value.comment.author === null || typeof value.comment.author === 'string')
    || !(value.comment.createdAt === null || typeof value.comment.createdAt === 'string')) {
    throw env.invalid('invalid_upstream', 'The hosting API did not confirm the new pull request comment.')
  }
  if (value.comment.body !== body) throw env.invalid('unknown_completion', 'The hosting API confirmed a different comment body.')
  return {
    kind: 'issue_comment', id: value.comment.id, author: value.comment.author, body: value.comment.body,
    createdAt: value.comment.createdAt, state: null, path: null, line: null, startLine: null, threadId: null,
    isResolved: null, isOutdated: null, reactionSubjectId: null, reactions: [], url: value.comment.url,
  }
}

function parseReplyComment(env: ReviewsEnv, value: unknown, number: number, body: string): ReviewComment {
  if (!isRecord(value) || value.number !== number || value.action !== 'reply' || !isRecord(value.comment)
    || typeof value.comment.id !== 'number' || !Number.isSafeInteger(value.comment.id) || value.comment.id < 1
    || typeof value.comment.body !== 'string' || value.comment.body !== body) {
    throw env.invalid('invalid_upstream', 'The hosting API did not confirm the review reply.')
  }
  const path = value.comment.path === null || typeof value.comment.path === 'string' ? value.comment.path : null
  const line = value.comment.line === null || typeof value.comment.line === 'number' && Number.isSafeInteger(value.comment.line) ? value.comment.line : null
  const startLine = value.comment.startLine === null || typeof value.comment.startLine === 'number' && Number.isSafeInteger(value.comment.startLine) ? value.comment.startLine : null
  return {
    kind: 'review_comment', id: value.comment.id, author: null, body, createdAt: null, state: null, path, line, startLine,
    threadId: null, isResolved: null, isOutdated: null, reactionSubjectId: null, reactions: [],
  }
}

function parseEditedComment(env: ReviewsEnv, value: unknown, number: number, commentId: number, body: string): ReviewComment {
  if (!isRecord(value) || value.number !== number || value.action !== 'edit' || !isRecord(value.comment)
    || value.comment.kind !== 'issue_comment' || value.comment.id !== commentId || value.comment.body !== body
    || !(value.comment.author === null || typeof value.comment.author === 'string')
    || !(value.comment.createdAt === null || typeof value.comment.createdAt === 'string')
    || typeof value.comment.url !== 'string') {
    throw env.invalid('invalid_upstream', 'The hosting API did not confirm the comment edit.')
  }
  return {
    kind: 'issue_comment', id: commentId, author: value.comment.author, body, createdAt: value.comment.createdAt,
    state: null, path: null, line: null, startLine: null, threadId: null, isResolved: null, isOutdated: null,
    reactionSubjectId: null, reactions: [], url: value.comment.url,
  }
}

function mergeOverlay(comments: ReviewComment[], overlay: Map<string, ReviewComment | null>): ReviewComment[] {
  const byKey = new Map(comments.map((comment) => [commentIdKey(comment), comment]))
  for (const [key, comment] of overlay) {
    if (comment === null) byKey.delete(key)
    else {
      const existing = byKey.get(key)
      if (existing?.body === comment.body) overlay.delete(key)
      else byKey.set(key, comment)
    }
  }
  return [...byKey.values()].slice(-100)
}

export function detailMethods(env: ReviewsEnv): ReviewMethodTable {
  const reads = new Map<string, number>()
  const writeVersions = new Map<string, number>()
  const mutationCounters = new Map<string, number>()
  const pendingCounts = new Map<string, number>()
  const commentOverlays = new Map<string, Map<string, ReviewComment | null>>()
  const draftRevisions = new Map<string, number>()

  const surface = (params: JsonRecord) => parseSurface(env, params.surface)
  const selection = (params: JsonRecord, selectedSurface: Surface, needsReview = true) => selectionFromParams(env, params, selectedSurface, needsReview)
  const checkNumber = (params: JsonRecord, selected: Selection) => requireMatchingNumber(env, selected, params.number)
  const getOverlay = (selected: Selection) => {
    const key = targetCommentKey(selected)
    let overlay = commentOverlays.get(key)
    if (overlay === undefined) {
      overlay = new Map()
      commentOverlays.set(key, overlay)
    }
    return overlay
  }

  const methods: Record<string, MethodHandler> = {
    async open(params, caller) {
      const number = positiveNumber(env, params.number, 'number')
      if (typeof params.worktree !== 'string' || params.worktree.trim() === '') throw env.invalid('invalid_input', 'worktree must be a non-empty selector.')
      const requestedTab = params.tab === undefined ? 'conversation' : params.tab
      if (!tabs.includes(requestedTab as ReviewTab)) throw env.invalid('invalid_input', 'tab must be conversation, checks, or files.')
      const repo = params.prRepo === undefined ? null : parseRepoIdentity(params.prRepo)
      if (params.prRepo !== undefined && repo === null) throw env.invalid('invalid_input', 'prRepo must include a valid host, owner, and repository.')
      const worktree = await env.resolve({ worktree: params.worktree }, caller)
      const target = {
        worktree: worktree.id,
        number,
        tab: requestedTab as ReviewTab,
        ...(repo === null ? {} : { prRepo: repo }),
      } as ReviewTargetWithRepo
      await env.openView(REVIEW_VIEW, {
        worktree: worktree.id,
        number,
        tab: target.tab,
        ...(repo === null ? {} : { prRepo: repo }),
      })
      env.update((state) => {
        state.detail = {
          ...state.detail,
          target,
          tab: target.tab ?? 'conversation',
          generation: state.detail.generation + 1,
          loading: false,
          error: null,
          review: null,
          details: null,
          checks: null,
          comments: null,
          files: null,
          expandedChecks: [],
          queuedComments: [],
          selectedFile: null,
          diffMode: 'inline',
          collapsedFiles: [],
          fileFilter: '',
          commentDraft: '',
          bodyDraft: null,
          pending: [],
          fetchedAt: 0,
        }
      })
      return { worktree: worktree.id, number, tab: target.tab, ...(repo === null ? {} : { prRepo: repo }) }
    },

    async detailRefresh(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, false)
      const readKey = `${selected.identity}\u0000${selected.generation}`
      const request = (reads.get(readKey) ?? 0) + 1
      reads.set(readKey, request)
      const writeVersionAtStart = writeVersions.get(selected.identity) ?? 0
      applyIfOwner(env, selected, (state) => {
        if (selectedSurface === 'detail') {
          state.detail.loading = true
          state.detail.error = null
        } else {
          state.checks.loading = true
          state.checks.error = null
        }
      })
      const loaded = { review: false, details: false, checks: false, comments: false, files: false }
      const errors: string[] = []
      const noData = () => ({ surface: selectedSurface, number: selected.number, ok: false, errors, loaded, fetchedAt: Date.now() })
      const hostParams = hostingParams(selected)
      let lookup: RepoLookupResult | null = null
      try {
        const raw = await env.call('quirky.hosting/review', hostParams)
        lookup = parseReviewLookup(raw)
        if (lookup === null || lookup.kind === 'found' && lookup.review.number !== selected.number) {
          throw env.invalid('invalid_upstream', 'The hosting API returned an invalid pull request response.')
        }
      } catch (error) {
        const message = errorMessage(error)
        errors.push(message)
        if (reads.get(readKey) === request && ownerMatches(env.read(), selected)) {
          applyIfOwner(env, selected, (state) => {
            if (selectedSurface === 'detail') {
              state.detail.loading = false
              state.detail.error = message
            } else {
              state.checks.loading = false
              state.checks.error = message
            }
          })
        }
        return noData()
      }
      if (!lookup || lookup.kind !== 'found') {
        const message = lookup?.kind === 'unavailable' ? lookup.message : `Pull request #${selected.number} was not found.`
        errors.push(message)
        if (reads.get(readKey) === request && ownerMatches(env.read(), selected)) {
          applyIfOwner(env, selected, (state) => {
            if (lookup?.kind === 'no-review') assignReview(state, selectedSurface, null)
            if (selectedSurface === 'detail') {
              state.detail.loading = false
              state.detail.error = message
              state.detail.fetchedAt = lookup?.fetchedAt ?? Date.now()
            } else {
              state.checks.loading = false
              state.checks.error = message
              state.checks.fetchedAt = lookup?.fetchedAt ?? Date.now()
            }
          })
        }
        return noData()
      }
      loaded.review = true
      const review = lookup.review
      const urlRepo = repoFromReviewUrl(review.url, review.number)
      if (urlRepo === null || selected.repo !== null && !sameRepo(selected.repo, urlRepo)) {
        const message = 'The pull request URL did not match the selected trusted repository.'
        errors.push(message)
        surfaceError(env, selected, message)
        return noData()
      }
      const source = selected.repo ?? urlRepo
      const sourceSelection: Selection = {
        ...selected,
        repo: source,
        identity: selectionIdentity(selected.worktree, selected.number, source),
      }
      const nextReview = { ...review, prRepo: source } as ReviewData
      const selectedArgs = { worktree: selected.worktree, number: selected.number, prRepo: source }
      const detailArgs = { worktree: selected.worktree, kind: 'pullRequest', reference: review.url }
      const stackRequested = review.stack !== null && review.stack !== undefined
      const results = await Promise.allSettled([
        env.call('quirky.hosting/workItemDetails', detailArgs),
        env.call('quirky.hosting/checks', { ...selectedArgs, noCache: true }),
        env.call('quirky.hosting/comments', { ...selectedArgs, noCache: true }),
        env.call('quirky.hosting/files', { ...selectedArgs, noCache: true }),
        stackRequested
          ? env.call('quirky.hosting/reviewStack', { ...selectedArgs, noCache: true })
          : Promise.resolve(null),
      ])
      const detailsResult = results[0]
      const checksResult = results[1]
      const commentsResult = results[2]
      const filesResult = results[3]
      const stackResult = results[4]
      let details: JsonRecord | null = null
      let checks: JsonRecord | null = null
      let comments: JsonRecord | null = null
      let files: JsonRecord | null = null
      if (detailsResult?.status === 'fulfilled' && isRecord(detailsResult.value) && isRecord(detailsResult.value.item)
        && detailsResult.value.item.number === selected.number) {
        details = detailsResult.value
        loaded.details = true
      } else {
        errors.push(detailsResult?.status === 'rejected' ? errorMessage(detailsResult.reason) : 'The hosting API returned invalid pull request details.')
      }
      let stack: ReviewStackResult | null = null
      if (stackRequested) {
        stack = stackResult?.status === 'fulfilled' ? parseReviewStackResult(stackResult.value, selected.number) : null
        if (stack === null) {
          errors.push(stackResult?.status === 'rejected' ? errorMessage(stackResult.reason) : 'The hosting API returned invalid stack membership.')
        } else if (!stack.available || stack.truncated || stack.stack === null) {
          errors.push(stack.reason ?? 'Complete stack membership is unavailable; use the provider merge box.')
        }
        if (stack !== null) details = { ...(details ?? {}), reviewStack: stack }
      }
      const priorReview = surfaceReview(env.read(), selectedSurface)
      const headChanged = priorReview !== null && priorReview.headRefOid.toLowerCase() !== review.headRefOid.toLowerCase()
      const overlay = getOverlay(sourceSelection)
      if (headChanged) {
        for (const [key, comment] of overlay) if (comment?.kind === 'review_comment') overlay.delete(key)
      }
      const parsedChecks = checksResult?.status === 'fulfilled' ? parseChecksResult(checksResult.value, selected.number) : null
      if (parsedChecks !== null) {
        const checkHead = parsedChecks.headSha
        if (typeof checkHead === 'string' && checkHead.toLowerCase() === review.headRefOid.toLowerCase()) {
          checks = parsedChecks
          loaded.checks = true
        } else {
          errors.push('Check data belongs to a different pull request head; refresh before using it.')
        }
      } else {
        errors.push(checksResult?.status === 'rejected' ? errorMessage(checksResult.reason) : 'The hosting API returned invalid check data.')
      }
      const parsedComments = commentsResult?.status === 'fulfilled' ? parseCommentsResult(commentsResult.value, selected.number) : null
      if (parsedComments !== null) {
        const rawComments = parsedComments.comments as unknown as ReviewComment[]
        comments = { ...parsedComments, comments: mergeOverlay(rawComments, overlay) }
        loaded.comments = true
      } else {
        errors.push(commentsResult?.status === 'rejected' ? errorMessage(commentsResult.reason) : 'The hosting API returned invalid comment data.')
      }
      const parsedFiles = filesResult?.status === 'fulfilled' ? parseFilesResult(filesResult.value, selected.number) : null
      if (parsedFiles !== null) {
        files = parsedFiles
        loaded.files = true
      } else {
        errors.push(filesResult?.status === 'rejected' ? errorMessage(filesResult.reason) : 'The hosting API returned invalid changed-file data.')
      }
      const now = Date.now()
      const fresh = reads.get(readKey) === request && selectionMatches(env.read(), selected)
      const writesUnchanged = (writeVersions.get(selected.identity) ?? 0) === writeVersionAtStart
      if (fresh && writesUnchanged) {
        const errorsText = errors.length === 0 ? null : errors.join(' ')
        applyIfOwner(env, sourceSelection, (state) => {
          assignReview(state, selectedSurface, nextReview)
          if (selectedSurface === 'detail') {
            const target = state.detail.target as ReviewTargetWithRepo | null
            if (target !== null) state.detail.target = { ...target, prRepo: source }
            state.detail.details = details ?? state.detail.details
            state.detail.checks = checks ?? (headChanged ? null : state.detail.checks)
            state.detail.comments = comments ?? (headChanged ? withoutInlineComments(state.detail.comments, selected.number) : state.detail.comments)
            state.detail.files = files ?? (headChanged ? null : state.detail.files)
            state.detail.error = errorsText
            state.detail.loading = false
            state.detail.fetchedAt = now
            if (headChanged) {
              state.detail.selectedFile = null
              state.detail.expandedChecks = []
              state.detail.queuedComments = []
              state.detail.collapsedFiles = []
            }
          } else {
            state.checks.checks = checks ?? (headChanged ? null : state.checks.checks)
            state.checks.comments = comments ?? (headChanged ? withoutInlineComments(state.checks.comments, selected.number) : state.checks.comments)
            state.checks.error = errorsText
            state.checks.loading = false
            state.checks.fetchedAt = now
            if (headChanged) {
              state.checks.expandedChecks = []
              state.checks.queuedComments = []
            }
          }
        })
      } else if (fresh) {
        applyIfOwner(env, selected, (state) => {
          if (selectedSurface === 'detail') state.detail.loading = false
          else state.checks.loading = false
        })
        errors.push('A newer review mutation completed while this refresh was in flight; stale data was discarded.')
      }
      return { surface: selectedSurface, number: selected.number, ok: errors.length === 0, errors, loaded, fetchedAt: now }
    },

    async detailSetTab(params) {
      const selected = selection(params, 'detail', false)
      const tab = params.tab
      if (!tabs.includes(tab as ReviewTab)) throw env.invalid('invalid_input', 'tab must be conversation, checks, or files.')
      applyIfOwner(env, selected, (state) => {
        state.detail.tab = tab as ReviewTab
        if (state.detail.target) state.detail.target = { ...state.detail.target, tab: tab as ReviewTab }
      })
      return { tab }
    },

    async detailSetAudience(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, false)
      if (!audiences.includes(params.audience as typeof audiences[number])) throw env.invalid('invalid_input', 'audience must be all, humans, or bots.')
      applyIfOwner(env, selected, (state) => {
        if (selectedSurface === 'detail') state.detail.audience = params.audience as typeof audiences[number]
        else state.checks.audience = params.audience as typeof audiences[number]
      })
      return { surface: selectedSurface, audience: params.audience }
    },

    async detailSetGrouping(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, false)
      if (!groupings.includes(params.grouping as typeof groupings[number])) throw env.invalid('invalid_input', 'grouping must be grouped or timeline.')
      applyIfOwner(env, selected, (state) => {
        if (selectedSurface === 'detail') state.detail.grouping = params.grouping as typeof groupings[number]
        else state.checks.grouping = params.grouping as typeof groupings[number]
      })
      return { surface: selectedSurface, grouping: params.grouping }
    },

    async detailSetCommentDraft(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, false)
      if (typeof params.body !== 'string' || new TextEncoder().encode(params.body).byteLength > 65_536) throw env.invalid('invalid_input', 'Comment drafts must be at most 64 KiB.')
      if (typeof params.draftVersion !== 'number' || !Number.isSafeInteger(params.draftVersion) || params.draftVersion < 0) {
        throw env.invalid('invalid_input', 'draftVersion must be a non-negative integer.')
      }
      const key = `${selected.identity}\\u0000${selected.generation}\\u0000${selectedSurface}\\u0000comment-draft`
      const previous = draftRevisions.get(key)
      const applied = previous === undefined || params.draftVersion > previous
      if (applied) {
        draftRevisions.set(key, params.draftVersion)
        applyIfOwner(env, selected, (state) => {
          if (selectedSurface === 'detail') state.detail.commentDraft = params.body as string
          else state.checks.commentDraft = params.body as string
        })
      }
      return { surface: selectedSurface, body: params.body, draftVersion: params.draftVersion, applied }
    },

    async detailSetBodyDraft(params) {
      const selected = selection(params, 'detail', false)
      const body = params.body
      if (!(body === null || typeof body === 'string') || typeof body === 'string' && new TextEncoder().encode(body).byteLength > 1_048_576) {
        throw env.invalid('invalid_input', 'The pull request description draft must be a string or null and at most 1 MiB.')
      }
      if (typeof params.draftVersion !== 'number' || !Number.isSafeInteger(params.draftVersion) || params.draftVersion < 0) {
        throw env.invalid('invalid_input', 'draftVersion must be a non-negative integer.')
      }
      const key = `${selected.identity}\\u0000${selected.generation}\\u0000body-draft`
      const previous = draftRevisions.get(key)
      const applied = previous === undefined || params.draftVersion > previous
      if (applied) {
        draftRevisions.set(key, params.draftVersion)
        applyIfOwner(env, selected, (state) => { state.detail.bodyDraft = body as string | null })
      }
      return { body, draftVersion: params.draftVersion, applied }
    },

    async detailSetFilesView(params) {
      const selected = selection(params, 'detail', false)
      if (typeof params.fileFilter !== 'string' || params.fileFilter.length > 256
        || params.diffMode !== 'inline' && params.diffMode !== 'side-by-side'
        || !(params.selectedFile === null || typeof params.selectedFile === 'string')
        || !Array.isArray(params.collapsedFiles) || params.collapsedFiles.length > 300
        || !params.collapsedFiles.every((path) => typeof path === 'string')
        || typeof params.treeVisible !== 'boolean') {
        throw env.invalid('invalid_input', 'The files view state is invalid or exceeds its bounds.')
      }
      applyIfOwner(env, selected, (state) => {
        state.detail.fileFilter = params.fileFilter as string
        state.detail.diffMode = params.diffMode as 'inline' | 'side-by-side'
        state.detail.selectedFile = params.selectedFile as string | null
        state.detail.collapsedFiles = [...new Set(params.collapsedFiles as string[])]
        const detail = state.detail as typeof state.detail & { fileTreeVisible: boolean }
        detail.fileTreeVisible = params.treeVisible as boolean
      })
      return {
        fileFilter: params.fileFilter,
        diffMode: params.diffMode,
        selectedFile: params.selectedFile,
        collapsedFiles: [...new Set(params.collapsedFiles as string[])],
        treeVisible: params.treeVisible,
      }
    },

    async detailQueueComment(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, false)
      if (typeof params.commentId !== 'string' || params.commentId.trim() === '' || params.commentId.length > 1024 || typeof params.queued !== 'boolean') {
        throw env.invalid('invalid_input', 'commentId must be a non-empty review comment or thread ID.')
      }
      const queueId = params.commentId
      applyIfOwner(env, selected, (state) => {
        const queue = selectedSurface === 'detail' ? state.detail.queuedComments : state.checks.queuedComments
        const next = params.queued === true
          ? [...new Set([...queue, queueId])]
          : queue.filter((id) => id !== queueId)
        if (selectedSurface === 'detail') state.detail.queuedComments = next
        else state.checks.queuedComments = next
      })
      return { surface: selectedSurface, commentId: queueId, queued: params.queued }
    },


    async detailSetBotOverride(params) {
      if (typeof params.author !== 'string' || params.author.trim() === '' || params.author.length > 256 || typeof params.bot !== 'boolean') {
        throw env.invalid('invalid_input', 'author must be a non-empty login and bot must be a boolean.')
      }
      const author = params.author.trim()
      let overrides: string[] = []
      env.update((state) => {
        const current = [...new Set(state.botOverrides.filter((login) => typeof login === 'string'))]
        const present = current.some((login) => login.toLowerCase() === author.toLowerCase())
        if (params.bot === true && !present) {
          if (current.length >= 500) throw env.invalid('limit_reached', 'The bot author override limit of 500 has been reached.')
          current.push(author)
        }
        if (params.bot === false) {
          const filtered = current.filter((login) => login.toLowerCase() !== author.toLowerCase())
          current.splice(0, current.length, ...filtered)
        }
        state.botOverrides = current
        overrides = [...current]
      })
      return { author, bot: params.bot, overrides }
    },

    async detailExpandCheck(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, false)
      if (typeof params.checkId !== 'string' || params.checkId.trim() === '' || params.checkId.length > 256 || typeof params.expanded !== 'boolean') {
        throw env.invalid('invalid_input', 'checkId must be a non-empty string and expanded must be a boolean.')
      }
      const checkId = params.checkId
      applyIfOwner(env, selected, (state) => {
        const current = selectedSurface === 'detail' ? state.detail.expandedChecks : state.checks.expandedChecks
        const next = params.expanded === true ? [...new Set([...current, checkId])] : current.filter((id) => id !== checkId)
        if (selectedSurface === 'detail') state.detail.expandedChecks = next
        else state.checks.expandedChecks = next
      })
      return { surface: selectedSurface, checkId, expanded: params.expanded }
    },

    async detailRefreshChecks(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const requestHead = selected.review?.headRefOid
      if (requestHead === undefined || requestHead === null) throw env.invalid('head_unavailable', 'The pull request head SHA is unavailable.')
      const readKey = `${selected.identity}\u0000checks\u0000${selected.generation}`
      const request = (reads.get(readKey) ?? 0) + 1
      reads.set(readKey, request)
      const writeVersionAtStart = writeVersions.get(selected.identity) ?? 0
      try {
        const raw = await env.call('quirky.hosting/checks', { ...hostingParams(selected), noCache: true })
        const checks = parseChecksResult(raw, selected.number)
        if (checks === null) throw env.invalid('invalid_upstream', 'The hosting API returned invalid check data.')
        const headSha = checks.headSha
        if (typeof headSha !== 'string' || headSha.toLowerCase() !== requestHead.toLowerCase()) {
          throw env.invalid('stale_head', 'Check data belongs to another pull request head; refresh the review before using it.')
        }
        if (reads.get(readKey) !== request || !selectionMatches(env.read(), selected)
          || (writeVersions.get(selected.identity) ?? 0) !== writeVersionAtStart) {
          throw env.invalid('stale_target', 'A newer review request or mutation owns this checks state.')
        }
        applyIfOwner(env, selected, (state) => {
          assignChecks(state, selectedSurface, checks)
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return { surface: selectedSurface, number: selected.number, headSha, checks: checks.checks }
      } catch (error) {
        if (reads.get(readKey) === request && selectionMatches(env.read(), selected)
          && (writeVersions.get(selected.identity) ?? 0) === writeVersionAtStart) recordError(env, selected, error)
        throw error
      }
    },

    async detailLoadCheckDetails(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const expectedHead = requireHead(env, selected, params.expectedHead)
      const checkRunId = positiveNumber(env, params.checkRunId, 'checkRunId')
      const checks = checkState(env.read(), selectedSurface)
      const parsedChecks = checks === null ? null : parseChecksResult(checks, selected.number)
      const row = parsedChecks?.checks.find((check) => isRecord(check) && check.checkRunId === checkRunId)
      if (!isRecord(row)) throw env.invalid('not_found', 'The selected check run is not in the current pull request checks list.')
      const workflowRunId = params.workflowRunId === undefined ? undefined : positiveNumber(env, params.workflowRunId, 'workflowRunId')
      const jobName = params.jobName
      if (jobName !== undefined && (typeof jobName !== 'string' || jobName.length === 0 || jobName.length > 200)) {
        throw env.invalid('invalid_input', 'jobName must be a non-empty string of at most 200 characters.')
      }
      const detailsParams: JsonRecord = {
        ...hostingParams(selected), checkRunId, noCache: true,
        ...(workflowRunId === undefined ? {} : { workflowRunId }),
        ...(typeof jobName === 'string' ? { jobName } : {}),
      }
      const readKey = `${selected.identity}\u0000check-detail\u0000${selected.generation}\u0000${checkRunId}\u0000${workflowRunId ?? ''}\u0000${jobName ?? ''}`
      const request = (reads.get(readKey) ?? 0) + 1
      reads.set(readKey, request)
      const writeVersionAtStart = writeVersions.get(selected.identity) ?? 0
      try {
        const raw = await env.call('quirky.hosting/checkDetails', detailsParams)
        const details = parseCheckDetail(raw, checkRunId)
        if (details === null) throw env.invalid('invalid_upstream', 'The hosting API returned invalid check details.')
        if (reads.get(readKey) !== request || !selectionMatches(env.read(), selected)
          || selected.review?.headRefOid.toLowerCase() !== expectedHead.toLowerCase()
          || (writeVersions.get(selected.identity) ?? 0) !== writeVersionAtStart) {
          throw env.invalid('stale_head', 'The pull request or check changed while check details were loading.')
        }
        applyIfOwner(env, selected, (state) => {
          const existing = selectedSurface === 'detail' ? state.detail.checks : state.checks.checks
          const detailsById = isRecord(existing?.detailsById) ? { ...existing.detailsById } : {}
          detailsById[String(checkRunId)] = details
          const next = { ...(existing ?? { number: selected.number, checks: [] }), detailsById }
          assignChecks(state, selectedSurface, next)
        })
        return { surface: selectedSurface, number: selected.number, checkRunId, details }
      } catch (error) {
        if (reads.get(readKey) === request && selectionMatches(env.read(), selected)
          && (writeVersions.get(selected.identity) ?? 0) === writeVersionAtStart) recordError(env, selected, error)
        throw error
      }
    },

    async detailRerunChecks(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      if (typeof params.failedOnly !== 'boolean') throw env.invalid('invalid_input', 'failedOnly must be a boolean.')
      const ticket = beginMutation(env, selected, 'rerun-checks', mutationCounters, pendingCounts, writeVersions)
      const writeVersionAfterStart = writeVersions.get(selected.identity) ?? 0
      try {
        const raw = await env.call('quirky.hosting/rerunChecks', { ...hostingParams(selected), failedOnly: params.failedOnly })
        if (!isRecord(raw) || typeof raw.started !== 'number' || !Number.isSafeInteger(raw.started) || raw.started < 1
          || typeof raw.targetCount !== 'number' || !Number.isSafeInteger(raw.targetCount) || raw.targetCount < raw.started
          || !Array.isArray(raw.completedSteps) || !raw.completedSteps.every((step) => typeof step === 'string')) {
          throw env.invalid('invalid_upstream', 'The hosting API did not confirm any check rerun.')
        }
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_head', 'The pull request changed while the rerun was being requested.')
        let refreshed = false
        let refreshError: string | null = null
        try {
          const fresh = await env.call('quirky.hosting/checks', { ...hostingParams(selected), noCache: true })
          const parsed = parseChecksResult(fresh, selected.number)
          if (parsed === null || typeof parsed.headSha !== 'string' || parsed.headSha.toLowerCase() !== selected.head?.toLowerCase()) {
            throw env.invalid('invalid_upstream', 'The rerun was requested, but refreshed check data could not be verified.')
          }
          if (!selectionMatches(env.read(), selected) || (writeVersions.get(selected.identity) ?? 0) !== writeVersionAfterStart) {
            throw env.invalid('stale_target', 'The rerun was requested, but a newer review mutation owns the checks state.')
          }
          refreshed = applyIfOwner(env, selected, (state) => assignChecks(state, selectedSurface, parsed))
          if (!refreshed) throw env.invalid('stale_target', 'The rerun was requested, but the selected review surface changed.')
        } catch (error) {
          refreshError = errorMessage(error)
          surfaceError(env, selected, `The rerun was requested, but checks could not be refreshed: ${refreshError}`)
        }
        return {
          surface: selectedSurface,
          number: selected.number,
          started: raw.started,
          targetCount: raw.targetCount,
          completedSteps: raw.completedSteps,
          refreshed,
          ...(refreshError === null ? {} : { refreshError }),
        }
      } catch (error) {
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailPostComment(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const body = validateBody(env, params.body, 'comment body')
      const replyToId = params.replyToId === undefined ? null : positiveNumber(env, params.replyToId, 'replyToId')
      const ticket = beginMutation(env, selected, 'comment', mutationCounters, pendingCounts, writeVersions)
      try {
        let raw: unknown
        let comment: ReviewComment
        if (replyToId === null) {
          raw = await env.call('quirky.hosting/reviewConversation', { ...hostingParams(selected), action: 'add', body })
          comment = parseTopLevelIssueComment(env, raw, selected.number, body)
        } else {
          raw = await env.call('quirky.hosting/reviewComment', { ...hostingParams(selected), action: 'reply', replyToId, body })
          comment = parseReplyComment(env, raw, selected.number, body)
        }
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before the comment was confirmed.')
        const overlay = getOverlay(selected)
        overlay.set(commentIdKey(comment), comment)
        applyIfOwner(env, selected, (state) => {
          const current = commentState(state, selectedSurface)
          const parsed = current === null ? null : parseCommentsResult(current, selected.number)
          const comments = parsed?.comments as unknown as ReviewComment[] | undefined
          const next = commentsEnvelope(selected.number, [...(comments ?? []), comment], current)
          assignComments(state, selectedSurface, { ...next, comments: mergeOverlay(next.comments as ReviewComment[], overlay) })
          if (selectedSurface === 'detail' && state.detail.commentDraft === body) state.detail.commentDraft = ''
          if (selectedSurface === 'checks' && state.checks.commentDraft === body) state.checks.commentDraft = ''
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return { number: selected.number, comment: { id: comment.id as number, kind: comment.kind, body: comment.body, author: comment.author, createdAt: comment.createdAt, url: comment.url ?? null } }
      } catch (error) {
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailEditComment(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const commentId = positiveNumber(env, params.commentId, 'commentId')
      const body = validateBody(env, params.body, 'comment body')
      const comments = commentsFromState(env, selected)
      const index = commentIndex(comments, commentId)
      const original = comments[index]
      if (!original || original.kind !== 'issue_comment' || original.path !== null || original.threadId !== null) {
        throw env.invalid('invalid_target', 'Only a top-level conversation comment can be edited.')
      }
      const ticket = beginMutation(env, selected, `comment:${commentId}`, mutationCounters, pendingCounts, writeVersions)
      const optimistic = { ...original, body }
      applyIfOwner(env, selected, (state) => {
        const current = commentState(state, selectedSurface)
        const parsed = current === null ? null : parseCommentsResult(current, selected.number)
        if (parsed === null) return
        const list = updateCommentList(parsed.comments as unknown as ReviewComment[], commentId, (value) => ({ ...value, body }))
        assignComments(state, selectedSurface, { ...parsed, comments: list })
      })
      try {
        const raw = await env.call('quirky.hosting/reviewConversation', { ...hostingParams(selected), action: 'edit', commentId, body })
        const edited = parseEditedComment(env, raw, selected.number, commentId, body)
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before the comment edit was confirmed.')
        getOverlay(selected).set(commentIdKey(edited), edited)
        applyIfOwner(env, selected, (state) => {
          const current = commentState(state, selectedSurface)
          const parsed = current === null ? null : parseCommentsResult(current, selected.number)
          if (parsed !== null) assignComments(state, selectedSurface, { ...parsed, comments: updateCommentList(parsed.comments as unknown as ReviewComment[], commentId, () => edited) })
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return { number: selected.number, commentId, body, updated: true }
      } catch (error) {
        if (isLatest(ticket, mutationCounters)) {
          applyIfOwner(env, selected, (state) => {
            const current = commentState(state, selectedSurface)
            const parsed = current === null ? null : parseCommentsResult(current, selected.number)
            if (parsed !== null) assignComments(state, selectedSurface, { ...parsed, comments: updateCommentList(parsed.comments as unknown as ReviewComment[], commentId, () => original) })
          })
        }
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailDeleteComment(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const commentId = positiveNumber(env, params.commentId, 'commentId')
      const comments = commentsFromState(env, selected)
      const original = comments[commentIndex(comments, commentId)]
      if (!original || original.kind !== 'issue_comment' || original.path !== null || original.threadId !== null) {
        throw env.invalid('invalid_target', 'Only a top-level conversation comment can be deleted.')
      }
      const ticket = beginMutation(env, selected, `comment:${commentId}`, mutationCounters, pendingCounts, writeVersions)
      applyIfOwner(env, selected, (state) => {
        const current = commentState(state, selectedSurface)
        const parsed = current === null ? null : parseCommentsResult(current, selected.number)
        if (parsed !== null) assignComments(state, selectedSurface, { ...parsed, comments: updateCommentList(parsed.comments as unknown as ReviewComment[], commentId, () => null) })
      })
      try {
        const raw = await env.call('quirky.hosting/reviewConversation', { ...hostingParams(selected), action: 'delete', commentId, yes: true })
        if (!isRecord(raw) || raw.number !== selected.number || raw.action !== 'delete' || raw.commentId !== commentId || raw.deleted !== true) {
          throw env.invalid('invalid_upstream', 'The hosting API did not confirm the comment deletion.')
        }
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before comment deletion was confirmed.')
        const overlay = getOverlay(selected)
        overlay.set(`issue_comment:${commentId}`, null)
        applyIfOwner(env, selected, (state) => {
          const current = commentState(state, selectedSurface)
          const parsed = current === null ? null : parseCommentsResult(current, selected.number)
          if (parsed !== null) assignComments(state, selectedSurface, { ...parsed, comments: updateCommentList(parsed.comments as unknown as ReviewComment[], commentId, () => null) })
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return { number: selected.number, commentId, deleted: true }
      } catch (error) {
        if (isLatest(ticket, mutationCounters)) {
          applyIfOwner(env, selected, (state) => {
            const current = commentState(state, selectedSurface)
            const parsed = current === null ? null : parseCommentsResult(current, selected.number)
            if (parsed !== null && commentIndex(parsed.comments as unknown as ReviewComment[], commentId) === -1) {
              assignComments(state, selectedSurface, { ...parsed, comments: [...parsed.comments, original] })
            }
          })
        }
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailResolveThread(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      if (typeof params.threadId !== 'string' || params.threadId.trim() === '' || params.threadId.length > 1024 || typeof params.resolved !== 'boolean') {
        throw env.invalid('invalid_input', 'threadId and resolved are required.')
      }
      const comments = commentsFromState(env, selected)
      if (!comments.some((comment) => comment.threadId === params.threadId)) throw env.invalid('invalid_target', 'The review thread is not part of this pull request.')
      const oldStates = comments.filter((comment) => comment.threadId === params.threadId).map((comment) => comment.isResolved)
      const ticket = beginMutation(env, selected, `thread:${params.threadId}`, mutationCounters, pendingCounts, writeVersions)
      const setResolved = (resolved: boolean | null) => applyIfOwner(env, selected, (state) => {
        const current = commentState(state, selectedSurface)
        const parsed = current === null ? null : parseCommentsResult(current, selected.number)
        if (parsed === null) return
        const next = (parsed.comments as unknown as ReviewComment[]).map((comment) => comment.threadId === params.threadId ? { ...comment, isResolved: resolved } : comment)
        assignComments(state, selectedSurface, { ...parsed, comments: next })
      })
      setResolved(params.resolved as boolean)
      try {
        const raw = await env.call('quirky.hosting/resolveThread', { ...hostingParams(selected), threadId: params.threadId, action: params.resolved === true ? 'resolve' : 'unresolve' })
        const expectedAction = params.resolved === true ? 'resolve' : 'unresolve'
        if (!isRecord(raw) || raw.number !== selected.number || raw.threadId !== params.threadId || raw.action !== expectedAction || raw.resolved !== params.resolved) {
          throw env.invalid('invalid_upstream', 'The hosting API did not confirm the review thread state.')
        }
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before the thread update was confirmed.')
        surfaceError(env, selected, null)
        return { number: selected.number, threadId: params.threadId, resolved: params.resolved }
      } catch (error) {
        if (isLatest(ticket, mutationCounters)) {
          let offset = 0
          applyIfOwner(env, selected, (state) => {
            const current = commentState(state, selectedSurface)
            const parsed = current === null ? null : parseCommentsResult(current, selected.number)
            if (parsed === null) return
            const next = (parsed.comments as unknown as ReviewComment[]).map((comment) => {
              if (comment.threadId !== params.threadId) return comment
              const isResolved = oldStates[offset] ?? null
              offset += 1
              return { ...comment, isResolved }
            })
            assignComments(state, selectedSurface, { ...parsed, comments: next })
          })
        }
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailReact(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      if (typeof params.subjectId !== 'string' || params.subjectId.trim() === '' || params.subjectId.length > 1024
        || !reactions.includes(params.content as typeof reactions[number]) || typeof params.add !== 'boolean') {
        throw env.invalid('invalid_input', 'Reaction target, content, and action are required.')
      }
      const comments = commentsFromState(env, selected)
      if (!comments.some((comment) => comment.reactionSubjectId === params.subjectId)) throw env.invalid('invalid_target', 'The reaction subject is not part of this pull request.')
      const content = params.content as typeof reactions[number]
      const ticket = beginMutation(env, selected, `reaction:${params.subjectId}:${content}`, mutationCounters, pendingCounts, writeVersions)
      const patch = (viewerHasReacted: boolean, countDelta: number) => applyIfOwner(env, selected, (state) => {
        const current = commentState(state, selectedSurface)
        const parsed = current === null ? null : parseCommentsResult(current, selected.number)
        if (parsed === null) return
        const next = (parsed.comments as unknown as ReviewComment[]).map((comment) => {
          if (comment.reactionSubjectId !== params.subjectId) return comment
          const found = comment.reactions.find((reaction) => reaction.content === content)
          const nextReactions = comment.reactions.filter((reaction) => reaction.content !== content)
          const count = Math.max(0, (found?.count ?? 0) + countDelta)
          if (viewerHasReacted || count > 0) nextReactions.push({ content, count, viewerHasReacted })
          return { ...comment, reactions: nextReactions }
        })
        assignComments(state, selectedSurface, { ...parsed, comments: next })
      })
      patch(params.add as boolean, params.add === true ? 1 : -1)
      try {
        const raw = await env.call('quirky.hosting/reaction', { ...hostingParams(selected), subjectId: params.subjectId, action: params.add === true ? 'add' : 'remove', content })
        if (!isRecord(raw) || raw.subjectId !== params.subjectId || raw.action !== (params.add === true ? 'add' : 'remove') || raw.content !== content || raw.changed !== true) {
          throw env.invalid('invalid_upstream', 'The hosting API did not confirm the reaction.')
        }
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before the reaction was confirmed.')
        surfaceError(env, selected, null)
        return { number: selected.number, subjectId: params.subjectId, content, add: params.add, changed: true }
      } catch (error) {
        if (isLatest(ticket, mutationCounters)) patch(!(params.add as boolean), params.add === true ? -1 : 1)
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailUpdateBody(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      if (typeof params.body !== 'string' || new TextEncoder().encode(params.body).byteLength > 1_048_576) throw env.invalid('invalid_input', 'The pull request description must be at most 1 MiB.')
      const body = params.body
      const before = selected.review
      if (before === null) throw env.invalid('no_review', 'The pull request is not available.')
      const ticket = beginMutation(env, selected, 'description', mutationCounters, pendingCounts, writeVersions)
      applyIfOwner(env, selected, (state) => {
        const current = surfaceReview(state, selectedSurface)
        if (current !== null) assignReview(state, selectedSurface, withReviewChange(current, { body }))
        if (selectedSurface === 'detail' && state.detail.details && isRecord(state.detail.details.item)) {
          state.detail.details = { ...state.detail.details, item: { ...state.detail.details.item, body } }
        }
      })
      try {
        const raw = await env.call('quirky.hosting/updateReview', { ...hostingParams(selected), action: 'edit', body })
        if (!parseNumberResult(raw, selected.number) || raw.updated !== true) throw env.invalid('invalid_upstream', 'The hosting API did not confirm the pull request description update.')
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before the description update was confirmed.')
        applyIfOwner(env, selected, (state) => {
          const current = surfaceReview(state, selectedSurface)
          if (current !== null) assignReview(state, selectedSurface, withReviewChange(current, { body }))
          if (selectedSurface === 'detail') {
            if (state.detail.details && isRecord(state.detail.details.item)) {
              state.detail.details = { ...state.detail.details, item: { ...state.detail.details.item, body } }
            }
            state.detail.bodyDraft = null
            state.detail.error = null
          } else state.checks.error = null
        })
        return { number: selected.number, body, updated: true }
      } catch (error) {
        if (isLatest(ticket, mutationCounters)) {
          applyIfOwner(env, selected, (state) => {
            const current = surfaceReview(state, selectedSurface)
            if (current !== null && current.body === body) assignReview(state, selectedSurface, withReviewChange(current, { body: before.body }))
            if (selectedSurface === 'detail' && state.detail.details && isRecord(state.detail.details.item) && state.detail.details.item.body === body) {
              state.detail.details = { ...state.detail.details, item: { ...state.detail.details.item, body: before.body } }
            }
          })
        }
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailUpdateReviewers(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const action = params.action
      if (action !== 'add' && action !== 'remove' || !Array.isArray(params.logins) || params.logins.length < 1 || params.logins.length > 15
        || !params.logins.every((login) => typeof login === 'string' && login.trim().length > 0 && login.trim().length <= 39)) {
        throw env.invalid('invalid_input', 'Reviewer updates need one to fifteen valid logins.')
      }
      const logins = [...new Set((params.logins as string[]).map((login) => login.trim().replace(/^@+/, '')))]
      if (logins.length === 0 || logins.some((login) => !/^[A-Za-z0-9-]{1,39}$/.test(login))) throw env.invalid('invalid_input', 'Reviewer logins are invalid.')
      const ticket = beginMutation(env, selected, 'reviewers', mutationCounters, pendingCounts, writeVersions)
      try {
        const raw = await env.call('quirky.hosting/reviewers', { ...hostingParams(selected), action, logins })
        const reviewers = parseReviewerList(raw, selected.number)
        if (reviewers === null || !isRecord(raw) || raw.updated !== true) throw env.invalid('invalid_upstream', 'The hosting API did not confirm the reviewer update.')
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before reviewers were updated.')
        applyIfOwner(env, selected, (state) => {
          const current = surfaceReview(state, selectedSurface)
          if (current !== null) assignReview(state, selectedSurface, withReviewChange(current, { requestedReviewers: reviewers }))
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return { number: selected.number, reviewers, updated: true }
      } catch (error) {
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailUpdateAssignees(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const action = params.action
      if (action !== 'add' && action !== 'remove' && action !== 'set' || !Array.isArray(params.logins) || params.logins.length > 100
        || !params.logins.every((login) => typeof login === 'string' && login.trim().length > 0 && login.trim().length <= 256)) {
        throw env.invalid('invalid_input', 'Assignee updates need a valid action and at most 100 logins.')
      }
      const logins = [...new Set((params.logins as string[]).map((login) => login.trim()))]
      const ticket = beginMutation(env, selected, 'assignees', mutationCounters, pendingCounts, writeVersions)
      try {
        const raw = await env.call('quirky.hosting/reviewAssignees', { ...hostingParams(selected), action, logins })
        const assignees = parseAssigneeList(raw, selected.number)
        if (assignees === null) throw env.invalid('invalid_upstream', 'The hosting API did not confirm the assignee update.')
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before assignees were updated.')
        applyIfOwner(env, selected, (state) => {
          const current = surfaceReview(state, selectedSurface)
          if (current !== null) assignReview(state, selectedSurface, withReviewChange(current, { assignees }))
          if (selectedSurface === 'detail' && state.detail.details && isRecord(state.detail.details.item)) {
            state.detail.details = { ...state.detail.details, item: { ...state.detail.details.item, assignees } }
          }
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return { number: selected.number, assignees }
      } catch (error) {
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailMarkReady(params) {
      return updateReviewState(env, params, 'ready', mutationCounters, pendingCounts, writeVersions)
    },

    async detailCloseReview(params) {
      return updateReviewState(env, params, 'close', mutationCounters, pendingCounts, writeVersions)
    },

    async detailReopenReview(params) {
      return updateReviewState(env, params, 'reopen', mutationCounters, pendingCounts, writeVersions)
    },

    async detailMergeConfirmation(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      requireHead(env, selected, params.expectedHead)
      const method = params.method
      const action = params.action
      if (!mergeMethods.includes(method as typeof mergeMethods[number]) || action !== 'direct' && action !== 'queue') {
        throw env.invalid('invalid_input', 'Merge method or action is invalid.')
      }
      const review = selected.review as ReviewData
      const policy = reviewMethods(review)
      if (!policy.known || !policy.allowed.includes(method as string)) {
        throw env.invalid('merge_method_unavailable', 'The selected merge method is not allowed by current repository metadata.')
      }
      const allowed = action === 'direct' ? directMergeAllowed(review) : queueMergeAllowed(review)
      if (!allowed) throw env.invalid('merge_blocked', 'The pull request is not currently eligible for that merge action.')
      const entries = includedStackEntries(env, selected)
      const methodLabel = method === 'squash' ? 'Squash and merge' : method === 'merge' ? 'Create merge commit' : 'Rebase and merge'
      const actionLabel = action === 'queue' ? 'Queue' : 'Merge'
      const heading = `${actionLabel} PR #${selected.number} (${review.title}) using ${methodLabel}?`
      return entries.length === 0 ? heading : `${heading}\\nIncluded pull requests:\\n${entries.map((entry) => `#${entry.number} ${entry.title}`).join('\\n')}`
    },

    async detailMerge(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const expectedHead = requireHead(env, selected, params.expectedHead)
      const method = params.method
      const action = params.action
      if (!mergeMethods.includes(method as typeof mergeMethods[number]) || action !== 'direct' && action !== 'queue') throw env.invalid('invalid_input', 'Merge method or action is invalid.')
      const available = reviewMethods(selected.review as ReviewData)
      if (!available.known || !available.allowed.includes(method as string)) throw env.invalid('merge_method_unavailable', 'The selected merge method is not allowed by the current repository metadata.')
      const allowed = action === 'direct' ? directMergeAllowed(selected.review as ReviewData) : queueMergeAllowed(selected.review as ReviewData)
      if (!allowed) throw env.invalid('merge_blocked', action === 'direct' ? 'The pull request is not currently eligible for a direct merge.' : 'The pull request is not currently eligible for the merge queue.')
      includedStackEntries(env, selected)
      const ticket = beginMutation(env, selected, 'merge', mutationCounters, pendingCounts, writeVersions)
      try {
        const raw = await env.call('quirky.hosting/merge', { ...hostingParams(selected), expectedHead, method, action, yes: true })
        if (!isRecord(raw) || raw.number !== selected.number || !['merged', 'enqueued', 'pending'].includes(String(raw.state))
          || typeof raw.head !== 'string' || raw.head.toLowerCase() !== expectedHead.toLowerCase()
          || raw.operationId !== undefined && typeof raw.operationId !== 'string') {
          throw env.invalid('invalid_upstream', 'The hosting API did not confirm the merge or queue request.')
        }
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_head', 'The pull request changed before the merge was confirmed.')
        applyIfOwner(env, selected, (state) => {
          const current = surfaceReview(state, selectedSurface)
          if (current === null) return
          if (raw.state === 'merged') assignReview(state, selectedSurface, withReviewChange(current, { state: 'merged' }))
          else assignReview(state, selectedSurface, withReviewChange(current, { state: 'open', autoMergeRequest: { state: raw.state, operationId: raw.operationId ?? null } }))
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return {
          number: selected.number,
          state: raw.state,
          head: raw.head,
          ...(typeof raw.operationId === 'string' ? { operationId: raw.operationId } : {}),
        }
      } catch (error) {
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailSetAutoMerge(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      const expectedHead = requireHead(env, selected, params.expectedHead)
      if (typeof params.enabled !== 'boolean') throw env.invalid('invalid_input', 'enabled must be a boolean.')
      const method = params.method === undefined ? undefined : params.method
      if (method !== undefined && !mergeMethods.includes(method as typeof mergeMethods[number])) throw env.invalid('invalid_input', 'method must be a supported merge method.')
      const policy = reviewMethods(selected.review as ReviewData)
      if (params.enabled === true && (!policy.known || method === undefined || !policy.allowed.includes(method as string))) {
        throw env.invalid('merge_method_unavailable', 'Current repository merge metadata does not allow the requested auto-merge method.')
      }
      const ticket = beginMutation(env, selected, 'auto-merge', mutationCounters, pendingCounts, writeVersions)
      try {
        const raw = await env.call('quirky.hosting/autoMerge', {
          ...hostingParams(selected), action: params.enabled === true ? 'enable' : 'disable', expectedHead,
          ...(method === undefined ? {} : { method }),
        })
        if (!isRecord(raw) || raw.number !== selected.number || raw.enabled !== params.enabled || typeof raw.state !== 'string') {
          throw env.invalid('invalid_upstream', 'The hosting API did not confirm the auto-merge state.')
        }
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_head', 'The pull request changed before the auto-merge state was confirmed.')
        applyIfOwner(env, selected, (state) => {
          const current = surfaceReview(state, selectedSurface)
          if (current !== null) assignReview(state, selectedSurface, withReviewChange(current, {
            autoMergeRequest: params.enabled === true ? { state: raw.state, enabled: true, method: method ?? policy.defaultMethod } : null,
          }))
          if (selectedSurface === 'detail') state.detail.error = null
          else state.checks.error = null
        })
        return { number: selected.number, enabled: params.enabled, state: raw.state }
      } catch (error) {
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailSetFileViewed(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      if (typeof params.path !== 'string' || params.path.trim() === '' || params.path.length > 1024 || typeof params.viewed !== 'boolean') {
        throw env.invalid('invalid_input', 'path and viewed are required for a changed-file update.')
      }
      if (selectedSurface !== 'detail') throw env.invalid('unsupported_surface', 'Changed-file state is available only on the pull request detail page.')
      const originalFiles = filesFromState(env, selected)
      const file = originalFiles.find((item) => item.path === params.path)
      if (!file) throw env.invalid('invalid_target', 'The selected path is not a changed file on this pull request.')
      const ticket = beginMutation(env, selected, `file:${params.path}`, mutationCounters, pendingCounts, writeVersions)
      applyIfOwner(env, selected, (state) => {
        const current = state.detail.files
        const parsed = current === null ? null : parseFilesResult(current, selected.number)
        if (parsed === null) return
        const files = (parsed.files as unknown as ChangedFile[]).map((entry) => entry.path === params.path ? { ...entry, viewed: params.viewed as boolean } : entry)
        state.detail.files = { ...parsed, files }
      })
      try {
        const raw = await env.call('quirky.hosting/fileViewed', { ...hostingParams(selected), path: params.path, viewed: params.viewed })
        if (!isRecord(raw) || raw.number !== selected.number || raw.path !== params.path || raw.viewed !== params.viewed) throw env.invalid('invalid_upstream', 'The hosting API did not confirm the viewed-file state.')
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_head', 'The pull request changed before the viewed-file state was confirmed.')
        surfaceError(env, selected, null)
        return { number: selected.number, path: params.path, viewed: params.viewed }
      } catch (error) {
        if (isLatest(ticket, mutationCounters)) applyIfOwner(env, selected, (state) => {
          const current = state.detail.files
          const parsed = current === null ? null : parseFilesResult(current, selected.number)
          if (parsed === null) return
          const files = (parsed.files as unknown as ChangedFile[]).map((entry) => entry.path === params.path ? { ...entry, viewed: file.viewed } : entry)
          state.detail.files = { ...parsed, files }
        })
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },

    async detailInlineComment(params) {
      const selectedSurface = surface(params)
      const selected = selection(params, selectedSurface, true)
      checkNumber(params, selected)
      if (selectedSurface !== 'detail') throw env.invalid('unsupported_surface', 'Inline review comments are available only on the pull request detail page.')
      const expectedHead = requireHead(env, selected, params.expectedHead)
      const path = params.path
      const line = positiveNumber(env, params.line, 'line')
      const startLine = params.startLine === undefined ? line : positiveNumber(env, params.startLine, 'startLine')
      if (typeof path !== 'string' || path.trim() === '' || path.length > 1024 || startLine > line) throw env.invalid('invalid_input', 'The inline comment path or range is invalid.')
      const body = validateBody(env, params.body, 'review comment body')
      const files = filesFromState(env, selected)
      const changedFile = files.find((file) => file.path === path)
      if (!changedFile) throw env.invalid('invalid_coordinates', 'The inline comment path is not part of the selected pull request diff.')
      const rightLines = new Set(changedFile.coordinates.filter((coordinate) => coordinate.side === 'RIGHT').map((coordinate) => coordinate.line))
      for (let coordinate = startLine; coordinate <= line; coordinate += 1) {
        if (!rightLines.has(coordinate)) throw env.invalid('invalid_coordinates', 'The selected comment range is not present on the current side of the pull request diff.')
      }
      const ticket = beginMutation(env, selected, 'inline-comment', mutationCounters, pendingCounts, writeVersions)
      try {
        const raw = await env.call('quirky.hosting/reviewComment', {
          ...hostingParams(selected), action: 'inline', body, headSha: expectedHead, path, line,
          ...(startLine === line ? {} : { startLine }),
        })
        if (!isRecord(raw) || raw.number !== selected.number || raw.action !== 'inline' || !isRecord(raw.comment)
          || typeof raw.comment.id !== 'number' || !Number.isSafeInteger(raw.comment.id) || raw.comment.id < 1
          || raw.comment.path !== path || raw.comment.line !== line || raw.comment.startLine !== (startLine === line ? null : startLine)
          || raw.comment.body !== body) throw env.invalid('invalid_upstream', 'The hosting API did not confirm the inline comment coordinates.')
        if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_head', 'The pull request head changed before the inline comment was confirmed.')
        const inline: ReviewComment = {
          kind: 'review_comment', id: raw.comment.id, author: null, body, createdAt: null, state: null, path,
          line, startLine: startLine === line ? null : startLine, threadId: null, isResolved: null, isOutdated: false,
          reactionSubjectId: null, reactions: [],
        }
        const overlay = getOverlay(selected)
        overlay.set(commentIdKey(inline), inline)
        applyIfOwner(env, selected, (state) => {
          const current = state.detail.comments
          const parsed = current === null ? null : parseCommentsResult(current, selected.number)
          const previous = parsed === null ? null : parsed
          const currentComments = parsed?.comments as unknown as ReviewComment[] | undefined
          const next = commentsEnvelope(selected.number, [...(currentComments ?? []), inline], previous)
          state.detail.comments = { ...next, comments: mergeOverlay(next.comments as ReviewComment[], overlay) }
          state.detail.error = null
        })
        return { number: selected.number, comment: { id: inline.id as number, path, line, startLine: inline.startLine, body } }
      } catch (error) {
        recordError(env, selected, error)
        throw error
      } finally {
        finishMutation(env, ticket, mutationCounters, pendingCounts)
      }
    },
  }

  return methods
}

async function updateReviewState(
  env: ReviewsEnv,
  params: JsonRecord,
  action: 'ready' | 'close' | 'reopen',
  mutationCounters: Map<string, number>,
  pendingCounts: Map<string, number>,
  writeVersions: Map<string, number>,
): Promise<unknown> {
  const selectedSurface = parseSurface(env, params.surface)
  const selected = selectionFromParams(env, params, selectedSurface, true)
  requireMatchingNumber(env, selected, params.number)
  const before = selected.review
  if (before === null) throw env.invalid('no_review', 'The pull request is not available.')
  if (action === 'ready' && before.state !== 'draft') throw env.invalid('invalid_state', 'Only a draft pull request can be marked ready.')
  if (action === 'close' && before.state !== 'open' && before.state !== 'draft') throw env.invalid('invalid_state', 'Only an open pull request can be closed.')
  if (action === 'reopen' && before.state !== 'closed') throw env.invalid('invalid_state', 'Only a closed pull request can be reopened.')
  const operation = action === 'ready' ? 'ready' : action
  const ticket = beginMutation(env, selected, operation, mutationCounters, pendingCounts, writeVersions)
  const optimisticState = action === 'close' ? 'closed' : 'open'
  if (action !== 'ready') applyIfOwner(env, selected, (state) => {
    const current = surfaceReview(state, selectedSurface)
    if (current !== null) assignReview(state, selectedSurface, withReviewChange(current, { state: optimisticState }))
  })
  try {
    const raw = await env.call('quirky.hosting/updateReview', { ...hostingParams(selected), action })
    const expected = action === 'close' ? 'closed' : 'open'
    if (!parseReviewUpdate(raw, selected.number, expected)) throw env.invalid('invalid_upstream', `The hosting API did not confirm the pull request ${action} action.`)
    if (!selectionMatches(env.read(), selected)) throw env.invalid('stale_target', 'The selected pull request changed before the state update was confirmed.')
    applyIfOwner(env, selected, (state) => {
      const current = surfaceReview(state, selectedSurface)
      if (current !== null) assignReview(state, selectedSurface, withReviewChange(current, { state: expected }))
      if (selectedSurface === 'detail') state.detail.error = null
      else state.checks.error = null
    })
    return { number: selected.number, state: expected, updated: true }
  } catch (error) {
    if (action !== 'ready' && mutationCounters.get(ticket.key) === ticket.sequence) {
      applyIfOwner(env, selected, (state) => {
        const current = surfaceReview(state, selectedSurface)
        if (current !== null && current.state === optimisticState) assignReview(state, selectedSurface, withReviewChange(current, { state: before.state }))
      })
    }
    recordError(env, selected, error)
    throw error
  } finally {
    finishMutation(env, ticket, mutationCounters, pendingCounts)
  }
}
