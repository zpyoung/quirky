import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Handler, HostingEnv, Scope } from './env'
import { isRecord, nonEmptyString, parseBranch, parseIdentity, parsePositiveInteger, sameIdentity, type IdentityValue } from './pr-data'
import type { PRLookup } from './pr-review'

type Blocker = { reason: string; nextAction: string; message: string }
type Eligibility = {
  eligible: boolean
  defaultBase: string | null
  head: string | null
  title: string
  body: string
  blockers: Blocker[]
  reason?: string
  nextAction?: string
  review?: unknown
}
type CreateResult = { number: number; url: string; existing?: boolean }

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md'
]

function repoArg(repository: IdentityValue): string {
  return `${repository.owner}/${repository.repo}`
}
function creationRepository(scope: Scope): IdentityValue {
  return scope.candidates?.[0] ?? scope.origin
}

function readParamString(env: HostingEnv, params: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = params[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || (required && value.trim().length === 0) || /[\u0000]/u.test(value)) {
    throw env.invalid('validation_error', `${key} must be a non-empty string.`)
  }
  return value.trim()
}

function branchOf(scope: Scope): string | undefined {
  return parseBranch(scope.worktree.branch)
}
function supportsGitHubOrigin(scope: Scope): boolean {
  if (scope.candidates === undefined) {
    return scope.origin.host.toLowerCase() === 'github.com'
  }
  return scope.candidates.some((candidate) => {
    const identity = parseIdentity(candidate)
    return identity !== undefined && sameIdentity(identity, scope.origin)
  })
}

function worktreeSelector(scope: Scope): string {
  return scope.worktree.id
}

function blocker(reason: string, nextAction: string, message: string): Blocker {
  return { reason, nextAction, message }
}

function firstBlock(result: Eligibility): Blocker | undefined {
  return result.blockers[0]
}

function defaultBranchFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.defaultBranchRef)) return undefined
  return nonEmptyString(value.defaultBranchRef.name)
}

async function projectDefaultBase(env: HostingEnv, scope: Scope): Promise<string | undefined> {
  try {
    const details = await env.context.call('quirky.repo/show', { repo: scope.worktree.repoId })
    if (!isRecord(details) || !isRecord(details.settings)) return undefined
    return nonEmptyString(details.settings.defaultBase)
  } catch {
    return undefined
  }
}

async function detectedDefaultBase(env: HostingEnv, scope: Scope): Promise<string | undefined> {
  try {
    const repository = creationRepository(scope)
    const result = await env.json({ ...scope, repository }, [
      'repo', 'view', '--repo', repoArg(repository), '--json', 'defaultBranchRef'
    ], { idempotent: true })
    return defaultBranchFrom(result)
  } catch {
    return undefined
  }
}

function normalizeBase(value: string): string {
  const trimmed = value.trim().replace(/^refs\/heads\//u, '').replace(/^refs\/remotes\//u, '')
  const slash = trimmed.indexOf('/')
  if (slash > 0 && (trimmed.slice(0, slash) === 'origin' || trimmed.slice(0, slash) === 'upstream')) return trimmed.slice(slash + 1)
  return trimmed
}

async function selectedBase(
  env: HostingEnv,
  scope: Scope,
  params: Record<string, unknown>
): Promise<{ base?: string; defaultBase?: string; detectedDefaultBase?: string }> {
  const requested = readParamString(env, params, 'base')
  const worktreeBase = nonEmptyString(scope.worktree.baseRef)
  const saved = await projectDefaultBase(env, scope)
  const detected = await detectedDefaultBase(env, scope)
  const selected = requested ?? worktreeBase ?? saved ?? detected
  if (!selected) return {}
  return {
    base: normalizeBase(selected),
    defaultBase: normalizeBase(selected),
    ...(detected ? { detectedDefaultBase: normalizeBase(detected) } : {})
  }
}

async function upstreamRef(env: HostingEnv, scope: Scope, branch: string): Promise<string | undefined> {
  try {
    const output = await env.git(scope, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
    const ref = nonEmptyString(output)
    return ref && !ref.startsWith('-') ? ref : undefined
  } catch {
    return undefined
  }
}

async function aheadBehind(env: HostingEnv, scope: Scope, upstream: string): Promise<{ behind: number; ahead: number } | undefined> {
  try {
    const output = await env.git(scope, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
    const parts = output.trim().split(/\s+/u)
    const behind = Number(parts[0])
    const ahead = Number(parts[1])
    if (!Number.isSafeInteger(behind) || behind < 0 || !Number.isSafeInteger(ahead) || ahead < 0) return undefined
    return { behind, ahead }
  } catch {
    return undefined
  }
}

async function remoteBaseExists(env: HostingEnv, scope: Scope, base: string): Promise<boolean> {
  try {
    const output = await env.git(scope, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
    return output.split(/\r?\n/u).some((ref) => {
      const slash = ref.indexOf('/')
      return slash > 0 && ref.slice(slash + 1) === base
    })
  } catch {
    return false
  }
}

async function authenticated(env: HostingEnv, scope: Scope): Promise<boolean> {
  try {
    await env.run(scope, ['auth', 'status'], { idempotent: true })
    return true
  } catch {
    return false
  }
}


export async function creationEligibility(
  env: HostingEnv,
  lookup: PRLookup,
  params: Record<string, unknown>,
  caller: Parameters<Handler>[1]
): Promise<Eligibility> {
  let scope: Scope
  try {
    scope = await env.resolve(params, caller)
  } catch (error) {
    const reason = isRecord(error) && isRecord(error.data) && typeof error.data.reason === 'string' ? error.data.reason : undefined
    if (reason !== 'unsupported_provider') throw error
    const item = blocker('unsupported_provider', 'select_github_repo', 'Pull request creation requires a configured GitHub repository.')
    return {
      eligible: false,
      defaultBase: null,
      head: null,
      title: typeof params.title === 'string' ? params.title : '',
      body: typeof params.body === 'string' ? params.body : '',
      blockers: [item],
      reason: item.reason,
      nextAction: item.nextAction
    }
  }
  const branch = branchOf(scope)
  const title = typeof params.title === 'string' ? params.title : ''
  const body = typeof params.body === 'string' ? params.body : ''
  if (!branch) {
    const item = blocker('detached_head', 'checkout_branch', 'Check out a branch before creating a pull request.')
    return { eligible: false, defaultBase: null, head: null, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  if (!supportsGitHubOrigin(scope)) {
    const item = blocker('unsupported_provider', 'select_github_repo', 'Pull request creation requires a configured GitHub repository.')
    return { eligible: false, defaultBase: null, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }

  const lookupResult = await lookup.forBranch({ worktree: worktreeSelector(scope), branch, headOid: scope.worktree.head, active: true }, caller)
  if (lookupResult.kind === 'found') {
    const item = blocker('existing_review', 'open_existing_review', 'This branch already has a pull request.')
    return { eligible: false, defaultBase: null, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction, review: lookupResult.review }
  }
  if (lookupResult.kind === 'unavailable') {
    const item = blocker('lookup_unavailable', 'retry_lookup', 'Could not verify whether this branch already has a pull request.')
    return { eligible: false, defaultBase: null, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }

  const baseSelection = await selectedBase(env, scope, params)
  const base = baseSelection.base
  if (!base) {
    const item = blocker('missing_remote_base', 'fetch_base', 'Could not determine a base branch for this repository.')
    return { eligible: false, defaultBase: null, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  if (branch.toLowerCase() === (baseSelection.detectedDefaultBase ?? base).toLowerCase() || branch.toLowerCase() === base.toLowerCase()) {
    const item = blocker('default_branch', 'create_new_branch', 'A pull request cannot be created from the repository default branch.')
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }

  let status = ''
  try {
    status = await env.git(scope, ['status', '--porcelain', '--untracked-files=all'])
  } catch {
    status = '?'
  }
  if (status.trim().length > 0) {
    const item = blocker('dirty_tree', 'commit_changes', 'Commit or discard local changes before creating a pull request.')
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }

  const upstream = await upstreamRef(env, scope, branch)
  if (!upstream) {
    const item = blocker('no_upstream', 'publish_branch', 'Publish this branch and configure its upstream before creating a pull request.')
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  const divergence = await aheadBehind(env, scope, upstream)
  if (!divergence) {
    const item = blocker('no_upstream', 'configure_upstream', 'Could not verify the branch upstream.')
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  if (divergence.behind > 0) {
    const item = blocker('branch_behind', 'sync_branch', 'Sync this branch with its upstream before creating a pull request.')
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  if (!(await authenticated(env, scope))) {
    const item = blocker('authentication_required', 'authenticate', 'GitHub authentication is unavailable. Check your gh login.')
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  if (divergence.ahead > 0) {
    const item = blocker('branch_ahead', 'push_branch', 'Push local commits to the configured upstream before creating a pull request.')
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  if (!(await remoteBaseExists(env, scope, base))) {
    const item = blocker('missing_remote_base', 'fetch_base', `The base branch ${base} is not present on a configured remote.`)
    return { eligible: false, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [item], reason: item.reason, nextAction: item.nextAction }
  }
  return { eligible: true, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [] }
}

function parseCreatedReview(value: unknown, repository: IdentityValue): CreateResult | undefined {
  let number: number | undefined
  let url: string | undefined
  if (isRecord(value)) {
    number = parsePositiveInteger(value.number)
    url = nonEmptyString(value.url)
  }
  if ((!number || !url) && typeof value === 'string') {
    const match = value.match(/https?:\/\/[^\s]+\/pull\/(\d+)/iu)
    if (match) {
      number = parsePositiveInteger(Number(match[1]))
      url = match[0].replace(/[),.]+$/u, '')
    }
  }
  if (!number || !url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.hostname.toLowerCase() !== repository.host.toLowerCase()) return undefined
  const expectedPath = `/${repository.owner}/${repository.repo}/pull/${number}`.toLowerCase()
  if (parsed.pathname.toLowerCase() !== expectedPath) return undefined
  return { number, url: `${parsed.origin}${expectedPath}` }
}

function createListMatches(value: unknown, head: string, base: string, repository: IdentityValue, headOwner: string): CreateResult[] {
  if (!Array.isArray(value)) return []
  const matches: CreateResult[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const number = parsePositiveInteger(item.number)
    const url = nonEmptyString(item.url)
    const branch = parseBranch(item.headRefName)
    const target = parseBranch(item.baseRefName)
    const owner = isRecord(item.headRepositoryOwner) ? nonEmptyString(item.headRepositoryOwner.login) : undefined
    const headRepository = isRecord(item.headRepository) ? nonEmptyString(item.headRepository.name) : undefined
    if (!number || !url || branch !== head || target !== base || !owner || owner.toLowerCase() !== headOwner.toLowerCase() ||
      !headRepository || headRepository.toLowerCase() !== repository.repo.toLowerCase()) continue
    const parsed = parseCreatedReview({ number, url }, repository)
    if (parsed) matches.push(parsed)
  }
  return matches
}

async function probeCreate(env: HostingEnv, scope: Scope, repository: IdentityValue, headOwner: string, head: string, base: string): Promise<CreateResult[]> {
  const selectedScope: Scope = { ...scope, repository }
  const value = await env.json(selectedScope, [
    'pr', 'list', '--repo', repoArg(repository), '--head', `${headOwner}:${head}`, '--base', base,
    '--state', 'open', '--limit', '2', '--json', 'number,url,headRefName,baseRefName,headRepositoryOwner,headRepository'
  ], { idempotent: true })
  return createListMatches(value, head, base, repository, headOwner)
}

function createErrorReason(error: unknown): string {
  if (isRecord(error) && isRecord(error.data) && typeof error.data.reason === 'string') return error.data.reason
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (/401|authentication|not logged|bad credentials/.test(message)) return 'auth_required'
  if (/403|permission/.test(message)) return 'permission_denied'
  if (/422|validation/.test(message)) return 'validation_error'
  if (/429|rate limit|retry-after/.test(message)) return 'rate_limited'
  if (/already exists|already a pull request|duplicate/.test(message)) return 'already_exists'
  if (/timed out|timeout|connection lost|unknown completion/.test(message)) return 'unknown_completion'
  return 'upstream_unavailable'
}

function isAmbiguousCreate(error: unknown): boolean {
  const reason = createErrorReason(error)
  return !['auth_required', 'permission_denied', 'validation_error', 'rate_limited', 'repo_unavailable', 'gh_unavailable', 'unsupported_provider'].includes(reason)
}

function unknownCompletion(env: HostingEnv): Error {
  return env.invalid('unknown_completion', 'PR creation may have completed, but one matching pull request could not be confirmed. Refresh the branch review state.')
}

async function bodyForCreate(scope: Scope, supplied: string | undefined, useTemplate: boolean): Promise<string> {
  if (!useTemplate) return supplied ?? ''
  if (supplied !== undefined && supplied.trim().length > 0) return supplied
  for (const relative of TEMPLATE_PATHS) {
    try {
      return await readFile(join(scope.worktree.path, relative), 'utf8')
    } catch {
      // The ordered template search continues until the first readable file.
    }
  }
  return ''
}

function requestedHead(env: HostingEnv, params: Record<string, unknown>, scope: Scope, branch: string): string {
  const requested = readParamString(env, params, 'head')
  if (requested === undefined) return branch
  if (requested.includes(':')) {
    const [owner, ref, extra] = requested.split(':')
    if (!owner || !ref || extra !== undefined || owner.toLowerCase() !== scope.origin.owner.toLowerCase()) {
      throw env.invalid('validation_error', 'head must name the current origin owner and one branch.')
    }
    return ref
  }
  const parsed = parseBranch(requested)
  if (!parsed) throw env.invalid('validation_error', 'head must be a valid branch name.')
  return parsed
}

export function createPRCreationMethods(env: HostingEnv, lookup: PRLookup): Record<string, Handler> {
  const eligibility: Handler = async (params, caller) => creationEligibility(env, lookup, params, caller)

  const create: Handler = async (params, caller) => {
    const title = readParamString(env, params, 'title', true)!
    const eligibilityResult = await creationEligibility(env, lookup, { ...params, title }, caller)
    const blocking = firstBlock(eligibilityResult)
    if (blocking) throw env.invalid(blocking.reason, blocking.message)
    const scope = await env.resolve(params, caller)
    const branch = branchOf(scope)
    if (!branch) throw env.invalid('detached_head', 'Check out a branch before creating a pull request.')
    const repository = creationRepository(scope)
    const mutationScope: Scope = { ...scope, repository }
    const baseSelection = await selectedBase(env, scope, params)
    const base = baseSelection.base
    if (!base) throw env.invalid('missing_remote_base', 'Could not determine a base branch for this repository.')
    const head = requestedHead(env, params, scope, branch)
    if (base.toLowerCase() === head.toLowerCase()) throw env.invalid('validation_error', 'The pull request head and base branches must differ.')
    const suppliedBody = readParamString(env, params, 'body')
    const body = await bodyForCreate(scope, suppliedBody, params.useTemplate === true)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quirky-pr-body-'))
    const bodyFile = join(temporaryDirectory, 'body.md')
    let output: string | undefined
    let mutationError: unknown
    try {
      await writeFile(bodyFile, body, 'utf8')
      const args = [
        'pr', 'create', '--repo', repoArg(repository), '--base', base, '--head', `${scope.origin.owner}:${head}`,
        '--title', title, '--body-file', bodyFile
      ]
      if (params.draft === true) args.push('--draft')
      try {
        output = await env.run(mutationScope, args, { idempotent: false, timeoutMs: 60_000 })
      } catch (error) {
        mutationError = error
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }

    const confirmed = parseCreatedReview(output, repository)
    if (confirmed) {
      lookup.invalidate(mutationScope, { type: 'pr', number: confirmed.number, url: confirmed.url })
      return confirmed
    }

    if (mutationError !== undefined && !isAmbiguousCreate(mutationError)) {
      const reason = createErrorReason(mutationError)
      if (reason === 'auth_required') throw env.invalid('auth_required', 'GitHub authentication is unavailable. Check your gh login.')
      if (reason === 'permission_denied') throw env.invalid('permission_denied', 'GitHub did not allow pull request creation.')
      if (reason === 'rate_limited') throw env.invalid('rate_limited', 'GitHub rate limits prevent pull request creation.')
      throw env.invalid('validation_error', 'GitHub rejected the pull request details.')
    }

    let matches: CreateResult[] = []
    try {
      matches = await probeCreate(env, scope, repository, scope.origin.owner, head, base)
    } catch {
      lookup.invalidate(mutationScope, { type: 'pr', unknownCompletion: true, confirmed: false })
      throw unknownCompletion(env)
    }
    if (matches.length === 1) {
      const [existing] = matches
      if (existing) {
        lookup.invalidate(mutationScope, { type: 'pr', number: existing.number, url: existing.url })
        return { ...existing, existing: true }
      }
    }
    lookup.invalidate(mutationScope, { type: 'pr', unknownCompletion: true, confirmed: false })
    throw unknownCompletion(env)
  }

  const createStacked: Handler = async (params, caller) => {
    const parentNumber = parsePositiveInteger(params.parentNumber)
    if (!parentNumber) throw env.invalid('validation_error', 'parentNumber must be a positive integer.')
    const scope = await env.resolve(params, caller)
    if (scope.origin.host.toLowerCase() !== 'github.com') {
      throw env.invalid('unsupported_provider', 'Stacked pull requests are available only on GitHub.com.')
    }
    const parent = await lookup.readFresh({ ...params, number: parentNumber }, caller)
    if (!parent) throw env.invalid('not_found', 'The parent pull request was not found.')
    if (parent.review.state !== 'open' && parent.review.state !== 'draft') {
      throw env.invalid('validation_error', 'A stacked pull request must have an open parent review.')
    }
    if (!parent.stackKnown) throw env.invalid('unknown_safety_metadata', 'Could not verify GitHub pull request stack metadata.')

    let stackId: string | undefined
    const parentStack = parent.review.stack
    if (parentStack !== null && parentStack !== undefined && parentStack !== false) {
      if (!isRecord(parentStack)) throw env.invalid('unknown_safety_metadata', 'Could not verify GitHub pull request stack metadata.')
      stackId = nonEmptyString(parentStack.id)
      const entries = Array.isArray(parentStack.pullRequests) ? parentStack.pullRequests :
        Array.isArray(parentStack.pull_requests) ? parentStack.pull_requests : undefined
      if (!stackId || !entries || entries.length === 0) {
        throw env.invalid('unknown_safety_metadata', 'Could not verify GitHub pull request stack metadata.')
      }
      const last = entries[entries.length - 1]
      const topNumber = isRecord(last) ? parsePositiveInteger(last.number) : parsePositiveInteger(last)
      if (topNumber !== parentNumber) throw env.invalid('stack_parent_not_top', 'The selected parent pull request is not the top of its stack.')
    }

    const localBranch = branchOf(scope)
    if (!localBranch) throw env.invalid('detached_head', 'Check out a branch before creating a stacked pull request.')
    const head = requestedHead(env, params, scope, localBranch)
    const base = readParamString(env, params, 'base') ?? parent.review.headRefName
    const current = await lookup.forBranch({
      worktree: scope.worktree.id,
      branch: head,
      headOid: scope.worktree.head,
      active: true
    }, caller)
    if (current.kind === 'unavailable') {
      throw env.invalid('lookup_unavailable', 'Could not verify whether this branch already has a pull request.')
    }

    let result: CreateResult
    let createdNow = false
    if (current.kind === 'found') {
      if (current.review.state !== 'open' && current.review.state !== 'draft') {
        throw env.invalid('validation_error', 'An existing stacked pull request must be open.')
      }
      if (current.review.baseRefName.toLowerCase() !== base.toLowerCase()) {
        throw env.invalid('stack_base_mismatch', 'The existing pull request does not target the selected parent branch.')
      }
      result = { number: current.review.number, url: current.review.url, existing: true }
      const childStack = current.review.stack
      if (childStack !== null && childStack !== undefined && childStack !== false) {
        if (!isRecord(childStack)) throw env.invalid('unknown_safety_metadata', 'Could not verify GitHub pull request stack metadata.')
        const childStackId = nonEmptyString(childStack.id)
        if (!childStackId) throw env.invalid('unknown_safety_metadata', 'Could not verify GitHub pull request stack metadata.')
        if (stackId && childStackId === stackId) return { ...result, stacked: true }
        throw env.invalid('stack_conflict', 'The existing pull request already belongs to a different stack.')
      }
    } else {
      const created = await create({ ...params, base }, caller)
      const number = isRecord(created) ? parsePositiveInteger(created.number) : undefined
      const url = isRecord(created) ? nonEmptyString(created.url) : undefined
      if (!number || !url) throw env.invalid('upstream_unavailable', 'GitHub created a pull request without a confirmed identity.')
      result = { number, url, ...(created.existing === true ? { existing: true } : {}) }
      createdNow = result.existing !== true
    }

    const repository = parent.repository
    const selectedScope: Scope = { ...scope, repository }
    try {
      let registration: unknown
      if (stackId) {
        registration = await env.rest(selectedScope,
          `repos/${repository.owner}/${repository.repo}/stacks/${encodeURIComponent(stackId)}/add`,
          'POST',
          { pull_requests: [result.number] },
          { idempotent: false, timeoutMs: 60_000 })
        if (!isRecord(registration) || (registration.added !== true && registration.id !== stackId)) {
          throw env.invalid('upstream_unavailable', 'GitHub did not confirm stack registration.')
        }
      } else {
        registration = await env.rest(selectedScope,
          `repos/${repository.owner}/${repository.repo}/stacks`,
          'POST',
          { pull_requests: [parentNumber, result.number] },
          { idempotent: false, timeoutMs: 60_000 })
        if (!isRecord(registration) || !nonEmptyString(registration.id)) {
          throw env.invalid('upstream_unavailable', 'GitHub did not confirm stack registration.')
        }
      }
      lookup.invalidate(selectedScope, { type: 'pr', number: result.number, url: result.url, stacked: true })
    } catch {
      if (createdNow) {
        lookup.invalidate(selectedScope, {
          partial: true,
          completedSteps: ['create'],
          createdReview: { number: result.number, url: result.url }
        })
        throw env.invalid('partial_change', `Pull request #${result.number} (${result.url}) was created, but GitHub stack registration failed; the stacks API may not be available for this repository. Completed steps: create.`)
      }
      throw env.invalid('upstream_unavailable', 'GitHub could not register the existing pull request in the stack; the stacks API may not be available for this repository.')
    }
    return { ...result, stacked: true }
  }

  return { creationEligibility: eligibility, create, createStacked }
}
