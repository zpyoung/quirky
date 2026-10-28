import type { PluginCaller } from '@quirky/protocol'
import type { ItemTarget, IssueDraft, TaskItem, TaskRepo, TaskMethodTable, TasksEnv } from '../contracts'

const HOSTING = 'quirky.hosting/'
const MAX_OPTIONS = 100
const MAX_TITLE_BYTES = 256
const MAX_BODY_BYTES = 1_048_576
const MAX_COMMENT_BYTES = 65_536
const issueMutationQueues = new Map<string, Promise<unknown>>()

type RecordValue = Record<string, unknown>
type IssueComment = {
  id: number | string | null
  issueNumber: number
  body: string
  author: string | null
  createdAt: string | null
  updatedAt: string | null
  url: string | null
  kind: 'issue'
}
type IssueDetail = {
  item: TaskItem
  viewerCanUpdate: boolean | null
  comments: IssueComment[]
  participants: RecordValue[]
  timeline: RecordValue[]
  partialFailures: string[]
  truncated: boolean
  source: 'repository' | 'project'
}
type IssueChanges = {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  stateReason?: 'completed' | 'not_planned'
  duplicateOf?: number
  labels?: string[]
  assignees?: string[]
}

function record(value: unknown): RecordValue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as RecordValue
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function queueIssueMutation<T>(target: ItemTarget, operation: () => Promise<T>): Promise<T> {
  const identity = target.url ?? `${target.host ?? ''}/${target.owner ?? ''}/${target.repo ?? ''}/issues/${target.number}`
  const key = `${target.worktree}\0${identity}`
  const previous = issueMutationQueues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  issueMutationQueues.set(key, next)
  return next.finally(() => {
    if (issueMutationQueues.get(key) === next) issueMutationQueues.delete(key)
  })
}

function stringList(env: TasksEnv, value: unknown, name: string, maxItems = MAX_OPTIONS): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw env.context.error('invalid-params', `${name} must contain at most ${maxItems} strings.`)
  const values: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || Buffer.byteLength(item, 'utf8') > 256) {
      throw env.context.error('invalid-params', `${name} entries must be non-empty strings no longer than 256 bytes.`)
    }
    const normalized = item.trim()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      values.push(normalized)
    }
  }
  return values
}

function optionalText(env: TasksEnv, params: RecordValue, name: string, maxBytes: number): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw env.context.error('invalid-params', `${name} must be a string no longer than ${maxBytes} bytes.`)
  }
  return value
}

function optionalIdentityPart(env: TasksEnv, params: RecordValue, name: string, maxLength = 512): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw env.context.error('invalid-params', `${name} must be a non-empty string no longer than ${maxLength} characters.`)
  }
  return value.trim()
}

function issueUrl(env: TasksEnv, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2048) throw env.context.error('invalid-params', 'url must be a GitHub issue URL no longer than 2048 characters.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw env.context.error('invalid-params', 'url must be an absolute HTTPS GitHub issue URL.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/(?:[^/]+)\/(?:[^/]+)\/issues\/[1-9][0-9]*\/?$/.test(url.pathname)) {
    throw env.context.error('invalid-params', 'url must be a credential-free HTTPS GitHub issue URL without query or fragment.')
  }
  return url.href.replace(/\/$/, '')
}


async function targetOf(env: TasksEnv, params: RecordValue, caller: PluginCaller): Promise<ItemTarget> {
  const active = env.read().navigation.detail
  const requestedNumberValue = params.number
  const requestedNumber = requestedNumberValue === undefined ? undefined : positiveInteger(requestedNumberValue)
  if (requestedNumberValue !== undefined && requestedNumber === null) {
    throw env.context.error('invalid-params', 'number must be a positive whole issue number.')
  }
  const explicitWorktree = optionalIdentityPart(env, params, 'worktree', 4096)
  const callerWorktree = caller.role === 'plugin' ? undefined : caller.worktreeId
  const callerPath = caller.role === 'plugin' ? undefined : caller.cwd
  const suppliedWorktree = explicitWorktree ?? callerWorktree
  const requestedUrl = issueUrl(env, params.url)
  const explicitProjectId = optionalIdentityPart(env, params, 'projectId', 256)
  const explicitItemId = optionalIdentityPart(env, params, 'itemId', 256)
  const explicitHost = optionalIdentityPart(env, params, 'host', 255)
  const explicitOwner = optionalIdentityPart(env, params, 'owner', 100)
  const explicitRepo = optionalIdentityPart(env, params, 'repo', 100)
  const activeUrl = active?.kind === 'issue' && active.url ? issueUrl(env, active.url) : undefined
  const activeMatches = active !== null
    && (suppliedWorktree === undefined || suppliedWorktree === active.worktree)
    && (requestedNumber === undefined || requestedNumber === active.number)
    && (requestedUrl === undefined || requestedUrl === activeUrl)
    && (explicitProjectId === undefined || explicitProjectId === active.projectId)
    && (explicitItemId === undefined || explicitItemId === active.itemId)
    && (explicitHost === undefined || explicitHost.toLowerCase() === active.host?.toLowerCase())
    && (explicitOwner === undefined || explicitOwner.toLowerCase() === active.owner?.toLowerCase())
    && (explicitRepo === undefined || explicitRepo.toLowerCase() === active.repo?.toLowerCase())
    && (params.kind === undefined || params.kind === active.kind)
  const hasExplicitSourceIdentity = requestedUrl !== undefined
    || explicitProjectId !== undefined
    || explicitItemId !== undefined
    || explicitHost !== undefined
    || explicitOwner !== undefined
    || explicitRepo !== undefined
  const ambiguousNumberOnly = requestedNumber !== undefined && !hasExplicitSourceIdentity
  const base = activeMatches && !ambiguousNumberOnly ? active : null
  const kindValue = params.kind ?? base?.kind ?? 'issue'
  if (kindValue !== 'issue') throw env.context.error('invalid-params', 'This surface supports GitHub issues only; pull-request detail is not implemented here.')

  let worktree = explicitWorktree ?? base?.worktree ?? callerWorktree
  if (!worktree && callerPath) {
    const repo = (await env.repositories()).find((candidate) => candidate.path === callerPath && candidate.kind === 'git')
    worktree = repo?.worktree
  }
  if (!worktree) throw env.context.error('invalid-params', 'A registered Git worktree is required for issue operations.')

  let url = requestedUrl ?? (base?.url ? issueUrl(env, base.url) : undefined)
  const urlIdentity = url ? identityFromUrl(url) : undefined
  const urlNumber = url
    ? positiveInteger(Number(/^\/[^/]+\/[^/]+\/issues\/([1-9][0-9]*)\/?$/.exec(new URL(url).pathname)?.[1]))
    : null
  if (requestedNumber !== undefined && urlNumber !== null && requestedNumber !== urlNumber) {
    throw env.context.error('invalid-params', 'number does not match the supplied issue URL.')
  }
  const number = requestedNumber ?? base?.number ?? urlNumber ?? undefined
  if (number === undefined) throw env.context.error('invalid-params', 'Open an issue or provide a positive issue number.')

  const projectId = explicitProjectId ?? base?.projectId
  const itemId = explicitItemId ?? base?.itemId
  if ((projectId === undefined) !== (itemId === undefined)) {
    throw env.context.error('invalid-params', 'projectId and itemId must be supplied together for a Project issue.')
  }
  const host = explicitHost ?? base?.host ?? urlIdentity?.host
  const owner = explicitOwner ?? base?.owner ?? urlIdentity?.owner
  const repo = explicitRepo ?? base?.repo ?? urlIdentity?.repo
  if ((owner === undefined) !== (repo === undefined)) {
    throw env.context.error('invalid-params', 'owner and repo must be supplied together.')
  }
  if (urlIdentity && (
    (explicitHost !== undefined && explicitHost.toLowerCase() !== urlIdentity.host.toLowerCase())
    || (explicitOwner !== undefined && explicitOwner.toLowerCase() !== urlIdentity.owner.toLowerCase())
    || (explicitRepo !== undefined && explicitRepo.toLowerCase() !== urlIdentity.repo.toLowerCase())
  )) {
    throw env.context.error('invalid-params', 'The supplied host, owner, or repo does not match the issue URL.')
  }
  if (!url && owner && repo) url = issueUrl(env, `https://${host ?? 'github.com'}/${owner}/${repo}/issues/${number}`)
  return {
    worktree,
    kind: 'issue',
    number,
    ...(url ? { url } : {}),
    ...(projectId ? { projectId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(host ? { host } : {}),
    ...(owner ? { owner } : {}),
    ...(repo ? { repo } : {})
  }
}

function projectHost(env: TasksEnv, target: ItemTarget): string | undefined {
  if (target.host) return target.host
  const project = env.read().navigation.project
  if (project && project.id === target.projectId && project.host) return project.host
  if (!target.url) return undefined
  try {
    return new URL(target.url).host
  } catch {
    return undefined
  }
}
function workItemIdentity(target: ItemTarget): { host: string; owner: string; repo: string } | null {
  const host = target.host
  const owner = target.owner
  const repo = target.repo
  if (host && owner && repo) return { host: host.toLowerCase(), owner: owner.toLowerCase(), repo: repo.toLowerCase() }
  if (!target.url) return null
  try {
    const url = new URL(target.url)
    const parts = /^\/([^/]+)\/([^/]+)\/issues\/[1-9][0-9]*\/?$/.exec(url.pathname)
    if (!parts?.[1] || !parts[2]) return null
    return { host: url.host.toLowerCase(), owner: parts[1].toLowerCase(), repo: parts[2].toLowerCase() }
  } catch {
    return null
  }
}

async function matchesConfiguredIssueRepository(env: TasksEnv, target: ItemTarget): Promise<boolean> {
  const identity = workItemIdentity(target)
  if (!identity) return true
  const raw = record(await env.context.call(`${HOSTING}repository`, { worktree: target.worktree }))
  if (!raw) return false
  const candidates: unknown[] = [raw.issueRepository]
  return candidates.some((value) => {
    const candidate = record(value)
    return candidate !== null
      && typeof candidate.host === 'string' && candidate.host.toLowerCase() === identity.host
      && typeof candidate.owner === 'string' && candidate.owner.toLowerCase() === identity.owner
      && typeof candidate.repo === 'string' && candidate.repo.toLowerCase() === identity.repo
  })
}

function mapTaskItem(value: unknown, target: ItemTarget): TaskItem | null {
  const raw = record(value)
  const number = positiveInteger(raw?.number)
  if (!raw || number === null || number !== target.number || raw.kind !== undefined && raw.kind !== 'issue') return null
  const state = raw.state === 'open' || raw.state === 'closed' ? raw.state : 'unknown'
  const labels = Array.isArray(raw.labels) ? raw.labels.flatMap((label) => typeof label === 'string' ? [label] : []) : []
  const assignees = Array.isArray(raw.assignees) ? raw.assignees.flatMap((assignee) => typeof assignee === 'string' ? [assignee] : []) : []
  const url = nonEmptyString(raw.url) ?? target.url ?? ''
  const result: TaskItem = {
    kind: 'issue',
    number,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    state,
    url,
    createdAt: nonEmptyString(raw.createdAt),
    updatedAt: nonEmptyString(raw.updatedAt),
    author: nonEmptyString(raw.author),
    labels: labels.slice(0, 100),
    assignees: assignees.slice(0, 100),
    isDraft: false
  }
  if (typeof raw.stateReason === 'string') result.stateReason = raw.stateReason
  if (positiveInteger(raw.duplicateOf) !== null) result.duplicateOf = positiveInteger(raw.duplicateOf) ?? undefined
  return result
}

function mapComment(value: unknown, issueNumber: number): IssueComment | null {
  const raw = record(value)
  if (!raw || typeof raw.body !== 'string') return null
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : null
  return {
    id,
    issueNumber,
    body: raw.body,
    author: nonEmptyString(raw.author),
    createdAt: nonEmptyString(raw.createdAt),
    updatedAt: nonEmptyString(raw.updatedAt),
    url: nonEmptyString(raw.url),
    kind: 'issue'
  }
}

function mapDetails(value: unknown, target: ItemTarget, source: 'repository' | 'project'): IssueDetail {
  const raw = record(value)
  const item = mapTaskItem(raw?.item, target)
  if (!raw || !item) throw new Error('GitHub did not return the requested issue details.')
  const comments = Array.isArray(raw.comments)
    ? raw.comments.flatMap((comment) => {
        const mapped = mapComment(comment, item.number)
        return mapped ? [mapped] : []
      }).slice(0, 100)
    : []
  const participants = Array.isArray(raw.participants)
    ? raw.participants.flatMap((participant) => {
        const person = record(participant)
        const login = nonEmptyString(person?.login)
        return login ? [{ login, name: nonEmptyString(person?.name), url: nonEmptyString(person?.url) }] : []
      }).slice(0, 100)
    : []
  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline.flatMap((event) => {
        const entry = record(event)
        const name = nonEmptyString(entry?.event)
        return entry && name ? [{
          event: name,
          createdAt: nonEmptyString(entry.createdAt),
          actor: nonEmptyString(entry.actor),
          label: nonEmptyString(entry.label),
          state: nonEmptyString(entry.state),
          body: typeof entry.body === 'string' ? entry.body : null,
          commitId: nonEmptyString(entry.commitId)
        }] : []
      }).slice(0, 300)
    : []
  const partialFailures = Array.isArray(raw.partialFailures)
    ? raw.partialFailures.flatMap((failure) => typeof failure === 'string' ? [failure.slice(0, 2048)] : []).slice(0, 10)
    : []
  return {
    item,
    comments,
    participants,
    timeline,
    partialFailures,
    truncated: raw.truncated === true,
    viewerCanUpdate: typeof raw.viewerCanUpdate === 'boolean' ? raw.viewerCanUpdate : null,
    source
  }
}

async function readIssueDetails(env: TasksEnv, target: ItemTarget, refresh = false): Promise<IssueDetail> {
  const project = target.projectId && target.itemId
  const params: RecordValue = project
    ? { worktree: target.worktree, projectId: target.projectId, itemId: target.itemId, ...(projectHost(env, target) ? { host: projectHost(env, target) } : {}) }
    : { worktree: target.worktree, number: target.number, kind: 'issue', ...(target.url ? { reference: target.url } : {}), ...(refresh ? { noCache: true } : {}) }
  const method = project ? 'projectItemDetails' : 'workItemDetails'
  const value = await env.context.call(`${HOSTING}${method}`, params)
  if (value === null) throw env.context.error('not-found', `GitHub issue #${target.number} was not found.`)
  return mapDetails(value, target, project ? 'project' : 'repository')
}

async function issue(env: TasksEnv, params: RecordValue, caller: PluginCaller): Promise<IssueDetail> {
  const target = await targetOf(env, params, caller)
  const refresh = params.refresh ?? false
  if (typeof refresh !== 'boolean') throw env.context.error('invalid-params', 'refresh must be a boolean.')
  return readIssueDetails(env, target, refresh)

}
function normalizedDesired(current: string[], desired: string[]): { add: string[]; remove: string[] } {
  const before = new Set(current)
  const after = new Set(desired)
  return {
    add: desired.filter((value) => !before.has(value)),
    remove: current.filter((value) => !after.has(value))
  }
}

function editChanges(env: TasksEnv, params: RecordValue, target: ItemTarget): IssueChanges {
  const title = optionalText(env, params, 'title', MAX_TITLE_BYTES)
  const body = optionalText(env, params, 'body', target.projectId && target.itemId ? MAX_COMMENT_BYTES : MAX_BODY_BYTES)
  const stateValue = params.state
  if (stateValue !== undefined && stateValue !== 'open' && stateValue !== 'closed') {
    throw env.context.error('invalid-params', 'state must be open or closed.')
  }
  const reasonValue = params.stateReason
  if (reasonValue !== undefined && reasonValue !== 'completed' && reasonValue !== 'not_planned') {
    throw env.context.error('invalid-params', 'stateReason must be completed or not_planned.')
  }
  if (reasonValue !== undefined && stateValue !== 'closed') {
    throw env.context.error('invalid-params', 'stateReason requires state closed.')
  }
  let duplicateOf: number | undefined
  if (params.duplicateOf !== undefined) {
    duplicateOf = positiveInteger(params.duplicateOf) ?? undefined
    if (duplicateOf === undefined || duplicateOf === target.number || stateValue !== 'closed') {
      throw env.context.error('invalid-params', 'duplicateOf must be a different positive issue number and requires state closed.')
    }
  }
  const labels = params.labels === undefined ? undefined : stringList(env, params.labels, 'labels')
  const assignees = params.assignees === undefined ? undefined : stringList(env, params.assignees, 'assignees')
  if (title !== undefined && title.trim().length === 0) throw env.context.error('invalid-params', 'title cannot be empty.')
  return {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(stateValue !== undefined ? { state: stateValue } : {}),
    ...(reasonValue !== undefined ? { stateReason: reasonValue } : {}),
    ...(duplicateOf !== undefined ? { duplicateOf } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(assignees !== undefined ? { assignees } : {})
  }
}


async function editProjectIssue(env: TasksEnv, target: ItemTarget, changes: IssueChanges): Promise<RecordValue> {
  if (target.projectId === undefined || target.itemId === undefined) throw env.context.error('invalid-params', 'projectId and itemId are required for a Project issue.')
  if (changes.duplicateOf !== undefined) throw env.context.error('invalid-params', 'Closing a Project issue as a duplicate is not supported by the public Project mutation API.')
  const before = await readIssueDetails(env, target)
  if (changes.body !== undefined && before.viewerCanUpdate === false) {
    throw env.context.error('invalid-params', 'GitHub reports that this issue description is read-only.')
  }
  const current = before.item
  const params: RecordValue = {
    worktree: target.worktree,
    action: 'editIssue',
    projectId: target.projectId,
    itemId: target.itemId,
    number: target.number,
    kind: 'issue',
    ...(projectHost(env, target) ? { host: projectHost(env, target) } : {}),
    ...changes
  }
  const mutation = record(await env.context.call(`${HOSTING}projectItemMutation`, params))
  const changed = mutation?.changed === true
  if (!changed) return { item: current, changed: false, partial: false }
  try {
    const refreshed = await readIssueDetails(env, target)
    return { item: refreshed.item, changed: true, partial: false, completedSteps: ['issue-fields'] }
  } catch (error: unknown) {
    return { item: current, changed: true, partial: false, completedSteps: ['issue-fields'], refreshError: errorMessage(error) }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function editRepositoryIssue(env: TasksEnv, target: ItemTarget, changes: IssueChanges): Promise<RecordValue> {
  const readParams = { worktree: target.worktree, number: target.number, kind: 'issue', ...(target.url ? { reference: target.url } : {}) }
  if (changes.body !== undefined) {
    const detail = await readIssueDetails(env, target)
    if (detail.viewerCanUpdate === false) {
      throw env.context.error('invalid-params', 'GitHub reports that this issue description is read-only.')
    }
  }
  const currentRaw = await env.context.call(`${HOSTING}workItem`, readParams)
  const current = mapTaskItem(currentRaw, target)
  if (!current) throw env.context.error('not-found', `GitHub issue #${target.number} was not found.`)
  const labels = changes.labels === undefined ? { add: [], remove: [] } : normalizedDesired(current.labels, changes.labels)
  const assignees = changes.assignees === undefined ? { add: [], remove: [] } : normalizedDesired(current.assignees, changes.assignees)
  const providerChanges: RecordValue = {
    worktree: target.worktree,
    number: target.number,
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.body !== undefined ? { body: changes.body } : {}),
    ...(changes.state !== undefined ? { state: changes.state } : {}),
    ...(changes.stateReason !== undefined ? { stateReason: changes.stateReason } : {}),
    ...(changes.duplicateOf !== undefined ? { duplicateOf: changes.duplicateOf } : {}),
    ...(labels.add.length > 0 ? { addLabels: labels.add } : {}),
    ...(labels.remove.length > 0 ? { removeLabels: labels.remove } : {}),
    ...(assignees.add.length > 0 ? { addAssignees: assignees.add } : {}),
    ...(assignees.remove.length > 0 ? { removeAssignees: assignees.remove } : {})
  }
  const changed = Object.keys(providerChanges).some((key) => !['worktree', 'number'].includes(key))
  if (!changed) return { item: current, changed: false, partial: false }
  const item = mapTaskItem(await env.context.call(`${HOSTING}updateIssue`, providerChanges), target)
  if (!item) throw env.context.error('conflict', 'GitHub accepted the issue update but did not return the requested issue.')
  return { item, changed: true, partial: false }
}

async function issueEdit(env: TasksEnv, params: RecordValue, caller: PluginCaller): Promise<RecordValue> {
  const target = await targetOf(env, params, caller)
  const changes = editChanges(env, params, target)
  if (Object.keys(changes).length === 0) throw env.context.error('invalid-params', 'At least one issue change is required.')
  return queueIssueMutation(target, () => target.projectId && target.itemId
    ? editProjectIssue(env, target, changes)
    : editRepositoryIssue(env, target, changes))
}


async function issueComment(env: TasksEnv, params: RecordValue, caller: PluginCaller): Promise<RecordValue> {
  const target = await targetOf(env, params, caller)
  const body = optionalText(env, params, 'body', MAX_COMMENT_BYTES)
  if (body === undefined || body.length === 0) throw env.context.error('invalid-params', 'body is required for an issue comment.')
  if (target.projectId && target.itemId) {
    const result = record(await env.context.call(`${HOSTING}projectItemMutation`, {
      worktree: target.worktree,
      action: 'addComment',
      projectId: target.projectId,
      itemId: target.itemId,
      kind: 'issue',
      ...(projectHost(env, target) ? { host: projectHost(env, target) } : {}),
      body
    }))
    const id = positiveInteger(result?.commentId)
    if (id === null) throw env.context.error('conflict', 'GitHub accepted the Project issue comment but returned no comment identity.')
    return {
      source: 'project',
      comment: { id, issueNumber: target.number, body: typeof result?.body === 'string' ? result.body : body, author: null, createdAt: null, updatedAt: null, url: null, kind: 'issue' }
    }
  }
  const result = record(await env.context.call(`${HOSTING}issueComment`, {
    worktree: target.worktree,
    number: target.number,
    body
  }))
  const comment = mapComment(result, target.number)
  if (!comment) throw env.context.error('conflict', 'GitHub accepted the issue comment but returned an invalid comment record.')
  return { source: 'repository', comment }
}

function emptyDraft(): IssueDraft {
  return { title: '', body: '', labels: [], assignees: [], repoId: null }
}

function issueDraft(env: TasksEnv, params: RecordValue): RecordValue {
  const current = env.read().issueDraft
  const reset = params.reset === true
  if (params.reset !== undefined && typeof params.reset !== 'boolean') throw env.context.error('invalid-params', 'reset must be a boolean.')
  let repoId: string | null = reset ? null : current.repoId
  if (params.repoId !== undefined) {
    if (params.repoId !== null && (typeof params.repoId !== 'string' || params.repoId.trim().length === 0 || params.repoId.length > 256)) {
      throw env.context.error('invalid-params', 'repoId must be a repository ID or null.')
    }
    repoId = typeof params.repoId === 'string' ? params.repoId.trim() : null
  }
  const repoChanged = repoId !== current.repoId
  const title = optionalText(env, params, 'title', MAX_TITLE_BYTES) ?? (reset ? '' : current.title)
  const body = optionalText(env, params, 'body', MAX_BODY_BYTES) ?? (reset ? '' : current.body)
  const labels = params.labels === undefined
    ? repoChanged || reset ? [] : current.labels
    : stringList(env, params.labels, 'labels')
  const assignees = params.assignees === undefined
    ? repoChanged || reset ? [] : current.assignees
    : stringList(env, params.assignees, 'assignees')
  const draft = { title, body, labels, assignees, repoId }
  env.update((state) => { state.issueDraft = draft })
  return { draft }
}

function selectableRepositories(env: TasksEnv, all: TaskRepo[], includeSelection: boolean): TaskRepo[] {
  const eligible = all.filter((repo) => repo.kind === 'git' && repo.path.length > 0 && repo.worktree.length > 0)
  const selected = env.read().navigation.repoIds
  if (!includeSelection || selected === null) return eligible
  const byId = new Map(eligible.map((repo) => [repo.id, repo]))
  return selected.flatMap((id) => {
    const repo = byId.get(id)
    return repo ? [repo] : []
  })
}

async function issueChoices(env: TasksEnv, params: RecordValue, caller: PluginCaller): Promise<RecordValue> {
  const kind = params.kind
  if (kind !== 'repositories' && kind !== 'labels' && kind !== 'assignees' && kind !== 'source') {
    throw env.context.error('invalid-params', 'kind must be repositories, labels, assignees, or source.')
  }
  const all = selectableRepositories(env, await env.repositories(), false)
  if (kind === 'repositories') {
    const selected = selectableRepositories(env, all, true)
    return { kind, repositories: selected.slice(0, MAX_OPTIONS), defaultRepoId: selected[0]?.id ?? null, truncated: selected.length > MAX_OPTIONS }
  }

  const requestedRepoId = optionalIdentityPart(env, params, 'repoId', 256)
  const requestedWorktree = optionalIdentityPart(env, params, 'worktree', 4096)
  const activeDetail = env.read().navigation.detail
  const useActiveTarget = activeDetail !== null && requestedRepoId === undefined
    && (requestedWorktree === undefined || requestedWorktree === activeDetail.worktree)
  const targetParams: RecordValue = {}
  for (const name of ['worktree', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo']) {
    if (params[name] !== undefined) targetParams[name] = params[name]
  }
  const activeTarget = useActiveTarget ? await targetOf(env, targetParams, caller) : null
  const repo = requestedRepoId
    ? all.find((candidate) => candidate.id === requestedRepoId)
    : all.find((candidate) => candidate.worktree === (activeTarget?.worktree ?? requestedWorktree))
      ?? selectableRepositories(env, all, true)[0]
  if (!repo) return { kind, available: false, message: 'Select a registered Git repository to load issue choices.', labels: [], assignees: [], truncated: false }

  if (kind === 'source') {
    const info = record(await env.context.call(`${HOSTING}repository`, { worktree: repo.worktree }))
    const origin = record(info?.origin)
    const candidates = Array.isArray(info?.candidates) ? info.candidates : []
    const upstream = candidates.find((value) => {
      const candidate = record(value)
      return candidate !== null && origin !== null && (
        candidate.host !== origin.host || candidate.owner !== origin.owner || candidate.repo !== origin.repo
      )
    })
    const upstreamIdentity = record(upstream)
    const originLabel = origin && typeof origin.owner === 'string' && typeof origin.repo === 'string' ? `${origin.owner}/${origin.repo}` : repo.name
    const upstreamLabel = upstreamIdentity && typeof upstreamIdentity.owner === 'string' && typeof upstreamIdentity.repo === 'string'
      ? `${upstreamIdentity.owner}/${upstreamIdentity.repo}`
      : 'upstream'
    const preference = info?.issueSourcePreference
    const source = preference === 'origin' || preference === 'upstream' ? preference : upstream ? 'upstream' : 'origin'
    const sources: { id: 'origin' | 'upstream'; label: string }[] = []
    if (upstream) sources.push({ id: 'upstream', label: `Upstream · ${upstreamLabel}` })
    sources.push({ id: 'origin', label: `Origin · ${originLabel}` })
    return { kind, available: upstream !== undefined, repoId: repo.id, source, sources, labels: [], assignees: [], truncated: false }
  }

  if (activeTarget && (!workItemIdentity(activeTarget) && activeTarget.projectId || !await matchesConfiguredIssueRepository(env, activeTarget))) {
    return { kind, available: false, repoId: repo.id, message: 'Repository labels and assignable users are unavailable for this Project issue source.', labels: [], assignees: [], truncated: false }
  }
  const query = optionalText(env, params, 'query', 256)
  const upstream = record(await env.context.call(`${HOSTING}${kind}`, {
    worktree: repo.worktree,
    ...(query !== undefined ? { query } : {})
  }))
  const source = kind === 'labels' ? upstream?.labels : upstream?.assignees
  const values = Array.isArray(source) ? source : []
  const truncated = values.length > MAX_OPTIONS || upstream?.truncated === true
  if (kind === 'labels') {
    const labels = values.flatMap((value) => typeof value === 'string' ? [value] : []).slice(0, MAX_OPTIONS)
    return { kind, available: true, repoId: repo.id, labels, assignees: [], truncated }
  }
  const assignees = values.flatMap((value) => {
    const user = record(value)
    const login = nonEmptyString(user?.login)
    return login ? [{ login, avatarUrl: nonEmptyString(user?.avatarUrl) }] : []
  }).slice(0, MAX_OPTIONS)
  return { kind, available: true, repoId: repo.id, labels: [], assignees, truncated }
}

async function issueSource(env: TasksEnv, params: RecordValue): Promise<RecordValue> {
  const repoId = optionalIdentityPart(env, params, 'repoId', 256)
  const source = params.source
  if (!repoId || (source !== 'origin' && source !== 'upstream')) {
    throw env.context.error('invalid-params', 'repoId and source origin|upstream are required.')
  }
  const repos = selectableRepositories(env, await env.repositories(), false)
  const repo = repos.find((candidate) => candidate.id === repoId)
  if (!repo) throw env.context.error('not-found', 'The selected issue repository is no longer registered.')
  const info = record(await env.context.call(`${HOSTING}repository`, { worktree: repo.worktree }))
  if (source === 'upstream') {
    const origin = record(info?.origin)
    const candidates = Array.isArray(info?.candidates) ? info.candidates : []
    const hasUpstream = candidates.some((value) => {
      const candidate = record(value)
      return candidate !== null && origin !== null && (
        candidate.host !== origin.host || candidate.owner !== origin.owner || candidate.repo !== origin.repo
      )
    })
    if (!hasUpstream) throw env.context.error('invalid-params', 'This repository has no authenticated GitHub upstream issue source.')
  }
  await env.context.call(`${HOSTING}configure`, { worktree: repo.worktree, issueSourcePreference: source })
  return { repoId, source }
}

async function createIssue(env: TasksEnv, params: RecordValue): Promise<RecordValue> {
  let draft = env.read().issueDraft
  const selection = await selectableRepositories(env, await env.repositories(), false)
  const repoId = optionalIdentityPart(env, params, 'repoId', 256) ?? draft.repoId ?? selectableRepositories(env, selection, true)[0]?.id ?? null
  const repo = repoId === null ? undefined : selection.find((candidate) => candidate.id === repoId)
  if (!repo) throw env.context.error('invalid-params', 'Choose a registered Git repository before creating an issue.')
  const repoChanged = repo.id !== draft.repoId
  const title = optionalText(env, params, 'title', MAX_TITLE_BYTES) ?? draft.title
  const body = optionalText(env, params, 'body', MAX_BODY_BYTES) ?? draft.body
  const labels = params.labels === undefined ? (repoChanged ? [] : draft.labels) : stringList(env, params.labels, 'labels')
  const assignees = params.assignees === undefined ? (repoChanged ? [] : draft.assignees) : stringList(env, params.assignees, 'assignees')
  draft = { title, body, labels, assignees, repoId: repo.id }
  env.update((state) => { state.issueDraft = draft })
  if (title.trim().length === 0) throw env.context.error('invalid-params', 'An issue title is required.')

  const raw = record(await env.context.call(`${HOSTING}createIssue`, {
    worktree: repo.worktree,
    title,
    body,
    labels,
    assignees
  }))
  const item = mapTaskItem(raw, { worktree: repo.worktree, kind: 'issue', number: positiveInteger(raw?.number) ?? 0, ...(nonEmptyString(raw?.url) ? { url: nonEmptyString(raw?.url) ?? undefined } : {}) })
  if (!raw || !item) throw env.context.error('conflict', 'GitHub created an issue but did not return a valid issue record.')
  const warning = typeof raw.bodySaveWarning === 'string' ? raw.bodySaveWarning : undefined
  env.update((state) => {
    state.issueDraft = warning
      ? { title: '', body, labels: [], assignees: [], repoId: repo.id }
      : emptyDraft()
  })
  let navigationWarning: string | undefined
  try {
    await env.navigate({
      mode: 'issues',
      repoIds: [repo.id],
      page: 1,
      scrollTop: 0,
      detail: { worktree: repo.worktree, kind: 'issue', number: item.number, url: item.url, ...(item.url ? identityFromUrl(item.url) : {}) },
      newIssue: false,
      project: null
    })
  } catch (error: unknown) {
    navigationWarning = `Issue #${item.number} was created, but it could not be opened in Tasks: ${errorMessage(error)}`
  }
  return {
    item,
    repositoryId: repo.id,
    partial: raw.partial === true,
    ...(warning ? { bodySaveWarning: warning } : {}),
    ...(Array.isArray(raw.completedSteps) ? { completedSteps: raw.completedSteps.filter((step): step is string => typeof step === 'string').slice(0, 3) } : {}),
    ...(navigationWarning ? { navigationWarning } : {})
  }
}

function identityFromUrl(value: string): { host: string; owner: string; repo: string } | undefined {
  try {
    const url = new URL(value)
    const match = /^\/([^/]+)\/([^/]+)\/issues\/[1-9][0-9]*\/?$/.exec(url.pathname)
    if (!match?.[1] || !match[2]) return undefined
    return { host: url.host, owner: match[1], repo: match[2] }
  } catch {
    return undefined
  }
}

export function issueMethods(env: TasksEnv): TaskMethodTable {
  return {
    issue: (params, caller) => issue(env, params, caller),
    issueEdit: (params, caller) => issueEdit(env, params, caller),
    issueComment: (params, caller) => issueComment(env, params, caller),
    issueChoices: (params, caller) => issueChoices(env, params, caller),
    issueSource: (params) => issueSource(env, params),
    draft: (params) => issueDraft(env, params),
    createIssue: (params) => createIssue(env, params)
  }
}
