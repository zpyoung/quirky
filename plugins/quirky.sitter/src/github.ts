import { realpathSync } from 'node:fs'
import { RpcError, RpcErrorCode, type PluginCaller, type PluginContext, type Schema } from '@quirky/protocol'
import {
  checkKey,
  contentIdentity,
  worldFromHosting,
  type CapabilityMode,
  type ExecuteResult,
  type JournalEntry,
  type SitterAction,
  type SitterPayload,
  type SitterWorld,
  type Snapshot
} from './policy'
import { prepareWorkerExecute } from './agent'
import {
  computeFailureSignature,
  inspectWorktree,
  normalizeLogText,
  preflightContention,
  publishPreparedBranch
} from './publication'

export type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>

type EnrollmentInput = {
  kind: string
  kindPayload: Record<string, unknown>
  capabilities?: Record<string, CapabilityMode>
  owner?: unknown
  ownerInterventionCapability?: CapabilityMode
}

type AuthorizedEnrollment = {
  workspaceKey: string
  workspacePath: string
  executionHostId: string
  schedulerOwner: string
  repoId?: string | null
  worktreeId?: string | null
  kindPayload: SitterPayload
}

type SitterEnrollment = {
  capabilities: Record<string, CapabilityMode>
  worktreeId?: string | null
  kindPayload: SitterPayload
}

const CAPABILITIES = ['updateBranch', 'resolveConflicts', 'fixChecks', 'merge'] as const
const SORTED_CAPABILITIES = [...CAPABILITIES].sort()
const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const

export const SITTER_PAYLOAD_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'worktreeId',
    'branch',
    'headRefName',
    'provider',
    'reviewNumber',
    'reviewUrl',
    'repository',
    'branchUpdateMode',
    'mergeMethod',
    'mergeCheckScope'
  ],
  properties: {
    worktreeId: { type: 'string' },
    branch: { type: 'string' },
    headRefName: { type: 'string' },
    provider: { type: 'string', enum: ['github'] },
    reviewNumber: { type: 'integer', minimum: 1 },
    reviewUrl: { type: 'string' },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['host', 'owner', 'repo'],
      properties: {
        host: { type: 'string' },
        owner: { type: 'string' },
        repo: { type: 'string' }
      }
    },
    branchUpdateMode: { type: 'string', enum: ['merge-base-update'] },
    agent: { type: 'string' },
    mergeMethod: {},
    mergeCheckScope: { type: 'string', enum: ['all'] }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


export function assertHeimdallCaller(caller: PluginCaller): void {
  if (caller.role !== 'plugin' || caller.pluginId !== 'quirky.heimdall') {
    throw new RpcError(RpcErrorCode.InvalidParams, 'quirky.sitter hooks accept only quirky.heimdall as the caller')
  }
}

function validateInput(input: EnrollmentInput): {
  worktreeSelector: string
  branchUpdateMode: 'merge-base-update'
  mergeMethod: 'merge' | 'squash' | 'rebase' | null
  mergeCheckScope: 'all'
  agent?: string
} {
  const capabilities = input.capabilities
  const capabilityKeys = capabilities === undefined ? [] : Object.keys(capabilities).sort()
  if (capabilityKeys.length !== CAPABILITIES.length ||
    capabilityKeys.some((key, index) => key !== SORTED_CAPABILITIES[index])) {
    throw new Error('The PR sitter needs exactly the capabilities updateBranch, resolveConflicts, fixChecks and merge.')
  }
  if (input.owner !== undefined && input.owner !== null) throw new Error('The PR sitter does not accept an owner agent.')
  if (input.ownerInterventionCapability !== undefined && input.ownerInterventionCapability !== 'off') {
    throw new Error('The PR sitter does not accept owner interventions.')
  }

  const kindPayload = asRecord(input.kindPayload)
  const branchUpdateMode = kindPayload.branchUpdateMode ?? 'merge-base-update'
  if (branchUpdateMode !== 'merge-base-update') {
    throw new Error('The PR sitter updates a branch by merging its base; rebase is not supported.')
  }
  const mergeCheckScope = kindPayload.mergeCheckScope ?? 'all'
  if (mergeCheckScope !== 'all') throw new Error('The PR sitter supports only the all-checks merge scope.')
  const mergeMethod = kindPayload.mergeMethod === undefined ? null : kindPayload.mergeMethod
  if (mergeMethod !== null && !MERGE_METHODS.includes(mergeMethod as (typeof MERGE_METHODS)[number])) {
    throw new Error('mergeMethod must be null, merge, squash or rebase.')
  }
  const agent = kindPayload.agent
  if (agent !== undefined && (typeof agent !== 'string' || agent.trim().length === 0)) {
    throw new Error('kindPayload.agent must be a non-empty string.')
  }
  const worktreeSelector = kindPayload.worktree
  if (typeof worktreeSelector !== 'string' || worktreeSelector.length === 0) {
    throw new Error('kindPayload.worktree must name a worktree.')
  }

  return {
    worktreeSelector,
    branchUpdateMode,
    mergeMethod: mergeMethod as 'merge' | 'squash' | 'rebase' | null,
    mergeCheckScope,
    ...(typeof agent === 'string' ? { agent } : {})
  }
}

async function activeWorktreeSelector(call: Call): Promise<string> {
  let state: Record<string, unknown>
  try {
    state = asRecord(await call('ui.state', {}))
  } catch (error) {
    throw new Error(`worktree-unresolved: window state is unavailable (${messageOf(error)}); pass --worktree id:<id>.`)
  }
  const windows = state.windows
  if (!Array.isArray(windows) || windows.some(window => {
    const connId = asRecord(window).connId
    return !Number.isInteger(connId) || (connId as number) <= 0
  })) {
    throw new Error('worktree-unresolved: window state is unavailable (bad window list); pass --worktree id:<id>.')
  }
  if (windows.length === 0) {
    throw new Error('worktree-unresolved: no Quirky window is connected, so there is no active worktree; pass --worktree id:<id>.')
  }
  if (windows.length > 1) {
    throw new Error(`worktree-unresolved: ${windows.length} Quirky windows are connected, so the active worktree is ambiguous; pass --worktree id:<id>.`)
  }

  const connId = asRecord(windows[0]).connId as number
  let windowState: Record<string, unknown>
  try {
    windowState = asRecord(await call('ui.window.state', { connId }))
  } catch (error) {
    throw new Error(`worktree-unresolved: window state is unavailable (${messageOf(error)}); pass --worktree id:<id>.`)
  }
  const worktreeId = asRecord(windowState.layout).worktree
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
    throw new Error('worktree-unresolved: the connected window has no selected worktree; pass --worktree id:<id>.')
  }
  return `id:${worktreeId}`
}

export async function authorize(call: Call, input: EnrollmentInput): Promise<AuthorizedEnrollment> {
  const options = validateInput(input)
  const selector = options.worktreeSelector === 'active'
    ? await activeWorktreeSelector(call)
    : options.worktreeSelector
  const worktree = asRecord(await call('quirky.worktree/resolve', { selector }))
  if (worktree.kind !== 'git') throw new Error('The PR sitter needs a git worktree.')
  if (typeof worktree.branch !== 'string' || worktree.branch.length === 0) {
    throw new Error('Check out a branch in the worktree before arming the PR sitter.')
  }
  const worktreeId = worktree.id
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) throw new Error('The PR sitter needs a git worktree.')

  const lookup = asRecord(await call('quirky.hosting/forBranch', {
    worktree: worktreeId,
    branch: worktree.branch,
    fresh: true
  }))
  if (lookup.kind === 'no-review') {
    throw new Error(`No open pull request exists for branch ${worktree.branch}.`)
  }
  if (lookup.kind === 'unavailable') {
    const message = typeof lookup.message === 'string' ? lookup.message : 'unknown error'
    throw new Error(`Pull request lookup is unavailable: ${message}`)
  }
  if (lookup.kind !== 'found') throw new Error(`Pull request lookup is unavailable: ${messageOf(lookup.error ?? 'unknown error')}`)

  const review = asRecord(lookup.review)
  const number = review.number
  const state = review.state
  if (state !== 'open' && state !== 'draft') throw new Error(`Only an open pull request can be enrolled; #${String(number)} is ${String(state)}.`)
  const repository = asRecord(review.repository)
  const canonicalRepository = {
    host: repository.host as string,
    owner: repository.owner as string,
    repo: repository.repo as string
  }
  const workspacePath = realpathSync(worktree.path as string)
  const repoId = typeof worktree.repoId === 'string' || worktree.repoId === null ? worktree.repoId : undefined

  return {
    workspaceKey: `local::${workspacePath}`,
    workspacePath,
    executionHostId: 'local',
    schedulerOwner: 'daemon',
    ...(repoId !== undefined ? { repoId } : {}),
    worktreeId,
    kindPayload: {
      worktreeId,
      branch: worktree.branch,
      headRefName: review.headRefName as string,
      provider: 'github',
      reviewNumber: number as number,
      reviewUrl: review.url as string,
      repository: canonicalRepository,
      branchUpdateMode: options.branchUpdateMode,
      mergeMethod: options.mergeMethod,
      mergeCheckScope: options.mergeCheckScope,
      ...(options.agent === undefined ? {} : { agent: options.agent })
    }
  }
}

function reviewFromLookup(lookup: unknown, payload: SitterPayload): Record<string, unknown> {
  const result = asRecord(lookup)
  if (result.kind === 'no-review') {
    throw new Error(`Pull request #${payload.reviewNumber} is no longer visible in ${payload.repository.owner}/${payload.repository.repo}.`)
  }
  if (result.kind === 'unavailable') {
    throw new Error(typeof result.message === 'string' ? result.message : 'Pull request lookup is unavailable.')
  }
  if (result.kind !== 'found') throw new Error('Pull request lookup is unavailable.')
  return asRecord(result.review)
}

function identityChanged(review: Record<string, unknown>, payload: SitterPayload): boolean {
  const repository = asRecord(review.repository)
  return review.number !== payload.reviewNumber ||
    review.url !== payload.reviewUrl ||
    review.headRefName !== payload.headRefName ||
    repository.host !== payload.repository.host ||
    repository.owner !== payload.repository.owner ||
    repository.repo !== payload.repository.repo
}

function lookupErrorMessage(lookup: Record<string, unknown>, payload: SitterPayload): string {
  try {
    reviewFromLookup(lookup, payload)
  } catch (error) {
    return messageOf(error)
  }
  return 'Pull request lookup is unavailable.'
}


const MAX_FAILURE_EXCERPT_BYTES = 32 * 1024

function boundedFailureExcerpt(text: string): string {
  let start = text.length
  let bytes = 0
  while (start > 0) {
    let charStart = start - 1
    const trailing = text.charCodeAt(charStart)
    if (trailing >= 0xdc00 && trailing <= 0xdfff && charStart > 0) charStart--
    const codePoint = text.codePointAt(charStart)
    if (codePoint === undefined) break
    const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + width > MAX_FAILURE_EXCERPT_BYTES) break
    bytes += width
    start = charStart
  }
  return text.slice(start)
}

function signatureEvidence(details: Record<string, unknown>): { text: string; excerpt: string } | null {
  const annotationText: string[] = []
  if (Array.isArray(details.annotations)) {
    for (const annotation of details.annotations) {
      const row = asRecord(annotation)
      for (const field of ['title', 'message', 'rawDetails']) {
        const value = row[field]
        if (typeof value === 'string') annotationText.push(value)
      }
    }
  }
  const logs: string[] = []
  if (Array.isArray(details.logTails)) {
    for (const log of details.logTails) {
      const tail = asRecord(log).tail
      if (typeof tail === 'string') logs.push(tail)
    }
  }
  const text = normalizeLogText([...annotationText, ...logs].join('\n'))
  return text.length === 0 ? null : { text, excerpt: boundedFailureExcerpt(text) }
}

async function resolveWorktreePath(call: Call, worktreeId: string): Promise<string> {
  const resolved = asRecord(await call('quirky.worktree/resolve', { selector: `id:${worktreeId}` }))
  if (resolved.id !== worktreeId || resolved.kind !== 'git' || typeof resolved.path !== 'string' || resolved.path.length === 0) {
    throw new Error(`The enrolled worktree ${worktreeId} could not be resolved as a git worktree.`)
  }
  return resolved.path
}

async function enrichFailures(
  call: Call,
  checksValue: unknown,
  world: SitterWorld,
  payload: SitterPayload
): Promise<void> {
  const rows = asRecord(checksValue).checks
  const sourceRows = Array.isArray(rows) ? rows : []
  world.checks = await Promise.all(world.checks.map(async (check, index) => {
    if (check.state !== 'failed') return check
    const source = asRecord(sourceRows[index])
    if (check.kind === 'status') {
      const status = typeof source.status === 'string' ? source.status : ''
      const conclusion = typeof source.conclusion === 'string' ? source.conclusion : ''
      return {
        ...check,
        failureSignature: computeFailureSignature(checkKey(check), `${status}\u0000${conclusion}\u0000${check.observation}`),
        failureExcerpt: check.observation
      }
    }
    if (check.kind !== 'check_run' || check.checkRunId === null) return check
    try {
      const details = asRecord(await call('quirky.hosting/checkDetails', {
        worktree: payload.worktreeId,
        number: payload.reviewNumber,
        prRepo: payload.repository,
        checkRunId: check.checkRunId,
        ...(check.workflowRunId === null ? {} : { workflowRunId: check.workflowRunId }),
        noCache: true
      }))
      const evidence = signatureEvidence(details)
      return evidence === null
        ? { ...check, failureSignature: null, failureExcerpt: null }
        : {
          ...check,
          failureSignature: computeFailureSignature(checkKey(check), evidence.text),
          failureExcerpt: evidence.excerpt
        }
    } catch {
      return { ...check, failureSignature: null, failureExcerpt: null }
    }
  }))
}

export async function read(
  call: Call,
  enrollment: SitterEnrollment,
  processRun: PluginContext['process']['run']
): Promise<Snapshot<SitterWorld>> {
  const payload = enrollment.kindPayload
  const review = reviewFromLookup(await call('quirky.hosting/review', {
    worktree: payload.worktreeId,
    number: payload.reviewNumber,
    prRepo: payload.repository
  }), payload)
  if (identityChanged(review, payload)) {
    throw new Error(`Pull request identity changed: expected ${payload.repository.owner}/${payload.repository.repo}#${payload.reviewNumber} on ${payload.headRefName}.`)
  }

  const checks = review.state === 'merged'
    ? null
    : await call('quirky.hosting/checks', {
      worktree: payload.worktreeId,
      number: payload.reviewNumber,
      prRepo: payload.repository,
      noCache: true
    })
  const world = worldFromHosting(review, checks, payload)
  if (checks !== null) await enrichFailures(call, checks, world, payload)
  const worktreePath = await resolveWorktreePath(call, payload.worktreeId)
  const localState = await inspectWorktree(processRun, worktreePath)
  if (localState.localHeadSha === null) throw new Error('Git HEAD could not be read for the enrolled worktree.')
  Object.assign(world, localState)
  return {
    freshness: 'live',
    contentIdentity: contentIdentity(world),
    observedAtMs: Date.now(),
    world
  }
}

function apiParams(payload: SitterPayload): Record<string, unknown> {
  return { worktree: payload.worktreeId, number: payload.reviewNumber, prRepo: payload.repository }
}
type PreflightParams = {
  action: SitterAction
  snapshot: { world: SitterWorld }
  journal: JournalEntry[]
  enrollment: SitterEnrollment
}

type WorkerRequest = {
  spec: string
  worktree: string
  agent: string
  mode: 'structured'
  taskTitle: string
  model?: string
}

type ExecuteOptions = {
  processRun?: PluginContext['process']['run']
  fingerprint?: string
}

export async function preflight(
  call: Call,
  params: PreflightParams,
  processRun: PluginContext['process']['run']
) {
  const worktreeId = params.enrollment.worktreeId ?? params.enrollment.kindPayload.worktreeId ?? null
  return preflightContention(call, processRun, {
    ...params,
    enrollment: { ...params.enrollment, worktreeId }
  })
}

function failureResult(error: unknown): ExecuteResult {
  const message = messageOf(error)
  const reasonValue = asRecord(asRecord(error).data).reason
  const reason = typeof reasonValue === 'string' ? reasonValue : undefined
  if (reason === undefined || reason === 'unknown_completion' || reason === 'partial_failure') {
    return { effect: 'indeterminate', reason: message }
  }
  return { effect: 'not-landed', reason: `${reason}: ${message}` }
}

export async function execute(
  call: Call,
  action: SitterAction,
  enrollment: SitterEnrollment,
  sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms),
  options: ExecuteOptions = {}
): Promise<ExecuteResult | { effect: 'not-landed'; reason: string; detail: string } | { worker: WorkerRequest }> {
  const payload = enrollment.kindPayload
  try {
    switch (action.kind) {
      case 'merge': {
        const result = asRecord(await call('quirky.hosting/merge', {
          ...apiParams(payload),
          expectedHead: action.head,
          method: action.method,
          action: 'direct',
          yes: true
        }))
        if (result.state === 'merged') return { effect: 'landed' }
        if (result.state === 'enqueued') return { effect: 'indeterminate', reason: 'merge enqueued' }
        if (result.state === 'pending') return { effect: 'indeterminate', reason: 'pending' }
        return { effect: 'indeterminate', reason: 'merge result was not confirmed' }
      }
      case 'update-branch': {
        await call('quirky.hosting/updateBranch', {
          ...apiParams(payload),
          expectedHead: action.head
        })
        try {
          for (let poll = 0; poll < 10; poll++) {
            if (poll > 0) await sleep(1000)
            const lookup = asRecord(await call('quirky.hosting/review', apiParams(payload)))
            if (lookup.kind !== 'found') continue
            const review = asRecord(lookup.review)
            const head = review.headRefOid
            if (typeof head === 'string' && head.toLowerCase() !== action.head.toLowerCase()) {
              return { effect: 'landed', expectedAfter: { head } }
            }
          }
          return { effect: 'indeterminate', reason: 'update-branch requested; head unchanged after polling' }
        } catch (error) {
          return { effect: 'indeterminate', reason: messageOf(error) }
        }
      }
      case 'rerun-check': {
        const lookup = asRecord(await call('quirky.hosting/review', apiParams(payload)))
        if (lookup.kind !== 'found') {
          const reason = lookup.kind === 'no-review'
            ? 'no-review'
            : typeof lookup.reason === 'string' ? lookup.reason : 'lookup-unavailable'
          const message = lookup.kind !== 'no-review' && typeof lookup.message === 'string'
            ? lookup.message
            : lookupErrorMessage(lookup, payload)
          return { effect: 'not-landed', reason: `${reason}: ${message}` }
        }
        const review = asRecord(lookup.review)
        const head = review.headRefOid
        if (typeof head !== 'string') {
          return { effect: 'not-landed', reason: 'lookup-unavailable: Pull request lookup is unavailable.' }
        }
        if (head.toLowerCase() !== action.head.toLowerCase()) {
          return { effect: 'not-landed', reason: 'expected-state-mismatch: head moved' }
        }
        const result = asRecord(await call('quirky.hosting/rerunChecks', {
          ...apiParams(payload),
          failedOnly: true
        }))
        const started = result.started
        const targetCount = result.targetCount
        if (typeof started === 'number' && started > 0 && typeof targetCount === 'number') {
          return { effect: 'landed', expectedAfter: { started, targetCount } }
        }
        return { effect: 'not-landed', reason: 'no checks started' }
      }
      case 'prepare-fix':
      case 'prepare-conflict-resolution': {
        if (typeof options.fingerprint !== 'string' || options.fingerprint.length === 0) {
          return {
            effect: 'not-landed',
            reason: 'attempt-fingerprint-unavailable',
            detail: 'Heimdall did not provide the fingerprint for this prepare attempt.'
          }
        }
        return prepareWorkerExecute(call, { action, enrollment, fingerprint: options.fingerprint })
      }
      case 'publish-fix':
      case 'publish-conflict-resolution': {
        if (!options.processRun) {
          return { effect: 'not-landed', reason: 'git-unavailable', detail: 'A git process runner is required to verify publication.' }
        }
        const worktreePath = await resolveWorktreePath(call, payload.worktreeId)
        return publishPreparedBranch(call, options.processRun, {
          worktreePath,
          worktreeId: payload.worktreeId,
          expectedHeadSha: action.expectedHeadSha,
          preparedCommitSha: action.preparedCommitSha,
          expectedPrepareFingerprint: action.prepareFingerprint,
          expectedBaseSha: action.kind === 'publish-conflict-resolution' ? action.baseSha : undefined,
          expectedKind: action.kind === 'publish-fix' ? 'fix' : 'conflict-resolution'
        })
      }
      default:
        return { effect: 'not-landed', reason: 'unsupported-action' }
    }
  } catch (error) {
    return failureResult(error)
  }
}
