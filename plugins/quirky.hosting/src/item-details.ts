import type { Handler, HostingEnv, Identity, Scope } from './env'
import type { GitHubWorktreeSource } from '@quirky/protocol'
import { parseBranch, parseOid } from './pr-data'
import { normalizeRestPull } from './pr-review'
import {
  array,
  configuredRepositories,
  graphqlData,
  identityKey,
  isRecord,
  mapWorkItem,
  ensureOutputBound,
  nonEmptyString,
  utf8Length,
  positiveInteger,
  positiveParam,
  record,
  requiredList,
  safeErrorReason,
  scopeForRepository,
  sameIdentity,
  pullRequestRepositories,
  string,
  type WorkItemKind,
  type WorkItemRecord
} from './item-data'

const PR_DETAIL_FIELDS = 'number,title,body,state,url,createdAt,updatedAt,author,isDraft,labels,assignees,headRefName,baseRefName,headRefOid,baseRefOid,additions,deletions,changedFiles,reviewDecision,latestReviews,statusCheckRollup,mergeable,mergeStateStatus,autoMergeRequest,maintainerCanModify'
const MAX_TIMELINE = 300
const MAX_COMMENTS = 100
const ITEM_DETAILS_QUERY = `query WorkItemDetails($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      __typename number title body state url createdAt updatedAt
      author { login }
      issueType { id name }
      assignees(first: 50) { nodes { login } pageInfo { hasNextPage } }
      participants(first: 100) { nodes { login } pageInfo { hasNextPage } }
      comments(first: 100) {
        nodes { id body createdAt updatedAt url author { login } authorAssociation }
        pageInfo { hasNextPage }
      }
    }
    pullRequest(number: $number) {
      __typename number title body state url createdAt updatedAt isDraft
      author { login }
      participants(first: 100) { nodes { login } pageInfo { hasNextPage } }
      reviews(first: 100) { nodes { author { login } body submittedAt state } pageInfo { hasNextPage } }
    }
  }
}`

type ItemCaller = Parameters<Handler>[1]

type ParsedReference = { number: number; kind: WorkItemKind | null; identity: Identity }

function validateKind(env: HostingEnv, value: unknown): WorkItemKind | undefined {
  if (value === undefined) return undefined
  if (value === 'issue' || value === 'pullRequest') return value
  throw env.invalid('validation_error', 'kind must be issue or pullRequest.')
}

function parseReference(env: HostingEnv, scope: Scope, reference: unknown): ParsedReference | null {
  if (reference === undefined) return null
  if (typeof reference !== 'string' || reference.length === 0 || utf8Length(reference) > 2048) {
    throw env.invalid('validation_error', 'reference must be a GitHub work-item URL no longer than 2048 bytes.')
  }
  let parsed: URL
  try {
    parsed = new URL(reference)
  } catch {
    throw env.invalid('validation_error', 'reference must be an absolute GitHub work-item URL.')
  }
  if (parsed.protocol !== 'https:' || parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw env.invalid('validation_error', 'reference must be a credential-free HTTPS GitHub work-item URL.')
  }
  const parts = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(parsed.pathname)
  if (!parts) throw env.invalid('validation_error', 'reference must point to a GitHub issue or pull request.')
  const owner = parts[1]
  const repo = parts[2]
  const kind: WorkItemKind = parts[3] === 'issues' ? 'issue' : 'pullRequest'
  const number = positiveInteger(Number(parts[4]))
  if (owner === undefined || repo === undefined || number === null) throw env.invalid('validation_error', 'reference contains an invalid repository or number.')
  const identity = configuredRepositories(scope).find((candidate) =>
    candidate.host.toLowerCase() === parsed.host.toLowerCase() &&
    candidate.owner.toLowerCase() === owner.toLowerCase() &&
    candidate.repo.toLowerCase() === repo.toLowerCase()
  )
  if (!identity) throw env.invalid('validation_error', 'Reference repository must match a configured remote.')
  return { number, kind, identity }
}

function itemOptions(env: HostingEnv, scope: Scope, params: Record<string, unknown>): { number: number; kind: WorkItemKind | undefined; identity: Identity | undefined } {
  const reference = parseReference(env, scope, params.reference)
  const kind = validateKind(env, params.kind)
  const number = positiveParam(env, params, 'number', reference === null)
  if (reference && number !== undefined && number !== reference.number) throw env.invalid('validation_error', 'number does not match the supplied reference.')
  if (reference && kind !== undefined && kind !== reference.kind) throw env.invalid('validation_error', 'kind does not match the supplied reference.')
  if (!reference && number === undefined) throw env.invalid('validation_error', 'number or reference is required.')
  return { number: reference?.number ?? number ?? 0, kind: reference?.kind ?? kind, identity: reference?.identity }
}

function workItemRepositoryOrder(scope: Scope, kind: WorkItemKind | undefined): Identity[] {
  if (kind === 'pullRequest') return pullRequestRepositories(scope)
  if (kind === 'issue') return [...new Map([scope.issueRepository, scope.origin].map((identity) => [identityKey(identity), identity])).values()]
  return [...new Map([scope.issueRepository, ...pullRequestRepositories(scope)].map((identity) => [identityKey(identity), identity])).values()]
}

function isNotFound(error: unknown): boolean {
  return safeErrorReason(error) === 'not_found'
}

async function readIssue(env: HostingEnv, scope: Scope, identity: Identity, number: number): Promise<unknown | null> {
  try {
    return await env.rest(scopeForRepository(scope, identity), `repos/${identity.owner}/${identity.repo}/issues/${number}`, 'GET', undefined, { idempotent: true })
  } catch (error: unknown) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function readPullRequest(env: HostingEnv, scope: Scope, identity: Identity, number: number): Promise<unknown | null> {
  const selected = scopeForRepository(scope, identity)
  try {
    return await env.json(selected, ['pr', 'view', String(number), '--repo', `${identity.owner}/${identity.repo}`, '--json', PR_DETAIL_FIELDS], { idempotent: true })
  } catch (viewError: unknown) {
    try {
      return await env.rest(selected, `repos/${identity.owner}/${identity.repo}/pulls/${number}`, 'GET', undefined, { idempotent: true })
    } catch (restError: unknown) {
      if (isNotFound(restError) && isNotFound(viewError)) return null
      if (isNotFound(restError)) throw viewError
      throw restError
    }
  }
}

async function resolveWorkItem(
  env: HostingEnv,
  scope: Scope,
  number: number,
  kind: WorkItemKind | undefined,
  selectedIdentity: Identity | undefined,
  includeRaw = false
): Promise<{ item: WorkItemRecord; identity: Identity; raw?: unknown } | null> {
  const identities = selectedIdentity ? [selectedIdentity] : workItemRepositoryOrder(scope, kind)
  const preferredPullRepository = selectedIdentity ?? pullRequestRepositories(scope)[0]
  let latestError: unknown
  for (const identity of identities) {
    if (kind !== 'pullRequest') {
      try {
        const issue = await readIssue(env, scope, identity, number)
        if (issue !== null) {
          const raw = record(issue)
          const resultKind: WorkItemKind = raw && isRecord(raw.pull_request) ? 'pullRequest' : 'issue'
          if (resultKind === 'pullRequest') {
            const hydrated = await readPullRequest(env, scope, identity, number)
            const mapped = mapWorkItem(hydrated ?? issue, { identity, kind: 'pullRequest' })
            if (mapped) {
              if (hydrated === null) mapped.partial = true
              return { item: mapped, identity, ...(includeRaw ? { raw: hydrated ?? issue } : {}) }
            }
            throw env.invalid('unknown', 'GitHub returned an invalid pull request.')
          }
          const mapped = mapWorkItem(issue, { identity, kind: 'issue' })
          if (mapped) return { item: mapped, identity, ...(includeRaw ? { raw: issue } : {}) }
        }
      } catch (error: unknown) {
        latestError = error
        if (!isNotFound(error)) throw error
      }
    }
    if (kind !== 'issue' && (kind === 'pullRequest' || (preferredPullRepository !== undefined && identityKey(identity) === identityKey(preferredPullRepository)))) {
      try {
        const pull = await readPullRequest(env, scope, identity, number)
        const mapped = pull === null ? null : mapWorkItem(pull, { identity, kind: 'pullRequest' })
        if (mapped) return { item: mapped, identity, ...(includeRaw ? { raw: pull } : {}) }
      } catch (error: unknown) {
        latestError = error
        if (!isNotFound(error)) throw error
      }
    }
  }
  if (latestError && !isNotFound(latestError)) throw latestError
  return null
}

async function workItem(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<unknown> {
  const scope = await env.resolve(params, caller)
  const options = itemOptions(env, scope, params)
  const cacheKey = env.cacheKey(scope, `work-item:${options.kind ?? 'any'}:${options.number}:${options.identity ? identityKey(options.identity) : 'configured'}`)
  const result = await env.cache(cacheKey, 300_000, () => resolveWorkItem(env, scope, options.number, options.kind, options.identity))
  const item = result?.item ?? null
  ensureOutputBound(env, item, 'Work item')
  return item
}

function participantLogin(value: unknown): string | null {
  const raw = record(value)
  const author = record(raw?.author)
  return nonEmptyString(raw?.login) ?? nonEmptyString(author?.login)
}

function normalizeParticipant(value: unknown): Record<string, unknown> | null {
  const raw = record(value)
  const login = participantLogin(value)
  if (!raw || login === null) return null
  return { login, name: nonEmptyString(raw.name), url: nonEmptyString(raw.url) }
}

function normalizeComment(value: unknown, sourceKind: 'issue' | 'review'): Record<string, unknown> | null {
  const raw = record(value)
  if (!raw) return null
  const id = positiveInteger(raw.id) ?? positiveInteger(raw.databaseId)
  const author = participantLogin(raw.author) ?? participantLogin(raw.user)
  const body = typeof raw.body === 'string' ? raw.body : ''
  const createdAt = nonEmptyString(raw.createdAt) ?? nonEmptyString(raw.created_at) ?? nonEmptyString(raw.submittedAt)
  const result: Record<string, unknown> = {
    kind: sourceKind,
    id,
    body,
    author,
    createdAt,
    updatedAt: nonEmptyString(raw.updatedAt) ?? nonEmptyString(raw.updated_at),
    url: nonEmptyString(raw.url) ?? nonEmptyString(raw.html_url),
    state: nonEmptyString(raw.state),
    authorAssociation: nonEmptyString(raw.authorAssociation) ?? nonEmptyString(raw.author_association)
  }
  return result
}

function normalizeTimelineEvent(value: unknown): Record<string, unknown> | null {
  const raw = record(value)
  if (!raw) return null
  const actor = record(raw.actor)
  const result: Record<string, unknown> = {
    event: nonEmptyString(raw.event) ?? nonEmptyString(raw.__typename) ?? 'unknown',
    createdAt: nonEmptyString(raw.created_at) ?? nonEmptyString(raw.createdAt),
    actor: nonEmptyString(actor?.login),
    commitId: nonEmptyString(raw.commit_id),
    label: nonEmptyString(record(raw.label)?.name),
    state: nonEmptyString(raw.state),
    body: typeof raw.body === 'string' ? raw.body : null
  }
  return result
}

function addParticipant(target: Map<string, Record<string, unknown>>, value: unknown): void {
  const participant = normalizeParticipant(value)
  if (participant && typeof participant.login === 'string') target.set(participant.login.toLowerCase(), participant)
}

function partialMessage(error: unknown, label: string): string {
  const reason = safeErrorReason(error)
  const names: Record<string, string> = {
    rate_limited: 'rate limit',
    permission_denied: 'permission denied',
    auth_required: 'authentication unavailable',
    not_found: 'not found',
    network_error: 'network unavailable',
    too_large: 'response too large',
    unknown: 'upstream unavailable'
  }
  return `${label}: ${names[reason] ?? names.unknown}.`
}

async function loadTimeline(env: HostingEnv, scope: Scope, identity: Identity, number: number): Promise<{ events: Record<string, unknown>[]; truncated: boolean }> {
  const events: Record<string, unknown>[] = []
  let truncated = false
  for (let page = 1; page <= 3; page += 1) {
    const path = `repos/${identity.owner}/${identity.repo}/issues/${number}/timeline?per_page=100&page=${page}`
    const response = await env.rest(scopeForRepository(scope, identity), path, 'GET', undefined, { idempotent: true })
    const values = requiredList(env, response, 'issue timeline')
    events.push(...values.flatMap((value) => {
      const event = normalizeTimelineEvent(value)
      return event === null ? [] : [event]
    }))
    if (values.length < 100) break
    if (events.length >= MAX_TIMELINE) {
      events.length = MAX_TIMELINE
      truncated = true
      break
    }
  }
  return { events, truncated }
}

function connectionNodes(value: unknown): { nodes: unknown[]; hasNextPage: boolean } {
  const connection = record(value)
  const pageInfo = record(connection?.pageInfo)
  return { nodes: array(connection?.nodes), hasNextPage: pageInfo?.hasNextPage === true }
}

async function loadIssueDetails(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  item: WorkItemRecord
): Promise<Record<string, unknown>> {
  const partialFailures: string[] = []
  const participants = new Map<string, Record<string, unknown>>()
  let comments: Record<string, unknown>[] = []
  let updatedItem = item
  let truncated = false
  const gqlScope = scopeForRepository(scope, identity)
  try {
    const result = await env.graphql(gqlScope, ITEM_DETAILS_QUERY, { owner: identity.owner, repo: identity.repo, number: item.number }, { idempotent: true })
    const data = graphqlData(result)
    const repository = record(data?.repository)
    const issue = record(repository?.issue)
    if (issue) {
      const mapped = mapWorkItem(issue, { identity, kind: 'issue' })
      if (mapped) updatedItem = mapped
      const assignees = connectionNodes(issue.assignees)
      const participantNodes = connectionNodes(issue.participants)
      for (const person of [...assignees.nodes, ...participantNodes.nodes]) addParticipant(participants, person)
      const commentConnection = connectionNodes(issue.comments)
      comments = commentConnection.nodes.flatMap((value) => {
        const comment = normalizeComment(value, 'issue')
        return comment === null ? [] : [comment]
      }).slice(0, MAX_COMMENTS)
      truncated = assignees.hasNextPage || participantNodes.hasNextPage || commentConnection.hasNextPage || commentConnection.nodes.length > MAX_COMMENTS
    } else {
      partialFailures.push('GitHub did not return issue details.')
    }
  } catch (error: unknown) {
    partialFailures.push(partialMessage(error, 'Issue details'))
    try {
      const fallback = await env.rest(gqlScope, `repos/${identity.owner}/${identity.repo}/issues/${item.number}`, 'GET', undefined, { idempotent: true })
      const mapped = mapWorkItem(fallback, { identity, kind: 'issue' })
      if (mapped) updatedItem = mapped
    } catch (fallbackError: unknown) {
      partialFailures.push(partialMessage(fallbackError, 'Issue fallback'))
    }
  }

  if (comments.length === 0) {
    try {
      const response = await env.rest(gqlScope, `repos/${identity.owner}/${identity.repo}/issues/${item.number}/comments?per_page=100&page=1`, 'GET', undefined, { idempotent: true })
      const values = requiredList(env, response, 'issue comments')
      comments = values.flatMap((value) => {
        const comment = normalizeComment(value, 'issue')
        return comment === null ? [] : [comment]
      }).slice(0, MAX_COMMENTS)
      if (values.length >= MAX_COMMENTS) truncated = true
      for (const comment of comments) {
        const author = typeof comment.author === 'string' ? comment.author : null
        if (author) addParticipant(participants, { login: author })
      }
    } catch (error: unknown) {
      partialFailures.push(partialMessage(error, 'Issue comments'))
    }
  }

  let timeline: Record<string, unknown>[] = []
  try {
    const result = await loadTimeline(env, scope, identity, item.number)
    timeline = result.events
    truncated = truncated || result.truncated
  } catch (error: unknown) {
    partialFailures.push(partialMessage(error, 'Issue timeline'))
  }
  return {
    item: updatedItem,
    participants: [...participants.values()],
    comments,
    timeline,
    partialFailures,
    truncated
  }
}

function normalizeFile(value: unknown): Record<string, unknown> | null {
  const raw = record(value)
  const filename = nonEmptyString(raw?.filename)
  if (!raw || filename === null) return null
  const additions = positiveInteger(raw.additions) ?? 0
  const deletions = positiveInteger(raw.deletions) ?? 0
  const changes = positiveInteger(raw.changes) ?? additions + deletions
  const patch = string(raw.patch)
  return {
    filename,
    status: nonEmptyString(raw.status) ?? 'unknown',
    additions,
    deletions,
    changes,
    patch,
    isBinary: patch === null && changes > 0
  }
}

async function loadPullDetails(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  item: WorkItemRecord
): Promise<Record<string, unknown>> {
  const partialFailures: string[] = []
  const participants = new Map<string, Record<string, unknown>>()
  const comments: Record<string, unknown>[] = []
  let updatedItem = item
  let files: Record<string, unknown>[] = []
  let filesUnavailable = false
  let truncated = false
  const selected = scopeForRepository(scope, identity)

  try {
    const raw = await env.rest(selected, `repos/${identity.owner}/${identity.repo}/pulls/${item.number}`, 'GET', undefined, { idempotent: true })
    const mapped = mapWorkItem(raw, { identity, kind: 'pullRequest' })
    if (mapped) updatedItem = { ...item, ...mapped }
    const rawPull = record(raw)
    const head = record(rawPull?.head)
    const base = record(rawPull?.base)
    if (head && nonEmptyString(head.sha)) updatedItem.headRefOid = nonEmptyString(head.sha) ?? undefined
    if (base && nonEmptyString(base.sha)) updatedItem.baseRefOid = nonEmptyString(base.sha) ?? undefined
  } catch (error: unknown) {
    partialFailures.push(partialMessage(error, 'Pull request'))
  }

  try {
    const gathered: Record<string, unknown>[] = []
    for (let page = 1; page <= 3; page += 1) {
      const raw = await env.rest(selected, `repos/${identity.owner}/${identity.repo}/pulls/${item.number}/files?per_page=100&page=${page}`, 'GET', undefined, { idempotent: true })
      const values = requiredList(env, raw, 'pull request files')
      gathered.push(...values.flatMap((value) => {
        const file = normalizeFile(value)
        return file === null ? [] : [file]
      }))
      if (values.length < 100) break
      if (gathered.length >= MAX_TIMELINE) {
        gathered.length = MAX_TIMELINE
        truncated = true
        break
      }
    }
    files = gathered
  } catch (error: unknown) {
    filesUnavailable = true
    partialFailures.push(partialMessage(error, 'Pull request files'))
  }

  for (const path of [
    `repos/${identity.owner}/${identity.repo}/issues/${item.number}/comments?per_page=100&page=1`,
    `repos/${identity.owner}/${identity.repo}/pulls/${item.number}/reviews?per_page=100&page=1`
  ]) {
    try {
      const raw = await env.rest(selected, path, 'GET', undefined, { idempotent: true })
      const values = requiredList(env, raw, path.includes('/reviews') ? 'pull request reviews' : 'pull request comments')
      for (const value of values.slice(0, MAX_COMMENTS)) {
        const comment = normalizeComment(value, path.includes('/reviews') ? 'review' : 'issue')
        if (comment) comments.push(comment)
        addParticipant(participants, record(value)?.user ?? record(value)?.author)
      }
      if (values.length >= MAX_COMMENTS) truncated = true
    } catch (error: unknown) {
      partialFailures.push(partialMessage(error, path.includes('/reviews') ? 'Pull request reviews' : 'Pull request comments'))
    }
  }

  try {
    const result = await env.graphql(selected, ITEM_DETAILS_QUERY, { owner: identity.owner, repo: identity.repo, number: item.number }, { idempotent: true })
    const pull = record(record(record(graphqlData(result)?.repository)?.pullRequest))
    if (pull) {
      const participantsPage = connectionNodes(pull.participants)
      const reviewPage = connectionNodes(pull.reviews)
      for (const person of [...participantsPage.nodes, ...reviewPage.nodes]) addParticipant(participants, person)
      truncated = truncated || participantsPage.hasNextPage || reviewPage.hasNextPage
    }
  } catch (error: unknown) {
    partialFailures.push(partialMessage(error, 'Pull request participants'))
  }

  let timeline: Record<string, unknown>[] = []
  try {
    const result = await loadTimeline(env, scope, identity, item.number)
    timeline = result.events
    truncated = truncated || result.truncated
  } catch (error: unknown) {
    partialFailures.push(partialMessage(error, 'Pull request timeline'))
  }

  const statusCheckRollup = await env.json(selected, ['pr', 'view', String(item.number), '--repo', `${identity.owner}/${identity.repo}`, '--json', 'statusCheckRollup'], { idempotent: true }).catch((error: unknown) => {
    partialFailures.push(partialMessage(error, 'Pull request checks'))
    return null
  })
  const checkRows = array(record(statusCheckRollup)?.statusCheckRollup)
  return {
    item: updatedItem,
    files,
    comments,
    participants: [...participants.values()],
    timeline,
    checks: checkRows,
    partialFailures,
    filesUnavailable,
    truncated
  }
}

async function workItemDetails(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<unknown> {
  const scope = await env.resolve(params, caller)
  const options = itemOptions(env, scope, params)
  const key = env.cacheKey(scope, `work-item-details:${options.kind ?? 'any'}:${options.number}:${options.identity ? identityKey(options.identity) : 'configured'}`)
  return env.cache(key, 60_000, async () => {
    const resolved = await resolveWorkItem(env, scope, options.number, options.kind, options.identity)
    if (!resolved) return null
    const detail = resolved.item.kind === 'pullRequest'
      ? await loadPullDetails(env, scope, resolved.identity, resolved.item)
      : await loadIssueDetails(env, scope, resolved.identity, resolved.item)
    ensureOutputBound(env, detail, 'Work-item details')
    return detail
  })
}

type SourceReference = { number: number; kind?: WorkItemKind; identity?: Identity }

function sourceReference(env: HostingEnv, scope: Scope, value: unknown): SourceReference {
  if (typeof value !== 'string' || value.length === 0 || utf8Length(value) > 2048) {
    throw env.invalid('validation_error', 'reference must be #number or a configured GitHub work-item URL no longer than 2048 bytes.')
  }
  const numberMatch = /^#([1-9][0-9]*)$/.exec(value)
  if (numberMatch) {
    const number = positiveInteger(Number(numberMatch[1]))
    if (number === null) throw env.invalid('validation_error', 'reference must contain a positive safe issue or pull request number.')
    return { number }
  }
  const parsed = parseReference(env, scope, value)
  if (!parsed || parsed.kind === null) throw env.invalid('validation_error', 'reference must be #number or a configured GitHub work-item URL.')
  return { number: parsed.number, kind: parsed.kind, identity: parsed.identity }
}

function safeRepositoryPart(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 && value.length <= 100 &&
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    value !== '.' && value !== '..'
}

function safeSourceIdentity(identity: Identity): boolean {
  return /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(identity.host) &&
    safeRepositoryPart(identity.owner) &&
    safeRepositoryPart(identity.repo)
}

function sourceItemUrl(identity: Identity, kind: WorkItemKind, number: number): string {
  return `https://${identity.host}/${identity.owner}/${identity.repo}/${kind === 'issue' ? 'issues' : 'pull'}/${number}`
}

function httpsUrlMatches(value: unknown, identity: Identity, suffix: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    const expectedPath = `/${identity.owner}/${identity.repo}${suffix}`
    const actualPath = suffix.length === 0 ? parsed.pathname.replace(/\/$/, '') : parsed.pathname
    return parsed.protocol === 'https:' &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.host.toLowerCase() === identity.host.toLowerCase() &&
      actualPath.toLowerCase() === expectedPath.toLowerCase()
  } catch {
    return false
  }
}

function sshCloneUrlMatches(value: unknown, identity: Identity): boolean {
  if (typeof value !== 'string') return false
  const scp = /^git@([^/:]+):([^/]+)\/([^/]+)\.git$/i.exec(value)
  if (scp) {
    return scp[1]?.toLowerCase() === identity.host.toLowerCase() &&
      scp[2]?.toLowerCase() === identity.owner.toLowerCase() &&
      scp[3]?.toLowerCase() === identity.repo.toLowerCase()
  }
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'ssh:' &&
      parsed.username === 'git' &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.host.toLowerCase() === identity.host.toLowerCase() &&
      parsed.pathname.toLowerCase() === `/${identity.owner}/${identity.repo}.git`.toLowerCase()
  } catch {
    return false
  }
}

function sourceRepository(value: unknown, host: string): Identity | null {
  const repository = record(value)
  const owner = record(repository?.owner)
  if (!repository || !owner || !safeRepositoryPart(owner.login) || !safeRepositoryPart(repository.name)) return null
  const identity = { host, owner: owner.login, repo: repository.name }
  if (!safeSourceIdentity(identity) || !httpsUrlMatches(repository.html_url, identity, '')) return null
  if (Object.hasOwn(repository, 'clone_url') && !httpsUrlMatches(repository.clone_url, identity, '.git')) return null
  if (Object.hasOwn(repository, 'ssh_url') && !sshCloneUrlMatches(repository.ssh_url, identity)) return null
  return identity
}

function sourceSchemaError(env: HostingEnv): never {
  throw env.invalid('upstream_unavailable', 'GitHub returned incomplete or mismatched worktree source details.')
}

function issueSource(
  env: HostingEnv,
  rawValue: unknown,
  identity: Identity,
  number: number
): GitHubWorktreeSource {
  const raw = record(rawValue)
  if (!raw ||
    positiveInteger(raw.number) !== number ||
    typeof raw.title !== 'string' ||
    raw.title.trim().length === 0 ||
    isRecord(raw.pull_request) ||
    raw.__typename === 'PullRequest' ||
    !safeSourceIdentity(identity) ||
    !httpsUrlMatches(raw.html_url, identity, `/issues/${number}`)) {
    return sourceSchemaError(env)
  }
  return {
    item: {
      provider: 'github',
      kind: 'issue',
      number,
      title: raw.title,
      url: sourceItemUrl(identity, 'issue', number),
      repository: identity
    },
    head: null,
    base: null
  }
}

async function validatedPullRef(
  env: HostingEnv,
  scope: Scope,
  rawValue: unknown,
  normalizedValue: unknown
): Promise<string | null> {
  if (typeof rawValue !== 'string' ||
    typeof normalizedValue !== 'string' ||
    rawValue !== normalizedValue ||
    parseBranch(rawValue) !== rawValue) return null
  try {
    await env.git(scope, ['check-ref-format', `refs/heads/${rawValue}`])
    return rawValue
  } catch {
    return null
  }
}

function canonicalSshCloneUrl(identity: Identity): string {
  return identity.host.includes(':')
    ? `ssh://git@${identity.host}/${identity.owner}/${identity.repo}.git`
    : `git@${identity.host}:${identity.owner}/${identity.repo}.git`
}

async function pullRequestSource(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  number: number
): Promise<GitHubWorktreeSource> {
  const response = await env.rest(
    scopeForRepository(scope, identity),
    `repos/${identity.owner}/${identity.repo}/pulls/${number}`,
    'GET',
    undefined,
    { idempotent: true }
  )
  const raw = record(response)
  const normalized = raw ? normalizeRestPull(raw) : undefined
  const head = record(raw?.head)
  const base = record(raw?.base)
  const headRepository = sourceRepository(head?.repo, identity.host)
  const baseRepository = sourceRepository(base?.repo, identity.host)
  const headRefName = await validatedPullRef(env, scope, head?.ref, normalized?.headRefName)
  const baseRefName = await validatedPullRef(env, scope, base?.ref, normalized?.baseRefName)
  const headOid = parseOid(head?.sha)
  const baseOid = parseOid(base?.sha)
  if (!raw ||
    !normalized ||
    positiveInteger(raw.number) !== number ||
    typeof raw.title !== 'string' ||
    raw.title.trim().length === 0 ||
    !httpsUrlMatches(raw.html_url, identity, `/pull/${number}`) ||
    !safeSourceIdentity(identity) ||
    !headRepository ||
    !baseRepository ||
    !sameIdentity(baseRepository, identity) ||
    !headRefName ||
    !baseRefName ||
    !headOid ||
    !baseOid ||
    normalized.headRefOid !== headOid ||
    normalized.baseRefOid !== baseOid ||
    typeof raw.maintainer_can_modify !== 'boolean') {
    return sourceSchemaError(env)
  }
  return {
    item: {
      provider: 'github',
      kind: 'pullRequest',
      number,
      title: raw.title,
      url: sourceItemUrl(identity, 'pullRequest', number),
      repository: identity
    },
    head: {
      repository: headRepository,
      refName: headRefName,
      oid: headOid,
      sshUrl: canonicalSshCloneUrl(headRepository),
      httpsUrl: `https://${headRepository.host}/${headRepository.owner}/${headRepository.repo}.git`,
      maintainerCanModify: raw.maintainer_can_modify
    },
    base: {
      repository: baseRepository,
      refName: baseRefName,
      oid: baseOid
    }
  }
}

async function worktreeSource(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: ItemCaller
): Promise<GitHubWorktreeSource> {
  const scope = await env.resolve(params, caller)
  const reference = sourceReference(env, scope, params.reference)
  if (reference.identity && reference.kind === 'issue') {
    const raw = await env.rest(
      scopeForRepository(scope, reference.identity),
      `repos/${reference.identity.owner}/${reference.identity.repo}/issues/${reference.number}`,
      'GET',
      undefined,
      { idempotent: true }
    )
    const result = issueSource(env, raw, reference.identity, reference.number)
    ensureOutputBound(env, result, 'Worktree source')
    return result
  }
  if (reference.identity && reference.kind === 'pullRequest') {
    const result = await pullRequestSource(env, scope, reference.identity, reference.number)
    ensureOutputBound(env, result, 'Worktree source')
    return result
  }
  const resolved = await resolveWorkItem(env, scope, reference.number, undefined, undefined, true)
  if (!resolved) throw env.invalid('not_found', 'The GitHub work item was not found in the configured repositories.')
  const result = resolved.item.kind === 'pullRequest'
    ? await pullRequestSource(env, scope, resolved.identity, reference.number)
    : issueSource(env, resolved.raw, resolved.identity, reference.number)
  ensureOutputBound(env, result, 'Worktree source')
  return result
}

export function itemDetailMethods(env: HostingEnv): Record<string, Handler> {
  return {
    workItem: (params, caller) => workItem(env, params, caller),
    workItemDetails: (params, caller) => workItemDetails(env, params, caller),
    worktreeSource: (params, caller) => worktreeSource(env, params, caller)
  }
}
