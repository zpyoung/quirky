import type { Handler, HostingEnv, Identity, Scope } from './env'
import {
  array,
  boundedText,
  nonEmptyString,
  positiveInteger,
  record,
  utf8Length
} from './item-data'
import { classifyProjectError, projectError } from './project-errors'
import { projectGraphql, projectRest, resolveProjectHost } from './project-ref'

type ProjectItemAction = 'editIssue' | 'editReview' | 'addComment' | 'updateComment' | 'deleteComment' | 'updateIssueType'
type ProjectCaller = Parameters<Handler>[1]
function isProjectItemAction(value: unknown): value is ProjectItemAction {
  switch (value) {
    case 'editIssue':
    case 'editReview':
    case 'addComment':
    case 'updateComment':
    case 'deleteComment':
    case 'updateIssueType':
      return true
    default:
      return false
  }
}

const PROJECT_FIELD_UPDATE = `mutation SetProjectField($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`
const PROJECT_FIELD_CLEAR = `mutation ClearProjectField($input: ClearProjectV2ItemFieldValueInput!) {
  clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`
const PROJECT_ITEM_CONTEXT = `query ProjectItemContext($projectId: ID!, $itemId: ID!) {
  project: node(id: $projectId) { __typename ... on ProjectV2 { id owner { __typename ... on Organization { login } ... on User { login } } } }
  item: node(id: $itemId) { __typename ... on ProjectV2Item { id type project { id } content { __typename ... on Issue { number url } ... on PullRequest { number url } } } }
}`
const ISSUE_TYPE_QUERY = `query OrganizationIssueTypes($owner: String!, $repoOwner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $repoOwner, name: $repo) { issue(number: $number) { id } }
  organization(login: $owner) { issueTypes(first: 100, after: $cursor) { nodes { id name description isEnabled } pageInfo { endCursor hasNextPage } } }
}`
const ISSUE_TYPE_MUTATION = `mutation SetIssueType($input: UpdateIssueIssueTypeInput!) {
  updateIssueIssueType(input: $input) { issue { id issueType { id name } } }
}`

function projectId(env: HostingEnv, params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f\s]/.test(value)) {
    throw env.invalid('validation_error', `${key} must be a non-empty project ID.`)
  }
  return value.trim()
}

function fieldValue(env: HostingEnv, value: unknown): Record<string, unknown> {
  const raw = record(value)
  if (!raw) throw env.invalid('validation_error', 'value must contain exactly one supported project field value.')
  const allowed = ['text', 'number', 'date', 'singleSelectOptionId', 'iterationId', 'userIds'] as const
  const keys = Object.keys(raw)
  if (keys.length !== 1 || !allowed.some((key) => key === keys[0])) {
    throw env.invalid('validation_error', 'value must contain exactly one supported project field value.')
  }
  const key = keys[0]
  if (key === 'text') {
    if (typeof raw.text !== 'string' || utf8Length(raw.text) > 8192) throw env.invalid('validation_error', 'text field values must be strings no longer than 8192 bytes.')
    return { text: raw.text }
  }
  if (key === 'number') {
    if (typeof raw.number !== 'number' || !Number.isFinite(raw.number)) throw env.invalid('validation_error', 'number field values must be finite numbers.')
    return { number: raw.number }
  }
  if (key === 'date') {
    if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) throw env.invalid('validation_error', 'date field values must use YYYY-MM-DD.')
    return { date: raw.date }
  }
  if (key === 'singleSelectOptionId' || key === 'iterationId') {
    const identifier = nonEmptyString(raw[key])
    if (identifier === null || identifier.length > 256) throw env.invalid('validation_error', `${key} must be a non-empty identifier.`)
    return key === 'singleSelectOptionId' ? { singleSelectOptionId: identifier } : { iterationId: identifier }
  }
  if (!Array.isArray(raw.userIds) || raw.userIds.length > 100) {
    throw env.invalid('validation_error', 'userIds must contain up to 100 non-empty identifiers.')
  }
  const userIds: string[] = []
  for (const user of array(raw.userIds)) {
    if (typeof user !== 'string' || user.trim().length === 0 || user.length > 256) {
      throw env.invalid('validation_error', 'userIds must contain up to 100 non-empty identifiers.')
    }
    userIds.push(user.trim())
  }
  return { userIds }
}

async function assertProjectFieldContext(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  project: string,
  item: string
): Promise<void> {
  const response = await projectGraphql(env, scope, identity, PROJECT_ITEM_CONTEXT, { projectId: project, itemId: item }, true)
  const root = record(record(response)?.data)
  if (nonEmptyString(record(root?.project)?.id) !== project || nonEmptyString(record(record(root?.item)?.project)?.id) !== project) {
    throw env.invalid('validation_error', 'Project item must belong to the selected project.')
  }
}

async function projectField(env: HostingEnv, params: Record<string, unknown>, caller: ProjectCaller): Promise<Record<string, unknown>> {
  const project = projectId(env, params, 'projectId')
  const item = projectId(env, params, 'itemId')
  const field = projectId(env, params, 'fieldId')
  const clear = params.clear === undefined ? false : params.clear
  if (typeof clear !== 'boolean') throw env.invalid('validation_error', 'clear must be a boolean.')
  const value = params.value
  if (clear && value !== undefined) throw env.invalid('validation_error', 'clear cannot be combined with a field value.')
  if (!clear && value === undefined) throw env.invalid('validation_error', 'value is required unless clear is true.')
  const normalizedValue = clear ? null : fieldValue(env, value)
  const scope = await env.resolve(params, caller)
  const { identity } = await resolveProjectHost(env, scope, params.host)
  const mutation = clear ? PROJECT_FIELD_CLEAR : PROJECT_FIELD_UPDATE
  await assertProjectFieldContext(env, scope, identity, project, item)
  const variables = clear
    ? { input: { projectId: project, itemId: item, fieldId: field } }
    : { input: { projectId: project, itemId: item, fieldId: field, value: normalizedValue } }
  const response = await projectGraphql(env, scope, identity, mutation, variables, false)
  const root = record(record(response)?.data)
  const payload = record(root?.[clear ? 'clearProjectV2ItemFieldValue' : 'updateProjectV2ItemFieldValue'])
  const updatedItem = nonEmptyString(record(payload?.projectV2Item)?.id)
  if (updatedItem === null) throw projectError(env, 'unknown', 'GitHub accepted the project update without confirming the item.')
  env.changed(scope, { type: 'project-item', projectId: project, itemId: item, fieldId: field, action: clear ? 'clear' : 'set' })
  return { updated: true, projectId: project, itemId: updatedItem, fieldId: field, cleared: clear, value: normalizedValue }
}

function workItemIdentity(env: HostingEnv, hostIdentity: Identity, value: unknown, expectedNumber: number, expectedKind: 'issue' | 'pullRequest'): Identity {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw env.invalid('validation_error', 'Project item has no valid work-item URL.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw env.invalid('validation_error', 'Project item has no valid work-item URL.')
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw env.invalid('validation_error', 'Project item URL must be credential-free HTTPS.')
  }
  if (url.host.toLowerCase() !== hostIdentity.host.toLowerCase()) {
    throw env.invalid('validation_error', 'Project item URL must match the selected trusted GitHub host.')
  }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname)
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw env.invalid('validation_error', 'Project item URL does not match its work-item identity.')
  }
  const number = positiveInteger(Number(match[4]))
  if (number === null || number !== expectedNumber || (match[3] === 'issues') !== (expectedKind === 'issue')) {
    throw env.invalid('validation_error', 'Project item URL does not match its work-item identity.')
  }
  return { host: hostIdentity.host, owner: match[1], repo: match[2] }
}

type ProjectItemContext = { identity: Identity; number: number; kind: 'issue' | 'pullRequest'; owner: string; ownerType: 'organization' | 'user' }

async function projectItemContext(
  env: HostingEnv,
  scope: Scope,
  projectIdValue: string,
  itemIdValue: string,
  hostIdentity: Identity
): Promise<ProjectItemContext> {
  const response = await projectGraphql(env, scope, hostIdentity, PROJECT_ITEM_CONTEXT, { projectId: projectIdValue, itemId: itemIdValue }, true)
  const root = record(record(response)?.data)
  const project = record(root?.project)
  const item = record(root?.item)
  const projectOwner = record(project?.owner)
  const projectType = projectOwner?.__typename === 'Organization' ? 'organization' : projectOwner?.__typename === 'User' ? 'user' : null
  const owner = nonEmptyString(projectOwner?.login)
  const issueContent = record(item?.content)
  const typename = issueContent?.__typename
  const kind = typename === 'Issue' ? 'issue' : typename === 'PullRequest' ? 'pullRequest' : null
  const number = positiveInteger(issueContent?.number)
  if (nonEmptyString(project?.id) !== projectIdValue || nonEmptyString(record(item?.project)?.id) !== projectIdValue) {
    throw env.invalid('validation_error', 'Project item must belong to the selected project.')
  }
  if (!item || kind === null || number === null || owner === null || projectType === null) {
    throw env.invalid('validation_error', 'Project item must contain a GitHub issue or pull request.')
  }
  const identity = workItemIdentity(env, hostIdentity, issueContent?.url, number, kind)
  return { identity, number, kind, owner, ownerType: projectType }
}

function validateMutationKind(env: HostingEnv, context: ProjectItemContext, params: Record<string, unknown>): void {
  if (params.number !== undefined && params.number !== context.number) throw env.invalid('validation_error', 'number must match the selected project item.')
  if (params.kind !== undefined && params.kind !== context.kind) throw env.invalid('validation_error', 'kind must match the selected project item.')
}

function commentPath(env: HostingEnv, context: ProjectItemContext, commentIdValue: unknown): { commentId: number; path: string } {
  const commentId = positiveInteger(commentIdValue)
  if (commentId === null) throw env.invalid('validation_error', 'commentId must be a positive safe integer.')
  const { identity } = context
  return { commentId, path: `repos/${identity.owner}/${identity.repo}/issues/comments/${commentId}` }
}

function commentMatchesContext(context: ProjectItemContext, value: unknown): boolean {
  const comment = record(value)
  const rawUrl = nonEmptyString(comment?.issue_url)
  if (rawUrl === null) return false
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const path = /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/([1-9][0-9]*)\/?$/.exec(url.pathname)
  return url.protocol === 'https:' &&
    (url.host.toLowerCase() === context.identity.host.toLowerCase() || (context.identity.host.toLowerCase() === 'github.com' && url.host.toLowerCase() === 'api.github.com')) &&
    path?.[1]?.toLowerCase() === context.identity.owner.toLowerCase() &&
    path?.[2]?.toLowerCase() === context.identity.repo.toLowerCase() &&
    Number(path?.[4]) === context.number
}

type IssueTypeResult = { types: Record<string, unknown>[]; issueId: string | null }

async function issueTypes(
  env: HostingEnv,
  scope: Scope,
  hostIdentity: Identity,
  context: ProjectItemContext
): Promise<IssueTypeResult> {
  if (context.ownerType !== 'organization') return { types: [], issueId: null }
  const types: Record<string, unknown>[] = []
  let cursor: string | null = null
  let issueId: string | null = null
  for (let page = 0; page < 100; page += 1) {
    const result = await projectGraphql(env, scope, hostIdentity, ISSUE_TYPE_QUERY, {
      owner: context.owner,
      repoOwner: context.identity.owner,
      repo: context.identity.repo,
      number: context.number,
      cursor
    }, true)
    const data = record(record(result)?.data)
    const repository = record(data?.repository)
    const issue = record(repository?.issue)
    issueId = nonEmptyString(issue?.id)
    if (issueId === null) throw projectError(env, 'not_found', 'The configured issue was not found.')
    const organization = record(data?.organization)
    const connection = record(organization?.issueTypes)
    for (const node of array(connection?.nodes)) {
      const raw = record(node)
      const id = nonEmptyString(raw?.id)
      const name = nonEmptyString(raw?.name)
      if (id && name) types.push({ id, name, description: typeof raw?.description === 'string' ? raw.description : null, enabled: raw?.isEnabled !== false })
    }
    const pageInfo = record(connection?.pageInfo)
    cursor = nonEmptyString(pageInfo?.endCursor)
    if (pageInfo?.hasNextPage !== true || cursor === null) return { types, issueId }
  }
  throw projectError(env, 'too_large', 'GitHub returned more than 10000 issue types.', { totalCount: types.length })
}

function mutationResult(context: ProjectItemContext, action: string, changed: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { action, number: context.number, kind: context.kind, url: `https://${context.identity.host}/${context.identity.owner}/${context.identity.repo}/${context.kind === 'issue' ? 'issues' : 'pull'}/${context.number}`, changed, ...extra }
}

async function projectItemMutation(env: HostingEnv, params: Record<string, unknown>, caller: ProjectCaller): Promise<Record<string, unknown>> {
  const action = params.action
  if (!isProjectItemAction(action)) {
    throw env.invalid('validation_error', 'action must be one of editIssue, editReview, addComment, updateComment, deleteComment, updateIssueType.')
  }
  const project = projectId(env, params, 'projectId')
  const item = projectId(env, params, 'itemId')
  const title = boundedText(env, params, 'title', { maxBytes: 256 })
  const body = boundedText(env, params, 'body', { required: action === 'addComment' || action === 'updateComment', maxBytes: 65_536 })
  const stateValue = params.state
  const stateReason = params.stateReason
  const commentId = params.commentId
  const issueTypeId = params.issueTypeId
  const issueTypeName = params.issueTypeName
  if (stateValue !== undefined && stateValue !== 'open' && stateValue !== 'closed') throw env.invalid('validation_error', 'state must be open or closed.')
  if (title !== undefined && title.trim().length === 0) throw env.invalid('validation_error', 'title cannot be empty.')
  if (issueTypeId !== undefined && issueTypeName !== undefined) throw env.invalid('validation_error', 'Provide issueTypeId or issueTypeName, not both.')
  if (issueTypeId !== undefined && (typeof issueTypeId !== 'string' || issueTypeId.trim().length === 0 || issueTypeId.length > 256)) throw env.invalid('validation_error', 'issueTypeId must be a non-empty ID.')
  if (issueTypeName !== undefined && (typeof issueTypeName !== 'string' || issueTypeName.trim().length === 0 || utf8Length(issueTypeName) > 256)) throw env.invalid('validation_error', 'issueTypeName must be a non-empty name no longer than 256 bytes.')
  if (action === 'editIssue' || action === 'editReview') {
    if (title === undefined && body === undefined && stateValue === undefined) throw env.invalid('validation_error', 'At least one issue or pull request field must change.')
    if (stateReason !== undefined && (action !== 'editIssue' || stateValue !== 'closed' || (stateReason !== 'completed' && stateReason !== 'not_planned'))) {
      throw env.invalid('validation_error', 'stateReason requires a closed issue and must be completed or not_planned.')
    }
  } else if (title !== undefined || stateValue !== undefined || stateReason !== undefined) {
    throw env.invalid('validation_error', 'title, state, and stateReason are only valid for issue or pull request edits.')
  }
  if (action !== 'editIssue' && action !== 'editReview' && action !== 'addComment' && action !== 'updateComment' && body !== undefined) {
    throw env.invalid('validation_error', 'body is not valid for this project item action.')
  }
  if ((action === 'updateComment' || action === 'deleteComment') && commentId === undefined) throw env.invalid('validation_error', 'commentId is required for comment edits.')
  if (action !== 'updateComment' && action !== 'deleteComment' && commentId !== undefined) throw env.invalid('validation_error', 'commentId is only valid for comment edits.')
  if (action !== 'updateIssueType' && (issueTypeId !== undefined || issueTypeName !== undefined)) throw env.invalid('validation_error', 'Issue type selectors are only valid for updateIssueType.')

  const scope = await env.resolve(params, caller)
  const { identity: projectHostIdentity } = await resolveProjectHost(env, scope, params.host)
  const context = await projectItemContext(env, scope, project, item, projectHostIdentity)
  validateMutationKind(env, context, params)
  if ((action === 'editIssue' && context.kind !== 'issue') || (action === 'editReview' && context.kind !== 'pullRequest')) {
    throw env.invalid('validation_error', 'Mutation action does not match the selected project item type.')
  }
  const itemPath = `repos/${context.identity.owner}/${context.identity.repo}/${context.kind === 'issue' ? 'issues' : 'pulls'}/${context.number}`

  if (action === 'editIssue' || action === 'editReview') {
    const fields: Record<string, unknown> = {}
    if (title !== undefined) fields.title = title
    if (body !== undefined) fields.body = body
    if (stateValue !== undefined) fields.state = stateValue
    if (action === 'editIssue' && stateValue === 'closed' && stateReason !== undefined) fields.state_reason = stateReason
    try {
      await projectRest(env, scope, context.identity, itemPath, 'PATCH', fields, { idempotent: false })
    } catch (error: unknown) {
      throw classifyProjectError(env, error, projectHostIdentity.host)
    }
    env.changed(scope, { type: context.kind === 'issue' ? 'issue' : 'pr', number: context.number, projectId: project, action })
    return mutationResult(context, action, true)
  }

  if (action === 'addComment') {
    const commentBody = body ?? ''
    let response: unknown
    try {
      response = await projectRest(env, scope, context.identity, `repos/${context.identity.owner}/${context.identity.repo}/issues/${context.number}/comments`, 'POST', { body: commentBody }, { idempotent: false })
    } catch (error: unknown) {
      throw classifyProjectError(env, error, projectHostIdentity.host)
    }
    const id = positiveInteger(record(response)?.id)
    env.changed(scope, { type: context.kind === 'issue' ? 'issue' : 'pr', number: context.number, projectId: project, action })
    if (id === null) throw projectError(env, 'unknown', 'GitHub accepted the comment without returning its identity.')
    return mutationResult(context, action, true, { commentId: id, body: typeof record(response)?.body === 'string' ? record(response)?.body : commentBody })
  }

  if (action === 'updateComment' || action === 'deleteComment') {
    const target = commentPath(env, context, commentId)
    let comment: unknown
    try {
      comment = await projectRest(env, scope, context.identity, target.path, 'GET', undefined, { idempotent: true })
    } catch (error: unknown) {
      throw classifyProjectError(env, error, projectHostIdentity.host)
    }
    if (!commentMatchesContext(context, comment)) throw env.invalid('validation_error', 'Comment does not belong to the selected work item.')
    try {
      await projectRest(env, scope, context.identity, target.path, action === 'deleteComment' ? 'DELETE' : 'PATCH', action === 'deleteComment' ? undefined : { body }, { idempotent: false })
    } catch (error: unknown) {
      throw classifyProjectError(env, error, projectHostIdentity.host)
    }
    env.changed(scope, { type: context.kind === 'issue' ? 'issue' : 'pr', number: context.number, projectId: project, action })
    return mutationResult(context, action, true, { commentId: target.commentId })
  }

  if (context.kind !== 'issue') throw env.invalid('validation_error', 'Issue types can only be changed on issues.')
  const typeResult = await issueTypes(env, scope, projectHostIdentity, context)
  if (issueTypeId === undefined && issueTypeName === undefined) {
    return mutationResult(context, action, false, { issueTypes: typeResult.types })
  }
  const selectedType = issueTypeId !== undefined
    ? typeResult.types.find((type) => type.id === issueTypeId)
    : typeResult.types.find((type) => typeof type.name === 'string' && type.name.toLowerCase() === String(issueTypeName).trim().toLowerCase())
  if (!selectedType || typeof selectedType.id !== 'string' || selectedType.enabled === false || typeResult.issueId === null) {
    throw projectError(env, 'not_found', 'The requested GitHub issue type is unavailable.')
  }
  const result = await projectGraphql(env, scope, projectHostIdentity, ISSUE_TYPE_MUTATION, {
    input: { issueId: typeResult.issueId, issueTypeId: selectedType.id }
  }, false)
  const mutation = record(record(record(result)?.data)?.updateIssueIssueType)
  const updatedIssue = record(mutation?.issue)
  if (nonEmptyString(updatedIssue?.id) === null) throw projectError(env, 'unknown', 'GitHub did not confirm the issue type update.')
  env.changed(scope, { type: 'issue', number: context.number, projectId: project, action })
  return mutationResult(context, action, true, { issueType: record(updatedIssue?.issueType) })
}

export function projectMutationMethods(env: HostingEnv): Record<string, Handler> {
  return {
    projectField: (params, caller) => projectField(env, params, caller),
    projectItemMutation: (params, caller) => projectItemMutation(env, params, caller)
  }
}
