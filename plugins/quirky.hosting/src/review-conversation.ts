import type { Handler, HostingEnv, Scope } from './env'
import { isRecord, parsePositiveInteger, providerReason } from './pr-data'
import type { PRLookup, PRRead } from './pr-review'

type ConversationAction = 'add' | 'edit' | 'delete'
type ConversationInput = { number: number; action: ConversationAction; commentId?: number; body?: string }

function conversationInput(env: HostingEnv, params: Record<string, unknown>): ConversationInput {
  const number = parsePositiveInteger(params.number)
  if (!number) throw env.invalid('invalid_number', 'A positive pull request number is required.')
  const action = params.action
  if (action !== 'add' && action !== 'edit' && action !== 'delete') throw env.invalid('invalid_action', 'Choose add, edit, or delete.')
  let commentId: number | undefined
  if (action !== 'add') {
    commentId = parsePositiveInteger(params.commentId)
    if (!commentId) throw env.invalid('invalid_comment', 'A positive conversation comment ID is required.')
  } else if (params.commentId !== undefined) throw env.invalid('invalid_comment', 'A new comment must not supply an existing comment ID.')
  let body: string | undefined
  if (action !== 'delete') {
    if (typeof params.body !== 'string' || params.body.trim().length === 0 || Buffer.byteLength(params.body, 'utf8') > 65_536) throw env.invalid('invalid_body', 'A nonempty comment body of at most 65536 UTF-8 bytes is required.')
    body = params.body
  } else if (params.body !== undefined) throw env.invalid('invalid_body', 'Deleting a comment does not accept a body.')
  return { number, action, ...(commentId !== undefined ? { commentId } : {}), ...(body !== undefined ? { body } : {}) }
}

async function selectedReview(env: HostingEnv, lookup: PRLookup, params: Record<string, unknown>, caller: Parameters<Handler>[1]): Promise<PRRead> {
  const read = await lookup.readFresh(params, caller)
  if (!read) throw env.invalid('not_found', 'The pull request was not found in a configured repository.')
  return read
}

function route(read: PRRead): { scope: Scope; base: string } {
  return { scope: { ...read.scope, repository: read.repository }, base: `repos/${read.repository.owner}/${read.repository.repo}` }
}

async function requireComment(env: HostingEnv, read: PRRead, id: number): Promise<Record<string, unknown>> {
  const { scope, base } = route(read)
  const raw = await env.rest(scope, `${base}/issues/comments/${id}`, 'GET', undefined, { idempotent: true })
  if (!isRecord(raw) || raw.id !== id || typeof raw.issue_url !== 'string') throw env.invalid('comment_mismatch', 'The comment does not belong to this pull request.')
  let url: URL
  try { url = new URL(raw.issue_url) } catch { throw env.invalid('comment_mismatch', 'The comment does not belong to this pull request.') }
  const expectedHost = read.repository.host.toLowerCase() === 'github.com' ? 'api.github.com' : read.repository.host.toLowerCase()
  const expectedPath = `${read.repository.host.toLowerCase() === 'github.com' ? '' : '/api/v3'}/${base}/issues/${read.review.number}`
  if (url.protocol !== 'https:' || url.host.toLowerCase() !== expectedHost || url.pathname.toLowerCase() !== expectedPath.toLowerCase() || url.username || url.password || url.search || url.hash) {
    throw env.invalid('comment_mismatch', 'The comment does not belong to this pull request.')
  }
  return raw
}

function commentValue(env: HostingEnv, raw: unknown, read: PRRead): Record<string, unknown> {
  if (!isRecord(raw) || !parsePositiveInteger(raw.id) || typeof raw.body !== 'string') throw env.invalid('unknown_completion', 'GitHub accepted the comment but did not return a valid comment. Refresh before retrying.')
  const author = isRecord(raw.user) && typeof raw.user.login === 'string' ? raw.user.login : null
  return { id: raw.id, kind: 'issue_comment', body: raw.body, author, createdAt: typeof raw.created_at === 'string' ? raw.created_at : null, url: `https://${read.repository.host}/${read.repository.owner}/${read.repository.repo}/pull/${read.review.number}#issuecomment-${raw.id}` }
}

function mutationError(env: HostingEnv, lookup: PRLookup, read: PRRead, error: unknown, operation: string): Error {
  const reason = providerReason(error)
  if (reason === 'timeout' || reason === 'output_limit' || reason === 'unknown_completion') {
    lookup.invalidate(read.scope, { type: 'pr', number: read.review.number, operation, uncertain: true })
    return env.invalid('unknown_completion', 'GitHub may have processed the change. Refresh before retrying.')
  }
  const messages: Record<string, string> = {
    permission_denied: 'GitHub did not permit this review change.',
    not_found: 'The selected review or comment is no longer available.',
    auth_required: 'GitHub authentication is required.',
    not_authenticated: 'GitHub authentication is required.',
    rate_limited: 'GitHub rate limits prevent this review change.',
    validation_error: 'GitHub rejected this review change.'
  }
  return env.invalid(reason && messages[reason] ? reason : 'upstream_unavailable', reason && messages[reason] ? messages[reason] : 'GitHub could not complete the review change.')
}

export function createPRConversationMethods(env: HostingEnv, lookup: PRLookup): Record<string, Handler> {
  const reviewConversationConfirmation: Handler = async (params, caller) => {
    const input = conversationInput(env, params)
    if (input.action !== 'delete') return null
    const read = await selectedReview(env, lookup, params, caller)
    await requireComment(env, read, input.commentId!)
    return `Delete conversation comment ${input.commentId} from ${read.repository.host}/${read.repository.owner}/${read.repository.repo} PR #${input.number}? This permanently removes the comment.`
  }
  const reviewConversation: Handler = async (params, caller) => {
    const input = conversationInput(env, params)
    const read = await selectedReview(env, lookup, params, caller)
    const { scope, base } = route(read)
    if (input.action !== 'add') await requireComment(env, read, input.commentId!)
    let raw: unknown
    try {
      raw = await env.rest(scope,
        input.action === 'add' ? `${base}/issues/${input.number}/comments` : `${base}/issues/comments/${input.commentId}`,
        input.action === 'add' ? 'POST' : input.action === 'edit' ? 'PATCH' : 'DELETE',
        input.action === 'delete' ? undefined : { body: input.body }, { idempotent: false })
    } catch (error) { throw mutationError(env, lookup, read, error, `conversation-${input.action}`) }
    lookup.invalidate(read.scope, { type: 'pr', number: input.number, operation: `conversation-${input.action}` })
    if (input.action === 'delete') return { number: input.number, action: input.action, commentId: input.commentId, deleted: true }
    return { number: input.number, action: input.action, comment: commentValue(env, raw, read) }
  }
  const reviewAssignees: Handler = async (params, caller) => {
    if (params.action !== 'add' && params.action !== 'remove' && params.action !== 'set') throw env.invalid('invalid_action', 'Choose add, remove, or set.')
    if (!Array.isArray(params.logins) || params.logins.length > 100 || (params.action !== 'set' && params.logins.length === 0)) throw env.invalid('invalid_logins', 'Supply up to 100 GitHub logins; add/remove requires at least one.')
    const logins: string[] = []
    const seen = new Set<string>()
    for (const login of params.logins) {
      if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw env.invalid('invalid_logins', 'Assignees must be valid GitHub usernames.')
      if (!seen.has(login.toLowerCase())) { seen.add(login.toLowerCase()); logins.push(login) }
    }
    const read = await selectedReview(env, lookup, params, caller)
    const { scope, base } = route(read)
    let raw: unknown
    try {
      raw = await env.rest(scope, `${base}/issues/${read.review.number}${params.action === 'set' ? '' : '/assignees'}`, params.action === 'set' ? 'PATCH' : params.action === 'add' ? 'POST' : 'DELETE', { assignees: logins }, { idempotent: false })
    } catch (error) { throw mutationError(env, lookup, read, error, 'review-assignees') }
    lookup.invalidate(read.scope, { type: 'pr', number: read.review.number, operation: 'review-assignees' })
    if (!isRecord(raw) || !Array.isArray(raw.assignees) || raw.assignees.some((user) => !isRecord(user) || typeof user.login !== 'string')) throw env.invalid('unknown_completion', 'GitHub accepted the assignee update but did not return the assignment. Refresh before retrying.')
    return { number: read.review.number, assignees: raw.assignees.map((user) => isRecord(user) ? user.login : null) }
  }
  return { reviewConversation, reviewConversationConfirmation, reviewAssignees }
}
