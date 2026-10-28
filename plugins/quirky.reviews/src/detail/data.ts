import type { JsonRecord, ReviewData, ReviewsState } from '../contracts'

export type RepoIdentity = { host: string; owner: string; repo: string }
export type ReviewComment = {
  kind: 'issue_comment' | 'review' | 'review_comment'
  id: number | string
  author: string | null
  body: string
  createdAt: string | null
  state: string | null
  path: string | null
  line: number | null
  startLine: number | null
  threadId: string | null
  isResolved: boolean | null
  isOutdated: boolean | null
  reactionSubjectId: string | null
  reactions: { content: string; count: number; viewerHasReacted: boolean }[]
  isBot?: boolean
  url?: string | null
}
export type ChangedFile = {
  path: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch: string | null
  isBinary: boolean
  patchUnavailable: boolean
  viewed: boolean | null
  coordinates: { line: number; side: 'LEFT' | 'RIGHT' }[]
}
export type CheckDetail = {
  check: JsonRecord
  annotations: JsonRecord[]
  jobs: JsonRecord[]
  logTails: { jobId: number; jobName: string; tail: string }[]
  partialFailures: string[]
  truncated: boolean
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRepoIdentity(value: unknown): RepoIdentity | null {
  if (!isRecord(value) || typeof value.host !== 'string' || typeof value.owner !== 'string' || typeof value.repo !== 'string') return null
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(value.host)
    || value.owner.length === 0 || value.repo.length === 0
    || value.owner.includes('/') || value.repo.includes('/')) return null
  return { host: value.host, owner: value.owner, repo: value.repo }
}

export function repoFromReviewUrl(value: unknown, expectedNumber?: number): RepoIdentity | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname)
  if (!match) return null
  const owner = match[1]
  const repo = match[2]
  const number = Number(match[3])
  if (!owner || !repo || !Number.isSafeInteger(number) || expectedNumber !== undefined && number !== expectedNumber) return null
  return { host: url.host, owner, repo }
}

export function sameRepo(left: RepoIdentity | null, right: RepoIdentity | null): boolean {
  return left === null ? right === null : right !== null
    && left.host.toLowerCase() === right.host.toLowerCase()
    && left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase()
}

export function parseReviewLookup(value: unknown):
  | { kind: 'found'; review: ReviewData; fetchedAt: number }
  | { kind: 'no-review'; fetchedAt: number }
  | { kind: 'unavailable'; message: string; reason: string; fetchedAt: number }
  | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)) return null
  if (value.kind === 'no-review') return { kind: 'no-review', fetchedAt: value.fetchedAt }
  if (value.kind === 'unavailable') {
    if (typeof value.message !== 'string' || typeof value.reason !== 'string') return null
    return { kind: 'unavailable', message: value.message, reason: value.reason, fetchedAt: value.fetchedAt }
  }
  if (value.kind !== 'found' || !isRecord(value.review)) return null
  const review = value.review
  if (typeof review.provider !== 'string' || typeof review.number !== 'number' || !Number.isSafeInteger(review.number) || review.number < 1
    || typeof review.url !== 'string' || typeof review.title !== 'string' || typeof review.body !== 'string'
    || !['open', 'draft', 'closed', 'merged'].includes(String(review.state))
    || typeof review.headRefName !== 'string' || typeof review.baseRefName !== 'string'
    || typeof review.headRefOid !== 'string' || typeof review.baseRefOid !== 'string'
    || typeof review.mergeable !== 'string' || typeof review.checksStatus !== 'string'
    || typeof review.reviewDecision !== 'string' || typeof review.mergeStateStatus !== 'string'
    || !repoFromReviewUrl(review.url, review.number)) return null
  return { kind: 'found', review: review as unknown as ReviewData, fetchedAt: value.fetchedAt }
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function nullablePositive(value: unknown): value is number | null {
  return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseComment(value: unknown): ReviewComment | null {
  if (!isRecord(value) || !['issue_comment', 'review', 'review_comment'].includes(String(value.kind))) return null
  if (!(typeof value.id === 'string' && value.id.length > 0 || typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0)
    || !nullableString(value.author) || typeof value.body !== 'string' || !nullableString(value.createdAt)
    || !nullableString(value.state) || !nullableString(value.path) || !nullablePositive(value.line)
    || !nullablePositive(value.startLine) || !nullableString(value.threadId)
    || !(value.isResolved === null || typeof value.isResolved === 'boolean')
    || !(value.isOutdated === null || typeof value.isOutdated === 'boolean')
    || !nullableString(value.reactionSubjectId) || !Array.isArray(value.reactions)) return null
  const reactions: ReviewComment['reactions'] = []
  for (const raw of value.reactions) {
    if (!isRecord(raw) || typeof raw.content !== 'string' || typeof raw.count !== 'number'
      || !Number.isSafeInteger(raw.count) || raw.count < 0 || typeof raw.viewerHasReacted !== 'boolean') return null
    reactions.push({ content: raw.content, count: raw.count, viewerHasReacted: raw.viewerHasReacted })
  }
  if (value.isBot !== undefined && typeof value.isBot !== 'boolean') return null
  if (value.url !== undefined && !nullableString(value.url)) return null
  const comment: ReviewComment = {
    kind: value.kind as ReviewComment['kind'],
    id: value.id,
    author: value.author,
    body: value.body,
    createdAt: value.createdAt,
    state: value.state,
    path: value.path,
    line: value.line,
    startLine: value.startLine,
    threadId: value.threadId,
    isResolved: value.isResolved,
    isOutdated: value.isOutdated,
    reactionSubjectId: value.reactionSubjectId,
    reactions,
  }
  if (value.isBot !== undefined) comment.isBot = value.isBot
  if (value.url !== undefined) comment.url = value.url
  return comment
}

export function parseCommentsResult(value: unknown, number: number): JsonRecord | null {
  if (!isRecord(value) || value.number !== number || !Array.isArray(value.comments)
    || typeof value.partial !== 'boolean' || !Array.isArray(value.partialFailures)
    || !value.partialFailures.every((entry) => typeof entry === 'string') || value.comments.length > 100) return null
  const comments: ReviewComment[] = []
  for (const raw of value.comments) {
    const comment = parseComment(raw)
    if (comment === null) return null
    comments.push(comment)
  }
  return { number, comments, partial: value.partial, partialFailures: value.partialFailures }
}

function parseChangedFile(value: unknown): ChangedFile | null {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.status !== 'string'
    || typeof value.additions !== 'number' || !Number.isSafeInteger(value.additions) || value.additions < 0
    || typeof value.deletions !== 'number' || !Number.isSafeInteger(value.deletions) || value.deletions < 0
    || typeof value.changes !== 'number' || !Number.isSafeInteger(value.changes) || value.changes < 0
    || !(value.patch === null || typeof value.patch === 'string') || typeof value.isBinary !== 'boolean'
    || typeof value.patchUnavailable !== 'boolean' || !(value.viewed === null || typeof value.viewed === 'boolean')
    || !Array.isArray(value.coordinates)) return null
  const coordinates: ChangedFile['coordinates'] = []
  for (const raw of value.coordinates) {
    if (!isRecord(raw) || typeof raw.line !== 'number' || !Number.isSafeInteger(raw.line) || raw.line < 1
      || raw.side !== 'LEFT' && raw.side !== 'RIGHT') return null
    coordinates.push({ line: raw.line, side: raw.side })
  }
  return {
    path: value.path,
    status: value.status,
    additions: value.additions,
    deletions: value.deletions,
    changes: value.changes,
    patch: value.patch,
    isBinary: value.isBinary,
    patchUnavailable: value.patchUnavailable,
    viewed: value.viewed,
    coordinates,
  }
}

export function parseFilesResult(value: unknown, number: number): JsonRecord | null {
  if (!isRecord(value) || value.number !== number || !Array.isArray(value.files)
    || typeof value.truncated !== 'boolean' || typeof value.filesUnavailable !== 'boolean'
    || !Array.isArray(value.partialFailures) || !value.partialFailures.every((entry) => typeof entry === 'string')) return null
  const files: ChangedFile[] = []
  for (const raw of value.files) {
    const file = parseChangedFile(raw)
    if (file === null) return null
    files.push(file)
  }
  return {
    number,
    files,
    truncated: value.truncated,
    filesUnavailable: value.filesUnavailable,
    partialFailures: value.partialFailures,
    ...(typeof value.totalCount === 'number' && Number.isSafeInteger(value.totalCount) && value.totalCount >= 0
      ? { totalCount: value.totalCount }
      : {}),
  }
}

export function parseChecksResult(value: unknown, number: number): JsonRecord | null {
  if (!isRecord(value) || value.number !== number || !Array.isArray(value.checks)
    || typeof value.rollup !== 'string' || !['neutral', 'pending', 'success', 'failure', 'unknown'].includes(value.rollup)
    || !(value.headSha === null || typeof value.headSha === 'string')
    || typeof value.partial !== 'boolean' || !Array.isArray(value.partialFailures)
    || !value.partialFailures.every((entry) => typeof entry === 'string')) return null
  const checks: JsonRecord[] = []
  for (const raw of value.checks) {
    if (!isRecord(raw) || !['check_run', 'status', 'approval'].includes(String(raw.kind))
      || typeof raw.name !== 'string' || typeof raw.status !== 'string'
      || !(raw.conclusion === null || typeof raw.conclusion === 'string')
      || !(raw.url === null || typeof raw.url === 'string')
      || !nullablePositive(raw.checkRunId) || !nullablePositive(raw.workflowRunId) || !nullablePositive(raw.suiteId)) return null
    checks.push(raw)
  }
  return {
    number,
    headSha: value.headSha,
    rollup: value.rollup,
    checks,
    partial: value.partial,
    partialFailures: value.partialFailures,
    ...(value.truncated === true ? { truncated: true } : {}),
  }
}

export function parseCheckDetail(value: unknown, checkRunId: number): CheckDetail | null {
  if (!isRecord(value) || !isRecord(value.check) || value.check.id !== checkRunId
    || !Array.isArray(value.annotations) || !Array.isArray(value.jobs) || !Array.isArray(value.logTails)
    || !Array.isArray(value.partialFailures) || !value.partialFailures.every((entry) => typeof entry === 'string')
    || typeof value.truncated !== 'boolean') return null
  if (value.annotations.length > 20 || value.jobs.length > 100 || value.logTails.length > 5) return null
  const annotations: JsonRecord[] = []
  for (const annotation of value.annotations) {
    if (!isRecord(annotation)) return null
    annotations.push(annotation)
  }
  const jobs: JsonRecord[] = []
  for (const job of value.jobs) {
    if (!isRecord(job)) return null
    jobs.push(job)
  }
  const logTails: CheckDetail['logTails'] = []
  for (const tail of value.logTails) {
    if (!isRecord(tail) || typeof tail.jobId !== 'number' || !Number.isSafeInteger(tail.jobId) || tail.jobId < 1
      || typeof tail.jobName !== 'string' || typeof tail.tail !== 'string') return null
    logTails.push({ jobId: tail.jobId, jobName: tail.jobName, tail: tail.tail })
  }
  return { check: value.check, annotations, jobs, logTails, partialFailures: value.partialFailures, truncated: value.truncated }
}

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' ? url.href : null
  } catch {
    return null
  }
}
export type ReviewContext = {
  surface: 'detail' | 'checks'
  worktree: string
  number: number
  generation: number
  review: ReviewData | null
  repo: RepoIdentity | null
}

export function reviewContext(state: ReviewsState, surface: 'detail' | 'checks'): ReviewContext | null {
  let worktree: string | null
  let number: number | null
  let generation: number
  let review: ReviewData | null
  let source: unknown
  if (surface === 'detail') {
    const target = state.detail.target as (NonNullable<ReviewsState['detail']['target']> & { prRepo?: unknown }) | null
    worktree = target?.worktree ?? null
    number = target?.number ?? null
    generation = state.detail.generation
    review = state.detail.review
    source = target?.prRepo
  } else {
    worktree = state.checks.worktree
    review = state.checks.review
    number = review?.number ?? null
    generation = state.checks.generation
    source = review?.prRepo
  }
  if (typeof worktree !== 'string' || worktree.length === 0 || number === null || !Number.isSafeInteger(number) || number < 1) return null
  if (review !== null && review.number !== number) return null
  const explicit = source === undefined ? null : parseRepoIdentity(source)
  if (source !== undefined && explicit === null) return null
  const urlRepo = review === null ? null : repoFromReviewUrl(review.url, number)
  if (review !== null && urlRepo === null || explicit !== null && urlRepo !== null && !sameRepo(explicit, urlRepo)) return null
  return { surface, worktree, number, generation, review, repo: explicit ?? urlRepo }
}
export type ReviewStackEntry = {
  position: number
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'closed' | 'merged'
  checksStatus: string
  mergeable: string
  updatedAt: string | null
  headRefName: string
  headRefOid: string
  reviewDecision: string
  mergeStateStatus: string
}
export type ReviewStackResult = {
  number: number
  available: boolean
  truncated: boolean
  stack: {
    number: number
    position: number
    size: number
    base: { ref: string; sha: string }
    entries: ReviewStackEntry[]
  } | null
  reason?: string
}

export function parseReviewStackResult(value: unknown, number: number): ReviewStackResult | null {
  if (!isRecord(value) || value.number !== number || typeof value.available !== 'boolean' || typeof value.truncated !== 'boolean') return null
  if (value.reason !== undefined && typeof value.reason !== 'string') return null
  if (value.stack === null) {
    if (value.available) return null
    return { number, available: false, truncated: value.truncated, stack: null, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }
  }
  if (!value.available || !isRecord(value.stack) || !Number.isSafeInteger(value.stack.number) || (value.stack.number as number) < 1
    || !Number.isSafeInteger(value.stack.position) || (value.stack.position as number) < 1
    || !Number.isSafeInteger(value.stack.size) || (value.stack.size as number) < (value.stack.position as number)
    || !isRecord(value.stack.base) || typeof value.stack.base.ref !== 'string' || typeof value.stack.base.sha !== 'string'
    || !Array.isArray(value.stack.entries) || value.stack.entries.length > 100) return null
  const entries: ReviewStackEntry[] = []
  for (const candidate of value.stack.entries) {
    if (!isRecord(candidate) || !Number.isSafeInteger(candidate.position) || (candidate.position as number) < 1
      || !Number.isSafeInteger(candidate.number) || (candidate.number as number) < 1
      || typeof candidate.title !== 'string' || safeHttpUrl(candidate.url) === null
      || !['open', 'draft', 'closed', 'merged'].includes(String(candidate.state))
      || typeof candidate.checksStatus !== 'string' || typeof candidate.mergeable !== 'string'
      || !(candidate.updatedAt === null || typeof candidate.updatedAt === 'string')
      || typeof candidate.headRefName !== 'string' || typeof candidate.headRefOid !== 'string'
      || typeof candidate.reviewDecision !== 'string' || typeof candidate.mergeStateStatus !== 'string') return null
    entries.push({
      position: candidate.position as number,
      number: candidate.number as number,
      title: candidate.title,
      url: safeHttpUrl(candidate.url) as string,
      state: candidate.state as ReviewStackEntry['state'],
      checksStatus: candidate.checksStatus,
      mergeable: candidate.mergeable,
      updatedAt: candidate.updatedAt,
      headRefName: candidate.headRefName,
      headRefOid: candidate.headRefOid,
      reviewDecision: candidate.reviewDecision,
      mergeStateStatus: candidate.mergeStateStatus,
    })
  }
  return {
    number,
    available: true,
    truncated: value.truncated,
    stack: {
      number: value.stack.number as number,
      position: value.stack.position as number,
      size: value.stack.size as number,
      base: { ref: value.stack.base.ref, sha: value.stack.base.sha },
      entries,
    },
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  }
}

export type WorkspaceLink = { worktree: string; name: string; url: string; repoId: string }

export function workspaceLinkFor(value: unknown, url: string): WorkspaceLink | null {
  if (!isRecord(value) || !isRecord(value.links)) return null
  const direct = value.links[url]
  const candidates: unknown[] = direct === undefined ? Object.values(value.links) : [direct]
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.worktree !== 'string' || typeof candidate.name !== 'string'
      || typeof candidate.url !== 'string' || typeof candidate.repoId !== 'string') continue
    if (safeHttpUrl(candidate.url) === url) return { worktree: candidate.worktree, name: candidate.name, url, repoId: candidate.repoId }
  }
  return null
}
