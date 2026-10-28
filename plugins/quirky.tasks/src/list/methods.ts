import type { ItemKind, ItemTarget, TaskItem, TaskListResult, TaskMethodTable, TaskRepo, TasksEnv } from '../contracts'
import { createWorkspaceMethods } from './workspace'
import { planSearch } from './search'
import {
  canonicalIdentity,
  eligibleRepositories,
  errorReason,
  identityFromTarget,
  issueSourceMatchesTarget,
  messageOf,
  object,
  resolveRepoSource,
  sourceMatchesTarget,
  targetLinkKey,
  text,
  type GitHubIdentity,
  type ResolvedRepoSource
} from './source'

const MAX_REVIEWER_TEXT = 2048
const MAX_REVIEWERS = 15
const MAX_SEARCH_RESULTS = 1000
const MAX_PER_REPO = 36

type ListMode = 'issues' | 'prs'
type ListArgs = { mode?: unknown; repoIds?: unknown; query?: unknown; page?: unknown; refresh?: unknown; noCache?: unknown }
type Failure = TaskListResult['failures'][number] & { stage?: string; source?: string }

function invalid(env: TasksEnv, message: string): never {
  throw env.context.error('invalid-params', message)
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function optionalBool(env: TasksEnv, value: unknown, label: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') invalid(env, `${label} must be a boolean.`)
  return value
}

function listMode(env: TasksEnv, value: unknown, fallback: string): ListMode {
  const mode = value === undefined ? fallback : value
  if (mode === 'issues' || mode === 'prs') return mode
  return invalid(env, 'mode must be issues or prs.')
}

function readTarget(env: TasksEnv, value: unknown): ItemTarget {
  const target = object(value)
  if (!target || typeof target.worktree !== 'string' || target.worktree.length === 0 || (target.kind !== 'issue' && target.kind !== 'pullRequest')) {
    return invalid(env, 'target requires a worktree and kind issue or pullRequest.')
  }
  const number = positiveInteger(target.number)
  if (number === null) return invalid(env, 'target.number must be a positive safe integer.')
  const url = target.url === undefined ? undefined : typeof target.url === 'string' ? target.url : invalid(env, 'target.url must be a string.')
  const owner = target.owner === undefined ? undefined : typeof target.owner === 'string' ? target.owner : invalid(env, 'target.owner must be a string.')
  const repo = target.repo === undefined ? undefined : typeof target.repo === 'string' ? target.repo : invalid(env, 'target.repo must be a string.')
  const host = target.host === undefined ? undefined : typeof target.host === 'string' ? target.host : invalid(env, 'target.host must be a string.')
  const projectId = target.projectId === undefined ? undefined : typeof target.projectId === 'string' ? target.projectId : invalid(env, 'target.projectId must be a string.')
  const itemId = target.itemId === undefined ? undefined : typeof target.itemId === 'string' ? target.itemId : invalid(env, 'target.itemId must be a string.')
  const result: ItemTarget = {
    worktree: target.worktree,
    kind: target.kind as ItemKind,
    number,
    ...(url !== undefined ? { url } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(itemId !== undefined ? { itemId } : {})
  }
  if (url !== undefined && !identityFromTarget(result)) invalid(env, 'target.url must be a valid URL for the selected issue or pull request.')
  return result
}

function stringArray(env: TasksEnv, value: unknown, label: string, limit: number): string[] {
  if (!Array.isArray(value)) return invalid(env, `${label} must be an array of strings.`)
  if (value.length > limit) return invalid(env, `${label} must contain at most ${limit} values.`)
  const values: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 256) return invalid(env, `${label} must contain non-empty strings up to 256 characters.`)
    if (!values.some((current) => current.toLowerCase() === entry.trim().toLowerCase())) values.push(entry.trim())
  }
  return values
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.map(object).filter((entry): entry is Record<string, unknown> => entry !== null)
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function taskItem(value: unknown): TaskItem | null {
  const raw = object(value)
  if (!raw || (raw.kind !== 'issue' && raw.kind !== 'pullRequest')) return null
  const number = positiveInteger(raw.number)
  const title = typeof raw.title === 'string' ? raw.title : null
  if (number === null || title === null) return null
  const state = raw.state === 'open' || raw.state === 'closed' || raw.state === 'merged' || raw.state === 'draft' ? raw.state : 'unknown'
  const item: TaskItem = {
    kind: raw.kind,
    number,
    title,
    body: '',
    state,
    url: typeof raw.url === 'string' ? raw.url : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    author: typeof raw.author === 'string' ? raw.author : null,
    labels: strings(raw.labels),
    assignees: strings(raw.assignees),
    isDraft: raw.isDraft === true
  }
  for (const key of ['headRefName', 'baseRefName', 'headRefOid', 'mergeStateStatus', 'reviewDecision', 'stateReason'] as const) {
    if (typeof raw[key] === 'string') item[key] = raw[key]
  }
  for (const key of ['additions', 'deletions', 'changedFiles', 'duplicateOf'] as const) {
    if (typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0) item[key] = raw[key]
  }
  return item
}

function listItems(value: unknown): TaskItem[] {
  const result = object(value)
  return recordArray(result?.items).map(taskItem).filter((item): item is TaskItem => item !== null)
}


function sourceSummary(source: ResolvedRepoSource): Record<string, unknown> {
  const issueSource = canonicalIdentity(source.issueRepository) === canonicalIdentity(source.origin) ? 'origin' : 'upstream'
  return {
    status: source.availability.status,
    ...(source.availability.reason ? { reason: source.availability.reason } : {}),
    ...(source.availability.message ? { message: source.availability.message } : {}),
    host: source.origin.host,
    origin: source.origin,
    issueRepository: source.issueRepository,
    issueSource,
    issueSourcePreference: source.issueSourcePreference,
    issueSourceFellBack: source.issueSourceFellBack,
    candidates: source.candidates
  }
}

function searchRepoMatches(source: ResolvedRepoSource, qualifiers: string[]): boolean {
  if (qualifiers.length === 0) return true
  const identities = [source.origin, source.issueRepository, source.repository, ...source.candidates]
  return qualifiers.some((qualifier) => identities.some((candidate) => `${candidate.owner}/${candidate.repo}`.toLowerCase() === qualifier))
}

function errorFailure(repoId: string, error: unknown, stage: string, source?: string): Failure {
  return {
    repoId,
    message: messageOf(error),
    ...(errorReason(error) ? { reason: errorReason(error) } : {}),
    stage,
    ...(source ? { source } : {})
  }
}

function sortItems(items: TaskListResult['items']): void {
  items.sort((left, right) => {
    const leftDate = Date.parse(left.updatedAt ?? left.createdAt ?? '')
    const rightDate = Date.parse(right.updatedAt ?? right.createdAt ?? '')
    const leftTime = Number.isNaN(leftDate) ? 0 : leftDate
    const rightTime = Number.isNaN(rightDate) ? 0 : rightDate
    if (leftTime !== rightTime) return rightTime - leftTime
    if (left.number !== right.number) return right.number - left.number
    return left.kind.localeCompare(right.kind)
  })
}

async function listWork(env: TasksEnv, params: Record<string, unknown>): Promise<TaskListResult> {
  const state = env.read()
  const navigation = state.navigation
  const links = state.links
  const mode = listMode(env, (params as ListArgs).mode, navigation.mode)
  const kind: ItemKind = mode === 'issues' ? 'issue' : 'pullRequest'
  const rawQuery = (params as ListArgs).query === undefined ? navigation.query : (params as ListArgs).query
  if (typeof rawQuery !== 'string') invalid(env, 'query must be a string.')
  let search: ReturnType<typeof planSearch>
  try {
    search = planSearch(rawQuery, kind)
  } catch (error) {
    invalid(env, messageOf(error))
  }
  const rawPage = (params as ListArgs).page === undefined ? navigation.page : (params as ListArgs).page
  const page = positiveInteger(rawPage)
  if (page === null) invalid(env, 'page must be a positive safe integer.')
  const noCache = optionalBool(env, (params as ListArgs).noCache, 'noCache') || optionalBool(env, (params as ListArgs).refresh, 'refresh')
  const selectedValue = (params as ListArgs).repoIds === undefined ? navigation.repoIds : (params as ListArgs).repoIds
  if (selectedValue !== null && selectedValue !== undefined && (!Array.isArray(selectedValue) || selectedValue.some((id) => typeof id !== 'string'))) {
    invalid(env, 'repoIds must be an array of repository IDs or null.')
  }
  const repos = eligibleRepositories(await env.repositories())
  const selectedIds = selectedValue === null || selectedValue === undefined ? null : new Set(selectedValue as string[])
  if ((params as ListArgs).repoIds !== undefined && selectedIds !== null) {
    const known = new Set(repos.map((repo) => repo.id))
    const unknown = [...selectedIds].filter((id) => !known.has(id))
    if (unknown.length > 0) invalid(env, `Unknown Git repository selection: ${unknown.join(', ')}.`)
  }
  const requestedRepos = selectedIds === null ? repos : repos.filter((repo) => selectedIds.has(repo.id))
  const repoSources = await Promise.all(requestedRepos.map(async (repo) => {
    try {
      const source = await resolveRepoSource(env, repo)
      return { repo, source }
    } catch (error) {
      return { repo, error }
    }
  }))
  const resolved = repoSources.filter((entry): entry is { repo: TaskRepo; source: ResolvedRepoSource } => 'source' in entry)
  if (search.repositories.length > 0 && !resolved.some((entry) => searchRepoMatches(entry.source, search.repositories))) {
    invalid(env, 'Search repository must match a selected configured GitHub source.')
  }
  const qualified = search.repositories.length === 0 ? resolved : resolved.filter((entry) => searchRepoMatches(entry.source, search.repositories))
  const perRepo = qualified.length === 0 ? 0 : Math.max(1, Math.min(MAX_PER_REPO, Math.floor(100 / qualified.length)))
  const pageLimit = perRepo > 0 ? Math.ceil(MAX_SEARCH_RESULTS / perRepo) : 1
  if (page > pageLimit) invalid(env, `page exceeds the ${MAX_SEARCH_RESULTS}-result GitHub search limit.`)

  const failures: Failure[] = []
  const sources: Record<string, unknown> = {}
  for (const entry of repoSources) {
    if ('error' in entry) {
      const reason = errorReason(entry.error)
      sources[entry.repo.id] = { status: 'unresolved', ...(reason ? { reason } : {}), message: messageOf(entry.error) }
      failures.push(errorFailure(entry.repo.id, entry.error, 'source'))
      continue
    }
    sources[entry.repo.id] = sourceSummary(entry.source)
    if (entry.source.availability.status !== 'available') {
      failures.push({
        repoId: entry.repo.id,
        stage: 'availability',
        ...(entry.source.availability.reason ? { reason: entry.source.availability.reason } : {}),
        message: entry.source.availability.message ?? 'GitHub source is unavailable.'
      })
    }
  }
  if (qualified.length === 0 || perRepo === 0) {
    return { items: [], repositories: repos, page, totalPages: 1, perRepo, failures, sources }
  }

  const pageCounts: number[] = []
  const items: TaskListResult['items'] = []
  await Promise.all(qualified.map(async ({ repo, source }) => {
    if (source.availability.status !== 'available') return
    const request = {
      worktree: repo.worktree,
      kind,
      query: search.query,
      page,
      limit: perRepo,
      ...(noCache ? { noCache: true } : {})
    }
    let response: Record<string, unknown> | null
    try {
      response = object(await env.context.call('quirky.hosting/workItemPage', request))
    } catch (error) {
      failures.push(errorFailure(repo.id, error, 'list', kind === 'issue' ? 'issues' : 'prs'))
      return
    }
    const repoListItems = listItems(response).filter((item) => item.kind === kind).map((item) => {
      const linkTarget: ItemTarget = { worktree: repo.worktree, kind: item.kind, number: item.number, url: item.url }
      const linked = links[targetLinkKey(linkTarget)]
      return {
        ...item,
        worktree: repo.worktree,
        repoId: repo.id,
        repoName: repo.displayName?.trim() || repo.name,
        ...(linked ? { linkedWorkspace: { name: linked.name, worktree: linked.worktree } } : {})
      }
    })
    items.push(...repoListItems)
    const errors = object(response?.errors)
    let providerFailed = false
    if (errors) {
      for (const [sourceName, error] of Object.entries(errors)) {
        providerFailed = true
        failures.push({ ...errorFailure(repo.id, error, 'list'), source: sourceName })
      }
    }
    const totalCount = response?.totalCount
    const countKnown = typeof totalCount === 'number' && Number.isSafeInteger(totalCount) && totalCount >= 0
    if (countKnown) {
      pageCounts.push(Math.ceil(totalCount / perRepo))
    } else {
      if (!providerFailed || repoListItems.length > 0) {
        failures.push({ repoId: repo.id, stage: 'count', message: 'GitHub did not provide a total count for this page.' })
      }
      if (response?.hasNextPage === true || repoListItems.length >= perRepo) pageCounts.push(page + 1)
    }
  }))
  sortItems(items)
  const maxPages = Math.ceil(MAX_SEARCH_RESULTS / perRepo)
  const totalPages = Math.min(maxPages, Math.max(1, ...pageCounts))
  return { items, repositories: repos, page, totalPages, perRepo, failures, sources }
}

function parseReviewerLogins(env: TasksEnv, params: Record<string, unknown>): string[] {
  let input: string
  if (params.reviewerText !== undefined) {
    if (typeof params.reviewerText !== 'string') invalid(env, 'reviewerText must be a string.')
    input = params.reviewerText
  } else if (params.logins !== undefined) {
    input = stringArray(env, params.logins, 'logins', MAX_REVIEWERS).join(' ')
  } else {
    return invalid(env, 'reviewerText or logins is required.')
  }
  if (new TextEncoder().encode(input).byteLength > MAX_REVIEWER_TEXT) invalid(env, 'Reviewer input exceeds the 2048-byte limit.')
  const logins = [...new Set(input.split(/[\s,]+/u).map((value) => value.replace(/^@+/u, '')).filter(Boolean))]
  if (logins.length > MAX_REVIEWERS) invalid(env, 'You can request up to 15 reviewers.')
  if (logins.some((login) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login))) invalid(env, 'Reviewer logins must be valid GitHub usernames.')
  return logins
}

function reviewRecord(value: unknown): Record<string, unknown> {
  const envelope = object(value)
  if (!envelope || envelope.kind !== 'found') {
    const message = text(envelope?.message)
    throw new Error(message ?? 'GitHub pull-request metadata is unavailable.')
  }
  const review = object(envelope.review)
  if (!review) throw new Error('GitHub returned no pull-request metadata.')
  return review
}

async function trustedPRRepo(env: TasksEnv, target: ItemTarget): Promise<GitHubIdentity> {
  const repo = eligibleRepositories(await env.repositories()).find((candidate) => candidate.worktree === target.worktree)
  if (!repo) return invalid(env, 'No registered Git repository matches this pull request.')
  const source = await resolveRepoSource(env, repo)
  const targetIdentity = identityFromTarget(target)
  const configured = [source.origin, source.repository, source.issueRepository, ...source.candidates]
  const prRepo = targetIdentity
    ? configured.find((candidate) => canonicalIdentity(candidate) === canonicalIdentity(targetIdentity))
    : source.origin
  if (!prRepo) invalid(env, 'The pull request source is not configured for this repository.')
  return prRepo
}

function verifyReviewTarget(env: TasksEnv, target: ItemTarget, review: Record<string, unknown>): void {
  const reviewUrl = text(review.url)
  if (target.url && reviewUrl !== target.url) invalid(env, 'The pull request source changed; refresh the list before editing it.')
  if (review.number !== target.number) invalid(env, 'GitHub returned metadata for a different pull request.')
}

async function loadReview(env: TasksEnv, target: ItemTarget): Promise<{ review: Record<string, unknown>; prRepo: GitHubIdentity }> {
  if (target.kind !== 'pullRequest') invalid(env, 'Pull-request metadata requires a pullRequest target.')
  const prRepo = await trustedPRRepo(env, target)
  const response = await env.context.call('quirky.hosting/review', {
    worktree: target.worktree,
    number: target.number,
    prRepo
  })
  const review = reviewRecord(response)
  verifyReviewTarget(env, target, review)
  return { review, prRepo }
}

function mergeMethods(review: Record<string, unknown>): { default: string | null; allowed: string[] } {
  const value = object(review.mergeMethods)
  const allowed = strings(value?.allowed).filter((method) => method === 'squash' || method === 'merge' || method === 'rebase')
  const defaultMethod = value?.default === 'squash' || value?.default === 'merge' || value?.default === 'rebase' ? value.default : null
  return { default: defaultMethod, allowed }
}

async function mergeMetadata(env: TasksEnv, target: ItemTarget): Promise<Record<string, unknown>> {
  const { review } = await loadReview(env, target)
  const methods = mergeMethods(review)
  const head = text(review.headRefOid)
  const mergeMetadataKnown = review.mergeMetadataKnown === true
  const mergeQueueRequired = typeof review.mergeQueueRequired === 'boolean' ? review.mergeQueueRequired : null
  const autoMergeAllowed = typeof review.autoMergeAllowed === 'boolean' ? review.autoMergeAllowed : null
  const mergeKnown = mergeMetadataKnown && mergeQueueRequired !== null && head !== null && methods.allowed.length > 0
  const mergeEligible = mergeKnown && mergeQueueRequired === false && review.state === 'open' && review.mergeable === 'MERGEABLE'
  const queueEligible = mergeKnown && mergeQueueRequired === true && review.state === 'open'
  const autoMergeEnabled = review.autoMergeRequest !== null && review.autoMergeRequest !== undefined
  const autoMergeEnableEligible = mergeKnown && autoMergeAllowed === true && review.state === 'open' && review.mergeable !== 'CONFLICTING'
  return {
    kind: 'loaded',
    number: target.number,
    review: {
      state: review.state,
      title: review.title,
      url: review.url,
      headRefOid: head,
      mergeable: review.mergeable,
      mergeStateStatus: review.mergeStateStatus,
      reviewDecision: review.reviewDecision,
      autoMergeRequest: review.autoMergeRequest ?? null,
      mergeMethods: methods,
      mergeQueueRequired,
      autoMergeAllowed,
      mergeMetadataKnown,
      ...(typeof review.isDraft === 'boolean' ? { isDraft: review.isDraft } : {}),
      ...(typeof review.additions === 'number' && Number.isSafeInteger(review.additions) && review.additions >= 0 ? { additions: review.additions } : {}),
      ...(typeof review.deletions === 'number' && Number.isSafeInteger(review.deletions) && review.deletions >= 0 ? { deletions: review.deletions } : {}),
      ...(typeof review.changedFiles === 'number' && Number.isSafeInteger(review.changedFiles) && review.changedFiles >= 0 ? { changedFiles: review.changedFiles } : {}),
      ...(Array.isArray(review.requestedReviewers) ? { requestedReviewers: strings(review.requestedReviewers) } : review.requestedReviewers === null ? { requestedReviewers: null } : {}),
      ...(Array.isArray(review.reviews) || review.reviews === null ? { reviews: review.reviews } : {}),
      ...(Array.isArray(review.assignees) ? { assignees: strings(review.assignees) } : review.assignees === null ? { assignees: null } : {}),
      ...(typeof review.participantsTruncated === 'boolean' ? { participantsTruncated: review.participantsTruncated } : {})
    },
    mergeMetadataKnown,
    mergeQueueRequired,
    autoMergeAllowed,
    mergeKnown,
    mergeEligible,
    queueEligible,
    autoMergeEnabled,
    autoMergeEnableEligible,
    directMethods: mergeEligible ? methods.allowed : [],
    queueMethods: queueEligible ? methods.allowed : [],
  }
}

function safeMethod(env: TasksEnv, value: unknown): 'squash' | 'merge' | 'rebase' {
  if (value === 'squash' || value === 'merge' || value === 'rebase') return value
  return invalid(env, 'method must be squash, merge, or rebase.')
}

async function mutateRow(env: TasksEnv, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = readTarget(env, params.target)
  const action = params.action
  if (action === 'issueStatus') {
    if (target.kind !== 'issue') invalid(env, 'issueStatus requires an issue target.')
    const state = params.state
    if (state !== 'open' && state !== 'closed') invalid(env, 'state must be open or closed.')
    const reason = params.stateReason
    if (reason !== undefined && reason !== 'completed' && reason !== 'not_planned' && reason !== 'duplicate') invalid(env, 'stateReason must be completed, not_planned, or duplicate.')
    const duplicateOf = params.duplicateOf === undefined ? undefined : positiveInteger(params.duplicateOf)
    if (params.duplicateOf !== undefined && duplicateOf === null) invalid(env, 'Enter a whole positive issue number.')
    if (reason === 'duplicate') {
      if (state !== 'closed') invalid(env, 'Duplicate status requires a closed issue.')
      if (duplicateOf === undefined || duplicateOf === null) invalid(env, 'Enter an issue number in this repository.')
      if (duplicateOf === target.number) invalid(env, 'Choose a different issue.')
    } else if (duplicateOf !== undefined) invalid(env, 'duplicateOf is only valid for a duplicate close.')
    if (reason !== undefined && reason !== 'duplicate' && state !== 'closed') invalid(env, 'Close reason requires a closed issue.')
    await assertIssueTarget(env, target)
    const item = await env.context.call('quirky.hosting/updateIssue', {
      worktree: target.worktree,
      number: target.number,
      state,
      ...(reason === 'completed' || reason === 'not_planned' ? { stateReason: reason } : {}),
      ...(duplicateOf !== undefined ? { duplicateOf } : {})
    })
    return { kind: 'updated', action, item }
  }
  if (action === 'assignees') {
    if (target.kind !== 'issue') invalid(env, 'assignees requires an issue target.')
    const desired = stringArray(env, params.assignees, 'assignees', 100)
    await assertIssueTarget(env, target)
    const current = object(await env.context.call('quirky.hosting/workItem', {
      worktree: target.worktree,
      kind: 'issue',
      number: target.number,
      ...(target.url ? { reference: target.url } : {})
    }))
    if (!current) throw new Error(`GitHub issue #${target.number} could not be loaded.`)
    const existing = strings(current.assignees)
    const addAssignees = desired.filter((login) => !existing.some((value) => value.toLowerCase() === login.toLowerCase()))
    const removeAssignees = existing.filter((login) => !desired.some((value) => value.toLowerCase() === login.toLowerCase()))
    if (addAssignees.length === 0 && removeAssignees.length === 0) return { kind: 'updated', action, noChange: true, item: current }
    const item = await env.context.call('quirky.hosting/updateIssue', {
      worktree: target.worktree,
      number: target.number,
      ...(addAssignees.length ? { addAssignees } : {}),
      ...(removeAssignees.length ? { removeAssignees } : {})
    })
    return { kind: 'updated', action, item }
  }
  if (action === 'reviewers') {
    if (target.kind !== 'pullRequest') invalid(env, 'reviewers requires a pullRequest target.')
    const actionValue = params.reviewerAction
    if (actionValue !== 'add' && actionValue !== 'remove') invalid(env, 'reviewerAction must be add or remove.')
    const logins = parseReviewerLogins(env, params)
    const { prRepo } = await loadReview(env, target)
    const result = await env.context.call('quirky.hosting/reviewers', {
      worktree: target.worktree,
      number: target.number,
      prRepo,
      action: actionValue,
      logins
    })
    return { kind: 'updated', action, result }
  }
  if (action === 'issueSource') {
    if (target.kind !== 'issue') invalid(env, 'issueSource applies only to issues.')
    const preference = params.preference
    if (preference !== 'origin' && preference !== 'upstream') invalid(env, 'preference must be origin or upstream.')
    const source = await resolveTargetRepo(env, target)
    const targetIdentity = identityFromTarget(target)
    if (targetIdentity && ![source.origin, ...source.candidates].some((candidate) => canonicalIdentity(candidate) === canonicalIdentity(targetIdentity))) {
      invalid(env, 'The selected issue source is not configured for this repository.')
    }
    const result = await env.context.call('quirky.hosting/configure', { worktree: source.repo.worktree, issueSourcePreference: preference })
    return { kind: 'updated', action, result }
  }
  if (action === 'merge') {
    if (target.kind !== 'pullRequest') invalid(env, 'merge requires a pullRequest target.')
    const method = safeMethod(env, params.method)
    const mergeAction = params.mergeAction === undefined ? 'direct' : params.mergeAction
    if (mergeAction !== 'direct' && mergeAction !== 'queue') invalid(env, 'mergeAction must be direct or queue.')
    const expectedHead = text(params.expectedHead)
    if (!expectedHead) invalid(env, 'expectedHead is required for merge.')
    const { review, prRepo } = await loadReview(env, target)
    const methods = mergeMethods(review)
    if (review.headRefOid !== expectedHead) invalid(env, 'The pull request head changed. Refresh and confirm the merge again.')
    if (review.mergeMetadataKnown !== true || typeof review.mergeQueueRequired !== 'boolean') invalid(env, 'GitHub has not confirmed the merge queue and method safety metadata.')
    if (review.state !== 'open' || !methods.allowed.includes(method)) invalid(env, 'GitHub has not confirmed this merge method is available.')
    if (mergeAction === 'queue' && review.mergeQueueRequired !== true) invalid(env, 'GitHub has not confirmed that this pull request requires a merge queue.')
    if (mergeAction === 'direct' && review.mergeQueueRequired !== false) invalid(env, 'This pull request must use its configured merge queue.')
    if (mergeAction === 'direct' && review.mergeable !== 'MERGEABLE') invalid(env, 'GitHub has not confirmed that this pull request is mergeable.')
    const result = await env.context.call('quirky.hosting/merge', {
      worktree: target.worktree,
      number: target.number,
      prRepo,
      expectedHead,
      method,
      action: mergeAction,
      yes: true
    })
    const outcome = object(result)
    const state = outcome?.state
    if (state !== 'merged' && state !== 'enqueued' && state !== 'pending') throw new Error('GitHub did not confirm the merge outcome.')
    return { kind: state, result }
  }
  if (action === 'autoMerge') {
    if (target.kind !== 'pullRequest') invalid(env, 'autoMerge requires a pullRequest target.')
    const autoAction = params.autoMergeAction
    if (autoAction !== 'enable' && autoAction !== 'disable') invalid(env, 'autoMergeAction must be enable or disable.')
    const { review, prRepo } = await loadReview(env, target)
    const methods = mergeMethods(review)
    const expectedHead = params.expectedHead === undefined ? undefined : text(params.expectedHead)
    if (autoAction === 'enable') {
      if (!expectedHead || expectedHead !== review.headRefOid) invalid(env, 'Confirm the current pull-request head before enabling auto-merge.')
      const method = safeMethod(env, params.method)
      if (review.mergeMetadataKnown !== true || typeof review.mergeQueueRequired !== 'boolean') invalid(env, 'GitHub has not confirmed the auto-merge safety metadata.')
      if (review.autoMergeAllowed !== true) invalid(env, 'GitHub has not enabled auto-merge for this repository.')
      if (review.state !== 'open' || !methods.allowed.includes(method) || review.mergeable === 'CONFLICTING') invalid(env, 'GitHub metadata does not allow auto-merge for this pull request.')
      const result = await env.context.call('quirky.hosting/autoMerge', { worktree: target.worktree, number: target.number, prRepo, action: 'enable', expectedHead, method })
      return { kind: 'updated', action, result }
    }
    const result = await env.context.call('quirky.hosting/autoMerge', { worktree: target.worktree, number: target.number, prRepo, action: 'disable' })
    return { kind: 'updated', action, result }
  }
  return invalid(env, 'action must be issueStatus, assignees, reviewers, issueSource, merge, or autoMerge.')
}

async function assertIssueTarget(env: TasksEnv, target: ItemTarget): Promise<ResolvedRepoSource> {
  const source = await resolveTargetRepo(env, target)
  if (!issueSourceMatchesTarget(source, target)) invalid(env, 'The issue source changed; refresh the item before editing it.')
  return source
}

export async function resolveTargetRepo(env: TasksEnv, target: ItemTarget): Promise<ResolvedRepoSource> {
  const repos = eligibleRepositories(await env.repositories())
  const ordered = [...repos].sort((left, right) => Number(right.worktree === target.worktree) - Number(left.worktree === target.worktree))
  for (const repo of ordered) {
    try {
      const source = await resolveRepoSource(env, repo)
      if (sourceMatchesTarget(source, target)) return source
    } catch {
      continue
    }
  }
  return invalid(env, 'No registered Git repository matches this GitHub item.')
}

async function checks(env: TasksEnv, params: Record<string, unknown>): Promise<unknown> {
  const target = readTarget(env, params.target)
  if (target.kind !== 'pullRequest') invalid(env, 'checks requires a pullRequest target.')
  const noCache = optionalBool(env, params.noCache, 'noCache')
  const prRepo = await trustedPRRepo(env, target)
  return await env.context.call('quirky.hosting/checks', {
    worktree: target.worktree,
    number: target.number,
    prRepo,
    ...(noCache ? { noCache: true } : {})
  })
}
async function options(env: TasksEnv, params: Record<string, unknown>): Promise<unknown> {
  const kind = params.kind
  if (kind === 'reviewers') {
    const target = readTarget(env, params.target)
    if (target.kind !== 'pullRequest') invalid(env, 'Reviewer suggestions require a pullRequest target.')
    const details = object(await env.context.call('quirky.hosting/workItemDetails', {
      worktree: target.worktree,
      kind: 'pullRequest',
      number: target.number,
      ...(target.url ? { reference: target.url } : {})
    }))
    const participants = Array.isArray(details?.participants) ? details.participants.flatMap((entry) => {
      if (typeof entry === 'string') return [entry]
      const user = object(entry)
      return typeof user?.login === 'string' ? [user.login] : []
    }) : []
    const source = await resolveTargetRepo(env, target)
    const targetIdentity = identityFromTarget(target)
    const sameAssignableRepository = targetIdentity !== null && issueSourceMatchesTarget(source, target)
    const assignees = sameAssignableRepository
      ? object(await env.context.call('quirky.hosting/assignees', { worktree: target.worktree }))
      : null
    const suggestions = recordArray(assignees?.assignees).flatMap((user) => typeof user.login === 'string' ? [user.login] : [])
    return { recentlyActive: [...new Set(participants)], suggestions: [...new Set(suggestions)] }
  }
  if (kind !== 'labels' && kind !== 'assignees') invalid(env, 'kind must be labels, assignees, or reviewers.')
  const repoId = params.repoId
  if (typeof repoId !== 'string' || repoId.length === 0) invalid(env, 'repoId is required.')
  const query = params.query
  if (query !== undefined && typeof query !== 'string') invalid(env, 'query must be a string.')
  const repo = eligibleRepositories(await env.repositories()).find((entry) => entry.id === repoId)
  if (!repo) invalid(env, 'repoId must identify a registered Git repository.')
  return await env.context.call(`quirky.hosting/${kind}`, {
    worktree: repo.worktree,
    ...(query !== undefined ? { query } : {})
  })
}


async function rowConfirmation(env: TasksEnv, params: Record<string, unknown>): Promise<string | null> {
  if (params.action !== 'merge') return null
  const target = readTarget(env, params.target)
  if (target.kind !== 'pullRequest') invalid(env, 'merge requires a pullRequest target.')
  const method = safeMethod(env, params.method)
  const action = params.mergeAction ?? 'direct'
  if (action !== 'direct' && action !== 'queue') invalid(env, 'mergeAction must be direct or queue.')
  const head = text(params.expectedHead)
  if (!head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) invalid(env, 'expectedHead must be the full current pull request SHA.')
  const repository = await trustedPRRepo(env, target)
  return `${action === 'queue' ? 'Queue' : 'Merge'} ${method} PR #${target.number} in ${repository.host}/${repository.owner}/${repository.repo} at ${head}?`
}

export function listMethods(env: TasksEnv): TaskMethodTable {
  return {
    list: (params) => listWork(env, params),
    row: (params) => mutateRow(env, params),
    rowConfirmation: (params) => rowConfirmation(env, params),
    checks: (params) => checks(env, params),
    options: (params) => options(env, params),
    mergeMetadata: async (params) => mergeMetadata(env, readTarget(env, params.target)),
    ...createWorkspaceMethods(env)
  }
}
