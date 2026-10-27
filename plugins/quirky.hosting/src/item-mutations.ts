import type { Handler, HostingEnv, Identity, Scope } from './env'
import {
  boundedText,
  ensureStringArray,
  isBodyTooLarge,
  mapWorkItem,
  positiveInteger,
  positiveParam,
  requiredList,
  safeErrorMessage,
  safeErrorReason,
  scopeForRepository,
  type WorkItemRecord
} from './item-data'

type ItemCaller = Parameters<Handler>[1]

function issueScope(scope: Scope): { scope: Scope; identity: Identity } {
  const identity = scope.issueRepository
  return { scope: scopeForRepository(scope, identity), identity }
}

function completedError(env: HostingEnv, error: unknown, completedSteps: string[]): Error {
  const reason = safeErrorReason(error)
  const message = completedSteps.length > 0
    ? `Issue update failed after completed steps: ${completedSteps.join(', ')}.`
    : safeErrorMessage(error)
  const failure = env.invalid(reason, message)
  return Object.assign(failure, { data: { reason, partial: completedSteps.length > 0, completedSteps } })
}

function issueResult(env: HostingEnv, value: unknown, identity: Identity): WorkItemRecord {
  const mapped = mapWorkItem(value, { identity, kind: 'issue' })
  if (!mapped) throw env.invalid('unknown', 'GitHub accepted the issue mutation but returned an invalid issue.')
  return mapped
}


async function createIssue(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<Record<string, unknown>> {
  const title = boundedText(env, params, 'title', { required: true, maxBytes: 256 })
  const body = boundedText(env, params, 'body', { maxBytes: 1_048_576 })
  const labels = ensureStringArray(env, params.labels, 'labels')
  const assignees = ensureStringArray(env, params.assignees, 'assignees')
  const scope = await env.resolve(params, caller)
  const { scope: selected, identity } = issueScope(scope)
  const path = `repos/${identity.owner}/${identity.repo}/issues`
  const payload: Record<string, unknown> = { title }
  if (body !== undefined) payload.body = body
  if (labels.length > 0) payload.labels = labels
  if (assignees.length > 0) payload.assignees = assignees

  let response: unknown
  let bodyTooLarge = false
  try {
    response = await env.rest(selected, path, 'POST', payload, { idempotent: false })
  } catch (error: unknown) {
    if (body === undefined || body.length === 0 || !isBodyTooLarge(error)) throw error
    response = await env.rest(selected, path, 'POST', { ...payload, body: '' }, { idempotent: false })
    bodyTooLarge = true
  }
  const created = record(response)
  const number = positiveInteger(created?.number)
  env.changed(scope, { type: 'issue', ...(number === null ? {} : { number }), completedSteps: ['issue-created'] })
  if (number === null) throw env.invalid('unknown', 'GitHub created the issue without returning its number.')
  if (bodyTooLarge && body !== undefined) {
    try {
      await env.rest(selected, `${path}/${number}`, 'PATCH', { body }, { idempotent: false })
      env.changed(scope, { type: 'issue', number, completedSteps: ['issue-created', 'body-saved'] })
    } catch {
      const warning = 'The issue was created, but GitHub could not save its body.'
      env.changed(scope, { type: 'issue', number, partial: true, completedSteps: ['issue-created'] })
      const mapped = issueResult(env, response, identity)
      return { ...mapped, bodySaveWarning: warning, partial: true, completedSteps: ['issue-created'] }
    }
  }
  return issueResult(env, response, identity)
}

async function assertIssue(env: HostingEnv, scope: Scope, identity: Identity, number: number): Promise<void> {
  const raw = await env.rest(scope, `repos/${identity.owner}/${identity.repo}/issues/${number}`, 'GET', undefined, { idempotent: true })
  if (record(raw) && record(raw)?.pull_request) throw env.invalid('validation_error', 'updateIssue only supports issues, not pull requests.')
}

async function updateIssue(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<Record<string, unknown>> {
  const number = positiveParam(env, params, 'number') ?? 0
  const stateValue = params.state
  if (stateValue !== undefined && stateValue !== 'open' && stateValue !== 'closed') throw env.invalid('validation_error', 'state must be open or closed.')
  const stateReason = params.stateReason
  if (stateReason !== undefined && stateReason !== 'completed' && stateReason !== 'not_planned') throw env.invalid('validation_error', 'stateReason must be completed or not_planned.')
  const duplicateOf = positiveParam(env, params, 'duplicateOf', false)
  if (duplicateOf !== undefined && stateValue !== 'closed') throw env.invalid('validation_error', 'duplicateOf requires state closed.')
  if (stateReason !== undefined && stateValue !== 'closed') throw env.invalid('validation_error', 'stateReason requires state closed.')
  const title = boundedText(env, params, 'title', { maxBytes: 256 })
  const body = boundedText(env, params, 'body', { maxBytes: 1_048_576 })
  if (title !== undefined && title.trim().length === 0) throw env.invalid('validation_error', 'title cannot be empty.')
  const addLabels = ensureStringArray(env, params.addLabels, 'addLabels')
  const removeLabels = ensureStringArray(env, params.removeLabels, 'removeLabels')
  const addAssignees = ensureStringArray(env, params.addAssignees, 'addAssignees')
  const removeAssignees = ensureStringArray(env, params.removeAssignees, 'removeAssignees')
  const hasFields = title !== undefined || body !== undefined || addLabels.length > 0 || removeLabels.length > 0 || addAssignees.length > 0 || removeAssignees.length > 0
  if (stateValue === undefined && !hasFields) throw env.invalid('validation_error', 'At least one issue change is required.')
  const scope = await env.resolve(params, caller)
  const { scope: selected, identity } = issueScope(scope)
  await assertIssue(env, selected, identity, number)
  const completedSteps: string[] = []
  try {
    if (stateValue !== undefined) {
      const args = ['issue', stateValue === 'closed' ? 'close' : 'reopen', String(number), '--repo', `${identity.owner}/${identity.repo}`]
      if (stateValue === 'closed' && stateReason !== undefined) args.push('--reason', stateReason === 'not_planned' ? 'not planned' : 'completed')
      if (duplicateOf !== undefined) args.push('--duplicate-of', String(duplicateOf))
      await env.run(selected, args, { idempotent: false })
      completedSteps.push('state')
      env.changed(scope, { type: 'issue', number, completedSteps: [...completedSteps] })
    }
    const fields: Record<string, unknown> = {}
    if (title !== undefined) fields.title = title
    if (body !== undefined) fields.body = body
    if (Object.keys(fields).length > 0) {
      await env.rest(selected, `repos/${identity.owner}/${identity.repo}/issues/${number}`, 'PATCH', fields, { idempotent: false })
      completedSteps.push('content')
      env.changed(scope, { type: 'issue', number, completedSteps: [...completedSteps] })
    }
    if (addLabels.length + removeLabels.length + addAssignees.length + removeAssignees.length > 0) {
      const args = ['issue', 'edit', String(number), '--repo', `${identity.owner}/${identity.repo}`]
      for (const label of addLabels) args.push('--add-label', label)
      for (const label of removeLabels) args.push('--remove-label', label)
      for (const login of addAssignees) args.push('--add-assignee', login)
      for (const login of removeAssignees) args.push('--remove-assignee', login)
      await env.run(selected, args, { idempotent: false })
      completedSteps.push('labels-assignees')
      env.changed(scope, { type: 'issue', number, completedSteps: [...completedSteps] })
    }
  } catch (error: unknown) {
    if (completedSteps.length > 0) env.changed(scope, { type: 'issue', number, partial: true, completedSteps: [...completedSteps] })
    throw completedError(env, error, completedSteps)
  }
  try {
    const item = await env.rest(selected, `repos/${identity.owner}/${identity.repo}/issues/${number}`, 'GET', undefined, { idempotent: true })
    return issueResult(env, item, identity)
  } catch (error: unknown) {
    if (completedSteps.length > 0) env.changed(scope, { type: 'issue', number, partial: true, completedSteps: [...completedSteps] })
    throw completedError(env, error, completedSteps)
  }
}

async function issueComment(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<Record<string, unknown>> {
  const number = positiveParam(env, params, 'number') ?? 0
  const body = boundedText(env, params, 'body', { required: true, maxBytes: 65_536 }) ?? ''
  const scope = await env.resolve(params, caller)
  const { scope: selected, identity } = issueScope(scope)
  await assertIssue(env, selected, identity, number)
  const response = await env.rest(selected, `repos/${identity.owner}/${identity.repo}/issues/${number}/comments`, 'POST', { body }, { idempotent: false })
  env.changed(scope, { type: 'issue', number })
  const raw = record(response)
  const id = positiveInteger(raw?.id)
  if (id === null) throw env.invalid('unknown', 'GitHub accepted the comment but did not return its identity.')
  return {
    id,
    issueNumber: number,
    body: typeof raw?.body === 'string' ? raw.body : body,
    url: typeof raw?.html_url === 'string' ? raw.html_url : typeof raw?.url === 'string' ? raw.url : null,
    createdAt: typeof raw?.created_at === 'string' ? raw.created_at : null,
    author: record(raw?.user)?.login ?? null
  }
}

async function listCollection(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller, kind: 'labels' | 'assignees'): Promise<Record<string, unknown>> {
  const queryValue = params.query
  if (queryValue !== undefined && typeof queryValue !== 'string') throw env.invalid('validation_error', 'query must be a string.')
  const query = typeof queryValue === 'string' ? queryValue.trim().toLowerCase() : ''
  if (query.length > 256) throw env.invalid('validation_error', 'query exceeds the 256-character limit.')
  const scope = await env.resolve(params, caller)
  const { scope: selected, identity } = issueScope(scope)
  const entries: unknown[] = []
  for (let page = 1; page <= 1000; page += 1) {
    const path = kind === 'labels'
      ? `repos/${identity.owner}/${identity.repo}/labels?per_page=100&page=${page}`
      : `repos/${identity.owner}/${identity.repo}/assignees?per_page=100&page=${page}`
    const response = await env.rest(selected, path, 'GET', undefined, { idempotent: true })
    const values = requiredList(env, response, kind)
    entries.push(...values)
    if (values.length < 100) break
    if (page === 1000) throw env.invalid('too_large', `GitHub returned more than 100000 ${kind}.`)
  }
  const results = kind === 'labels'
    ? entries.flatMap((value) => {
        const raw = record(value)
        const name = typeof value === 'string' ? value : raw && typeof raw.name === 'string' ? raw.name : null
        return name !== null && name.toLowerCase().includes(query) ? [name] : []
      })
    : entries.flatMap((value) => {
        const raw = record(value)
        const login = typeof raw?.login === 'string' ? raw.login : null
        return login !== null && login.toLowerCase().includes(query) ? [{ login, avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : null }] : []
      })
  return kind === 'labels'
    ? { labels: results, totalCount: results.length, truncated: false }
    : { assignees: results, totalCount: results.length, truncated: false }
}

export function itemMutationMethods(env: HostingEnv): Record<string, Handler> {
  return {
    createIssue: (params, caller) => createIssue(env, params, caller),
    updateIssue: (params, caller) => updateIssue(env, params, caller),
    issueComment: (params, caller) => issueComment(env, params, caller),
    labels: (params, caller) => listCollection(env, params, caller, 'labels'),
    assignees: (params, caller) => listCollection(env, params, caller, 'assignees')
  }
}
