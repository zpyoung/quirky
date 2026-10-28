import { gitApi } from '@quirky/git'
import type { PluginCaller, Worktree } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'
import { isRecord } from './validation'

export type PushPurpose = 'review' | 'creation'
export type PushTargetRepository = { host: string; owner: string; repo: string }
type Unavailable = { ready: false; reason: string; message: string }
type LocalIdentity = { branch: string; head: string }
type LocalIdentityResult = LocalIdentity | Unavailable
type ConfiguredRemote = {
  ready: true
  remote: string
  repository: PushTargetRepository
  pushUrl: string
  pushUrlFingerprint: string
}
type CurrentReview = { ready: true; review: Record<string, unknown> } | Unavailable
export type ReadyPushTarget = {
  ready: true
  remote: string
  branch: string
  localBranch: string
  localHead: string
  headOid?: string
  number?: number
  fork: boolean
  repository: PushTargetRepository
}
export type ValidatedPushTarget = ReadyPushTarget & { pushUrl: string; pushUrlFingerprint: string }
export type PushTargetResult = ReadyPushTarget | Unavailable
type ResolvedPushTarget = ValidatedPushTarget | Unavailable

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u
function identity(value: unknown): PushTargetRepository | null {
  if (!isRecord(value) || typeof value.host !== 'string' || typeof value.owner !== 'string' || typeof value.repo !== 'string') return null
  if (!value.host || !value.owner || !value.repo) return null
  return { host: value.host, owner: value.owner, repo: value.repo }
}

function sameIdentity(left: PushTargetRepository, right: PushTargetRepository): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase() &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
}

function unavailable(reason: string, message: string): Unavailable {
  return { ready: false, reason, message }
}

function failedLookup(value: unknown): Unavailable {
  if (!isRecord(value)) return unavailable('review_unavailable', 'GitHub pull-request state could not be verified.')
  const reason = typeof value.reason === 'string' ? value.reason : 'review_unavailable'
  const message = typeof value.message === 'string' && value.message !== ''
    ? value.message
    : 'GitHub pull-request state could not be verified.'
  return unavailable(reason, message)
}

function failureFields(error: unknown): { reason?: string; message: string } {
  const record = isRecord(error) ? error : null
  const data = record && isRecord(record.data) ? record.data : null
  return {
    ...(data && typeof data.reason === 'string' ? { reason: data.reason } : {}),
    message: error instanceof Error ? error.message : 'The validated GitHub target could not be read.'
  }
}

async function localIdentity(worktree: Worktree): Promise<LocalIdentityResult> {
  const { current } = await gitApi().listBranches(worktree.path)
  if (!current) return unavailable('detached_head', 'Check out a branch before pushing to a pull request target.')
  if (worktree.branch !== current) return unavailable('stale_worktree', 'The registered worktree branch no longer matches its checked-out branch.')
  const head = await gitApi().resolveCommit(worktree.path, 'HEAD')
  if (!head || !OID.test(head)) return unavailable('head_unavailable', 'The current Git head could not be verified.')
  return { branch: current, head }
}

async function configuredTarget(worktree: Worktree, branch: string): Promise<{ remote: string; dest: string } | Unavailable> {
  const target = await gitApi().pushTarget(worktree.path, branch)
  if (!REMOTE_NAME.test(target.remote) || !target.dest || !(await gitApi().checkRefFormatBranch(target.dest))) {
    return unavailable('unsafe_target', 'The configured Git push destination is not a safe remote branch.')
  }
  if (!(await gitApi().listRemotes(worktree.path)).includes(target.remote)) {
    return unavailable('remote_unavailable', 'The configured Git push remote no longer exists.')
  }
  return target
}

async function configuredRepository(env: DaemonEnv, worktree: Worktree, remote: string): Promise<ConfiguredRemote | Unavailable> {
  try {
    const value = await env.context.call('quirky.hosting/pushRepository', { worktree: worktree.id, remote })
    if (!isRecord(value) || value.ready !== true) return failedLookup(value)
    const repository = identity(value.repository)
    const fingerprint = typeof value.pushUrlFingerprint === 'string' && /^[0-9a-f]{64}$/iu.test(value.pushUrlFingerprint)
      ? value.pushUrlFingerprint
      : undefined
    if (!repository || fingerprint === undefined) {
      return unavailable('repository_unavailable', 'The configured push repository identity is incomplete.')
    }
    const urls = await gitApi().remotePushUrls(worktree.path, remote)
    if (urls.length !== 1 || gitApi().pushUrlFingerprint(urls[0]!) !== fingerprint) {
      return unavailable('push_url_changed', 'The configured push URL changed while its provider identity was being verified.')
    }
    return { ready: true, remote, repository, pushUrl: urls[0]!, pushUrlFingerprint: fingerprint }
  } catch (error) {
    const safe = failureFields(error)
    return unavailable(safe.reason ?? 'repository_unavailable', safe.message)
  }
}

async function currentReview(env: DaemonEnv, worktree: Worktree, branch: string, head: string): Promise<CurrentReview> {
  try {
    const linked = worktree.linkedPR
    const linkedRepository = linked?.kind === 'pullRequest' ? identity(linked.repository) : null
    const linkedNumber = linked?.kind === 'pullRequest' ? linked.number : undefined
    const result = linkedRepository && typeof linkedNumber === 'number' && Number.isSafeInteger(linkedNumber) && linkedNumber > 0
      ? await env.context.call('quirky.hosting/review', {
          worktree: worktree.id,
          number: linkedNumber,
          prRepo: linkedRepository
        })
      : await env.context.call('quirky.hosting/forBranch', {
          worktree: worktree.id,
          branch,
          headOid: head,
          fresh: true
        })
    if (!isRecord(result)) return unavailable('review_unavailable', 'GitHub returned an invalid pull-request lookup.')
    if (result.kind === 'unavailable') return failedLookup(result)
    if (result.kind !== 'found' || !isRecord(result.review)) {
      return unavailable(
        linkedRepository ? 'stale_linked_review' : 'no_linked_review',
        linkedRepository
          ? 'The saved pull-request link no longer resolves to a fresh review.'
          : 'No fresh pull request is linked to this branch; refusing to publish it as a new branch.'
      )
    }
    if (linkedRepository) {
      const reviewRepository = identity(result.review.repository)
      if (result.review.number !== linkedNumber || !reviewRepository || !sameIdentity(reviewRepository, linkedRepository) ||
        (typeof linked?.url === 'string' && result.review.url !== linked.url)) {
        return unavailable('stale_linked_review', 'The fresh pull request no longer matches this worktree link.')
      }
    }
    return { ready: true, review: result.review }
  } catch (error) {
    const safe = failureFields(error)
    return unavailable(safe.reason ?? 'review_unavailable', safe.message)
  }
}
async function reviewDestination(
  env: DaemonEnv,
  worktree: Worktree,
  headRepository: PushTargetRepository,
  headRefName: string
): Promise<(ConfiguredRemote & { dest: string }) | Unavailable> {
  if (!(await gitApi().checkRefFormatBranch(headRefName))) {
    return unavailable('unsafe_target', 'The pull-request head ref is not a safe Git branch.')
  }
  const saved = worktree.pushTarget
  if (saved) {
    if (!REMOTE_NAME.test(saved.remoteName) || saved.branchName !== headRefName) {
      return unavailable('stale_worktree_target', 'The saved worktree push target no longer matches the pull-request head.')
    }
    const configured = await configuredRepository(env, worktree, saved.remoteName)
    if (configured.ready === false) return configured
    if (!sameIdentity(configured.repository, headRepository)) {
      return unavailable('repository_mismatch', 'The saved worktree push remote no longer matches the pull-request head repository.')
    }
    return { ...configured, dest: saved.branchName }
  }

  let names: string[]
  try {
    names = await gitApi().listRemotes(worktree.path)
  } catch {
    return unavailable('remote_unavailable', 'The configured Git remotes could not be read.')
  }
  const matches: ConfiguredRemote[] = []
  let unresolvedRemote = false
  for (const remote of names) {
    if (!REMOTE_NAME.test(remote)) continue
    const configured = await configuredRepository(env, worktree, remote)
    if (configured.ready === true) {
      if (sameIdentity(configured.repository, headRepository)) matches.push(configured)
    } else if (configured.reason === 'ambiguous_push_url' || configured.reason === 'push_url_changed') {
      unresolvedRemote = true
    }
  }
  if (unresolvedRemote) {
    return unavailable('ambiguous_push_url', 'A configured remote has an unverified push URL, so the pull-request destination is ambiguous.')
  }
  if (matches.length > 1) {
    return unavailable('ambiguous_target', 'More than one configured remote points to the pull-request head repository.')
  }
  const match = matches[0]
  if (!match) return unavailable('repository_mismatch', 'No configured push URL matches the pull-request head repository.')
  return { ...match, dest: headRefName }
}


async function creationBase(env: DaemonEnv, worktree: Worktree): Promise<PushTargetRepository[] | Unavailable> {
  try {
    const value = await env.context.call('quirky.hosting/repository', { worktree: worktree.id })
    if (!isRecord(value) || value.worktreeId !== worktree.id || !Array.isArray(value.candidates)) {
      return unavailable('repository_unavailable', 'The authenticated GitHub repositories for this worktree could not be verified.')
    }
    const candidates = value.candidates.map(identity).filter((item): item is PushTargetRepository => item !== null)
    return candidates.length > 0
      ? candidates
      : unavailable('repository_unavailable', 'No authenticated GitHub repository is configured for this worktree.')
  } catch (error) {
    const safe = failureFields(error)
    return unavailable(safe.reason ?? 'repository_unavailable', safe.message)
  }
}

async function readyTarget(env: DaemonEnv, worktree: Worktree, purpose: PushPurpose): Promise<ResolvedPushTarget> {
  let before: LocalIdentityResult
  try {
    before = await localIdentity(worktree)
  } catch {
    return unavailable('git_unavailable', 'The current Git branch and head could not be verified.')
  }
  if ('ready' in before) return before

  let target: ConfiguredRemote & { dest: string }
  let headOid: string | undefined
  let number: number | undefined
  let fork = false
  let repository: PushTargetRepository
  if (purpose === 'review') {
    const reviewResult = await currentReview(env, worktree, before.branch, before.head)
    if (reviewResult.ready === false) return reviewResult
    const found = reviewResult.review
    if (found.state !== 'open' && found.state !== 'draft') {
      return unavailable('closed_review', 'The linked pull request is closed or merged; refusing to publish another branch.')
    }
    if (typeof found.headRefName !== 'string' || typeof found.headRefOid !== 'string' || !OID.test(found.headRefOid)) {
      return unavailable('stale_review', 'The pull-request head ref or commit could not be verified.')
    }
    const baseRepository = identity(found.repository)
    const headRepository = identity({
      host: baseRepository?.host,
      owner: isRecord(found.headRepository) && isRecord(found.headRepository.owner)
        ? found.headRepository.owner.login
        : isRecord(found.headRepositoryOwner) ? found.headRepositoryOwner.login : undefined,
      repo: isRecord(found.headRepository) ? found.headRepository.name : undefined
    })
    if (!baseRepository || !headRepository) {
      return unavailable('head_repository_unavailable', 'The pull-request head repository was deleted or is unavailable.')
    }
    const destination = await reviewDestination(env, worktree, headRepository, found.headRefName)
    if (destination.ready === false) return destination
    target = destination
    repository = destination.repository
    headOid = found.headRefOid
    number = typeof found.number === 'number' && Number.isSafeInteger(found.number) && found.number > 0 ? found.number : undefined
    if (number === undefined) return unavailable('review_unavailable', 'The linked pull request number could not be verified.')
    fork = !sameIdentity(headRepository, baseRepository)
  } else {
    let configured: { remote: string; dest: string } | Unavailable
    try {
      configured = await configuredTarget(worktree, before.branch)
    } catch {
      return unavailable('target_unavailable', 'The configured Git push destination could not be verified.')
    }
    if ('ready' in configured) return configured
    if (configured.dest !== before.branch) {
      return unavailable('branch_mismatch', 'The configured creation push ref is not the current branch.')
    }
    const pushRepository = await configuredRepository(env, worktree, configured.remote)
    if (pushRepository.ready === false) return pushRepository
    const candidates = await creationBase(env, worktree)
    if ('ready' in candidates) return candidates
    if (!candidates.some((candidate) => sameIdentity(candidate, pushRepository.repository))) {
      return unavailable('repository_mismatch', 'The configured push repository is not an authenticated repository for this worktree.')
    }
    repository = pushRepository.repository
    target = { ...pushRepository, dest: configured.dest }
    fork = !sameIdentity(candidates[0]!, repository)
  }

  let after: LocalIdentityResult
  try {
    after = await localIdentity(worktree)
  } catch {
    return unavailable('git_unavailable', 'The current Git branch and head could not be verified after the provider lookup.')
  }
  if ('ready' in after || after.branch !== before.branch || after.head !== before.head) {
    return unavailable('stale_worktree', 'The current branch or head changed during push-target validation.')
  }

  return {
    ready: true,
    remote: target.remote,
    branch: target.dest,
    localBranch: before.branch,
    localHead: before.head,
    ...(headOid === undefined ? {} : { headOid }),
    ...(number === undefined ? {} : { number }),
    fork,
    repository,
    pushUrl: target.pushUrl,
    pushUrlFingerprint: target.pushUrlFingerprint
  }
}

function publicTarget(target: ResolvedPushTarget): PushTargetResult {
  if (!target.ready) return target
  return {
    ready: true,
    remote: target.remote,
    branch: target.branch,
    localBranch: target.localBranch,
    localHead: target.localHead,
    ...(target.headOid === undefined ? {} : { headOid: target.headOid }),
    ...(target.number === undefined ? {} : { number: target.number }),
    fork: target.fork,
    repository: target.repository
  }
}

export function pushTarget(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const purpose = params.purpose
    if (purpose !== 'review' && purpose !== 'creation') {
      throw env.context.error('invalid-params', 'purpose must be review or creation.')
    }
    const worktree = await env.resolve(params, caller)
    try {
      return publicTarget(await readyTarget(env, worktree, purpose))
    } catch {
      return unavailable('target_unavailable', 'The fresh Git push target could not be verified.')
    }
  }
}

export async function requirePushTarget(
  env: DaemonEnv,
  worktree: Worktree,
  caller: PluginCaller,
  purpose: PushPurpose
): Promise<ValidatedPushTarget> {
  let current: Worktree
  try {
    current = await env.resolve({ worktree: worktree.id }, caller)
  } catch {
    throw env.errors.reasoned('conflict', 'stale_worktree', 'The selected worktree is no longer available.')
  }
  if (current.id !== worktree.id || current.path !== worktree.path || current.instanceId !== worktree.instanceId) {
    throw env.errors.reasoned('conflict', 'stale_worktree', 'The selected worktree identity changed before the push.')
  }
  const target = await readyTarget(env, current, purpose)
  if (!target.ready) throw env.errors.reasoned('conflict', target.reason, target.message)

  let latest: Worktree
  try {
    latest = await env.resolve({ worktree: current.id }, caller)
  } catch {
    throw env.errors.reasoned('conflict', 'stale_worktree', 'The selected worktree is no longer available.')
  }
  if (latest.id !== current.id || latest.path !== current.path || latest.instanceId !== current.instanceId ||
    JSON.stringify(latest.linkedPR ?? null) !== JSON.stringify(current.linkedPR ?? null) ||
    JSON.stringify(latest.pushTarget ?? null) !== JSON.stringify(current.pushTarget ?? null)) {
    throw env.errors.reasoned('conflict', 'stale_worktree', 'The linked pull-request destination changed during validation.')
  }
  return target
}
