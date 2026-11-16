import { createHash } from 'node:crypto'
import type { PluginContext, RunOptions, RunResult } from '@quirky/protocol'
import type { ExpectedReview, ObjectivePayload, RemoteLandingAuthority, RemoteObservation, RepoIdentity } from './contract'
import { remoteExpectedStateTarget, sameRemoteAuthority } from './contract'
import type { ObjectiveAction, ObjectiveJournalEntry, ObjectiveProgress } from './decide'
import { recordFilesOnDisk, readLocalGitHead } from './landing'
import type { ObjectiveRuntime } from './checks'
import type { LandingRecord } from './store'

type RemoteAction = Extract<ObjectiveAction, { kind: 'push-ref' | 'open-hosted-review' }>
type GitResult = RunResult
type LocalTarget = {
  branch: string
  headSha: string
  remote: string
  remoteRef: string
  pushUrl: string
  pushUrlFingerprint: string
}
type Eligibility = {
  eligible: boolean
  defaultBase: string | null
  blockers: string[]
  review: unknown | null
}
type AuthorityResolution = {
  authority: RemoteLandingAuthority
  pushUrl: string
  problem: string | null
  review: ExpectedReview | null
  eligibility: Eligibility | null
}
type GitResultValue<T> = { value: T } | { problem: string }
type ReviewRead = { kind: 'found'; expected: ExpectedReview; state: string; isDraft: boolean } | { kind: 'no-review' } | { kind: 'unavailable'; reason: string }

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u
const REF_PART = /^[^\u0000-\u0020\u007f]{1,1024}$/u
const NON_INTERACTIVE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  GIT_ASKPASS: '/usr/bin/false',
  SSH_ASKPASS: '/usr/bin/false'
}
const LOCAL_READ_OPTIONS: Omit<RunOptions, 'cwd'> = {
  env: NON_INTERACTIVE_ENV,
  timeoutMs: 30_000,
  maxOutputBytes: 256 * 1024
}
const NETWORK_READ_OPTIONS: Omit<RunOptions, 'cwd'> = {
  env: NON_INTERACTIVE_ENV,
  timeoutMs: 120_000,
  maxOutputBytes: 256 * 1024
}
const NETWORK_WRITE_OPTIONS: Omit<RunOptions, 'cwd'> = {
  env: NON_INTERACTIVE_ENV,
  timeoutMs: 120_000,
  maxOutputBytes: 2 * 1024 * 1024
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameRepository(left: RepoIdentity, right: RepoIdentity): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase() &&
    left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase()
}

function identity(value: unknown): RepoIdentity | null {
  if (!isRecord(value) || typeof value.host !== 'string' || typeof value.owner !== 'string' || typeof value.repo !== 'string') return null
  if (!value.host || !value.owner || !value.repo || value.host.length > 255 || value.owner.length > 100 || value.repo.length > 100 ||
    /[\u0000-\u0020\u007f/\\]/u.test(value.host) || /[\u0000-\u0020\u007f/\\]/u.test(value.owner) ||
    /[\u0000-\u0020\u007f/\\]/u.test(value.repo)) return null
  return { host: value.host, owner: value.owner, repo: value.repo }
}

function expectedReview(value: unknown): ExpectedReview | null {
  if (!isRecord(value)) return null
  const repository = identity(value.repository)
  if (!repository) return null
  const number = Number.isSafeInteger(value.number) && (value.number as number) > 0 ? value.number as number : null
  const headRefName = typeof value.headRefName === 'string' && REF_PART.test(value.headRefName) ? value.headRefName : null
  const baseRefName = typeof value.baseRefName === 'string' && REF_PART.test(value.baseRefName) ? value.baseRefName : null
  const headSha = typeof value.headSha === 'string' && FULL_OID.test(value.headSha) ? value.headSha.toLowerCase() : null
  let headRepository: RepoIdentity | null = null
  if (identity(value.headRepository)) {
    headRepository = identity(value.headRepository)
  } else if (isRecord(value.headRepository) && typeof value.headRepository.name === 'string') {
    const owner = isRecord(value.headRepository.owner) ? value.headRepository.owner.login : undefined
    const headOwner = isRecord(value.headRepositoryOwner) ? value.headRepositoryOwner.login : undefined
    if (typeof owner === 'string') headRepository = { host: repository.host, owner, repo: value.headRepository.name }
    else if (typeof headOwner === 'string') headRepository = { host: repository.host, owner: headOwner, repo: value.headRepository.name }
  }
  if (!headRepository || !identity(headRepository) || number === null || !headRefName || !baseRefName || !headSha || typeof value.url !== 'string') return null
  let parsed: URL
  try { parsed = new URL(value.url) } catch { return null }
  const path = `/${repository.owner}/${repository.repo}/pull/${number}`
  if (parsed.protocol !== 'https:' || parsed.host.toLowerCase() !== repository.host.toLowerCase() ||
    parsed.pathname.toLowerCase() !== path.toLowerCase() || parsed.username || parsed.password || parsed.search || parsed.hash) return null
  return {
    number,
    url: `https://${repository.host}${path}`,
    repository,
    headRepository,
    headRefName,
    baseRefName,
    headSha
  }
}


async function git(
  context: PluginContext,
  workspacePath: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = LOCAL_READ_OPTIONS
): Promise<GitResult> {
  return context.process.run(['git', ...args], { ...options, cwd: workspacePath })
}

function commandFailed(result: GitResult): boolean {
  return result.exitCode !== 0 || result.signal !== null || result.stopped !== undefined || result.spawnError !== undefined
}

async function configValue(context: PluginContext, workspacePath: string, key: string): Promise<GitResultValue<string | null>> {
  try {
    const result = await git(context, workspacePath, ['config', '--get', key])
    if (!commandFailed(result)) return { value: result.stdoutText.trim() || null }
    if (result.exitCode === 1 && result.signal === null && result.stopped === undefined && result.spawnError === undefined) return { value: null }
    return { problem: 'push-target-unavailable' }
  } catch {
    return { problem: 'push-target-unavailable' }
  }
}

async function refIsValid(context: PluginContext, workspacePath: string, ref: string): Promise<boolean> {
  if (!REF_PART.test(ref) || ref.startsWith('/') || ref.endsWith('/') || ref.includes('..')) return false
  try {
    const result = await git(context, workspacePath, ['check-ref-format', `refs/heads/${ref}`])
    return !commandFailed(result)
  } catch {
    return false
  }
}

function safePushUrl(value: string): boolean {
  if (!value || value.length > 4096 || value.startsWith('-') || /[\u0000\r\n]/u.test(value) || value.startsWith('ext::')) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    try {
      const parsed = new URL(value)
      return ['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(parsed.protocol) && !parsed.hash
    } catch {
      return false
    }
  }
  return true
}

async function localPushTarget(
  context: PluginContext,
  workspacePath: string
): Promise<GitResultValue<LocalTarget>> {
  let head: { branch: string | null; headSha: string | null }
  try { head = await readLocalGitHead(context, workspacePath) } catch { return { problem: 'push-target-unavailable' } }
  if (!head.branch) return { problem: 'branch-not-attached' }
  if (!head.headSha || !FULL_OID.test(head.headSha)) return { problem: 'head-unavailable' }
  if (!await refIsValid(context, workspacePath, head.branch)) return { problem: 'branch-not-attached' }

  const upstreamRemote = await configValue(context, workspacePath, `branch.${head.branch}.remote`)
  const pushRemote = await configValue(context, workspacePath, `branch.${head.branch}.pushRemote`)
  const pushDefault = await configValue(context, workspacePath, 'remote.pushDefault')
  const merge = await configValue(context, workspacePath, `branch.${head.branch}.merge`)
  if ('problem' in upstreamRemote || 'problem' in pushRemote ||
    'problem' in pushDefault || 'problem' in merge) return { problem: 'push-target-unavailable' }
  const remote = pushRemote.value || pushDefault.value || upstreamRemote.value || 'origin'
  if (!REMOTE_NAME.test(remote)) return { problem: 'push-target-unavailable' }

  let remotes: GitResult
  try { remotes = await git(context, workspacePath, ['remote']) } catch { return { problem: 'push-target-unavailable' } }
  if (commandFailed(remotes) || !remotes.stdoutText.split(/\r?\n/u).includes(remote)) return { problem: 'push-target-unavailable' }

  let remoteRefName = head.branch
  if (upstreamRemote.value === remote && merge.value?.startsWith('refs/heads/')) {
    remoteRefName = merge.value.slice('refs/heads/'.length)
  }
  if (!await refIsValid(context, workspacePath, remoteRefName)) return { problem: 'push-target-unavailable' }
  const remoteRef = `refs/heads/${remoteRefName}`

  let urls: GitResult
  try { urls = await git(context, workspacePath, ['remote', 'get-url', '--push', '--all', remote]) }
  catch { return { problem: 'push-target-unavailable' } }
  if (commandFailed(urls)) return { problem: 'push-target-unavailable' }
  const pushUrls = urls.stdoutText.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
  if (pushUrls.length !== 1) return { problem: 'push-target-unavailable' }
  const pushUrl = pushUrls[0]!
  if (!safePushUrl(pushUrl)) return { problem: 'push-target-unavailable' }
  const pushUrlFingerprint = createHash('sha256').update(pushUrl).digest('hex')
  return { value: { branch: head.branch, headSha: head.headSha.toLowerCase(), remote, remoteRef, pushUrl, pushUrlFingerprint } }
}

async function currentPushUrl(
  context: PluginContext,
  workspacePath: string,
  remote: string
): Promise<GitResultValue<{ pushUrl: string; pushUrlFingerprint: string }>> {
  if (!REMOTE_NAME.test(remote)) return { problem: 'push-target-unavailable' }
  let urls: GitResult
  try { urls = await git(context, workspacePath, ['remote', 'get-url', '--push', '--all', remote]) }
  catch { return { problem: 'push-target-unavailable' } }
  if (commandFailed(urls)) return { problem: 'push-target-unavailable' }
  const pushUrls = urls.stdoutText.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
  if (pushUrls.length !== 1 || !safePushUrl(pushUrls[0]!)) return { problem: 'push-target-unavailable' }
  const pushUrl = pushUrls[0]!
  return { value: { pushUrl, pushUrlFingerprint: createHash('sha256').update(pushUrl).digest('hex') } }
}

async function readRemoteRef(
  context: PluginContext,
  workspacePath: string,
  pushUrl: string,
  remoteRef: string
): Promise<GitResultValue<string | null>> {
  if (!safePushUrl(pushUrl) || !remoteRef.startsWith('refs/heads/')) return { problem: 'push-target-unavailable' }
  let result: GitResult
  try {
    result = await git(context, workspacePath, ['ls-remote', '--heads', '--refs', pushUrl, remoteRef], NETWORK_READ_OPTIONS)
  } catch {
    return { problem: 'push-target-unavailable' }
  }
  if (commandFailed(result)) return { problem: 'push-target-unavailable' }
  const lines = result.stdoutText.split(/\r?\n/u).filter(Boolean)
  if (lines.length === 0) return { value: null }
  if (lines.length !== 1) return { problem: 'push-target-unavailable' }
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t([^\t]+)$/iu.exec(lines[0]!)
  if (!match || match[2] !== remoteRef) return { problem: 'push-target-unavailable' }
  return { value: match[1]!.toLowerCase() }
}

function reviewState(value: unknown): { state: string; isDraft: boolean } | null {
  if (!isRecord(value) || typeof value.state !== 'string') return null
  const state = value.state.toLowerCase()
  if (state !== 'open' && state !== 'draft' && state !== 'closed' && state !== 'merged') return null
  return { state, isDraft: state === 'draft' }
}

function reviewHeadRepository(value: Record<string, unknown>, base: RepoIdentity): RepoIdentity | null {
  if (identity(value.headRepository)) return identity(value.headRepository)
  const head = value.headRepository
  if (!isRecord(head) || typeof head.name !== 'string') return null
  const owner = isRecord(head.owner) ? head.owner.login : undefined
  if (typeof owner === 'string') return identity({ host: base.host, owner, repo: head.name })
  const headOwner = isRecord(value.headRepositoryOwner) ? value.headRepositoryOwner.login : undefined
  return typeof headOwner === 'string' ? identity({ host: base.host, owner: headOwner, repo: head.name }) : null
}

function parseHostedReview(value: unknown): { expected: ExpectedReview; state: string; isDraft: boolean } | null {
  if (!isRecord(value)) return null
  const repository = identity(value.repository)
  if (!repository) return null
  const headRepository = reviewHeadRepository(value, repository)
  const state = reviewState(value)
  const expected = expectedReview({
    number: value.number,
    url: value.url,
    repository,
    headRepository,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    headSha: value.headRefOid
  })
  return expected && state ? { expected, ...state } : null
}

function reviewMatchesAuthority(review: ExpectedReview, authority: RemoteLandingAuthority, requireSha = true): boolean {
  return Boolean(authority.repository && authority.headRepository && authority.baseRefName &&
    sameRepository(review.repository, authority.repository) &&
    sameRepository(review.headRepository, authority.headRepository) &&
    review.headRefName === authority.branch && review.baseRefName === authority.baseRefName &&
    (!requireSha || review.headSha.toLowerCase() === authority.headSha.toLowerCase()))
}

function reviewMatchesExpected(left: ExpectedReview, right: ExpectedReview): boolean {
  return left.number === right.number && left.url === right.url && sameRepository(left.repository, right.repository) &&
    sameRepository(left.headRepository, right.headRepository) && left.headRefName === right.headRefName &&
    left.baseRefName === right.baseRefName && left.headSha.toLowerCase() === right.headSha.toLowerCase()
}

function repositoryList(value: unknown, worktreeId: string): { origin: RepoIdentity; base: RepoIdentity } | null {
  if (!isRecord(value) || value.worktreeId !== worktreeId) return null
  const origin = identity(value.origin)
  const candidates = Array.isArray(value.candidates) ? value.candidates.map(identity).filter((item): item is RepoIdentity => item !== null) : []
  const base = candidates[0] ?? identity(value.repository)
  return origin && base ? { origin, base } : null
}

async function hostingEligibility(
  context: PluginContext,
  worktreeId: string,
  title: string,
  base?: string
): Promise<GitResultValue<Eligibility>> {
  try {
    const value = await context.call('quirky.hosting/creationEligibility', {
      worktree: worktreeId,
      title,
      ...(base ? { base } : {})
    })
    if (!isRecord(value) || typeof value.eligible !== 'boolean' || !Array.isArray(value.blockers)) {
      return { problem: 'creation-eligibility-unavailable' }
    }
    const blockers: string[] = []
    for (const blocker of value.blockers) {
      if (!isRecord(blocker) || typeof blocker.reason !== 'string' || blocker.reason.length === 0) {
        return { problem: 'creation-eligibility-unavailable' }
      }
      blockers.push(blocker.reason)
    }
    const defaultBase = typeof value.defaultBase === 'string' && value.defaultBase.trim() ? value.defaultBase.trim() : null
    return { value: { eligible: value.eligible, defaultBase, blockers, review: value.review ?? null } }
  } catch {
    return { problem: 'creation-eligibility-unavailable' }
  }
}


function objectiveTitle(payload: ObjectivePayload): string {
  return (payload.objectiveText.split(/\r?\n/u).find(line => line.trim().length > 0)?.trim() ?? 'Objective').slice(0, 120)
}

function titleAndBody(payload: ObjectivePayload, plan?: { tasks?: { title?: string; criteria?: { body?: string }[] }[] }): { title: string; body: string } {
  const criterionLines: string[] = []
  for (const task of plan?.tasks ?? []) {
    for (const criterion of task.criteria ?? []) {
      if (typeof criterion.body === 'string' && criterion.body.length > 0) {
        criterionLines.push(`- ${criterion.body}`)
      }
    }
  }
  const full = criterionLines.length > 0
    ? `${payload.objectiveText}\n\nApproved plan criteria:\n${criterionLines.join('\n')}`
    : payload.objectiveText
  const limit = 60_000
  if (full.length <= limit) return { title: objectiveTitle(payload), body: full }
  const marker = '\n\n[Approved objective and plan criteria truncated at 60,000 characters.]'
  return { title: objectiveTitle(payload), body: `${full.slice(0, limit - marker.length)}${marker}` }
}

async function resolveAuthority(
  context: PluginContext,
  workspacePath: string,
  worktreeId: string | null | undefined,
  payload: ObjectivePayload,
): Promise<GitResultValue<AuthorityResolution>> {
  const local = await localPushTarget(context, workspacePath)
  if ('problem' in local) return local
  const target = local.value
  const bar = payload.landingBar
  if (bar !== 'hosted-review' && bar !== 'merged') {
    return { value: {
      authority: {
        branch: target.branch,
        headSha: target.headSha,
        remote: target.remote,
        remoteRef: target.remoteRef,
        pushUrlFingerprint: target.pushUrlFingerprint
      },
      pushUrl: target.pushUrl,
      problem: null,
      review: null,
      eligibility: null
    } }
  }
  if (!worktreeId) return { problem: 'landing-bar-requires-github' }

  let repositoryValue: unknown
  let pushRepositoryValue: unknown
  try {
    repositoryValue = await context.call('quirky.hosting/repository', { worktree: worktreeId })
    pushRepositoryValue = await context.call('quirky.hosting/pushRepository', { worktree: worktreeId, remote: target.remote })
  } catch {
    return { problem: 'landing-bar-requires-github' }
  }
  const repositories = repositoryList(repositoryValue, worktreeId)
  if (!repositories || !isRecord(pushRepositoryValue) || pushRepositoryValue.ready !== true) {
    return { problem: 'landing-bar-requires-github' }
  }
  const headRepository = identity(pushRepositoryValue.repository)
  const fingerprint = typeof pushRepositoryValue.pushUrlFingerprint === 'string' ? pushRepositoryValue.pushUrlFingerprint.toLowerCase() : ''
  if (!headRepository || !FULL_OID.test(fingerprint) || fingerprint !== target.pushUrlFingerprint ||
    headRepository.host.toLowerCase() !== repositories.base.host.toLowerCase() ||
    !sameRepository(headRepository, repositories.origin)) {
    return { problem: 'push-target-unavailable' }
  }
  if (target.remoteRef !== `refs/heads/${target.branch}`) return { problem: 'push-target-unavailable' }


  const title = objectiveTitle(payload)
  let firstEligibility = await hostingEligibility(context, worktreeId, title)
  if ('problem' in firstEligibility) return firstEligibility
  let selectedBase = firstEligibility.value.defaultBase
  let existing: { expected: ExpectedReview; state: string; isDraft: boolean } | null = null
  let problem: string | null = null
  if (firstEligibility.value.blockers.includes('existing_review')) {
    existing = parseHostedReview(firstEligibility.value.review)
    if (!existing) {
      problem = 'review-lookup-unavailable'
    } else if (!sameRepository(existing.expected.repository, repositories.base) ||
      !sameRepository(existing.expected.headRepository, headRepository) ||
      existing.expected.headRefName !== target.branch || existing.expected.baseRefName.length === 0) {
      problem = 'review-identity-mismatch'
    } else {
      selectedBase = existing.expected.baseRefName
      if (existing.isDraft) problem = 'review-is-draft'
      else if (existing.state !== 'open') problem = 'review-not-open'
    }
  }
  if (selectedBase && !await refIsValid(context, workspacePath, selectedBase)) {
    problem = 'creation-blocked:missing_remote_base'
    selectedBase = null
  }
  if (problem === null && !firstEligibility.value.blockers.includes('existing_review')) {
    const disallowed = firstEligibility.value.blockers.filter(reason => reason !== 'no_upstream' && reason !== 'branch_ahead')
    if (disallowed.length > 0 || (!firstEligibility.value.eligible && firstEligibility.value.blockers.length === 0)) {
      problem = `creation-blocked:${disallowed[0] ?? 'unknown'}`
    }
    if (!selectedBase) problem = 'creation-blocked:missing_remote_base'
  }

  if (selectedBase && problem === null) {
    firstEligibility = await hostingEligibility(context, worktreeId, title, selectedBase)
    if ('problem' in firstEligibility) return firstEligibility
    if (firstEligibility.value.blockers.includes('existing_review')) {
      existing = parseHostedReview(firstEligibility.value.review)
      if (!existing) {
        problem = 'review-lookup-unavailable'
      } else if (!sameRepository(existing.expected.repository, repositories.base) ||
        !sameRepository(existing.expected.headRepository, headRepository) ||
        existing.expected.headRefName !== target.branch || existing.expected.baseRefName !== selectedBase) {
        problem = 'review-identity-mismatch'
        existing = null
      } else if (existing.isDraft) {
        problem = 'review-is-draft'
      } else if (existing.state !== 'open') {
        problem = 'review-not-open'
      } else {
        problem = null
      }
    } else {
      existing = null
      const disallowed = firstEligibility.value.blockers.filter(reason => reason !== 'no_upstream' && reason !== 'branch_ahead')
      if (disallowed.length > 0 || (!firstEligibility.value.eligible && firstEligibility.value.blockers.length === 0)) {
        problem = `creation-blocked:${disallowed[0] ?? 'unknown'}`
      } else {
        problem = null
      }
    }
  }

  if (!selectedBase) {
    if (firstEligibility.value.blockers.includes('lookup_unavailable') ||
      problem === 'review-lookup-unavailable' || problem === 'review-identity-mismatch') {
      return { problem: 'review-lookup-unavailable' }
    }
    if (firstEligibility.value.blockers.some(reason =>
      reason === 'authentication_required' || reason === 'auth_required' ||
      reason === 'not_authenticated' || reason === 'unsupported_provider'
    )) return { problem: 'landing-bar-requires-github' }
    return { problem: 'base-unavailable:missing_remote_base' }
  }
  const authority: RemoteLandingAuthority = {
    branch: target.branch,
    headSha: target.headSha,
    remote: target.remote,
    remoteRef: target.remoteRef,
    pushUrlFingerprint: target.pushUrlFingerprint,
    repository: repositories.base,
    headRepository,
    ...(selectedBase ? { baseRefName: selectedBase } : {})
  }

  const current = await localPushTarget(context, workspacePath)
  if ('problem' in current || current.value.branch !== target.branch || current.value.headSha !== target.headSha ||
    current.value.remote !== target.remote || current.value.remoteRef !== target.remoteRef ||
    current.value.pushUrlFingerprint !== target.pushUrlFingerprint) {
    return { problem: 'landing-evidence-stale' }
  }
  const review = existing && existing.expected.headSha.toLowerCase() === authority.headSha.toLowerCase()
    ? existing.expected
    : null
  return { value: {
    authority,
    pushUrl: current.value.pushUrl,
    problem,
    review,
    eligibility: firstEligibility.value
  } }
}

export async function observeRemoteLanding(
  context: PluginContext,
  workspacePath: string,
  worktreeId: string | null | undefined,
  payload: ObjectivePayload,
): Promise<RemoteObservation> {
  const resolved = await resolveAuthority(context, workspacePath, worktreeId, payload)
  if ('problem' in resolved) {
    return { authority: null, remoteHeadSha: null, review: null, problem: resolved.problem }
  }
  const head = await readRemoteRef(context, workspacePath, resolved.value.pushUrl, resolved.value.authority.remoteRef)
  const problem = resolved.value.problem ?? ('problem' in head ? head.problem : null)
  return {
    authority: resolved.value.authority,
    remoteHeadSha: 'value' in head ? head.value : null,
    review: resolved.value.review,
    problem
  }
}

async function verifyActionEvidence(
  runtime: ObjectiveRuntime,
  action: RemoteAction,
  attemptId: string,
  journal: ObjectiveJournalEntry[],
  tasks?: ObjectiveProgress['tasks']
): Promise<string | null> {
  const files = await recordFilesOnDisk(runtime, action, attemptId, journal, tasks)
  if (files.effect !== 'landed') return files.reason ?? 'landing-evidence-incomplete'
  if (runtime.store.revision(runtime.enrollment.watcherId)?.number !== action.revision) return 'landing-evidence-stale'
  let identity: string
  try { identity = await runtime.captureContentIdentity() } catch { return 'landing-evidence-unavailable' }
  if (identity !== action.contentIdentity) return 'landing-evidence-stale'
  for (const landing of runtime.store.landings(runtime.enrollment.watcherId)) {
    if (landing.rung !== 'pushed-ref' && landing.rung !== 'hosted-review') continue
    const savedAuthority = authorityFromPayload(landing.payload)
    if (landing.payload.revision !== action.revision || landing.contentIdentity !== action.contentIdentity ||
      !savedAuthority || !sameRemoteAuthority(savedAuthority, action.authority)) return 'landing-target-changed'
  }

  const committed = runtime.store.landings(runtime.enrollment.watcherId).find(row =>
    row.rung === 'committed-local-branch' && row.contentIdentity === action.contentIdentity && row.payload.revision === action.revision
  )
  if (!committed || typeof committed.payload.headSha !== 'string' || !FULL_OID.test(committed.payload.headSha) ||
    committed.payload.headSha.toLowerCase() !== action.authority.headSha.toLowerCase()) return 'remote-tree-not-committed'

  let head: { branch: string | null; headSha: string | null }
  try { head = await readLocalGitHead(runtime.context, runtime.enrollment.workspacePath) }
  catch { return 'landing-evidence-unavailable' }
  if (!head.branch) return 'branch-not-attached'
  if (!head.headSha) return 'head-unavailable'
  if (head.branch !== action.authority.branch || head.headSha.toLowerCase() !== action.authority.headSha.toLowerCase()) return 'landing-evidence-stale'

  const treeMatch = /^objective-tree:([0-9a-f]{40}|[0-9a-f]{64})$/i.exec(action.contentIdentity)
  if (!treeMatch) return 'landing-evidence-unavailable'
  const commitTree = await git(runtime.context, runtime.enrollment.workspacePath, ['rev-parse', '--verify', `${action.authority.headSha}^{tree}`]).catch(() => null)
  if (!commitTree || commandFailed(commitTree)) return 'remote-tree-not-committed'
  const commitTreeOid = commitTree.stdoutText.trim().toLowerCase()
  if (!FULL_OID.test(commitTreeOid)) return 'remote-tree-not-committed'
  const differences = await git(runtime.context, runtime.enrollment.workspacePath,
    ['diff-tree', '--no-commit-id', '--no-renames', '-r', '-z', '--name-only', commitTreeOid, treeMatch[1]!]).catch(() => null)
  if (!differences || commandFailed(differences)) return 'remote-tree-not-committed'
  const uncommittedTerritory = differences.stdoutText.split('\0').filter(Boolean)
    .some(path => runtime.enrollment.kindPayload.writeTerritory.some(pattern => new Bun.Glob(pattern).match(path)))
  return uncommittedTerritory ? 'remote-tree-not-committed' : null
}

function authorityFromPayload(payload: Record<string, unknown>): RemoteLandingAuthority | null {
  const raw = isRecord(payload.authority) ? payload.authority : payload
  if (typeof raw.branch !== 'string' || typeof raw.headSha !== 'string' || !FULL_OID.test(raw.headSha) ||
    typeof raw.remote !== 'string' || !REMOTE_NAME.test(raw.remote) || typeof raw.remoteRef !== 'string' ||
    !raw.remoteRef.startsWith('refs/heads/') || typeof raw.pushUrlFingerprint !== 'string' || !/^[0-9a-f]{64}$/iu.test(raw.pushUrlFingerprint)) return null
  const repository = raw.repository === undefined ? undefined : identity(raw.repository)
  const headRepository = raw.headRepository === undefined ? undefined : identity(raw.headRepository)
  if (raw.repository !== undefined && !repository || raw.headRepository !== undefined && !headRepository) return null
  if (raw.baseRefName !== undefined && (typeof raw.baseRefName !== 'string' || !REF_PART.test(raw.baseRefName))) return null
  return {
    branch: raw.branch,
    headSha: raw.headSha.toLowerCase(),
    remote: raw.remote,
    remoteRef: raw.remoteRef,
    pushUrlFingerprint: raw.pushUrlFingerprint.toLowerCase(),
    ...(repository ? { repository } : {}),
    ...(headRepository ? { headRepository } : {}),
    ...(typeof raw.baseRefName === 'string' ? { baseRefName: raw.baseRefName } : {})
  }
}

function landingRow(
  runtime: ObjectiveRuntime,
  action: RemoteAction,
  attemptId: string,
  rung: LandingRecord['rung'],
  payload: Record<string, unknown>
): boolean {
  const existing = runtime.store.landings(runtime.enrollment.watcherId).find(row =>
    row.rung === rung && row.contentIdentity === action.contentIdentity
  )
  if (existing) {
    const savedAuthority = authorityFromPayload(existing.payload)
    return Boolean(savedAuthority && sameRemoteAuthority(savedAuthority, action.authority) &&
      existing.payload.revision === action.revision)
  }
  runtime.store.recordLanding({
    watcherId: runtime.enrollment.watcherId,
    rung,
    contentIdentity: action.contentIdentity,
    attemptId,
    payload,
    recordedAtMs: Date.now()
  })
  const saved = runtime.store.landings(runtime.enrollment.watcherId).find(row =>
    row.rung === rung && row.contentIdentity === action.contentIdentity
  )
  const savedAuthority = saved ? authorityFromPayload(saved.payload) : null
  return Boolean(saved && savedAuthority && sameRemoteAuthority(savedAuthority, action.authority) && saved.payload.revision === action.revision)
}

function pushedPayload(action: RemoteAction): Record<string, unknown> {
  return { ...action.authority, revision: action.revision, remoteHeadSha: action.authority.headSha }
}

function hostedPayload(action: RemoteAction, review: ExpectedReview): Record<string, unknown> {
  return { ...action.authority, revision: action.revision, review }
}

async function configureUpstream(runtime: ObjectiveRuntime, authority: RemoteLandingAuthority): Promise<void> {
  const branchKey = `branch.${authority.branch}`
  const commands: string[][] = [
    ['config', '--local', '--replace-all', `${branchKey}.remote`, authority.remote],
    ['config', '--local', '--replace-all', `${branchKey}.merge`, authority.remoteRef],
    ['update-ref', `refs/remotes/${authority.remote}/${authority.remoteRef.slice('refs/heads/'.length)}`, authority.headSha]
  ]
  for (const args of commands) {
    try {
      const result = await git(runtime.context, runtime.enrollment.workspacePath, args)
      if (commandFailed(result)) return
    } catch {
      return
    }
  }
}

async function finalTargetStillMatches(
  context: PluginContext,
  workspacePath: string,
  authority: RemoteLandingAuthority
): Promise<boolean> {
  const target = await localPushTarget(context, workspacePath)
  return 'value' in target && target.value.branch === authority.branch &&
    target.value.headSha.toLowerCase() === authority.headSha.toLowerCase() &&
    target.value.remote === authority.remote && target.value.remoteRef === authority.remoteRef &&
    target.value.pushUrlFingerprint === authority.pushUrlFingerprint
}

function eligibilityAllowsPush(resolution: AuthorityResolution): boolean {
  if (!resolution.eligibility) return true
  if (resolution.problem) return false
  return resolution.eligibility.eligible || resolution.eligibility.blockers.every(reason =>
    reason === 'no_upstream' || reason === 'branch_ahead' || reason === 'existing_review'
  )
}

async function recheckAfterPush(
  context: PluginContext,
  worktreeId: string,
  payload: ObjectivePayload,
  authority: RemoteLandingAuthority
): Promise<void> {
  if (!authority.repository || !authority.baseRefName) return
  await hostingEligibility(context, worktreeId, objectiveTitle(payload), authority.baseRefName)
}

async function remoteRefMatchesAuthority(
  context: PluginContext,
  workspacePath: string,
  authority: RemoteLandingAuthority
): Promise<boolean> {
  const target = await localPushTarget(context, workspacePath)
  if ('problem' in target || target.value.branch !== authority.branch ||
    target.value.headSha.toLowerCase() !== authority.headSha.toLowerCase() ||
    target.value.remote !== authority.remote || target.value.remoteRef !== authority.remoteRef ||
    target.value.pushUrlFingerprint !== authority.pushUrlFingerprint) return false
  const ref = await readRemoteRef(context, workspacePath, target.value.pushUrl, authority.remoteRef)
  return 'value' in ref && ref.value === authority.headSha.toLowerCase()
}

function isRefSpecificPushRejection(result: GitResult, headSha: string, remoteRef: string): boolean {
  if (result.exitCode === null || result.exitCode === 0 || result.signal !== null ||
    result.stopped !== undefined || result.groupSurvived === true ||
    result.truncated?.stdout === true || result.truncated?.stderr === true) return false
  const expectedRefspec = `${headSha.toLowerCase()}:${remoteRef}`
  let start = 0
  while (start < result.stdoutText.length) {
    const newline = result.stdoutText.indexOf('\n', start)
    const end = newline === -1 ? result.stdoutText.length : newline
    const line = result.stdoutText.slice(start, end)
    const statusLine = line.endsWith('\r') ? line.slice(0, -1) : line
    if (statusLine.startsWith('!\t')) {
      const refspecEnd = statusLine.indexOf('\t', 2)
      if (refspecEnd !== -1 && statusLine.slice(2, refspecEnd) === expectedRefspec) {
        const summary = statusLine.slice(refspecEnd + 1)
        return summary === '[rejected]' || summary.startsWith('[rejected] ') ||
          summary === '[remote rejected]' || summary.startsWith('[remote rejected] ')
      }
    }
    if (newline === -1) break
    start = newline + 1
  }
  return false
}

async function executePush(
  runtime: ObjectiveRuntime,
  action: Extract<RemoteAction, { kind: 'push-ref' }>,
  attemptId: string,
  journal: ObjectiveJournalEntry[],
  tasks: ObjectiveProgress['tasks'],
  worktreeId: string | null | undefined
): Promise<{ effect: 'landed' | 'not-landed' | 'indeterminate'; reason?: string }> {
  const evidenceProblem = await verifyActionEvidence(runtime, action, attemptId, journal, tasks)
  if (evidenceProblem) return { effect: 'not-landed', reason: evidenceProblem }
  const resolved = await resolveAuthority(runtime.context, runtime.enrollment.workspacePath, worktreeId, runtime.enrollment.kindPayload)
  if ('problem' in resolved) return { effect: 'not-landed', reason: resolved.problem }
  if (!sameRemoteAuthority(resolved.value.authority, action.authority)) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  if (!eligibilityAllowsPush(resolved.value)) {
    return { effect: 'not-landed', reason: resolved.value.problem ?? 'creation-blocked:unknown' }
  }

  const before = await readRemoteRef(runtime.context, runtime.enrollment.workspacePath, resolved.value.pushUrl, action.authority.remoteRef)
  if ('problem' in before) return { effect: 'not-landed', reason: before.problem }
  if (before.value !== action.expectedState.before) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  if (before.value === action.authority.headSha.toLowerCase()) {
    const recorded = landingRow(runtime, action, attemptId, 'pushed-ref', pushedPayload(action))
    if (!recorded) return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
    await configureUpstream(runtime, action.authority)
    if (action.authority.repository && worktreeId) {
      await recheckAfterPush(runtime.context, worktreeId, runtime.enrollment.kindPayload, action.authority)
    }
    return { effect: 'landed' }
  }

  if (!await finalTargetStillMatches(runtime.context, runtime.enrollment.workspacePath, action.authority)) {
    return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  }
  let push: GitResult
  try {
    push = await git(runtime.context, runtime.enrollment.workspacePath,
      ['push', '--porcelain', '--', resolved.value.pushUrl, `${action.authority.headSha}:${action.authority.remoteRef}`], NETWORK_WRITE_OPTIONS)
  } catch {
    const afterThrown = await readRemoteRef(runtime.context, runtime.enrollment.workspacePath, resolved.value.pushUrl, action.authority.remoteRef)
    if ('value' in afterThrown && afterThrown.value === action.authority.headSha.toLowerCase()) {
      const recorded = landingRow(runtime, action, attemptId, 'pushed-ref', pushedPayload(action))
      if (!recorded) return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
      await configureUpstream(runtime, action.authority)
      if (action.authority.repository && worktreeId) {
        await recheckAfterPush(runtime.context, worktreeId, runtime.enrollment.kindPayload, action.authority)
      }
      return { effect: 'landed' }
    }
    return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  }
  const after = await readRemoteRef(runtime.context, runtime.enrollment.workspacePath, resolved.value.pushUrl, action.authority.remoteRef)
  if ('value' in after && after.value === action.authority.headSha.toLowerCase()) {
    const recorded = landingRow(runtime, action, attemptId, 'pushed-ref', pushedPayload(action))
    if (!recorded) return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
    await configureUpstream(runtime, action.authority)
    if (action.authority.repository && worktreeId) {
      await recheckAfterPush(runtime.context, worktreeId, runtime.enrollment.kindPayload, action.authority)
    }
    return { effect: 'landed' }
  }
  if (push.spawnError !== undefined) return { effect: 'not-landed', reason: 'push-target-unavailable' }
  if (push.stopped !== undefined || push.signal !== null || 'problem' in after) {
    return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  }
  if (push.exitCode !== null && push.exitCode !== 0 && after.value === before.value &&
    isRefSpecificPushRejection(push, action.authority.headSha, action.authority.remoteRef)) {
    return { effect: 'not-landed', reason: 'push-rejected' }
  }
  return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
}

async function branchReview(
  context: PluginContext,
  worktreeId: string,
  authority: RemoteLandingAuthority
): Promise<ReviewRead> {
  if (!authority.repository) return { kind: 'unavailable', reason: 'landing-bar-requires-github' }
  try {
    const value = await context.call('quirky.hosting/forBranch', {
      worktree: worktreeId,
      branch: authority.branch,
      headOid: authority.headSha,
      prRepo: authority.repository,
      fresh: true
    })
    if (!isRecord(value) || typeof value.kind !== 'string') return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    if (value.kind === 'no-review') return { kind: 'no-review' }
    if (value.kind === 'unavailable') return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    if (value.kind !== 'found') return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    const parsed = parseHostedReview(value.review)
    if (!parsed) return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    return { kind: 'found', ...parsed }
  } catch {
    return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
  }
}

function matchingReviewResult(
  result: Extract<ReviewRead, { kind: 'found' }>,
  authority: RemoteLandingAuthority,
  expected?: ExpectedReview
): string | null {
  if (!reviewMatchesAuthority(result.expected, authority)) return 'review-identity-mismatch'
  if (expected && !reviewMatchesExpected(result.expected, expected)) return 'review-identity-mismatch'
  if (result.isDraft) return 'review-is-draft'
  if (result.state !== 'open') return 'review-not-open'
  return null
}

async function numberedReview(
  context: PluginContext,
  worktreeId: string,
  authority: RemoteLandingAuthority,
  number: number
): Promise<ReviewRead> {
  if (!authority.repository) return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
  try {
    const value = await context.call('quirky.hosting/review', {
      worktree: worktreeId,
      number,
      prRepo: authority.repository
    })
    if (!isRecord(value) || typeof value.kind !== 'string') return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    if (value.kind === 'no-review') return { kind: 'no-review' }
    if (value.kind === 'unavailable') return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    if (value.kind !== 'found') return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    const parsed = parseHostedReview(value.review)
    if (!parsed) return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
    return { kind: 'found', ...parsed }
  } catch {
    return { kind: 'unavailable', reason: 'review-lookup-unavailable' }
  }
}

function providerReason(error: unknown): string | null {
  if (!isRecord(error)) return null
  const data = isRecord(error.data) ? error.data : null
  const values = [data?.reason, error.reason, error.code]
  for (const value of values) {
    if (typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/iu.test(value)) return value.toLowerCase()
  }
  if (error instanceof Error) {
    const match = /(?:^|[\s:])([a-z][a-z0-9_-]{0,63})(?::|$)/iu.exec(error.message)
    if (match) return match[1]!.toLowerCase()
  }
  return null
}

const KNOWN_NO_EFFECT_CREATE_REASONS: Record<string, true> = {
  auth_required: true, not_authenticated: true, permission_denied: true, validation_error: true, rate_limited: true,
  repo_unavailable: true, repository_unavailable: true, gh_unavailable: true, unsupported_provider: true, not_found: true,
  body_too_long: true, schema_drift: true, scope_missing: true, 'stale-target': true, stale_target: true, branch_behind: true,
  dirty_tree: true, default_branch: true, missing_remote_base: true, authentication_required: true
}

async function eligibilityForOpen(
  context: PluginContext,
  worktreeId: string,
  payload: ObjectivePayload,
  authority: RemoteLandingAuthority
): Promise<GitResultValue<Eligibility>> {
  if (!authority.baseRefName) return { problem: 'creation-blocked:missing_remote_base' }
  return hostingEligibility(context, worktreeId, objectiveTitle(payload), authority.baseRefName)
}

function eligibilityProblem(eligibility: Eligibility): string | null {
  if (eligibility.blockers.length === 0) return eligibility.eligible ? null : 'creation-blocked:unknown'
  if (eligibility.blockers.length === 1 && eligibility.blockers[0] === 'existing_review') return null
  return `creation-blocked:${eligibility.blockers[0]}`
}

async function executeOpenReview(
  runtime: ObjectiveRuntime,
  action: Extract<RemoteAction, { kind: 'open-hosted-review' }>,
  attemptId: string,
  journal: ObjectiveJournalEntry[],
  tasks: ObjectiveProgress['tasks'],
  worktreeId: string | null | undefined
): Promise<{ effect: 'landed' | 'not-landed' | 'indeterminate'; reason?: string }> {
  if (!worktreeId || !action.authority.repository || !action.authority.headRepository || !action.authority.baseRefName) {
    return { effect: 'not-landed', reason: 'landing-bar-requires-github' }
  }
  const evidenceProblem = await verifyActionEvidence(runtime, action, attemptId, journal, tasks)
  if (evidenceProblem) return { effect: 'not-landed', reason: evidenceProblem }
  const resolved = await resolveAuthority(runtime.context, runtime.enrollment.workspacePath, worktreeId, runtime.enrollment.kindPayload)
  if ('problem' in resolved) return { effect: 'not-landed', reason: resolved.problem }
  if (!sameRemoteAuthority(resolved.value.authority, action.authority)) return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  if (resolved.value.problem) return { effect: 'not-landed', reason: resolved.value.problem }
  if (!await remoteRefMatchesAuthority(runtime.context, runtime.enrollment.workspacePath, action.authority)) {
    return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  }

  const initialLookup = await branchReview(runtime.context, worktreeId, action.authority)
  if (initialLookup.kind === 'unavailable') return { effect: 'not-landed', reason: initialLookup.reason }
  if (initialLookup.kind === 'no-review' && action.expectedState.before !== null) {
    return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  }
  if (initialLookup.kind === 'found') {
    if (action.expectedState.before === null || typeof action.expectedState.before === 'string' ||
      !reviewMatchesExpected(initialLookup.expected, action.expectedState.before)) {
      return { effect: 'not-landed', reason: 'landing-evidence-stale' }
    }
    const mismatch = matchingReviewResult(initialLookup, action.authority, action.review)
    if (mismatch) return { effect: 'not-landed', reason: mismatch }
    if (!await remoteRefMatchesAuthority(runtime.context, runtime.enrollment.workspacePath, action.authority)) {
      return { effect: 'not-landed', reason: 'landing-evidence-stale' }
    }
    const recorded = landingRow(runtime, action, attemptId, 'hosted-review', hostedPayload(action, initialLookup.expected))
    return recorded ? { effect: 'landed' } : { effect: 'not-landed', reason: 'landing-target-changed' }
  }

  const eligibility = await eligibilityForOpen(runtime.context, worktreeId, runtime.enrollment.kindPayload, action.authority)
  if ('problem' in eligibility) return { effect: 'not-landed', reason: eligibility.problem }
  if (eligibility.value.blockers.includes('existing_review')) {
    return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  }
  const blocked = eligibilityProblem(eligibility.value)
  if (blocked) return { effect: 'not-landed', reason: blocked }

  const repeatedEvidenceProblem = await verifyActionEvidence(runtime, action, attemptId, journal, tasks)
  if (repeatedEvidenceProblem) return { effect: 'not-landed', reason: repeatedEvidenceProblem }
  const finalTarget = await localPushTarget(runtime.context, runtime.enrollment.workspacePath)
  if ('problem' in finalTarget || finalTarget.value.branch !== action.authority.branch ||
    finalTarget.value.headSha.toLowerCase() !== action.authority.headSha.toLowerCase() ||
    finalTarget.value.remote !== action.authority.remote || finalTarget.value.remoteRef !== action.authority.remoteRef ||
    finalTarget.value.pushUrlFingerprint !== action.authority.pushUrlFingerprint) {
    return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  }
  const remoteHead = await readRemoteRef(runtime.context, runtime.enrollment.workspacePath, finalTarget.value.pushUrl, action.authority.remoteRef)
  if ('problem' in remoteHead || remoteHead.value !== action.authority.headSha.toLowerCase()) {
    return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  }
  if (!await finalTargetStillMatches(runtime.context, runtime.enrollment.workspacePath, action.authority)) {
    return { effect: 'not-landed', reason: 'landing-evidence-stale' }
  }

  const copy = titleAndBody(runtime.enrollment.kindPayload,
    runtime.store.revision(runtime.enrollment.watcherId)?.plan.plan)
  const expected = {
    branch: action.authority.branch,
    headSha: action.authority.headSha,
    baseRefName: action.authority.baseRefName,
    repository: action.authority.repository,
    headRepository: action.authority.headRepository
  }
  let created: unknown
  try {
    created = await runtime.context.call('quirky.hosting/create', {
      worktree: worktreeId,
      title: copy.title,
      body: copy.body,
      head: action.authority.branch,
      base: action.authority.baseRefName,
      expected
    })
  } catch (error) {
    const reason = providerReason(error)
    if (reason && Object.hasOwn(KNOWN_NO_EFFECT_CREATE_REASONS, reason)) {
      return { effect: 'not-landed', reason: `creation-blocked:${reason}` }
    }
    const recovered = await branchReview(runtime.context, worktreeId, action.authority)
    if (recovered.kind === 'found' && !matchingReviewResult(recovered, action.authority, action.review)) {
      if (!await remoteRefMatchesAuthority(runtime.context, runtime.enrollment.workspacePath, action.authority)) {
        return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
      }
      const recorded = landingRow(runtime, action, attemptId, 'hosted-review', hostedPayload(action, recovered.expected))
      if (recorded) return { effect: 'landed' }
    }
    return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  }

  const number = isRecord(created) && Number.isSafeInteger(created.number) && (created.number as number) > 0
    ? created.number as number
    : null
  if (number === null) {
    const recovered = await branchReview(runtime.context, worktreeId, action.authority)
    if (recovered.kind === 'found' && !matchingReviewResult(recovered, action.authority, action.review)) {
      if (!await remoteRefMatchesAuthority(runtime.context, runtime.enrollment.workspacePath, action.authority)) {
        return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
      }
      const recorded = landingRow(runtime, action, attemptId, 'hosted-review', hostedPayload(action, recovered.expected))
      if (recorded) return { effect: 'landed' }
    }
    return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  }

  const confirmed = await numberedReview(runtime.context, worktreeId, action.authority, number)
  if (confirmed.kind !== 'found' || confirmed.expected.number !== number) {
    return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  }
  const mismatch = matchingReviewResult(confirmed, action.authority, action.review)
  if (mismatch) return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  if (isRecord(created) && typeof created.url === 'string' && confirmed.expected.url !== created.url) {
    return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  }
  const freshBranch = await branchReview(runtime.context, worktreeId, action.authority)
  if (freshBranch.kind !== 'found' || matchingReviewResult(freshBranch, action.authority, action.review) ||
    !reviewMatchesExpected(freshBranch.expected, confirmed.expected)) {
    return { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
  }
  const recorded = landingRow(runtime, action, attemptId, 'hosted-review', hostedPayload(action, confirmed.expected))
  return recorded ? { effect: 'landed' } : { effect: 'indeterminate', reason: 'landing-outcome-indeterminate' }
}

function remoteActionIsValid(action: RemoteAction): boolean {
  const authority = isRecord(action.authority) ? authorityFromPayload(action.authority) : null
  const state = action.expectedState
  if (!Number.isSafeInteger(action.revision) || action.revision <= 0 ||
    !/^objective-tree:(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(action.contentIdentity) ||
    !authority || !sameRemoteAuthority(authority, action.authority) ||
    !isRecord(state) || typeof state.target !== 'string' || state.target !== remoteExpectedStateTarget(action.kind, authority)) return false
  if (action.kind === 'push-ref') {
    return state.before === null || typeof state.before === 'string' && FULL_OID.test(state.before)
  }
  if (!authority.repository || !authority.headRepository || !authority.baseRefName) return false
  if (state.before === null) return action.review === undefined
  const before = expectedReview(state.before)
  return before !== null && action.review !== undefined && reviewMatchesExpected(before, action.review)
}

export async function executeRemoteLanding(
  runtime: ObjectiveRuntime,
  action: RemoteAction,
  attemptId: string,
  journal: ObjectiveJournalEntry[],
  tasks: ObjectiveProgress['tasks'],
  worktreeId: string | null | undefined
): Promise<{ effect: 'landed' | 'not-landed' | 'indeterminate'; reason?: string }> {
  if (!remoteActionIsValid(action)) return { effect: 'not-landed', reason: 'landing-target-changed' }
  if (action.kind === 'push-ref') return executePush(runtime, action, attemptId, journal, tasks, worktreeId)
  return executeOpenReview(runtime, action, attemptId, journal, tasks, worktreeId)
}

function saveRecoveredPush(
  runtime: ObjectiveRuntime,
  action: RemoteAction,
  attemptId: string
): { effect: 'landed' } | null {
  if (action.kind !== 'push-ref') return null
  return landingRow(runtime, action, attemptId, 'pushed-ref', pushedPayload(action)) ? { effect: 'landed' } : null
}

export async function resolveRemoteLandingOutcome(
  runtime: ObjectiveRuntime,
  action: RemoteAction,
  attemptId: string,
  worktreeId: string | null | undefined
): Promise<{ effect: 'landed' } | null> {
  if (!remoteActionIsValid(action)) return null
  if (action.kind === 'push-ref') {
    const current = await currentPushUrl(runtime.context, runtime.enrollment.workspacePath, action.authority.remote)
    if ('problem' in current || current.value.pushUrlFingerprint.toLowerCase() !== action.authority.pushUrlFingerprint.toLowerCase()) return null
    const observed = await readRemoteRef(runtime.context, runtime.enrollment.workspacePath, current.value.pushUrl, action.authority.remoteRef)
    if ('problem' in observed || observed.value !== action.authority.headSha.toLowerCase()) return null
    return saveRecoveredPush(runtime, action, attemptId)
  }
  if (!worktreeId || !action.authority.repository) return null
  const observed = await branchReview(runtime.context, worktreeId, action.authority)
  if (observed.kind !== 'found' || matchingReviewResult(observed, action.authority, action.review)) return null
  return landingRow(runtime, action, attemptId, 'hosted-review', hostedPayload(action, observed.expected)) ? { effect: 'landed' } : null
}

export function expectedReviewFromLanding(row: LandingRecord | undefined): ExpectedReview | null {
  if (!row || row.rung !== 'hosted-review' || !isRecord(row.payload)) return null
  return expectedReview(row.payload.review)
}

export function authorityFromLanding(row: LandingRecord | undefined): RemoteLandingAuthority | null {
  return row && (row.rung === 'pushed-ref' || row.rung === 'hosted-review')
    ? authorityFromPayload(row.payload)
    : null
}

export function reviewMatchesExpectedPin(value: unknown, expected: ExpectedReview): boolean {
  const review = expectedReview(value)
  return Boolean(review && reviewMatchesExpected(review, expected))
}

export function handoffPayloadReview(value: unknown): ExpectedReview | null {
  if (!isRecord(value)) return null
  return expectedReview(value.expectedReview)
}

export function hostedReviewMatchesAuthority(review: ExpectedReview, authority: RemoteLandingAuthority): boolean {
  return reviewMatchesAuthority(review, authority)
}
