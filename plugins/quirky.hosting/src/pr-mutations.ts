import type { Handler, HostingEnv, Scope } from './env'
import { isRecord, nonEmptyString, parseOid, parsePositiveInteger, providerReason } from './pr-data'
import type { PRLookup, PRRead } from './pr-review'

type MergeMethod = 'squash' | 'merge' | 'rebase'
type MergeAction = 'direct' | 'queue'
type AsyncOutcome = { state: 'merged' | 'enqueued' | 'pending'; operationId?: string }

function repoArg(read: PRRead): string {
  return `${read.repository.owner}/${read.repository.repo}`
}

function invalid(env: HostingEnv, reason: string, message: string): never {
  throw env.invalid(reason, message)
}
function safeProviderFailure(env: HostingEnv, error: unknown): Error | undefined {
  const reason = providerReason(error)
  if (reason === 'already_exists') return env.invalid(reason, 'A matching GitHub item already exists.')
  if (reason === 'body_too_long') return env.invalid(reason, 'GitHub rejected the request because its body is too long.')
  if (reason === 'schema_drift') return env.invalid(reason, 'GitHub returned an unsupported API schema.')
  if (reason === 'scope_missing') return env.invalid(reason, 'The authenticated GitHub account lacks the required API scopes.')
  if (reason === 'head_changed') return env.invalid(reason, 'The pull request head changed. Refresh and review the new commit before trying again.')
  if (reason === 'not_found') return env.invalid(reason, 'The GitHub pull request was not found in the configured repository.')
  if (reason === 'not_authenticated' || reason === 'auth_required') return env.invalid('auth_required', 'GitHub authentication is unavailable. Check your gh login.')
  if (reason === 'permission_denied') return env.invalid(reason, 'GitHub did not allow access to this pull request.')
  if (reason === 'rate_limited') return env.invalid(reason, 'GitHub rate limits prevent this pull request operation.')
  if (reason === 'repository_unavailable' || reason === 'repo_unavailable') return env.invalid('repo_unavailable', 'The GitHub repository is unavailable or inaccessible.')
  if (reason === 'gh_unavailable') return env.invalid(reason, 'GitHub CLI is unavailable.')
  if (reason === 'validation_error') return env.invalid(reason, 'GitHub rejected the requested operation.')
  return undefined
}

function numberParam(env: HostingEnv, params: Record<string, unknown>): number {
  const number = parsePositiveInteger(params.number)
  if (!number) return invalid(env, 'validation_error', 'number must be a positive integer.')
  return number
}

function methodParam(env: HostingEnv, value: unknown): MergeMethod {
  if (value === 'squash' || value === 'merge' || value === 'rebase') return value
  return invalid(env, 'validation_error', 'method must be squash, merge, or rebase.')
}

function expectedHeadParam(env: HostingEnv, value: unknown, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  const oid = parseOid(value)
  if (!oid) return invalid(env, 'validation_error', 'expectedHead must be a 40- or 64-character hexadecimal commit SHA.')
  return oid
}

function rawString(read: PRRead, key: string): string | undefined {
  const value = read.raw[key]
  return typeof value === 'string' ? value : undefined
}

function isStacked(read: PRRead): boolean {
  return read.review.stack !== null && read.review.stack !== undefined && read.review.stack !== false &&
    !(Array.isArray(read.review.stack) && read.review.stack.length === 0)
}

function stackId(read: PRRead): string | undefined {
  return isRecord(read.review.stack) ? nonEmptyString(read.review.stack.id) : undefined
}

function mergeRulesRequireReview(read: PRRead): boolean {
  return read.metadata.rules.some((rule) => isRecord(rule) && (rule.type === 'PULL_REQUEST' || rule.type === 'REQUIRED_REVIEWERS'))
}

function mergeRulesRequireChecks(read: PRRead): boolean {
  return read.metadata.rules.some((rule) => isRecord(rule) && rule.type === 'REQUIRED_STATUS_CHECKS')
}

function checkedRead(env: HostingEnv, read: PRRead | null): PRRead {
  if (!read) return invalid(env, 'not_found', 'The GitHub pull request was not found in the configured repository.')
  return read
}

async function freshRead(env: HostingEnv, lookup: PRLookup, params: Record<string, unknown>, caller: Parameters<Handler>[1]): Promise<PRRead> {
  return checkedRead(env, await lookup.readFresh(params, caller))
}

function verifyHead(env: HostingEnv, read: PRRead, expectedHead: string): void {
  if (read.review.headRefOid.toLowerCase() !== expectedHead) {
    invalid(env, 'head_changed', 'The pull request head changed. Refresh and review the new commit before trying again.')
  }
}

function checkSafety(env: HostingEnv, read: PRRead, method: MergeMethod, action: MergeAction): void {
  if (!read.stackKnown) invalid(env, 'unknown_safety_metadata', 'Could not verify GitHub pull request stack metadata. Refresh and try again.')
  if (!read.metadata.known || read.metadata.mergeQueueRequired === null) {
    invalid(env, 'unknown_safety_metadata', 'Could not verify GitHub branch protection and merge-queue metadata. Refresh and try again.')
  }
  if (!read.metadata.mergeMethods.allowed.includes(method)) {
    invalid(env, 'merge_method_unavailable', `The ${method} merge method is not enabled for this repository.`)
  }
  if (read.review.reviewDecision === 'REVIEW_REQUIRED') {
    invalid(env, 'review_required', 'Required reviews are still missing. Request and receive the required approvals before merging.')
  }
  if (read.review.reviewDecision === 'CHANGES_REQUESTED') {
    invalid(env, 'changes_requested', 'A reviewer requested changes. Resolve the review before merging.')
  }
  if (!['APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(read.review.reviewDecision)) {
    invalid(env, 'unknown_safety_metadata', 'Could not verify the current review decision. Refresh and try again.')
  }
  if (mergeRulesRequireReview(read) && read.review.reviewDecision !== 'APPROVED') {
    invalid(env, 'review_required', 'Required reviews are still missing. Request and receive the required approvals before merging.')
  }
  if (read.review.mergeable === 'CONFLICTING' || read.review.mergeStateStatus === 'DIRTY') {
    invalid(env, 'merge_conflict', 'This pull request has merge conflicts. Resolve them before merging.')
  }
  if (read.review.mergeStateStatus === 'BLOCKED') {
    invalid(env, 'merge_blocked', 'GitHub protection rules currently block this pull request from merging.')
  }
  if (read.review.mergeable === 'UNKNOWN' || !['CLEAN', 'BEHIND', 'UNSTABLE'].includes(read.review.mergeStateStatus)) {
    invalid(env, 'unknown_safety_metadata', 'GitHub has not provided enough current mergeability information. Refresh and try again.')
  }
  if (mergeRulesRequireChecks(read) && read.review.checksStatus !== 'success') {
    invalid(env, read.review.checksStatus === 'failure' ? 'checks_failed' : 'checks_pending', 'Required status checks have not succeeded.')
  }
  if (action === 'direct' && read.metadata.mergeQueueRequired) {
    invalid(env, 'queue_required', 'This branch requires a merge queue. Choose the queue action instead of direct merge.')
  }
  if (action === 'queue' && !read.metadata.mergeQueueRequired) {
    invalid(env, 'queue_unavailable', 'This branch does not have a configured merge queue.')
  }
  if (read.review.state !== 'open') invalid(env, 'review_not_open', 'Only an open pull request can be merged.')
}

function parseAsync(value: unknown): AsyncOutcome | undefined {
  if (!isRecord(value) || typeof value.status !== 'string') return undefined
  const status = value.status.toLowerCase()
  if (status !== 'merged' && status !== 'enqueued' && status !== 'pending') return undefined
  const operationId = typeof value.id === 'string' && value.id.trim().length > 0 ? value.id : undefined
  return { state: status, ...(operationId ? { operationId } : {}) }
}

function unknownCompletion(env: HostingEnv): Error {
  return env.invalid('unknown_completion', 'GitHub may still be processing this merge. Refresh the pull request state before retrying.')
}
function isHeadMismatch(error: unknown): boolean {
  return providerReason(error) === 'head_changed'
}

function recordUnknownCompletion(lookup: PRLookup, scope: Scope, number: number): void {
  lookup.invalidate(scope, { type: 'pr', number, unknownCompletion: true, confirmed: false })
}

async function asyncMerge(
  env: HostingEnv,
  lookup: PRLookup,
  read: PRRead,
  expectedHead: string,
  method: MergeMethod,
  action: MergeAction
): Promise<{ state: AsyncOutcome['state']; number: number; head: string; operationId?: string }> {
  const number = read.review.number
  const operation = read.review.stack ? stackId(read) : undefined
  if (read.review.stack && !operation) invalid(env, 'unknown_safety_metadata', 'Could not verify the GitHub stack identity.')
  if (read.repository.host.toLowerCase() !== 'github.com') {
    invalid(env, 'stacked_merge_unsupported', 'GitHub asynchronous stack and queue merging is not supported on this host.')
  }
  const path = `repos/${read.repository.owner}/${read.repository.repo}/pulls/${number}/merge-async`
  let result: AsyncOutcome | undefined
  try {
    const response = await env.rest(read.scope, path, 'PUT', {
      merge_action: action === 'queue' ? 'merge_queue' : 'direct_merge',
      merge_method: method,
      sha: expectedHead
    }, { idempotent: false, timeoutMs: 60_000 })
    result = parseAsync(response)
  } catch (error) {
    if (isHeadMismatch(error)) invalid(env, 'head_changed', 'The pull request head changed. Refresh and review the new commit before trying again.')
    const failure = safeProviderFailure(env, error)
    if (failure) throw failure
    recordUnknownCompletion(lookup, read.scope, number)
    throw unknownCompletion(env)
  }
  if (!result) {
    recordUnknownCompletion(lookup, read.scope, number)
    throw unknownCompletion(env)
  }
  if (result.state !== 'pending') {
    lookup.invalidate(read.scope, { type: 'pr', number, state: result.state, head: expectedHead })
    return { state: result.state, number, head: expectedHead, ...(result.operationId ? { operationId: result.operationId } : {}) }
  }
  if (!result.operationId) {
    recordUnknownCompletion(lookup, read.scope, number)
    throw unknownCompletion(env)
  }

  lookup.invalidate(read.scope, { type: 'pr', number, state: 'pending', operationId: result.operationId, head: expectedHead })
  const deadline = Date.now() + 180_000
  for (let attempt = 0; attempt < 180 && Date.now() < deadline; attempt += 1) {
    await Bun.sleep(1_000)
    try {
      const polled = parseAsync(await env.rest(read.scope, `${path}/${encodeURIComponent(result.operationId)}`, 'GET', undefined, { idempotent: true, timeoutMs: 10_000 }))
      if (polled?.state === 'merged' || polled?.state === 'enqueued') {
        lookup.invalidate(read.scope, { type: 'pr', number, state: polled.state, operationId: result.operationId, head: expectedHead })
        return { state: polled.state, number, head: expectedHead, operationId: result.operationId }
      }
    } catch {
      // The accepted operation remains pending when a status read is temporarily unavailable.
    }
  }
  return { state: 'pending', number, head: expectedHead, operationId: result.operationId }
}

export function createPRMutationMethods(env: HostingEnv, lookup: PRLookup): Record<string, Handler> {
  const merge: Handler = async (params, caller) => {
    const number = numberParam(env, params)
    const expectedHead = expectedHeadParam(env, params.expectedHead)!
    const method = methodParam(env, params.method)
    const action = params.action === 'direct' || params.action === 'queue' ? params.action : invalid(env, 'validation_error', 'action must be direct or queue.')
    const read = await freshRead(env, lookup, { ...params, number }, caller)
    verifyHead(env, read, expectedHead)
    checkSafety(env, read, method, action)
    if (isStacked(read) || action === 'queue') return asyncMerge(env, lookup, read, expectedHead, method, action)

    try {
      await env.run(read.scope, [
        'pr', 'merge', String(number), `--${method}`, '--match-head-commit', expectedHead, '--repo', repoArg(read)
      ], { idempotent: false, timeoutMs: 60_000 })
    } catch (error) {
      if (isHeadMismatch(error)) invalid(env, 'head_changed', 'The pull request head changed. Refresh and review the new commit before trying again.')
      const failure = safeProviderFailure(env, error)
      if (failure) throw failure
      recordUnknownCompletion(lookup, read.scope, number)
      throw unknownCompletion(env)
    }
    lookup.invalidate(read.scope, { type: 'pr', number, state: 'merged', head: expectedHead })
    return { state: 'merged', number, head: expectedHead }
  }

  const autoMerge: Handler = async (params, caller) => {
    const number = numberParam(env, params)
    const action = params.action
    if (action !== 'enable' && action !== 'disable') invalid(env, 'validation_error', 'action must be enable or disable.')
    const read = await freshRead(env, lookup, { ...params, number }, caller)
    const expectedHead = expectedHeadParam(env, params.expectedHead, action === 'enable')
    if (expectedHead) verifyHead(env, read, expectedHead)
    if (action === 'enable' && (!read.stackKnown || !read.metadata.known || read.metadata.mergeQueueRequired === null)) {
      invalid(env, 'unknown_safety_metadata', 'Could not verify stack and merge metadata. Refresh and try again.')
    }
    if (action === 'enable') {
      if (isStacked(read)) invalid(env, 'stacked_auto_merge_unsupported', 'GitHub does not support auto-merge for stacked pull requests.')
      const method = methodParam(env, params.method)
      if (!read.metadata.mergeMethods.allowed.includes(method)) invalid(env, 'merge_method_unavailable', `The ${method} merge method is not enabled for this repository.`)
      const id = rawString(read, 'id')
      if (!id) invalid(env, 'unknown_safety_metadata', 'Could not verify the pull request identity for auto-merge.')
      if (read.review.autoMergeRequest !== null && read.review.autoMergeRequest !== undefined) {
        return { number, enabled: true, alreadyEnabled: true }
      }
      if (read.metadata.mergeQueueRequired) {
        try {
          await env.run(read.scope, [
            'pr', 'merge', String(number), '--auto', `--${method}`, '--match-head-commit', expectedHead!, '--repo', repoArg(read)
          ], { idempotent: false, timeoutMs: 60_000 })
        } catch (error) {
          if (providerReason(error) === 'already_exists') invalid(env, 'already_mergeable', 'This pull request can already be merged. Use Merge instead of auto-merge.')
          if (isHeadMismatch(error)) invalid(env, 'head_changed', 'The pull request head changed. Refresh and review the new commit before trying again.')
          const failure = safeProviderFailure(env, error)
          if (failure) throw failure
          recordUnknownCompletion(lookup, read.scope, number)
          throw env.invalid('unknown_completion', 'GitHub may still be processing the auto-merge request. Refresh before retrying.')
        }
      } else {
        let response: unknown
        try {
          response = await env.graphql(read.scope,
            'mutation EnableHostingPullRequestAutoMerge($pullRequestId:ID!,$mergeMethod:PullRequestMergeMethod!,$expectedHeadOid:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,mergeMethod:$mergeMethod,expectedHeadOid:$expectedHeadOid}){pullRequest{id autoMergeRequest{enabledAt}}}}',
            { pullRequestId: id, mergeMethod: method.toUpperCase(), expectedHeadOid: expectedHead },
            { idempotent: false, timeoutMs: 60_000 }
          )
        } catch (error) {
          if (providerReason(error) === 'already_exists') invalid(env, 'already_mergeable', 'This pull request can already be merged. Use Merge instead of auto-merge.')
          if (isHeadMismatch(error)) invalid(env, 'head_changed', 'The pull request head changed. Refresh and review the new commit before trying again.')
          const failure = safeProviderFailure(env, error)
          if (failure) throw failure
          recordUnknownCompletion(lookup, read.scope, number)
          throw env.invalid('unknown_completion', 'GitHub may still be processing the auto-merge request. Refresh before retrying.')
        }
        const data = isRecord(response) && isRecord(response.data) ? response.data : undefined
        const payload = data?.enablePullRequestAutoMerge
        const pullRequest = isRecord(payload) ? payload.pullRequest : undefined
        const autoMergeRequest = isRecord(pullRequest) ? pullRequest.autoMergeRequest : undefined
        if (!isRecord(pullRequest) || pullRequest.id !== id || !isRecord(autoMergeRequest) || !nonEmptyString(autoMergeRequest.enabledAt)) {
          recordUnknownCompletion(lookup, read.scope, number)
          throw unknownCompletion(env)
        }
      }
    } else {
      if (read.review.autoMergeRequest === null || read.review.autoMergeRequest === undefined) return { number, enabled: false, alreadyDisabled: true }
      try {
        await env.run(read.scope, ['pr', 'merge', String(number), '--disable-auto', '--repo', repoArg(read)], { idempotent: false, timeoutMs: 60_000 })
      } catch (error) {
        const failure = safeProviderFailure(env, error)
        if (failure) throw failure
        recordUnknownCompletion(lookup, read.scope, number)
        throw env.invalid('unknown_completion', 'GitHub may still be processing the auto-merge cancellation. Refresh before retrying.')
      }
    }
    lookup.invalidate(read.scope, { type: 'pr', number, autoMerge: action })
    return { number, enabled: action === 'enable' }
  }

  const updateReview: Handler = async (params, caller) => {
    const number = numberParam(env, params)
    const action = params.action
    if (action !== 'edit' && action !== 'close' && action !== 'reopen' && action !== 'ready') {
      invalid(env, 'validation_error', 'action must be edit, close, reopen, or ready.')
    }
    const fields: Record<string, unknown> = {}
    if (action === 'edit') {
      if (params.title !== undefined) {
        if (typeof params.title !== 'string' || params.title.trim().length === 0) invalid(env, 'validation_error', 'title must not be empty.')
        fields.title = params.title.trim()
      }
      if (params.body !== undefined) {
        if (typeof params.body !== 'string') invalid(env, 'validation_error', 'body must be a string.')
        fields.body = params.body
      }
      if (Object.keys(fields).length === 0) invalid(env, 'validation_error', 'Provide a title or body to edit.')
    }
    const read = await freshRead(env, lookup, { ...params, number }, caller)
    if (action === 'edit') {
      try {
        await env.rest(read.scope, `repos/${read.repository.owner}/${read.repository.repo}/pulls/${number}`, 'PATCH', fields, { idempotent: false, timeoutMs: 60_000 })
      } catch (error) {
        const failure = safeProviderFailure(env, error)
        throw failure ?? env.invalid('upstream_unavailable', 'GitHub could not update the pull request.')
      }
    } else {
      const verb = action === 'ready' ? 'ready' : action
      try {
        await env.run(read.scope, ['pr', verb, String(number), '--repo', repoArg(read)], { idempotent: false, timeoutMs: 60_000 })
      } catch (error) {
        const failure = safeProviderFailure(env, error)
        throw failure ?? env.invalid('upstream_unavailable', `GitHub could not ${action} the pull request.`)
      }
    }
    lookup.invalidate(read.scope, { type: 'pr', number, action })
    return { number, updated: true }
  }

  const reviewers: Handler = async (params, caller) => {
    const number = numberParam(env, params)
    if (params.action !== 'add' && params.action !== 'remove') invalid(env, 'validation_error', 'action must be add or remove.')
    if (!Array.isArray(params.logins) || params.logins.length === 0) invalid(env, 'validation_error', 'At least one reviewer login is required.')
    const logins: string[] = []
    for (const value of params.logins) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)) {
        invalid(env, 'validation_error', 'Reviewer logins must be valid GitHub usernames.')
      }
      if (!logins.some((login) => login.toLowerCase() === value.toLowerCase())) logins.push(value)
    }
    const read = await freshRead(env, lookup, { ...params, number }, caller)
    const option = params.action === 'add' ? '--add-reviewer' : '--remove-reviewer'
    try {
      await env.run(read.scope, ['pr', 'edit', String(number), option, logins.join(','), '--repo', repoArg(read)], { idempotent: false, timeoutMs: 60_000 })
    } catch (error) {
      const failure = safeProviderFailure(env, error)
      throw failure ?? env.invalid('upstream_unavailable', 'GitHub could not update pull request reviewers.')
    }
    lookup.invalidate(read.scope, { type: 'pr', number, reviewers: params.action })
    return { number, updated: true }
  }

  return { merge, autoMerge, updateReview, reviewers }
}
