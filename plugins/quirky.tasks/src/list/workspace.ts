import { randomUUID } from 'node:crypto'
import type { ItemTarget, TaskMethodTable, TaskRepo, TasksEnv, WorkspaceLink } from '../contracts'
import {
  eligibleRepositories,
  errorReason,
  identityFromTarget,
  messageOf,
  object,
  resolveRepoSource,
  sourceMatchesTarget,
  targetLinkKey,
  targetUrl,
  type ResolvedRepoSource
} from './source'

const SESSION_VIEW = 'view:quirky.session/worktree'
type SetupChoice = 'run' | 'skip' | 'inherit'
type ComposerRequest = {
  requestId: string
  target: ItemTarget
  repoId: string
  repoName: string
  name: string
  title: string
  prompt: string
  setup: SetupChoice
  agent: string | null
  setupDecisionRequired?: boolean
  trustScript?: string
  trustChanged?: boolean
  error?: string
}

function invalid(env: TasksEnv, message: string): never {
  throw env.context.error('invalid-params', message)
}

function stringValue(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  return value
}

function readTarget(env: TasksEnv, value: unknown): ItemTarget {
  const target = object(value)
  if (!target || typeof target.worktree !== 'string' || target.worktree.length === 0 || (target.kind !== 'issue' && target.kind !== 'pullRequest')) {
    return invalid(env, 'target requires a worktree and kind issue or pullRequest.')
  }
  if (typeof target.number !== 'number' || !Number.isSafeInteger(target.number) || target.number < 1) invalid(env, 'target.number must be a positive safe integer.')
  const optional = (key: 'url' | 'host' | 'owner' | 'repo' | 'projectId' | 'itemId') => {
    const value = target[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') invalid(env, `target.${key} must be a string.`)
    return value
  }
  const url = optional('url')
  const host = optional('host')
  const owner = optional('owner')
  const repo = optional('repo')
  const projectId = optional('projectId')
  const itemId = optional('itemId')
  const result: ItemTarget = {
    worktree: target.worktree,
    kind: target.kind,
    number: target.number,
    ...(url !== undefined ? { url } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(itemId !== undefined ? { itemId } : {})
  }
  if (url !== undefined && !identityFromTarget(result)) invalid(env, 'target.url must identify the same HTTP(S) GitHub item.')
  return result
}

function setupChoice(env: TasksEnv, value: unknown): SetupChoice {
  if (value === undefined || value === 'inherit') return 'inherit'
  if (value === 'run' || value === 'skip') return value
  return invalid(env, 'setup must be run, skip, or inherit.')
}


async function resolveTargetRepo(env: TasksEnv, target: ItemTarget): Promise<{ repo: TaskRepo; source: ResolvedRepoSource }> {
  const repos = eligibleRepositories(await env.repositories())
  const ordered = [...repos].sort((left, right) => Number(right.worktree === target.worktree) - Number(left.worktree === target.worktree))
  for (const repo of ordered) {
    try {
      const source = await resolveRepoSource(env, repo)
      if (sourceMatchesTarget(source, target)) return { repo, source }
    } catch {
      continue
    }
  }
  return invalid(env, 'No registered local Git repository matches this GitHub item.')
}

async function canonicalTarget(env: TasksEnv, target: ItemTarget): Promise<ItemTarget> {
  if (identityFromTarget(target)) return target
  const { source } = await resolveTargetRepo(env, target)
  const identity = target.kind === 'issue'
    ? source.issueRepository
    : source.candidates.find((candidate) => candidate.host !== source.origin.host || candidate.owner !== source.origin.owner || candidate.repo !== source.origin.repo) ?? source.origin
  return { ...target, host: identity.host, owner: identity.owner, repo: identity.repo }
}

async function loadItem(env: TasksEnv, target: ItemTarget): Promise<Record<string, unknown>> {
  const item = object(await env.context.call('quirky.hosting/workItem', {
    worktree: target.worktree,
    kind: target.kind,
    number: target.number,
    ...(target.url ? { reference: target.url } : {})
  }))
  if (!item) throw new Error(`GitHub ${target.kind === 'issue' ? 'issue' : 'pull request'} #${target.number} could not be loaded.`)
  if (item.number !== target.number || item.kind !== target.kind) throw new Error('GitHub returned a different work item than the requested target.')
  if (target.url && item.url !== target.url) throw new Error('The item source changed; refresh it before starting a workspace.')
  return item
}

function promptFor(target: ItemTarget, item: Record<string, unknown>): string {
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `${target.kind === 'issue' ? 'Issue' : 'Pull request'} #${target.number}`
  const url = targetUrl(target) || (typeof item.url === 'string' ? item.url : '')
  return [`Work on GitHub ${target.kind === 'issue' ? 'issue' : 'pull request'} #${target.number}: ${title}`, url].filter(Boolean).join('\n')
}

function displayName(repo: TaskRepo): string {
  return repo.displayName?.trim() || repo.name
}

function linkValue(target: ItemTarget, source: ResolvedRepoSource, worktree: { id: string; name: string }): WorkspaceLink {
  const identity = target.kind === 'issue' ? source.issueRepository : source.origin
  const url = targetUrl(target) || `https://${identity.host}/${identity.owner}/${identity.repo}/${target.kind === 'issue' ? 'issues' : 'pull'}/${target.number}`
  return { worktree: worktree.id, name: worktree.name, url, repoId: source.repo.id }
}

function emitComposer(env: TasksEnv, request: ComposerRequest | null): void {
  env.context.emit('workspaceComposer', { request })
}

function composeRequest(
  target: ItemTarget,
  repo: TaskRepo,
  item: Record<string, unknown>,
  fields: { name?: string; prompt?: string; setup?: SetupChoice; agent?: string | null; requestId?: string; error?: string } = {}
): ComposerRequest {
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `#${target.number}`
  const defaultPrompt = promptFor(target, item)
  return {
    requestId: fields.requestId ?? randomUUID(),
    target,
    repoId: repo.id,
    repoName: displayName(repo),
    name: fields.name?.trim() || title,
    title,
    prompt: fields.prompt?.trim() || defaultPrompt,
    setup: fields.setup ?? 'inherit',
    agent: fields.agent ?? null,
    ...(fields.error ? { error: fields.error } : {})
  }
}

async function defaultAgent(env: TasksEnv): Promise<string | null> {
  const selected = object(await env.context.call('quirky.agents/pick', { forAgentTab: true }))
  return typeof selected?.agent === 'string' && selected.agent.length > 0 && selected.agent !== 'shell' ? selected.agent : null
}

async function validateAgent(env: TasksEnv, value: string | null): Promise<string | null> {
  if (value === null || value.length === 0) return null
  if (value === 'shell') invalid(env, 'The shell is not a supported task agent.')
  const result = object(await env.context.call('quirky.agents/list', {}))
  const agents = Array.isArray(result?.agents) ? result.agents.map(object).filter((entry): entry is Record<string, unknown> => entry !== null) : []
  if (!agents.some((agent) => agent.id === value && agent.installed === true && agent.enabled === true)) invalid(env, `Agent ${value} is not installed and enabled.`)
  return value
}

async function setupPolicy(env: TasksEnv, repoId: string): Promise<string | null> {
  try {
    const details = object(await env.context.call('quirky.repo/show', { repo: repoId }))
    const settings = object(details?.settings)
    const setup = object(object(details?.hooks)?.setup)
    if (!setup || typeof setup.text !== 'string' || setup.text.trim().length === 0) return null
    return typeof settings?.setupPolicy === 'string' ? settings.setupPolicy : null
  } catch {
    return null
  }
}

function currentLink(env: TasksEnv, target: ItemTarget): WorkspaceLink | null {
  return env.read().links[targetLinkKey(target)] ?? null
}

async function activateLinked(env: TasksEnv, target: ItemTarget, link: WorkspaceLink): Promise<Record<string, unknown>> {
  const worktree = object(await env.context.call('quirky.worktree/resolve', { selector: link.worktree }))
  if (!worktree || typeof worktree.id !== 'string' || typeof worktree.name !== 'string' || worktree.repoId !== link.repoId) {
    throw new Error('The workspace attached to this GitHub item is no longer registered.')
  }
  await env.context.call('ui.view.open', { id: SESSION_VIEW, input: { worktree: worktree.id } })
  return { kind: 'resumed', target, worktree }
}

async function linkWorkspace(env: TasksEnv, target: ItemTarget, selector: string): Promise<Record<string, unknown>> {
  const source = await resolveTargetRepo(env, target)
  const worktree = object(await env.context.call('quirky.worktree/resolve', { selector }))
  if (!worktree || typeof worktree.id !== 'string' || typeof worktree.name !== 'string' || worktree.repoId !== source.repo.id || worktree.kind !== 'git') {
    invalid(env, 'The workspace must belong to the matching registered Git repository.')
  }
  const link = linkValue(target, source.source, { id: worktree.id, name: worktree.name })
  env.update((state) => { state.links[targetLinkKey(target)] = link })
  return { kind: 'linked', target, ...link }
}

function unlinkWorkspace(env: TasksEnv, target: ItemTarget): Record<string, unknown> {
  const key = targetLinkKey(target)
  env.update((state) => { delete state.links[key] })
  return { kind: 'unlinked', target, linked: false }
}

function workspaceResult(result: unknown): { record: Record<string, unknown>; worktree: { id: string; name: string; repoId: string } } {
  const record = object(result)
  const worktree = object(record?.worktree)
  if (!record || !worktree || typeof worktree.id !== 'string' || typeof worktree.name !== 'string' || typeof worktree.repoId !== 'string') {
    throw new Error('The worktree API did not return a registered workspace record.')
  }
  return { record, worktree: { id: worktree.id, name: worktree.name, repoId: worktree.repoId } }
}

type WorkspaceSession = { request: ComposerRequest | null }

function setComposer(env: TasksEnv, session: WorkspaceSession, request: ComposerRequest | null): void {
  session.request = request
  emitComposer(env, request)
}


function composerResult(request: ComposerRequest, blocked = false): Record<string, unknown> {
  return { kind: 'composer', ...request, ...(blocked ? { blocked: true } : {}) }
}

function mergeComposerError(request: ComposerRequest, error: unknown): ComposerRequest {
  const outer = object(error)
  const data = object(outer?.data)
  const reason = errorReason(error)
  return {
    ...request,
    ...(reason === 'setup-decision-required' ? { setupDecisionRequired: true } : {}),
    ...(reason === 'hooks-untrusted' ? {
      trustScript: typeof data?.script === 'string' ? data.script : '',
      trustChanged: data?.changed === true
    } : {}),
    error: messageOf(error)
  }
}

function isSetupRetry(error: unknown): boolean {
  const reason = errorReason(error)
  return reason === 'setup-decision-required' || reason === 'hooks-untrusted'
}

async function createFromComposer(
  env: TasksEnv,
  session: WorkspaceSession,
  target: ItemTarget,
  params: Record<string, unknown>,
  current: ComposerRequest | null,
  trustedAgent: string | null
): Promise<Record<string, unknown>> {
  const requestId = stringValue(params.composerRequestId, 'composerRequestId')
  const fromComposer = requestId !== undefined
  if (fromComposer && (!current || current.requestId !== requestId || targetLinkKey(current.target) !== targetLinkKey(target))) {
    invalid(env, 'This workspace composer request is no longer active.')
  }
  const source = await resolveTargetRepo(env, target)
  const item = await loadItem(env, target)
  const setup = setupChoice(env, params.setup ?? current?.setup)
  const name = stringValue(params.name, 'name') ?? current?.name
  const prompt = stringValue(params.prompt, 'prompt') ?? current?.prompt ?? promptFor(target, item)
  const agentValue = params.agent === undefined ? (current?.agent ?? trustedAgent) : stringValue(params.agent, 'agent') ?? null
  const agent = await validateAgent(env, agentValue)
  if (!fromComposer && params.newWorkspace !== true) {
    const request = composeRequest(target, source.repo, item, { name, prompt, setup, agent })
    setComposer(env, session, request)
    return composerResult(request)
  }
  if (!fromComposer) {
    if (!agent) {
      const request = composeRequest(target, source.repo, item, { name, prompt, setup, agent })
      setComposer(env, session, request)
      return composerResult(request)
    }
    const policy = await setupPolicy(env, source.repo.id)
    if (policy === 'ask' && setup === 'inherit') {
      const request = composeRequest(target, source.repo, item, { name, prompt, setup, agent, error: 'Choose whether to run the repository setup before creating this workspace.' })
      request.setupDecisionRequired = true
      setComposer(env, session, request)
      return composerResult(request, true)
    }
  }
  const trustSetup = params.trustSetup === true
  if (params.trustSetup !== undefined && typeof params.trustSetup !== 'boolean') invalid(env, 'trustSetup must be a boolean.')
  if (trustSetup && (!fromComposer || !current?.trustScript || setup !== 'run')) invalid(env, 'Untrusted setup can only run after an explicit composer approval.')
  const request = current ?? composeRequest(target, source.repo, item, { name, prompt, setup, agent })
  try {
    const created = workspaceResult(await env.context.call('quirky.worktree/create', {
      repo: source.repo.id,
      github: targetUrl(target),
      ...(name ? { name } : {}),
      setup,
      ...(agent ? { agent } : {}),
      ...(prompt ? { prompt } : {}),
      ...(trustSetup ? { trustSetup: true } : {}),
      createdBy: 'window',
      activate: true
    }))
    if (created.worktree.repoId !== source.repo.id) throw new Error('The new workspace belongs to a different repository.')
    const link = linkValue(target, source.source, created.worktree)
    env.update((state) => { state.links[targetLinkKey(target)] = link })
    if (current?.requestId === request.requestId) setComposer(env, session, null)
    return { kind: 'created', target, worktree: created.record.worktree, setup: created.record.setup, warnings: created.record.warnings ?? [] }
  } catch (error) {
    if (isSetupRetry(error)) {
      const updated = mergeComposerError(request, error)
      setComposer(env, session, updated)
      return composerResult(updated, true)
    }
    if (fromComposer && current?.requestId === request.requestId) {
      const updated = { ...request, error: messageOf(error) }
      setComposer(env, session, updated)
      return composerResult(updated, true)
    }
    throw error
  }
}

async function workspace(env: TasksEnv, session: WorkspaceSession, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  let target = readTarget(env, params.target)
  if (!identityFromTarget(target)) target = await canonicalTarget(env, target)
  const action = params.action
  if (action !== 'start' && action !== 'resume' && action !== 'link' && action !== 'unlink') invalid(env, 'action must be start, resume, link, or unlink.')
  if (action === 'unlink') return unlinkWorkspace(env, target)
  if (action === 'link') {
    const selector = stringValue(params.worktree, 'worktree')
    if (!selector) invalid(env, 'worktree is required for link.')
    return linkWorkspace(env, target, selector)
  }
  if (action === 'resume') {
    const link = currentLink(env, target)
    if (!link) invalid(env, 'No workspace is linked to this GitHub item.')
    return activateLinked(env, target, link)
  }
  const newWorkspace = params.newWorkspace === undefined ? false : params.newWorkspace
  if (typeof newWorkspace !== 'boolean') invalid(env, 'newWorkspace must be a boolean.')
  if (!newWorkspace) {
    const attached = currentLink(env, target)
    if (attached) return activateLinked(env, target, attached)
  }
  let agent: string | null = null
  if (params.agent !== undefined) {
    const requested = stringValue(params.agent, 'agent')
    agent = requested ? await validateAgent(env, requested) : null
  } else if (newWorkspace && params.composerRequestId === undefined && typeof params.prompt === 'string' && params.prompt.trim().length > 0) {
    try {
      agent = await defaultAgent(env)
    } catch {
      agent = null
    }
  }
  return createFromComposer(env, session, target, params, session.request, agent)
}

function composerState(session: WorkspaceSession): ComposerRequest | null {
  return session.request
}

function composerCancel(env: TasksEnv, session: WorkspaceSession, params: Record<string, unknown>): ComposerRequest | null {
  const requestId = stringValue(params.requestId, 'requestId')
  if (!requestId) invalid(env, 'requestId is required.')
  if (session.request?.requestId === requestId) setComposer(env, session, null)
  return session.request
}

export function createWorkspaceMethods(env: TasksEnv): TaskMethodTable {
  const session: WorkspaceSession = { request: null }
  return {
    workspace: (params) => workspace(env, session, params),
    workspaceComposerState: () => composerState(session),
    workspaceComposerCancel: (params) => composerCancel(env, session, params)
  }
}
