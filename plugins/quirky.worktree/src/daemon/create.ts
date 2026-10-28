import { lstatSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { BranchCheckedOutError, gitApi } from '@quirky/git'
import {
  RpcErrorCode,
  type AgentKind,
  type EffectiveHooks,
  type ProjectGroup,
  type ProjectSettings,
  type QuirkyEvent,
  type Repo,
  type RepoDetails,
  type Worktree,
  type WorktreeCreatedBy,
  type WorktreeCreateResult,
  type GitHubWorktreeSource,
  type WorktreeAutomationProvenance,
  type WorktreeAutomationProvenanceRequest
} from '@quirky/protocol'
import { contains, expandHome, resolveRealPath, worktreeIdForPath } from '../../paths'
import type { CallerIdentity } from '../../selector'
import { BaseError, resolveBase, type ResolvedBase } from './base'
import { carryFiles } from './carry'
import { createFolderWorkspace, type FolderEnv } from './folder'
import { dataRunnerPath, gitRunnerPath, runHookInDaemon, runnerCommand, writeRunner, type HookTarget } from './hooks-run'
import { birthtimeOf, groupRepoId, listProject } from './list'
import { InvalidNameError, NoFreeNameError, branchName as joinBranch, normalizePrefix, sanitizeName, walkCandidates } from './naming'
import { pickGeneratedName } from './names'
import type { KeyedQueue } from './queue'
import { insertRow } from './store'
import {
  addPushRemote,
  configurePullBranch,
  planPullRequest,
  removePushRemote,
  resolveGitHubSource,
  restoreBranchConfig,
  restorePullRef,
  snapshotBranchConfig,
  type PullRequestPlan
} from './github'

/** What `quirky.worktree/create` accepts. */
export type CreateParams = {
  repo?: string
  group?: string
  name?: string
  branch?: string
  branchName?: string
  base?: string
  /** GitHub #number or credential-free HTTPS PR/issue URL; resolved again by the daemon. */
  github?: string
  issueCommand?: 'run' | 'skip'
  trustIssueCommand?: boolean
  /** Content identity shown by a one-time consent UI; mismatches require a new decision. */
  trustIssueCommandHash?: string
  trustSetupHash?: string
  displayName?: string
  comment?: string
  parent?: string
  noParent?: boolean
  setup?: 'run' | 'skip' | 'inherit'
  trustSetup?: boolean
  agent?: AgentKind
  prompt?: string
  /** Overrides the default submit behavior for an initial agent prompt. */
  submitPrompt?: boolean
  allowLocalBaseFallback?: boolean
  activate?: boolean
  createdBy?: WorktreeCreatedBy
  automationProvenanceRequest?: WorktreeAutomationProvenanceRequest
}

/** A setup or agent start that is waiting for a Setup terminal to exit. */
export type PendingStart = { label: string; dispose(): void }

/** What the pipeline needs from the plugin: the folder-create environment plus callers, settings and shared state. */
export type CreateEnv = FolderEnv & {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: QuirkyEvent) => void | Promise<void>): () => void
  getSetting(name: string): unknown
  dataDir: string
  worktreesRoot(): string
  worktreeDirName(repo: Repo): Promise<string>
  resolveRepo(selector: string): Promise<Repo>
  resolveGroup(selector: string): Promise<ProjectGroup>
  find(selector: string, identity: CallerIdentity): Promise<{ worktree: Worktree; all: Worktree[] }>
  queue: KeyedQueue
  /** The generated name offered to a repo's next blank create, so a placeholder and the create agree. */
  suggestions: Map<string, string>
  /** Agent starts waiting for a Setup session to exit. */
  pending: Set<PendingStart>
}

const SESSION_VIEW = 'view:quirky.session/worktree'
const MAX_WALK = 100

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code
const labelOf = (repo: Repo): string => repo.displayName ?? repo.name

const reasoned = (env: CreateEnv, kind: 'invalid-params' | 'not-found' | 'conflict', reason: string, message: string, data: Record<string, unknown> = {}) =>
  env.fail(kind, message, { reason, ...data })

const MAX_PROVENANCE_ID_LENGTH = 512
const MAX_PROVENANCE_TOKEN_LENGTH = 128

function parseAutomationProvenanceRequest(env: CreateEnv, value: unknown): WorktreeAutomationProvenanceRequest | undefined {
  if (value === undefined) return undefined
  const invalid = (): never => {
    throw env.fail('invalid-params', 'automationProvenanceRequest must contain only automationId, runId, and dispatchToken.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  let keys: PropertyKey[]
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalid()
    keys = Reflect.ownKeys(value)
  } catch {
    return invalid()
  }
  const allowed = ['automationId', 'runId', 'dispatchToken'] as const
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key as typeof allowed[number]))) return invalid()
  const values = new Map<string, unknown>()
  for (const key of allowed) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return invalid()
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalid()
    values.set(key, descriptor.value)
  }
  const automationId = values.get('automationId')
  const runId = values.get('runId')
  const dispatchToken = values.get('dispatchToken')
  if (
    typeof automationId !== 'string' || automationId.trim().length === 0 || automationId.length > MAX_PROVENANCE_ID_LENGTH ||
    typeof runId !== 'string' || runId.trim().length === 0 || runId.length > MAX_PROVENANCE_ID_LENGTH ||
    typeof dispatchToken !== 'string' || dispatchToken.trim().length === 0 ||
    dispatchToken.length < 16 || dispatchToken.length > MAX_PROVENANCE_TOKEN_LENGTH
  ) return invalid()
  return { automationId, runId, dispatchToken }
}

async function claimAutomationProvenance(
  env: CreateEnv,
  repoId: string,
  request: WorktreeAutomationProvenanceRequest
): Promise<WorktreeAutomationProvenance> {
  const value = await env.call('quirky.automations/claimWorkspaceProvenance', { ...request, repoId })
  const candidate = objectRecord(value)
  const expectedKeys = ['kind', 'automationId', 'automationName', 'runId', 'runTitle', 'projectId', 'hostId']
  if (
    !candidate || Object.keys(candidate).length !== expectedKeys.length ||
    Object.keys(candidate).some((key) => !expectedKeys.includes(key)) ||
    candidate.kind !== 'created-by-automation' ||
    candidate.automationId !== request.automationId ||
    typeof candidate.automationName !== 'string' || candidate.automationName.trim().length === 0 ||
    candidate.runId !== request.runId ||
    typeof candidate.runTitle !== 'string' || candidate.runTitle.trim().length === 0 ||
    candidate.projectId !== repoId || candidate.hostId !== 'local'
  ) {
    throw env.fail('conflict', 'The automation workspace provenance claim returned invalid trusted data.')
  }
  return {
    kind: 'created-by-automation',
    automationId: candidate.automationId,
    automationName: candidate.automationName,
    runId: candidate.runId,
    runTitle: candidate.runTitle,
    projectId: candidate.projectId,
    hostId: 'local'
  }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

type Target = { repo: Repo } | { group: ProjectGroup }

/** The project or group a create is for: named explicitly, else the caller's own worktree's. */
async function resolveTarget(env: CreateEnv, params: CreateParams, identity: CallerIdentity): Promise<Target> {
  if (params.group !== undefined) {
    if (params.repo !== undefined) throw env.fail('invalid-params', 'pass either a repo or a group, not both')
    return { group: await env.resolveGroup(params.group) }
  }
  if (params.repo !== undefined) return { repo: await env.resolveRepo(params.repo) }
  if (identity.worktreeId || identity.cwd) {
    try {
      const { worktree } = await env.find('current', identity)
      return worktree.groupId ? { group: await env.resolveGroup(worktree.groupId) } : { repo: await env.resolveRepo(`id:${worktree.repoId}`) }
    } catch (error) {
      if (codeOf(error) !== RpcErrorCode.NotFound && codeOf(error) !== RpcErrorCode.InvalidParams) throw error
    }
  }
  throw env.fail('invalid-params', 'name a project with --repo')
}

/** The worktree a new one nests under: the named one, else the caller's own in the same project; none for a window create. */
async function resolveParent(env: CreateEnv, params: CreateParams, identity: CallerIdentity, createdBy: WorktreeCreatedBy, repoId: string): Promise<string | null> {
  if (params.noParent === true) return null
  if (params.parent !== undefined) return (await env.find(params.parent, identity)).worktree.id
  if (createdBy === 'window' || (!identity.worktreeId && !identity.cwd)) return null
  try {
    const { worktree } = await env.find('current', identity)
    return worktree.repoId === repoId ? worktree.id : null
  } catch (error) {
    if (codeOf(error) === RpcErrorCode.NotFound || codeOf(error) === RpcErrorCode.InvalidParams) return null
    throw error
  }
}

function sanitize(env: CreateEnv, text: string): string {
  try {
    return sanitizeName(text)
  } catch (error) {
    if (error instanceof InvalidNameError) throw reasoned(env, 'invalid-params', 'invalid-name', error.message)
    throw error
  }
}

/** The folder new worktrees of a project are created under: its own location (relative to the repo) or the global root. */
function rootOf(env: CreateEnv, repo: Repo, settings: ProjectSettings): string {
  const location = settings.worktreeLocation?.trim()
  if (!location) return env.worktreesRoot()
  const expanded = expandHome(location)
  return resolveRealPath(isAbsolute(expanded) ? expanded : resolve(repo.path, expanded))
}

/** The branch prefix the settings ask for, or null for none; a custom prefix git rejects is refused. */
async function branchPrefix(env: CreateEnv, repo: Repo): Promise<string | null> {
  const mode = String(env.getSetting('branchPrefix'))
  const git = gitApi()
  if (mode === 'none') return null
  if (mode === 'custom') {
    const prefix = normalizePrefix(String(env.getSetting('branchPrefixCustom')))
    if (prefix === '') return null
    if (!(await git.checkRefFormatBranch(`${prefix}/x`))) {
      throw reasoned(env, 'invalid-params', 'invalid-prefix', `Branch prefix "${prefix}" contains characters git rejects — update it in Settings`, { prefix })
    }
    return prefix
  }
  const prefix = normalizePrefix((await git.gitUsername(repo.path)) ?? '')
  return prefix !== '' && (await git.checkRefFormatBranch(`${prefix}/x`)) ? prefix : null
}

type BranchSource = { branch: string; fullRef: string; remote: string | null }

/** The existing branch a create names: a local one, or a remote one that needs a local tracking branch. */
async function findBranch(env: CreateEnv, repo: Repo, input: string): Promise<BranchSource> {
  const git = gitApi()
  const name = input.trim()
  const local = (branch: string): BranchSource => ({ branch, fullRef: `refs/heads/${branch}`, remote: null })
  if (await git.localBranchExists(repo.path, name)) return local(name)
  const remotes = await git.listRemotes(repo.path)
  const slash = name.indexOf('/')
  if (slash > 0 && remotes.includes(name.slice(0, slash)) && (await git.refExists(repo.path, `refs/remotes/${name}`))) {
    const branch = name.slice(slash + 1)
    return (await git.localBranchExists(repo.path, branch)) ? local(branch) : { branch, fullRef: `refs/remotes/${name}`, remote: name.slice(0, slash) }
  }
  for (const remote of remotes) {
    if (await git.refExists(repo.path, `refs/remotes/${remote}/${name}`)) return { branch: name, fullRef: `refs/remotes/${remote}/${name}`, remote }
  }
  throw env.fail('invalid-params', `Branch "${name}" was not found.`)
}

type SetupDecision = 'run' | 'skip' | 'none'

/** Whether setup runs for this create, refusing an undecided "ask" project and an untrusted shared script. */
function decideSetup(env: CreateEnv, repo: Repo, settings: ProjectSettings, hooks: EffectiveHooks, params: CreateParams, hooksRef?: string): SetupDecision {
  const setup = hooks.setup
  if (!setup) return 'none'
  const choice = params.setup ?? 'inherit'
  let decision: 'run' | 'skip'
  if (choice !== 'inherit') decision = choice
  else if (settings.setupPolicy === 'run-by-default') decision = 'run'
  else if (settings.setupPolicy === 'skip-by-default') decision = 'skip'
  else throw reasoned(env, 'conflict', 'setup-decision-required', 'Setup decision required for this repository; pass --setup run or --setup skip', { repo: repo.id })

  const shared = setup.shared
  const explicitPinMismatch = params.trustSetup === true && params.trustSetupHash !== undefined && params.trustSetupHash !== shared?.hash
  if (decision === 'run' && shared && (explicitPinMismatch || (!shared.trusted && params.trustSetup !== true))) {
    const file = hooks.file ?? 'quirky.yaml'
    const lead = explicitPinMismatch ? `The setup script in ${file} does not match the hash supplied for this create` : shared.changed ? `The setup script in ${file} changed since you last trusted it` : `The setup script in ${file} has not been trusted`
    throw reasoned(
      env,
      'conflict',
      'hooks-untrusted',
      `${lead}:\n${shared.text}\nPass --trust-setup --trust-setup-hash ${shared.hash} to run this script once, or run: quirky repo trust-hooks ${labelOf(repo)}${hooksRef !== undefined ? ` --ref ${hooksRef}` : ''}`,
      { repo: repo.id, kind: 'setup', source: file, script: shared.text, hash: shared.hash, changed: shared.changed, ...(hooksRef !== undefined ? { ref: hooksRef } : {}) }
    )
  }
  return decision
}
type IssueCommandDecision = 'run' | 'skip' | 'none'

/** Whether a linked issue command runs, independently of the setup decision and trust hash. */
function decideIssueCommand(
  env: CreateEnv,
  repo: Repo,
  hooks: EffectiveHooks,
  params: CreateParams,
  source: GitHubWorktreeSource | null,
  hooksRef?: string
): IssueCommandDecision {
  if (source?.item.kind !== 'issue' || !hooks.issueCommand) return 'none'
  if (params.issueCommand === 'skip') return 'skip'
  const shared = hooks.issueCommand.shared
  const explicitPinMismatch = params.trustIssueCommand === true && params.trustIssueCommandHash !== undefined && params.trustIssueCommandHash !== shared?.hash
  if (shared && (explicitPinMismatch || (!shared.trusted && params.trustIssueCommand !== true))) {
    const file = hooks.file ?? 'quirky.yaml'
    const lead = explicitPinMismatch ? `The issue command in ${file} does not match the hash supplied for this create` : shared.changed ? `The issue command in ${file} changed since you last trusted it` : `The issue command in ${file} has not been trusted`
    throw reasoned(
      env,
      'conflict',
      'hooks-untrusted',
      `${lead}:\n${shared.text}\nPass --trust-issue-command --trust-issue-command-hash ${shared.hash} to run it once, or run: quirky repo trust-hooks ${labelOf(repo)} --kind issue${hooksRef !== undefined ? ` --ref ${hooksRef}` : ''}`,
      { repo: repo.id, kind: 'issue', source: file, script: shared.text, hash: shared.hash, changed: shared.changed, ...(hooksRef !== undefined ? { ref: hooksRef } : {}) }
    )
  }
  return 'run'
}


/** Everything the finishing steps need once the workspace exists. */
type Created = {
  worktree: Worktree
  rootPath: string
  hooks: EffectiveHooks | null
  decision: SetupDecision
  source: GitHubWorktreeSource | null
  issueCommandDecision: IssueCommandDecision
  warnings: string[]
  baseFallback?: ResolvedBase['fallback']
}

/** Creates a workspace: a git worktree on a branch, or a folder workspace for a folder project or a group. */
export async function createWorkspace(env: CreateEnv, params: CreateParams, identity: CallerIdentity): Promise<WorktreeCreateResult> {
  if (Object.hasOwn(params, 'automationProvenance')) {
    throw env.fail('invalid-params', 'automationProvenance is assigned only by a live automation dispatch.')
  }
  const provenanceRequest = parseAutomationProvenanceRequest(env, params.automationProvenanceRequest)
  if (params.agent === 'shell') throw env.fail('invalid-params', 'agent must be an agent ID, not shell')
  if (params.submitPrompt !== undefined && typeof params.submitPrompt !== 'boolean') {
    throw env.fail('invalid-params', 'submitPrompt must be a boolean')
  }
  const createdBy = params.createdBy ?? 'api'
  if (params.parent !== undefined && params.noParent === true) throw env.fail('invalid-params', 'parent and noParent cannot be used together')
  if (params.branch !== undefined && params.branchName !== undefined) throw env.fail('invalid-params', 'pass either a branch or a branch name, not both')
  const target = await resolveTarget(env, params, identity)
  let automationProvenance: WorktreeAutomationProvenance | undefined
  if (provenanceRequest) {
    if (!('repo' in target) || target.repo.kind !== 'git') {
      throw env.fail('invalid-params', 'automation provenance is unsupported for folder and group workspaces.')
    }
    automationProvenance = await claimAutomationProvenance(env, target.repo.id, provenanceRequest)
  }
  if (params.github !== undefined && ('group' in target || target.repo.kind !== 'git')) {
    throw reasoned(env, 'invalid-params', 'github-target', 'GitHub work-item creation requires a Git project, not a folder or group.')
  }
  const parentId = await resolveParent(env, params, identity, createdBy, 'repo' in target ? target.repo.id : groupRepoId(target.group.id))

  let created: Created
  if ('group' in target) created = await createFolder(env, target, params, createdBy, parentId)
  else if (target.repo.kind === 'folder') created = await createFolder(env, target, params, createdBy, parentId)
  else created = await env.queue.run(target.repo.id, () => createGit(env, target.repo, params, createdBy, parentId, automationProvenance))

  env.changed({ repoId: created.worktree.repoId, worktreeId: created.worktree.id })
  return finish(env, created, params)
}

async function createFolder(env: CreateEnv, target: Target, params: CreateParams, createdBy: WorktreeCreatedBy, parentId: string | null): Promise<Created> {
  let hooks: EffectiveHooks | null = null
  let decision: SetupDecision = 'none'
  if ('repo' in target) {
    const details = (await env.call('quirky.repo/show', { repo: target.repo.id })) as RepoDetails
    hooks = details.hooks
    decision = decideSetup(env, target.repo, details.settings, hooks, params)
  }
  const repoId = 'repo' in target ? target.repo.id : groupRepoId(target.group.id)
  const worktree = await createFolderWorkspace(env, target, {
    ...(params.name !== undefined ? { name: params.name } : {}),
    createdBy,
    ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
    ...(params.comment !== undefined ? { comment: params.comment } : {}),
    parentId,
    generate: (unavailable) => generateName(env, repoId, unavailable)
  })
  return { worktree, rootPath: worktree.path, hooks, decision, source: null, issueCommandDecision: 'none', warnings: [] }
}

/** The generated name for `repoId`: the one last suggested if still free, else a fresh pick. */
function generateName(env: CreateEnv, repoId: string, unavailable: ReadonlySet<string>): string {
  const suggested = env.suggestions.get(repoId)
  env.suggestions.delete(repoId)
  return suggested !== undefined && !unavailable.has(suggested) ? suggested : pickGeneratedName(unavailable)
}

/** Names a blank create of `repo` would not reuse: those of its workspaces and the retired ones. */
async function unavailableNames(env: CreateEnv, repo: Repo): Promise<Set<string>> {
  const used = await listProject(env, repo)
  const retired = env.store.all<{ name: string }>('SELECT name FROM retired_names WHERE repo_id = ?', repo.id)
  return new Set([...used.flatMap((worktree) => [worktree.name, basename(worktree.path)]), ...retired.map((row) => row.name)])
}

/**
 * The generated name the next blank create in `repo` will use, without retiring it. It is
 * remembered until a create takes it or it stops being free.
 */
export async function suggestName(env: CreateEnv, params: { repo: string }): Promise<{ name: string }> {
  const repo = await env.resolveRepo(params.repo)
  const unavailable = await unavailableNames(env, repo)
  const known = env.suggestions.get(repo.id)
  if (known !== undefined && !unavailable.has(known)) return { name: known }
  const name = pickGeneratedName(unavailable)
  env.suggestions.set(repo.id, name)
  return { name }
}

/** Steps 3 to 10 of the pipeline for a git project; the caller holds the project's create queue slot. */
async function createGit(
  env: CreateEnv,
  repo: Repo,
  params: CreateParams,
  createdBy: WorktreeCreatedBy,
  parentId: string | null,
  automationProvenance?: WorktreeAutomationProvenance
): Promise<Created> {
  const git = gitApi()
  const details = (await env.call('quirky.repo/show', { repo: repo.id })) as RepoDetails
  const settings = details.settings

  if (!(await git.hasCommits(repo.path))) throw reasoned(env, 'conflict', 'no-commits', `${labelOf(repo)} has no commits yet`, { repo: repo.id })

  let source: GitHubWorktreeSource | null = null
  let pullPlan: PullRequestPlan | null = null
  let existing: BranchSource | null = null
  let base: ResolvedBase | null = null
  const resolveRequestedBase = async () => {
    try {
      return await resolveBase(repo.path, { requested: params.base, saved: settings.defaultBase, allowLocalFallback: params.allowLocalBaseFallback, log: env.log })
    } catch (error) {
      if (!(error instanceof BaseError)) throw error
      if (error.reason === 'not-found') throw env.fail('invalid-params', error.message)
      throw reasoned(env, 'conflict', error.reason, error.message, error.data)
    }
  }

  if (params.github !== undefined) {
    source = await resolveGitHubSource(env, repo, params.github)
    if (source.item.kind === 'pullRequest') {
      if (params.branch !== undefined || params.branchName !== undefined || params.base !== undefined) {
        throw reasoned(env, 'invalid-params', 'github-pr-overrides', 'A GitHub pull request source does not accept base, branch, or branchName overrides.')
      }
      pullPlan = await planPullRequest(env, repo, source)
      existing = pullPlan.existing
      base = pullPlan.base
    } else {
      if (params.branch !== undefined) {
        throw reasoned(env, 'invalid-params', 'github-issue-branch', 'A GitHub issue creates a new branch and does not accept an existing branch.')
      }
      base = await resolveRequestedBase()
    }
  } else {
    existing = params.branch !== undefined ? await findBranch(env, repo, params.branch) : null
    if (existing === null) base = await resolveRequestedBase()
  }

  const startRef = pullPlan?.startRef ?? existing?.fullRef ?? base!.fullRef
  const hooksRef = pullPlan?.hooksRef ?? await git.resolveCommit(repo.path, startRef)
  if (hooksRef === null) throw env.fail('invalid-params', `Base ref "${existing?.branch ?? base!.shortRef}" was not found.`)
  let hooks: EffectiveHooks
  let decision: SetupDecision
  let issueCommandDecision: IssueCommandDecision
  try {
    hooks = (await env.call('quirky.repo/hooks', { repo: repo.id, ref: hooksRef })) as EffectiveHooks
    decision = decideSetup(env, repo, settings, hooks, params, hooksRef)
    issueCommandDecision = decideIssueCommand(env, repo, hooks, params, source, hooksRef)
  } catch (error) {
    if (pullPlan) await restorePullRef(repo.path, pullPlan).catch((cleanupError) => env.log(`could not restore GitHub pull ref after a refused create: ${messageOf(cleanupError)}`))
    throw error
  }

  const typed = params.name?.trim() ?? ''
  let generated: string | null = null
  let unavailable: ReadonlySet<string> = new Set()
  let placed: string | null = null
  let folder = ''
  let branch = ''
  let mode: 'new' | 'existing' | 'tracking' = 'new'
  let worktreeAdded = false
  let branchCreated = false
  let durable = false
  let pushRemoteAdded = false
  let branchConfig: Map<string, string[]> | null = null
  const retire = () => {
    if (generated === null) return
    for (const name of new Set([generated, placed ?? generated])) env.store.run('INSERT OR IGNORE INTO retired_names (repo_id, name) VALUES (?, ?)', repo.id, name)
  }
  const rollback = async () => {
    if (!pullPlan || durable) return
    if (worktreeAdded && folder !== '') await git.removeWorktree(repo.path, folder, true).catch((error) => env.log(`could not remove incomplete GitHub worktree ${folder}: ${messageOf(error)}`))
    if (branchCreated) await git.deleteRefIfAt(repo.path, branch, hooksRef).catch((error) => env.log(`could not remove incomplete GitHub branch ${branch}: ${messageOf(error)}`))
    if (branchConfig !== null) await restoreBranchConfig(repo.path, branchConfig).catch((error) => env.log(`could not restore GitHub branch config for ${branch}: ${messageOf(error)}`))
    if (pushRemoteAdded) await removePushRemote(repo.path, pullPlan).catch((error) => env.log(`could not remove incomplete GitHub remote ${pullPlan!.pushTarget.remoteName}: ${messageOf(error)}`))
    await restorePullRef(repo.path, pullPlan).catch((error) => env.log(`could not restore GitHub tracking ref ${pullPlan!.trackingRef}: ${messageOf(error)}`))
  }

  try {
    const root = rootOf(env, repo, settings)
    const parentDir = env.getSetting('nestWorkspaces') === false ? root : join(root, await env.worktreeDirName(repo))
    let name: string
    if (typed !== '') name = sanitize(env, typed)
    else if (source !== null) name = sanitize(env, source.item.title.toLowerCase())
    else if (existing !== null) name = sanitize(env, existing.branch)
    else {
      unavailable = await unavailableNames(env, repo)
      generated = generateName(env, repo.id, unavailable)
      name = generated
    }
    const folderOf = (candidate: string) => join(parentDir, candidate)
    const checkedOut = async (candidate: string) => (await git.listRegistrations(repo.path)).find((registration) => registration.branch === candidate)

    let folderName: string
    let lastTaken = 'path'
    const fixed = pullPlan?.branch ?? existing?.branch ?? params.branchName?.trim()
    if (fixed !== undefined) {
      branch = fixed
      mode = existing === null ? 'new' : existing.remote === null ? 'existing' : 'tracking'
      if (existing === null) {
        if (!(await git.checkRefFormatBranch(branch))) throw reasoned(env, 'invalid-params', 'invalid-name', 'Invalid worktree name')
        if (await git.localBranchExists(repo.path, branch)) {
          const atBase = (await git.branchHead(repo.path, branch)) === hooksRef
          const holder = await checkedOut(branch)
          if (pullPlan && atBase && holder) throw branchCheckedOut(env, branch, holder.path)
          if (!atBase || holder) throw reasoned(env, 'conflict', 'branch-exists', `Branch ${branch} already exists`, { branch })
          mode = 'existing'
          if (pullPlan) existing = { branch, fullRef: `refs/heads/${branch}`, remote: null }
        }
      }
      try {
        folderName = await walkCandidates(name, async (candidate) => exists(folderOf(candidate)), MAX_WALK)
      } catch (error) {
        if (error instanceof NoFreeNameError) throw env.fail('conflict', 'Could not find an available worktree path')
        throw error
      }
    } else {
      mode = 'new'
      const prefix = await branchPrefix(env, repo)
      try {
        folderName = await walkCandidates(
          name,
          async (candidate) => {
            if (generated !== null && unavailable.has(candidate)) {
              lastTaken = 'path'
              return true
            }
            const candidateBranch = joinBranch(prefix, candidate)
            if (await git.localBranchExists(repo.path, candidateBranch)) {
              lastTaken = 'locally'
              return true
            }
            if (await git.remoteBranchExists(repo.path, candidateBranch)) {
              lastTaken = 'on a remote'
              return true
            }
            lastTaken = 'path'
            return exists(folderOf(candidate))
          },
          MAX_WALK
        )
      } catch (error) {
        if (!(error instanceof NoFreeNameError)) throw error
        throw lastTaken === 'path'
          ? env.fail('conflict', 'Could not find an available worktree path')
          : reasoned(env, 'conflict', 'branch-exists', `Branch "${joinBranch(prefix, `${name}-${MAX_WALK}`)}" already exists ${lastTaken}.`, { branch: joinBranch(prefix, `${name}-${MAX_WALK}`) })
      }
      branch = joinBranch(prefix, folderName)
    }
    placed = folderName
    folder = folderOf(folderName)
    if (!contains(resolveRealPath(root), resolveRealPath(folder))) throw reasoned(env, 'invalid-params', 'invalid-name', 'Invalid worktree name')

    if (mode !== 'new') {
      const holder = await checkedOut(branch)
      if (holder) throw branchCheckedOut(env, branch, holder.path)
    }

    if (pullPlan) {
      branchConfig = await snapshotBranchConfig(repo.path, branch)
      pushRemoteAdded = await addPushRemote(repo.path, pullPlan)
    }
    await addWorktree(env, repo, { mode, branch, folder, start: hooksRef, existing })
    worktreeAdded = true
    branchCreated = pullPlan !== null && mode === 'new'

    if (pullPlan) await configurePullBranch(repo.path, pullPlan)
    else await configureBranch(env, repo, branch, mode === 'tracking' || existing !== null ? null : base!)

    const id = worktreeIdForPath(folder)
    const displayName = params.displayName !== undefined ? params.displayName.trim() || null : source?.item.title ?? null
    const comment = params.comment ?? (source === null ? '' : `${source.item.kind === 'pullRequest' ? 'PR' : 'Issue'} #${source.item.number} — ${source.item.title}`)
    env.store.transaction(() => {
      env.store.run('DELETE FROM worktrees WHERE id = ?', id)
      insertRow(env.store, {
        id,
        repoId: repo.id,
        kind: 'git',
        path: resolveRealPath(folder),
        createdAt: Date.now(),
        createdBy,
        birthtime: birthtimeOf(folder),
        baseRef: pullPlan ? pullPlan.baseRef : existing === null ? base!.shortRef : null,
        keepBranch: existing !== null,
        createdRoot: root,
        displayName,
        comment,
        parentId,
        linkedPR: source?.item.kind === 'pullRequest' ? source.item : null,
        linkedIssue: source?.item.kind === 'issue' ? source.item : null,
        pushTarget: pullPlan?.pushTarget ?? null,
        automationProvenance
      })
      retire()
    })
    durable = true

    const warnings = await carryFiles(repo.path, folder, hooks.sharedDirectories)
    for (const warning of warnings) env.log(`carried files for ${folder}: ${warning}`)
    const worktree = (await listProject(env, repo)).find((listed) => listed.id === id)
    if (!worktree) throw new Error(`the new worktree ${folder} is not listed`)
    return {
      worktree,
      rootPath: repo.path,
      hooks,
      decision,
      source,
      issueCommandDecision,
      warnings,
      ...(base?.fallback ? { baseFallback: base.fallback } : {})
    }
  } catch (error) {
    retire()
    await rollback()
    throw error
  }
}

const branchCheckedOut = (env: CreateEnv, branch: string, path: string | null) =>
  reasoned(env, 'conflict', 'branch-checked-out', `branch '${branch}' is already checked out${path ? ` at ${path}` : ' in another worktree'}`, { branch, path })

/** Step 7: `git worktree add`, with a local tracking branch made first for a remote-only branch. */
async function addWorktree(
  env: CreateEnv,
  repo: Repo,
  plan: { mode: 'new' | 'existing' | 'tracking'; branch: string; folder: string; start: string; existing: BranchSource | null }
): Promise<void> {
  const git = gitApi()
  try {
    if (plan.mode === 'new') {
      await git.addNewBranchWorktree(repo.path, plan.folder, plan.branch, plan.start)
      return
    }
    if (plan.mode === 'tracking') {
      await git.createTrackingBranch(repo.path, plan.branch, plan.existing!.fullRef, plan.start)
      try {
        await git.addExistingBranchWorktree(repo.path, plan.folder, plan.branch)
      } catch (error) {
        await git.deleteRefIfAt(repo.path, plan.branch, plan.start)
        throw error
      }
      return
    }
    await git.addExistingBranchWorktree(repo.path, plan.folder, plan.branch)
  } catch (error) {
    if (error instanceof BranchCheckedOutError) throw branchCheckedOut(env, plan.branch, error.worktreePath)
    const stderr = (error as { stderr?: unknown } | null)?.stderr
    throw new Error(typeof stderr === 'string' && stderr.trim() ? stderr.trim() : messageOf(error))
  }
}

/** Step 8, best effort: record the base, let a first push set its upstream, and track a same-named remote base. */
async function configureBranch(env: CreateEnv, repo: Repo, branch: string, base: ResolvedBase | null): Promise<void> {
  const git = gitApi()
  const attempt = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      env.log(`could not set ${what} for ${branch}: ${messageOf(error)}`)
    }
  }
  if (base !== null) await attempt('branch base', () => git.setLocalConfig(repo.path, `branch.${branch}.base`, base.fullRef))
  await attempt('push.autoSetupRemote', async () => {
    if ((await git.getConfig(repo.path, 'push.autoSetupRemote')) === null) await git.setLocalConfig(repo.path, 'push.autoSetupRemote', 'true')
  })
  const remoteBase = base?.fullRef.startsWith('refs/remotes/') ? base.fullRef.slice('refs/remotes/'.length) : null
  const slash = remoteBase?.indexOf('/') ?? -1
  if (remoteBase !== null && slash > 0 && remoteBase.slice(slash + 1) === branch) {
    await attempt('upstream', async () => {
      await git.setLocalConfig(repo.path, `branch.${branch}.remote`, remoteBase.slice(0, slash))
      await git.setLocalConfig(repo.path, `branch.${branch}.merge`, `refs/heads/${branch}`)
    })
  }
}

type SessionLike = { id: string; status?: string }

/**
 * Waits for one session to exit or be removed, then runs `then` once. Events are watched from the
 * moment this is called, so an exit that lands before the session is known is not missed.
 */
function watchSessionExit(env: CreateEnv, label: string, then: () => void) {
  const gone = new Set<string>()
  let target: string | null = null
  let done = false
  const pending: PendingStart = { label, dispose: () => stop() }
  const unsubscribe = env.subscribe((event) => {
    const data = (event as { data?: unknown }).data as { session?: SessionLike; sessionId?: string } | undefined
    if (event.type === 'quirky.session/changed' && data?.session?.status === 'exited') note(data.session.id)
    else if (event.type === 'quirky.session/removed' && data?.sessionId) note(data.sessionId)
  })
  env.pending.add(pending)

  function stop() {
    done = true
    unsubscribe()
    env.pending.delete(pending)
  }
  function fire() {
    if (done) return
    stop()
    then()
  }
  function note(id: string) {
    gone.add(id)
    if (id === target) fire()
  }
  return {
    dispose: stop,
    arm(session: SessionLike) {
      target = session.id
      if (session.status === 'exited' || gone.has(session.id)) return fire()
      env.call('quirky.session/get', { session: session.id }).then(
        (current) => {
          if ((current as SessionLike).status === 'exited') fire()
        },
        (error) => {
          if (codeOf(error) === RpcErrorCode.NotFound) fire()
        }
      )
    }
  }
}

/** The issue URL is the native provider's draft prompt unless a caller supplied other text or an explicit choice. */
export function agentPromptParameters(
  params: Pick<CreateParams, 'prompt' | 'submitPrompt'>,
  source: GitHubWorktreeSource | null
): { prompt?: string; submitPrompt?: boolean } {
  const issueDerived = params.prompt === undefined && source?.item.kind === 'issue'
  const prompt = params.prompt ?? (issueDerived ? source.item.url : undefined)
  if (prompt === undefined) return {}
  return {
    prompt,
    ...(params.submitPrompt !== undefined
      ? { submitPrompt: params.submitPrompt }
      : issueDerived ? { submitPrompt: false } : {})
  }
}

/** Starts the agent session through the public session API; native provider readiness stays session-owned. */
async function startAgent(env: CreateEnv, worktreeId: string, params: CreateParams, source: GitHubWorktreeSource | null): Promise<string> {
  const session = (await env.call('quirky.session/create', {
    worktree: worktreeId,
    agent: params.agent!,
    ...agentPromptParameters(params, source)
  })) as SessionLike
  return session.id
}

type ObjectRecord = Record<string, unknown>

function objectRecord(value: unknown): ObjectRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectRecord : null
}



async function runIssueCommand(
  env: CreateEnv,
  created: Created,
  source: GitHubWorktreeSource,
  script: string,
  warnings: string[],
  setupSession: string | undefined
): Promise<NonNullable<WorktreeCreateResult['issueCommand']>> {
  const { worktree } = created
  const target: HookTarget = { rootPath: created.rootPath, worktreePath: worktree.path }
  const expanded = script
    .replaceAll('{{issue}}', String(source.item.number))
    .replaceAll('{{artifact_url}}', source.item.url)
  let runner: string
  try {
    runner = await gitRunnerPath(worktree.path, 'issue')
    await writeRunner(runner, target, expanded)
  } catch (error) {
    warnings.push(`could not prepare the issue command for ${worktree.path}: ${messageOf(error)}`)
    return { ran: 'none' }
  }
  if (setupSession !== undefined) {
    try {
      const split = objectRecord(await env.call('quirky.terminal/splitPane', {
        session: setupSession,
        direction: 'right',
        title: `Issue #${source.item.number}`,
        command: runnerCommand(runner),
        activate: false
      }))
      const sessionId = split?.session
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('terminal splitPane returned no session id')
      return { ran: 'terminal', sessionId }
    } catch (error) {
      if (codeOf(error) === RpcErrorCode.MethodNotFound) {
        // Older or unavailable terminal plugins retain the independent-session fallback below.
      } else {
        warnings.push(`could not split Issue #${source.item.number} beside Setup for ${worktree.path}: ${messageOf(error)}`)
        return { ran: 'none' }
      }
    }
  }
  try {
    const session = (await env.call('quirky.session/create', {
      worktree: worktree.id,
      agent: 'shell',
      title: `Issue #${source.item.number}`,
      command: runnerCommand(runner)
    })) as SessionLike
    return { ran: 'terminal', sessionId: session.id }
  } catch (error) {
    if (codeOf(error) !== RpcErrorCode.MethodNotFound) {
      warnings.push(`could not start the Issue #${source.item.number} terminal for ${worktree.path}: ${messageOf(error)}`)
      return { ran: 'none' }
    }
  }

  try {
    const outcome = await runHookInDaemon(runner, target)
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      warnings.push(`issue command for #${source.item.number} in ${worktree.path} ${outcome.timedOut ? 'timed out' : `exited with ${outcome.exitCode}`}`)
    }
    return { ran: 'daemon', exitCode: outcome.exitCode, timedOut: outcome.timedOut }
  } catch (error) {
    warnings.push(`could not run the issue command for ${worktree.path}: ${messageOf(error)}`)
    return { ran: 'none' }
  }
}

/** Steps 12 to 14: setup, the agent, and opening the view. */
async function finish(env: CreateEnv, created: Created, params: CreateParams): Promise<WorktreeCreateResult> {
  const { worktree, hooks, warnings } = created
  const result: WorktreeCreateResult = {
    worktree,
    warnings,
    setup: { ran: 'none' },
    ...(created.baseFallback ? { baseFallback: created.baseFallback } : {})
  }
  const script = hooks?.setup?.text
  const runs = created.decision === 'run' && script !== undefined

  if (created.decision === 'skip') {
    result.setup = { ran: 'skipped' }
    if (params.setup !== 'skip') warnings.push(`setup hook skipped for ${worktree.path}; pass --setup run to run it.`)
  }

  const waitsForSetup = runs && params.agent !== undefined && hooks?.agentStartup === 'wait-for-setup'
  const gate = waitsForSetup
    ? watchSessionExit(env, `${params.agent} in ${worktree.path}`, () => {
        startAgent(env, worktree.id, params, created.source).catch((error) => env.log(`could not start ${params.agent} in ${worktree.path} after setup: ${messageOf(error)}`))
      })
    : null

  if (runs) result.setup = await runSetup(env, created, script, warnings, gate ? (session) => gate.arm(session) : undefined)

  if (created.source?.item.kind === 'issue') {
    if (created.issueCommandDecision === 'skip') {
      result.issueCommand = { ran: 'skipped' }
    } else if (created.issueCommandDecision === 'run' && hooks?.issueCommand) {
      const setupSession = result.setup.ran === 'terminal' ? result.setup.sessionId : undefined
      result.issueCommand = await runIssueCommand(env, created, created.source, hooks.issueCommand.text, warnings, setupSession)
    } else {
      result.issueCommand = { ran: 'none' }
    }
  }

  if (params.agent !== undefined) {
    if (gate && result.setup.ran === 'terminal') result.agentPending = true
    else {
      gate?.dispose()
      try {
        result.agentSessionId = await startAgent(env, worktree.id, params, created.source)
      } catch (error) {
        warnings.push(`could not start ${params.agent}: ${messageOf(error)}`)
      }
    }
  }

  if (params.activate === true) {
    try {
      await env.call('ui.view.open', { id: SESSION_VIEW, input: { worktree: worktree.id } })
    } catch (error) {
      warnings.push(`could not open ${worktree.name}: ${messageOf(error)}`)
    }
  }
  return result
}

/** Step 12: setup in a "Setup" terminal, or in the daemon when sessions are off. */
async function runSetup(env: CreateEnv, created: Created, script: string, warnings: string[], onSession?: (session: SessionLike) => void): Promise<WorktreeCreateResult['setup']> {
  const { worktree } = created
  const target: HookTarget = { rootPath: created.rootPath, worktreePath: worktree.path }
  let runner: string
  try {
    runner = worktree.kind === 'git' ? await gitRunnerPath(worktree.path, 'setup') : dataRunnerPath(env.dataDir, worktree.id, 'setup')
    await writeRunner(runner, target, script)
  } catch (error) {
    warnings.push(`could not prepare setup for ${worktree.path}: ${messageOf(error)}`)
    return { ran: 'none' }
  }
  try {
    const session = (await env.call('quirky.session/create', { worktree: worktree.id, agent: 'shell', title: 'Setup', command: runnerCommand(runner) })) as SessionLike
    onSession?.(session)
    return { ran: 'terminal', sessionId: session.id }
  } catch (error) {
    if (codeOf(error) !== RpcErrorCode.MethodNotFound) {
      warnings.push(`could not start the Setup terminal for ${worktree.path}: ${messageOf(error)}`)
      return { ran: 'none' }
    }
  }
  const outcome = await runHookInDaemon(runner, target)
  if (outcome.exitCode !== 0 || outcome.timedOut) env.log(`setup for ${worktree.path} ${outcome.timedOut ? 'timed out' : `exited with ${outcome.exitCode}`}:\n${outcome.output.slice(-2000)}`)
  return { ran: 'daemon', exitCode: outcome.exitCode, timedOut: outcome.timedOut }
}
