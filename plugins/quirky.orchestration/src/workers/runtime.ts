import type { PluginContext, Session } from '@quirky/protocol'
import { randomUUID } from 'node:crypto'
import type { JsonValue, TaskRow } from '../contracts'
import type { SessionIdentity } from '../runtime-contracts'
import type {
  CoordinatorEvidence, TerminalResource, TurnStart, WorkerEffect, WorkerMode,
  WorkerModeDecision, WorkerObservation, WorkerPlacement, WorkerRuntime,
  WorkerSetup, WorkerStartParams, WorkerRecord,
} from '../worker-contracts'

const DEFAULT_READY_TIMEOUT_MS = 60_000
const OBSERVATION_TIMEOUT_MS = 30_000
const WAIT_SLICE_MS = 1_000
const EXIT_IDENTITY_CONFIRM_TIMEOUT_MS = 5_000

type PublicWorktree = { id: string; repoId: string; path: string; kind: 'git' | 'folder'; head?: string }
type PublicRepo = { id: string; name: string; path: string; kind: 'git' | 'folder' }
type PublicAgent = { id: string; label: string; installed: boolean; enabled: boolean }
type PublicAgentList = { defaultAgent: string; agents: PublicAgent[] }
type LaunchOption = { id: string; choices: readonly { value: string | boolean; label?: string }[] | null }
type ModelOptions = {
  id: string
  options: readonly LaunchOption[]
}
type AgentOptions = {
  supported: boolean
  models: readonly ModelOptions[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: readonly LaunchOption[]
  structured: boolean
}
type SetupResult = { ran: 'terminal' | 'daemon' | 'none' | 'skipped'; sessionId?: string; exitCode?: number | null; timedOut?: boolean }
type RepoHooks = { setup?: { text?: string; source?: string } | null; agentStartup?: 'start-immediately' | 'wait-for-setup' | null }
type SessionStatusWait = { status: 'matched' | 'pending'; state: 'working' | 'blocked' | 'idle' | 'unknown' | 'exited'; kind?: string }
type PointerResult = { operationId: string; result: { status: string; reason?: string; attemptedPhase?: string; retryEnter?: false } }
type StructuredMessage = { sessionId: string; seq: number; role: string; text: string; at: number; data?: unknown }
type SetupState = WorkerSetup['state']
type CodedError = Error & { code?: string; data?: unknown }

interface StartPlan {
  decision: WorkerModeDecision
  worktreeId: string | null
  coordinatorWorktreeId: string | null
  selectedWorktree: PublicWorktree | null
  selectedSession: Session | null
  repo: PublicRepo | null
  agent: PublicAgent
  agentOptions: AgentOptions
}
interface RuntimeStartPreflight {
  worktreeId: string | null
  coordinatorWorktreeId: string | null
  repoId: string | null
  mode: WorkerMode
  identity: SessionIdentity | null
}

function failure(code: string, message: string, data?: unknown): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  if (data !== undefined) error.data = data
  return error
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function codeOf(cause: unknown): string | null {
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : null
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function call<T>(context: PluginContext, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return context.call(method, params) as Promise<T>
}

function asWorktree(value: unknown): PublicWorktree {
  const result = asRecord(value)
  const nested = asRecord(result.worktree)
  const worktree = Object.keys(nested).length > 0 ? nested : result
  if (typeof worktree.id !== 'string' || typeof worktree.repoId !== 'string' || typeof worktree.path !== 'string' || (worktree.kind !== 'git' && worktree.kind !== 'folder')) {
    throw failure('invalid_runtime_response', 'quirky.worktree returned an invalid workspace record.')
  }
  return worktree as unknown as PublicWorktree
}

function asRepo(value: unknown): PublicRepo {
  const result = asRecord(value)
  const nested = asRecord(result.repo)
  const repo = Object.keys(nested).length > 0 ? nested : result
  if (typeof repo.id !== 'string' || typeof repo.name !== 'string' || typeof repo.path !== 'string' || (repo.kind !== 'git' && repo.kind !== 'folder')) {
    throw failure('invalid_runtime_response', 'quirky.repo returned an invalid repository record.')
  }
  return repo as unknown as PublicRepo
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function setupState(result: SetupResult | null, hookFound: boolean): SetupState {
  if (!result || result.ran === 'none') return hookFound ? 'spawn_failed' : 'not_configured'
  if (result.ran === 'skipped') return 'skipped'
  if (result.ran === 'terminal') return 'running'
  if (result.timedOut || result.exitCode !== 0) return 'failed'
  return 'succeeded'
}

function setupInfo(
  requested: string,
  source: string,
  hookFound: boolean,
  startupPolicy: string,
  result: SetupResult | null,
): WorkerSetup {
  return {
    requested,
    effective: result?.ran ?? (requested === 'skip' ? 'skipped' : 'not_configured'),
    source,
    hookFound,
    startupPolicy,
    state: setupState(result, hookFound),
  }
}

function effect(kind: WorkerEffect['kind'], action: string, role: WorkerEffect['role'], id: string): WorkerEffect {
  return { kind, action, role, id }
}

function attachPlacementData(cause: unknown, effects: readonly WorkerEffect[], residualResources: readonly JsonValue[]): CodedError {
  const prior = asRecord(cause)
  const priorData = asRecord(prior.data)
  const wrapped = cause instanceof Error ? cause as CodedError : failure(codeOf(cause) ?? 'runtime_error', messageOf(cause))
  wrapped.data = { ...priorData, effects, residualResources }
  return wrapped
}

function isAgentEnabled(agent: PublicAgent | undefined): agent is PublicAgent {
  return agent !== undefined && agent.enabled && agent.installed && agent.id !== 'shell'
}

function resolveModelOptions(agentOptions: AgentOptions, model: string | undefined): readonly LaunchOption[] | null {
  if (!model) return null
  return agentOptions.models.find(candidate => candidate.id === model)?.options ?? (agentOptions.unlisted === 'accept' ? agentOptions.unlistedOptions : null)
}

function validateModelPicks(params: WorkerStartParams, options: AgentOptions): void {
  if (params.model === undefined && params.effort === undefined) return
  if (params.model === undefined) throw failure('invalid_argument', 'effort requires model.')
  if (!options.supported) throw failure('invalid_argument', `Agent ${params.agent ?? 'selected'} does not accept model or effort picks.`)
  const listed = options.models.find(candidate => candidate.id === params.model)
  if (!listed && options.unlisted !== 'accept') throw failure('invalid_argument', `Model ${params.model} is not in the agent launch catalog.`)
  if (params.effort !== undefined) {
    const picks = resolveModelOptions(options, params.model)
    const effort = picks?.find(candidate => candidate.id === 'effort')
    if (!effort || !effort.choices?.some(choice => choice.value === params.effort)) {
      throw failure('invalid_argument', `Effort ${params.effort} is not supported for model ${params.model}.`)
    }
  }
}

async function listSessions(context: PluginContext): Promise<Session[]> {
  const sessions = await call<unknown>(context, 'quirky.session/list')
  if (!Array.isArray(sessions)) throw failure('invalid_runtime_response', 'quirky.session/list returned an invalid session list.')
  return sessions as Session[]
}

async function getSession(context: PluginContext, sessionId: string): Promise<Session> {
  const session = (await listSessions(context)).find(candidate => candidate.id === sessionId)
  if (!session || session.status === 'exited') throw failure('terminal_not_found', `Session ${sessionId} is not a live session.`)
  return session
}

async function getIdentity(context: PluginContext, sessionId: string): Promise<SessionIdentity> {
  const identity = await call<SessionIdentity>(context, 'quirky.session/identity', { session: sessionId })
  if (!identity || identity.sessionId !== sessionId || typeof identity.runtimeEpoch !== 'string' || identity.runtimeEpoch.length === 0
    || typeof identity.processIncarnation !== 'string' || identity.processIncarnation.length === 0
    || typeof identity.worktreeId !== 'string' || identity.worktreeId.length === 0
    || (identity.kind !== 'terminal' && identity.kind !== 'structured') || typeof identity.live !== 'boolean') {
    throw failure('invalid_runtime_response', `quirky.session/identity returned invalid evidence for ${sessionId}.`)
  }
  return identity
}

async function showWorktree(context: PluginContext, selector: string): Promise<PublicWorktree> {
  try {
    return asWorktree(await call(context, 'quirky.worktree/show', { worktree: selector }))
  } catch (cause) {
    if (codeOf(cause) === 'not-found' || codeOf(cause) === 'not_found') throw failure('invalid_argument', `Workspace ${selector} was not found.`)
    throw cause
  }
}

async function listRepos(context: PluginContext): Promise<PublicRepo[]> {
  const rows = await call<unknown>(context, 'quirky.repo/list')
  if (!Array.isArray(rows)) throw failure('invalid_runtime_response', 'quirky.repo/list returned an invalid repository list.')
  return rows.map(asRepo)
}

function repoMatch(repo: PublicRepo, selector: string): boolean {
  if (selector.startsWith('id:')) return repo.id === selector.slice(3)
  if (selector.startsWith('name:')) return repo.name === selector.slice(5)
  if (selector.startsWith('path:')) return repo.path === selector.slice(5)
  return repo.id === selector || repo.name === selector
}

async function resolveRepo(context: PluginContext, selector: string): Promise<PublicRepo> {
  const matches = (await listRepos(context)).filter(repo => repoMatch(repo, selector))
  if (matches.length === 0) throw failure('invalid_argument', `Repository ${selector} was not found.`)
  if (matches.length > 1) throw failure('invalid_argument', `Repository ${selector} is ambiguous; use an exact repository ID or path.`)
  return matches[0]!
}

async function repoHooks(context: PluginContext, repoId: string, ref?: string): Promise<RepoHooks> {
  const params: Record<string, unknown> = { repo: repoId }
  if (ref) params.ref = ref
  return call<RepoHooks>(context, 'quirky.repo/hooks', params)
}

function isServiceCoordinator(caller: CoordinatorEvidence): caller is Extract<CoordinatorEvidence, { kind: 'service' }> {
  return 'kind' in caller && caller.kind === 'service'
}

async function resolveServicePlan(
  context: PluginContext,
  params: WorkerStartParams,
  caller: Extract<CoordinatorEvidence, { kind: 'service' }>,
): Promise<StartPlan> {
  if (!params.runId || params.runId !== caller.runId) {
    throw failure('consumer_fenced', 'A service worker start must name the Run owned by that service.')
  }
  const selector = params.worktree
  if (selector === 'current' || selector === 'new-child' || selector === 'active') {
    throw failure('invalid_argument', 'A service worker start requires an explicit workspace; current, active, and new-child require a coordinator session.')
  }
  const creating = selector === 'new-top-level'
  const placementFlags = params.repo !== undefined || params.name !== undefined || params.baseBranch !== undefined
    || params.displayName !== undefined || params.comment !== undefined || params.setup !== undefined
  if (placementFlags && !creating) throw failure('invalid_argument', 'Worktree creation options require --worktree new-top-level.')
  if (params.terminal && creating) throw failure('invalid_argument', 'An existing terminal cannot be combined with new worktree placement.')
  if (params.terminal && (params.mode === 'structured' || params.model !== undefined || params.effort !== undefined)) {
    throw failure('invalid_argument', 'A reused terminal cannot be combined with structured mode or model picks.')
  }

  let selectedWorktree: PublicWorktree | null = null
  let repo: PublicRepo | null = null
  let worktreeId: string | null = null
  if (creating) {
    if (!params.repo) throw failure('invalid_argument', 'A service worker new-top-level placement requires an explicit repository.')
    repo = await resolveRepo(context, params.repo)
    if (repo.kind !== 'git') throw failure('invalid_argument', 'Folder projects cannot create orchestration worktrees; use an exact existing folder workspace.')
  } else {
    selectedWorktree = await showWorktree(context, selector)
    worktreeId = selectedWorktree.id
  }
  if (params.baseBranch !== undefined && repo) await repoHooks(context, repo.id, params.baseBranch)

  let selectedSession: Session | null = null
  if (params.terminal) {
    const sessions = await listSessions(context)
    selectedSession = sessions.find(session => session.id === params.terminal) ?? null
    if (!selectedSession || selectedSession.status === 'exited') {
      throw failure('terminal_not_found', `Session ${params.terminal} is not a live session.`)
    }
    if (selectedSession.kind !== 'terminal' || selectedSession.agent === 'shell') {
      throw failure('inject_rejected', 'The selected session is not a recognized running agent terminal.')
    }
    if (selectedSession.worktreeId !== worktreeId || selectedWorktree?.id !== worktreeId) {
      throw failure('terminal_worktree_mismatch', 'The selected terminal is not in the explicit workspace.')
    }
  }

  const agentId = selectedSession?.agent ?? params.agent
  if (!agentId || agentId === 'shell') throw failure('agent_unconfigured', 'worker-start requires an enabled, launchable agent.')
  const [agentCatalog, agentOptions] = await Promise.all([
    call<PublicAgentList>(context, 'quirky.agents/list'),
    call<AgentOptions>(context, 'quirky.agents/options', { agent: agentId }),
  ])
  if (!Array.isArray(agentCatalog.agents)) throw failure('invalid_runtime_response', 'quirky.agents/list returned an invalid agent catalog.')
  const agent = agentCatalog.agents.find(candidate => candidate.id === agentId)
  if (!isAgentEnabled(agent)) throw failure('agent_unconfigured', `Agent ${agentId} is not enabled and launchable.`)
  validateModelPicks(params, agentOptions)
  const preferred: WorkerMode = params.mode ?? 'terminal'
  const mode: WorkerMode = selectedSession ? 'terminal' : preferred
  if (mode === 'structured' && !agentOptions.structured) {
    throw failure('agent_unconfigured', `Agent ${agentId} does not support a structured background session.`)
  }
  const decision: WorkerModeDecision = {
    mode,
    preferred,
    reason: params.mode ? 'explicit' : selectedSession ? 'reused_terminal' : 'terminal_default',
    detail: params.mode === 'structured'
      ? 'Structured mode was explicitly requested; the worker is a background session without a PTY.'
      : selectedSession
        ? 'The selected existing agent terminal is reused.'
        : 'A service coordinator has no session-mode preference; terminal is the default unless structured is explicit.',
  }
  return { decision, worktreeId, coordinatorWorktreeId: null, selectedWorktree, selectedSession, repo, agent, agentOptions }
}
async function resolvePlan(context: PluginContext, params: WorkerStartParams, caller: CoordinatorEvidence): Promise<StartPlan> {
  if (isServiceCoordinator(caller)) return resolveServicePlan(context, params, caller)
  const sessions = await listSessions(context)
  const coordinator = sessions.find(session => session.id === caller.runtimeSessionId)
    ?? sessions.find(session => session.id === caller.callerSessionId)
  if (!coordinator || coordinator.status === 'exited' || !coordinator.worktreeId) {
    throw failure('consumer_fenced', 'The coordinator session is not a live workspace session.')
  }
  const coordinatorWorktree = await showWorktree(context, coordinator.worktreeId)
  const selector = params.worktree || 'current'
  if (selector === 'active') throw failure('invalid_argument', 'Use current or an exact workspace selector, not active.')
  const newChild = selector === 'new-child'
  const newTopLevel = selector === 'new-top-level'
  const creatingWorktree = newChild || newTopLevel
  const placementFlags = params.repo !== undefined || params.name !== undefined || params.baseBranch !== undefined
    || params.displayName !== undefined || params.comment !== undefined || params.setup !== undefined

  if (placementFlags && !creatingWorktree) {
    throw failure('invalid_argument', 'Worktree creation options require --worktree new-child or new-top-level.')
  }
  if (params.terminal && creatingWorktree) {
    throw failure('invalid_argument', 'An existing terminal cannot be combined with new worktree placement.')
  }
  if (params.terminal && params.mode === 'structured') {
    throw failure('invalid_argument', 'A reused terminal cannot be started in structured mode.')
  }
  if (params.terminal && (params.model !== undefined || params.effort !== undefined)) {
    throw failure('invalid_argument', 'Model and effort picks cannot be used with an existing terminal.')
  }

  let selectedWorktree: PublicWorktree | null = null
  let repo: PublicRepo | null = null
  let worktreeId: string | null = null
  if (selector === 'current') {
    selectedWorktree = coordinatorWorktree
    worktreeId = selectedWorktree.id
  } else if (creatingWorktree) {
    if (newChild) {
      if (coordinatorWorktree.kind === 'folder') {
        throw failure('invalid_argument', 'Folder projects cannot create orchestration worktrees; use current or an exact existing folder workspace.')
      }
      repo = await resolveRepo(context, coordinatorWorktree.repoId)
      if (repo.kind !== 'git') throw failure('invalid_argument', 'Folder projects cannot create orchestration worktrees; use current or an exact existing folder workspace.')
      if (params.repo !== undefined && repoMatch(repo, params.repo) === false) {
        throw failure('invalid_argument', 'new-child must remain in the coordinator workspace repository.')
      }
    } else {
      repo = await resolveRepo(context, params.repo ?? coordinatorWorktree.repoId)
      if (repo.kind !== 'git') {
        throw failure('invalid_argument', 'Folder projects cannot create orchestration worktrees; use current or an exact existing folder workspace.')
      }
    }
  } else {
    selectedWorktree = await showWorktree(context, selector)
    worktreeId = selectedWorktree.id
  }
  if (creatingWorktree && params.baseBranch !== undefined && repo) await repoHooks(context, repo.id, params.baseBranch)

  let selectedSession: Session | null = null
  if (params.terminal) {
    if (params.terminal === caller.runtimeSessionId || params.terminal === caller.callerSessionId) {
      throw failure('terminal_is_coordinator', 'The coordinator session cannot be reused as a worker.')
    }
    selectedSession = sessions.find(session => session.id === params.terminal) ?? null
    if (!selectedSession || selectedSession.status === 'exited') {
      throw failure('terminal_not_found', `Session ${params.terminal} is not a live session.`)
    }
    if (selectedSession.kind !== 'terminal' || selectedSession.agent === 'shell') {
      throw failure('inject_rejected', 'The selected session is not a recognized running agent terminal.')
    }
    if (worktreeId !== null && selectedSession.worktreeId !== worktreeId) {
      throw failure('terminal_worktree_mismatch', 'The selected terminal is not in the requested workspace.')
    }
    if (selectedWorktree && selectedSession.worktreeId !== selectedWorktree.id) {
      throw failure('terminal_worktree_mismatch', 'The selected terminal is not in the resolved workspace.')
    }
  }

  const agentId = selectedSession?.agent ?? params.agent
  if (!agentId || agentId === 'shell') throw failure('agent_unconfigured', 'worker-start requires an enabled, launchable agent.')
  const [agentCatalog, agentOptions] = await Promise.all([
    call<PublicAgentList>(context, 'quirky.agents/list'),
    call<AgentOptions>(context, 'quirky.agents/options', { agent: agentId }),
  ])
  if (!Array.isArray(agentCatalog.agents)) throw failure('invalid_runtime_response', 'quirky.agents/list returned an invalid agent catalog.')
  const agent = agentCatalog.agents.find(candidate => candidate.id === agentId)
  if (!isAgentEnabled(agent)) throw failure('agent_unconfigured', `Agent ${agentId} is not enabled and launchable.`)
  validateModelPicks(params, agentOptions)

  const preferred: WorkerMode = params.mode ?? 'terminal'
  const mode: WorkerMode = selectedSession ? 'terminal' : preferred
  if (mode === 'structured' && !agentOptions.structured) {
    throw failure('agent_unconfigured', `Agent ${agentId} does not support a structured background session.`)
  }
  const decision: WorkerModeDecision = {
    mode,
    preferred,
    reason: params.mode ? 'explicit' : selectedSession ? 'reused_terminal' : 'terminal_default',
    detail: params.mode === 'structured'
      ? 'Structured mode was explicitly requested; the worker is a background session without a PTY.'
      : selectedSession
        ? 'The selected existing agent terminal is reused.'
        : 'The public Quirky session API exposes terminal launch by default; no structured-session default is configured.',
  }
  return { decision, worktreeId, coordinatorWorktreeId: coordinatorWorktree.id, selectedWorktree, selectedSession, repo, agent, agentOptions }
}

function validatePlacementIdentity(placement: WorkerPlacement, expectedWorktreeId: string | null, caller: CoordinatorEvidence): void {
  const { session, identity } = placement
  if (!identity.live || !nonEmptyString(identity.processIncarnation)) {
    throw failure('worker_identity_changed', 'The selected worker session has no exact live process identity.')
  }
  if (identity.sessionId !== session.id || identity.kind !== session.kind || identity.worktreeId !== placement.worktreeId || session.worktreeId !== placement.worktreeId) {
    throw failure('worker_identity_changed', 'The worker session, workspace, and attested identity do not match.')
  }
  if (expectedWorktreeId !== null && placement.worktreeId !== expectedWorktreeId) {
    throw failure('terminal_worktree_mismatch', 'The placed worker is not in the workspace validated before Task acceptance.')
  }
  if (!isServiceCoordinator(caller) && (identity.sessionId === caller.runtimeSessionId || identity.sessionId === caller.callerSessionId)) {
    throw failure('terminal_is_coordinator', 'The coordinator session cannot be attached as a worker.')
  }
  if (session.status === 'exited' || session.agent === 'shell') {
    throw failure('inject_rejected', 'A worker must be a live recognized agent, not a plain shell.')
  }
}

function sessionTitle(task: TaskRow): string {
  const title = task.displayName.trim() || task.taskTitle.trim() || task.id
  return `Worker: ${title}`
}


async function waitForReadyAgent(
  context: PluginContext,
  sessionId: string,
  deadline: number,
  reused: boolean,
  ensureActive: () => void,
): Promise<void> {
  while (Date.now() < deadline) {
    ensureActive()
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const result = await call<SessionStatusWait>(context, 'quirky.agent-status/wait', {
      session: sessionId,
      until: ['idle', 'blocked', 'exited'],
      timeoutMs: Math.min(WAIT_SLICE_MS, remaining),
    })
    if (result.state === 'blocked') {
      throw failure('agent_startup_blocked', `Agent startup blocked: ${result.kind ?? 'human input is required'}.`, { reason: result.kind ?? 'blocked' })
    }
    if (result.state === 'exited') throw failure('terminal_not_found', `Agent session ${sessionId} exited before it became ready.`)
    if (result.state === 'idle' && result.status === 'matched') return
  }
  const detail = reused ? 'The reused agent terminal did not reach a fresh idle prompt.' : 'The launched agent did not reach its composer-ready idle state.'
  throw failure('worker_readiness_timeout', `${detail} Session ${sessionId} remains unready.`)
}

async function waitForStructuredReady(
  context: PluginContext,
  sessionId: string,
  expectedIdentity: SessionIdentity,
  deadline: number,
  ensureActive: () => void,
): Promise<void> {
  while (Date.now() < deadline) {
    ensureActive()
    const session = (await listSessions(context)).find(candidate => candidate.id === sessionId)
    if (!session) throw failure('terminal_not_found', `Structured worker session ${sessionId} is absent before startup completed.`)
    if (session.kind !== 'structured') throw failure('worker_identity_changed', `Session ${sessionId} is no longer structured.`)
    if (session.status === 'exited') {
      const messages = await call<StructuredMessage[]>(context, 'quirky.structured/messages', { session: sessionId })
      if (!Array.isArray(messages)) throw failure('invalid_runtime_response', 'quirky.structured/messages returned an invalid journal page.')
      let startupFailure: string | null = null
      for (const message of messages) {
        if (message.sessionId === sessionId && message.role === 'system' && message.text.startsWith('could not start: ')) {
          startupFailure = message.text.slice('could not start: '.length)
        }
      }
      if (startupFailure) throw failure('agent_not_ready', `Structured worker ${sessionId} could not start: ${startupFailure}`)
      throw failure('terminal_not_found', `Structured worker session ${sessionId} exited before it became ready.`)
    }
    const identity = await getIdentity(context, sessionId)
    if (!identity.live || identity.sessionId !== expectedIdentity.sessionId
      || identity.processIncarnation !== expectedIdentity.processIncarnation
      || identity.runtimeEpoch !== expectedIdentity.runtimeEpoch
      || identity.worktreeId !== expectedIdentity.worktreeId
      || identity.kind !== 'structured' || identity.providerId !== expectedIdentity.providerId) {
      throw failure('worker_identity_changed', `Structured worker session ${sessionId} changed identity before startup completed.`)
    }
    if (session.status === 'running') return
    if (session.status !== 'starting') {
      throw failure('agent_not_ready', `Structured worker session ${sessionId} entered ${session.status} before its initial turn was submitted.`)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, Math.min(WAIT_SLICE_MS, remaining))
    await delay.promise
  }
  throw failure('worker_readiness_timeout', `Structured worker session ${sessionId} did not finish provider startup before the worker start deadline.`)
}

async function waitForSetupExit(context: PluginContext, sessionId: string, deadline: number, ensureActive: () => void): Promise<number | null> {
  while (Date.now() < deadline) {
    ensureActive()
    const sessions = await listSessions(context)
    const session = sessions.find(candidate => candidate.id === sessionId)
    if (!session) throw failure('operation_unknown', `Setup terminal ${sessionId} is absent from session inventory.`)
    if (session.status === 'exited') return session.exitCode
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, Math.min(WAIT_SLICE_MS, remaining))
    await delay.promise
  }
  throw failure('setup_timeout', `Setup terminal ${sessionId} did not finish within the worker start timeout.`)
}


function sessionOptions(params: WorkerStartParams): Record<string, string | boolean> | undefined {
  if (params.effort === undefined) return undefined
  return { effort: params.effort }
}

function buildSetupEffects(setup: SetupResult | null): WorkerEffect[] {
  if (!setup?.sessionId) return []
  return [effect('setup', setup.ran === 'terminal' ? 'started' : 'completed', 'setup', setup.sessionId)]
}

function residualForWorktree(worktreeId: string, setup: SetupResult | null): JsonValue[] {
  const residual: JsonValue[] = [{ kind: 'worktree', id: worktreeId, state: 'created' }]
  if (setup?.sessionId) residual.push({ kind: 'setup', id: setup.sessionId, state: setup.ran === 'terminal' ? 'running' : 'created' })
  return residual
}
function residualForTerminal(
  worktreeId: string,
  state: 'created' | 'identity_unverifiable' | 'outcome_unknown',
  sessionId?: string,
  tabId?: string,
): JsonValue[] {
  const residual = residualForWorktree(worktreeId, null)
  residual.push({
    kind: 'terminal',
    state,
    worktreeId,
    ...(sessionId === undefined ? {} : { id: sessionId }),
    ...(tabId === undefined ? {} : { tabId }),
  })
  return residual
}


export function createWorkerRuntime(context: PluginContext): WorkerRuntime {
  const epoch = randomUUID()
  let disposed = false
  const preflightPlans = new WeakMap<WorkerStartParams, RuntimeStartPreflight>()

  const ensureActive = (): void => {
    if (disposed) throw failure('runtime_inactive', 'Worker runtime has been deactivated.')
  }

  return {
    context,
    epoch,

    async validate(params, caller) {
      ensureActive()
      const plan = await resolvePlan(context, params, caller)
      const identity = params.terminal ? await getIdentity(context, params.terminal) : null
      if (identity && (!identity.live || identity.kind !== 'terminal')) {
        throw failure('worker_identity_changed', `Session ${params.terminal} has no matching live terminal identity.`)
      }
      if (identity && identity.worktreeId !== plan.worktreeId) {
        throw failure('terminal_worktree_mismatch', 'The selected terminal identity is not in the resolved workspace.')
      }
      preflightPlans.set(params, {
        worktreeId: plan.worktreeId,
        coordinatorWorktreeId: plan.coordinatorWorktreeId,
        repoId: plan.repo?.id ?? null,
        mode: plan.decision.mode,
        identity,
      })
      return { worktreeId: plan.worktreeId, decision: plan.decision }
    },

    async place(params, task, _dispatch, caller, onCustody) {
      ensureActive()
      const placementDeadline = Date.now() + (params.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
      const preflight = preflightPlans.get(params)
      preflightPlans.delete(params)
      const plan = await resolvePlan(context, params, caller)
      if (preflight && (
        preflight.worktreeId !== plan.worktreeId
        || preflight.coordinatorWorktreeId !== plan.coordinatorWorktreeId
        || preflight.repoId !== (plan.repo?.id ?? null)
        || preflight.mode !== plan.decision.mode
      )) {
        throw failure(params.terminal ? 'terminal_worktree_mismatch' : 'invalid_argument', 'Worker placement changed after admission prevalidation.')
      }
      const expectedIdentity = preflight?.identity ?? null
      const effects: WorkerEffect[] = []
      let setup: WorkerSetup = {
        requested: params.setup ?? 'not_applicable', effective: 'not_applicable', source: 'existing_workspace',
        hookFound: false, startupPolicy: 'not_applicable', state: 'not_applicable',
      }
      let worktreeId = plan.worktreeId
      let session: Session
      let created = false
      let createdTerminalSessionId: string | null = null
      let terminalTabId: string | null = null

      try {
        if (plan.selectedSession) {
          session = await getSession(context, plan.selectedSession.id)
          if (session.kind !== 'terminal' || session.agent === 'shell') throw failure('inject_rejected', 'The selected terminal no longer runs a recognized agent.')
          worktreeId = session.worktreeId
        } else {
          if (worktreeId === null) {
            if (!plan.repo) throw failure('invalid_argument', 'New workspace placement has no validated repository.')
            if (params.worktree === 'new-child' && !plan.coordinatorWorktreeId) {
              throw failure('invalid_argument', 'new-child requires an attested coordinator workspace.')
            }
            const createParams: Record<string, unknown> = {
              repo: plan.repo.id,
              activate: false,
              setup: params.setup ?? 'run',
              ...(params.name !== undefined ? { name: params.name } : {}),
              ...(params.baseBranch !== undefined ? { base: params.baseBranch } : {}),
              ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
              ...(params.comment !== undefined ? { comment: params.comment } : {}),
              ...(params.worktree === 'new-child' ? { parent: plan.coordinatorWorktreeId } : { noParent: true }),
            }
            let createdWorktree: unknown
            try {
              createdWorktree = await call(context, 'quirky.worktree/create', createParams)
            } catch (cause) {
              throw attachPlacementData(cause, effects, [{ kind: 'worktree', state: 'outcome_unknown', repoId: plan.repo.id }])
            }
            const worktreeResult = asRecord(createdWorktree)
            const createdWorkspace = asWorktree(worktreeResult.worktree ?? createdWorktree)
            worktreeId = createdWorkspace.id
            effects.push(effect('worktree', 'created', 'agent', createdWorkspace.id))
            const setupResult = (worktreeResult.setup ?? null) as SetupResult | null
            let hooks: RepoHooks
            try {
              hooks = await repoHooks(context, plan.repo.id, createdWorkspace.head)
            } catch (cause) {
              throw attachPlacementData(cause, effects, residualForWorktree(createdWorkspace.id, setupResult))
            }
            const hookFound = typeof hooks.setup?.text === 'string' && hooks.setup.text.length > 0
            const startupPolicy = hooks.agentStartup ?? 'start-immediately'
            setup = setupInfo(params.setup ?? 'run', hooks.setup?.source ?? 'repo_policy', hookFound, startupPolicy, setupResult)
            effects.push(...buildSetupEffects(setupResult))

            if (startupPolicy === 'wait-for-setup') {
              if (setupResult?.ran === 'terminal' && setupResult.sessionId) {
                const exitCode = await waitForSetupExit(context, setupResult.sessionId, placementDeadline, ensureActive)
                setup = { ...setup, state: exitCode === 0 ? 'succeeded' : 'failed' }
                if (exitCode !== 0) {
                  throw attachPlacementData(failure('setup_failed', `Setup terminal ${setupResult.sessionId} exited with ${String(exitCode)}.`), effects, residualForWorktree(createdWorkspace.id, setupResult))
                }
              } else if (setupResult?.ran === 'daemon' && (setupResult.timedOut || setupResult.exitCode !== 0)) {
                throw attachPlacementData(failure('setup_failed', 'Repository setup failed; the wait-for-setup policy blocks this worker start.'), effects, residualForWorktree(createdWorkspace.id, setupResult))
              }
            }
          }

          const title = sessionTitle(task)
          const options = sessionOptions(params)
          if (plan.decision.mode === 'structured') {
            session = await call<Session>(context, 'quirky.structured/create', {
              worktree: worktreeId,
              agent: plan.agent.id,
              title,
              ...(params.model !== undefined ? { model: params.model } : {}),
              ...(options === undefined ? {} : { options }),
              deferStart: true,
            })
            created = true
            effects.push(effect('terminal', 'created', 'agent', session.id))
          } else {
            if (!worktreeId) throw failure('invalid_runtime_response', 'The worker session has no resolved workspace.')
            let createdTab: unknown
            try {
              createdTab = await call<unknown>(context, 'quirky.terminal/newTab', {
                workspace: worktreeId,
                agent: plan.agent.id,
                title,
                activate: false,
                ...(params.model !== undefined ? { model: params.model } : {}),
                ...(options === undefined ? {} : { options }),
              })
            } catch (cause) {
              const code = codeOf(cause)
              const causeData = asRecord(asRecord(cause).data)
              const ambiguous =
                causeData.accepted !== false
                && (code === 'operation_unknown'
                  || code === 'runtime_timeout'
                  || code === 'runtime_unavailable'
                  || code === 'connection_lost'
                  || code === 'timeout'
                  || (cause instanceof Error && cause.name === 'TimeoutError'))
              if (!ambiguous) throw cause
              const unknown = failure(
                'operation_unknown',
                `The terminal/newTab outcome for worker ${title} is unknown: ${messageOf(cause)}`,
                causeData,
              )
              throw attachPlacementData(unknown, effects, residualForTerminal(worktreeId, 'outcome_unknown'))
            }
            const result = asRecord(createdTab)
            const sessionId = nonEmptyString(result.session) ? result.session : null
            const tabId = nonEmptyString(result.tab) ? result.tab : null
            createdTerminalSessionId = sessionId
            terminalTabId = tabId
            if (sessionId !== null) {
              created = true
              effects.push(effect('terminal', 'created', 'agent', sessionId))
            }
            if (sessionId === null || tabId === null) {
              throw attachPlacementData(
                failure('operation_unknown', 'quirky.terminal/newTab returned an invalid creation response.'),
                effects,
                residualForTerminal(worktreeId, 'outcome_unknown', sessionId ?? undefined, tabId ?? undefined),
              )
            }

            let sessionValue: unknown
            try {
              sessionValue = await call<unknown>(context, 'quirky.session/get', { session: sessionId })
            } catch (cause) {
              throw attachPlacementData(
                failure('operation_unknown', `The created session ${sessionId} could not be read: ${messageOf(cause)}`),
                effects,
                residualForTerminal(worktreeId, 'identity_unverifiable', sessionId, tabId),
              )
            }
            const sessionRecord = asRecord(sessionValue)
            if (
              sessionRecord.id !== sessionId
              || sessionRecord.kind !== 'terminal'
              || sessionRecord.agent !== plan.agent.id
              || sessionRecord.worktreeId !== worktreeId
              || typeof sessionRecord.cwd !== 'string'
              || typeof sessionRecord.title !== 'string'
              || (sessionRecord.status !== 'starting'
                && sessionRecord.status !== 'running'
                && sessionRecord.status !== 'working'
                && sessionRecord.status !== 'waiting'
                && sessionRecord.status !== 'done'
                && sessionRecord.status !== 'exited')
              || typeof sessionRecord.createdAt !== 'number'
              || typeof sessionRecord.lastActivityAt !== 'number'
              || (sessionRecord.exitCode !== null && typeof sessionRecord.exitCode !== 'number')
            ) {
              throw attachPlacementData(
                failure('operation_unknown', `quirky.session/get returned an invalid record for created session ${sessionId}.`),
                effects,
                residualForTerminal(worktreeId, 'identity_unverifiable', sessionId, tabId),
              )
            }
            session = sessionRecord as unknown as Session
          }
        }

        if (!worktreeId) throw failure('invalid_runtime_response', 'The worker session has no resolved workspace.')
        let identity: SessionIdentity
        try {
          identity = await getIdentity(context, session.id)
        } catch (cause) {
          const identityResidual = terminalTabId === null
            ? [{ kind: 'session', id: session.id, state: 'identity_unverifiable' }]
            : residualForTerminal(worktreeId, 'identity_unverifiable', session.id, terminalTabId)
          throw attachPlacementData(
            failure('operation_unknown', `The exact identity of created session ${session.id} could not be established: ${messageOf(cause)}`),
            effects,
            identityResidual,
          )
        }
        if (expectedIdentity && (
          !identity.live
          || identity.sessionId !== expectedIdentity.sessionId
          || identity.processIncarnation !== expectedIdentity.processIncarnation
          || identity.worktreeId !== expectedIdentity.worktreeId
          || identity.kind !== expectedIdentity.kind
        )) {
          throw failure('worker_identity_changed', `Session ${session.id} changed incarnation after worker admission.`)
        }
        const placement: WorkerPlacement = { worktreeId, session, identity, created, effects, setup }
        validatePlacementIdentity(placement, plan.worktreeId, caller)
        onCustody(placement)
        if (terminalTabId !== null) {
          try {
            await call(context, 'quirky.terminal/renameTab', { tab: terminalTabId, title: session.title })
          } catch (cause) {
            throw attachPlacementData(
              failure('operation_unknown', `Worker session ${session.id} was created but its tab title could not be set: ${messageOf(cause)}`),
              effects,
              residualForTerminal(worktreeId, 'created', session.id, terminalTabId),
            )
          }
        }
        return placement
      } catch (cause) {
        if (cause instanceof Error && 'data' in cause && cause.data) throw cause
        const residual = worktreeId
          ? createdTerminalSessionId !== null || terminalTabId !== null
            ? residualForTerminal(worktreeId, 'created', createdTerminalSessionId ?? undefined, terminalTabId ?? undefined)
            : residualForWorktree(worktreeId, null)
          : []
        throw attachPlacementData(cause, effects, residual)
      }
    },

    async waitReady(placement, deadline, reused) {
      ensureActive()
      if (placement.session.kind === 'structured') {
        if (placement.setup.startupPolicy === 'wait-for-setup' && placement.setup.state === 'running') {
          throw failure('operation_unknown', 'A structured worker was created before its required setup gate completed.')
        }
        return waitForStructuredReady(context, placement.session.id, placement.identity, deadline, ensureActive)
      }
      await waitForReadyAgent(context, placement.session.id, deadline, reused, ensureActive)
    },

    async submit(placement, text, operationId, deadline) {
      ensureActive()
      const current = await getIdentity(context, placement.session.id)
      if (!current.live || current.processIncarnation !== placement.identity.processIncarnation || current.worktreeId !== placement.worktreeId || current.kind !== placement.session.kind) {
        throw failure('worker_identity_changed', `Worker session ${placement.session.id} changed before the initial turn was submitted.`)
      }

      let beforeSeq = 0
      if (placement.session.kind === 'structured') {
        const messages = await call<StructuredMessage[]>(context, 'quirky.structured/messages', { session: placement.session.id })
        if (!Array.isArray(messages)) throw failure('invalid_runtime_response', 'quirky.structured/messages returned an invalid journal page.')
        beforeSeq = messages.reduce((max, message) => Math.max(max, message.seq), 0)
      }

      const pointerParams: Record<string, unknown> = {
        session: placement.session.id,
        expectedIncarnation: placement.identity.processIncarnation,
        operationId,
        purpose: 'worker_start',
        text,
      }
      const submittedNotBefore = Date.now()
      let pointer: PointerResult
      try {
        pointer = await call<PointerResult>(context, 'quirky.session/pointer', pointerParams)
      } catch (cause) {
        const details = asRecord(asRecord(cause).data)
        const code = codeOf(cause)
        const knownNoSubmission = details.accepted === false
          || details.effectsApplied === false
          || code === 'agent_not_ready'
          || code === 'worker_identity_changed'
          || code === 'invalid_argument'
          || code === 'invalid-params'
          || code === 'not-found'
          || code === 'not_found'
          || code === 'terminal_not_found'
          || code === 'method_not_found'
          || code === 'capability_unsupported'
        if (knownNoSubmission) throw cause
        throw failure('operation_unknown', `The initial worker prompt may have been submitted: ${messageOf(cause)}`)
      }
      if (!pointer || pointer.operationId !== operationId || !pointer.result || typeof pointer.result.status !== 'string') {
        throw failure('operation_unknown', 'The session pointer did not return verifiable evidence for the initial worker prompt.')
      }
      if (pointer.result.status === 'outcome_unknown') return 'unobserved'
      if (pointer.result.status === 'deferred') {
        throw failure('agent_not_ready', `The worker prompt was not submitted because the session is ${pointer.result.reason}.`, { accepted: false, reason: pointer.result.reason })
      }
      if (pointer.result.status === 'released') {
        throw failure('worker_identity_changed', `The worker session changed before the prompt was submitted (${pointer.result.reason}).`)
      }
      if (pointer.result.status !== 'submitted' && pointer.result.status !== 'text_only') {
        throw failure('operation_unknown', `The session pointer returned an unverifiable result: ${pointer.result.status}.`)
      }
      if (pointer.result.status === 'text_only') return 'unobserved'

      const observationDeadline = Math.min(deadline, Date.now() + OBSERVATION_TIMEOUT_MS)
      let observation: TurnStart
      try {
        if (placement.session.kind === 'structured') {
          observation = await thisObserveStructured(context, placement.session.id, beforeSeq, text, placement.identity, observationDeadline, ensureActive)
        } else {
          observation = await thisObserveTerminal(context, placement.session.id, observationDeadline, submittedNotBefore, ensureActive)
        }
      } catch (cause) {
        if (codeOf(cause) === 'method_not_found' || codeOf(cause) === 'capability_unsupported') observation = 'unsupported'
        else {
          context.log(`Turn-start observation for ${placement.session.id} was inconclusive: ${messageOf(cause)}`)
          return 'unobserved'
        }
      }
      if (observation === 'unobserved') return observation
      try {
        const afterTurn = await getIdentity(context, placement.session.id)
        if (!afterTurn.live || afterTurn.sessionId !== placement.identity.sessionId
          || afterTurn.processIncarnation !== placement.identity.processIncarnation
          || afterTurn.runtimeEpoch !== placement.identity.runtimeEpoch
          || afterTurn.worktreeId !== placement.worktreeId || afterTurn.kind !== placement.session.kind) return 'unobserved'
      } catch (cause) {
        context.log(`Could not re-attest ${placement.session.id} after turn observation: ${messageOf(cause)}`)
        return 'unobserved'
      }
      return observation
    },

    async observe(record: WorkerRecord | null, dispatch) {
      ensureActive()
      if (!record?.sessionId || !record.processIncarnation) {
        return { status: 'unattached', exactWorker: false, reason: 'The worker has no attached session identity.', identity: null, session: null }
      }
      let sessions: Session[]
      try {
        sessions = await listSessions(context)
      } catch (cause) {
        return { status: 'unverifiable', exactWorker: false, reason: messageOf(cause), identity: null, session: null }
      }
      let session = sessions.find(candidate => candidate.id === record.sessionId) ?? null
      if (!session) return { status: 'missing', exactWorker: false, reason: 'The complete session inventory does not contain the recorded session.', identity: null, session: null }
      let identity: SessionIdentity | null = null
      let identityError: string | null = null
      try {
        identity = await getIdentity(context, record.sessionId)
      } catch (cause) {
        identityError = messageOf(cause)
      }
      if (dispatch.assigneeSessionId === null) {
        return { status: 'unattached', exactWorker: false, reason: 'The Dispatch has not attached worker authority yet.', identity, session }
      }
      if (identity && (
        identity.processIncarnation !== record.processIncarnation ||
        identity.runtimeEpoch !== record.processRuntimeEpoch ||
        identity.worktreeId !== record.worktreeId ||
        identity.sessionId !== dispatch.assigneeSessionId ||
        identity.kind !== record.mode
      )) {
        return { status: 'identity_changed', exactWorker: false, reason: 'The live process or Dispatch assignee does not match the recorded worker identity.', identity, session }
      }
      if (!identity && session.status !== 'exited') {
        return { status: 'unverifiable', exactWorker: false, reason: identityError ?? 'The worker identity is unavailable.', identity: null, session }
      }
      // The PTY exit callback refreshes identity asynchronously; timeout never counts as exit evidence.
      const exitConfirmationDeadline = Date.now() + EXIT_IDENTITY_CONFIRM_TIMEOUT_MS
      while (
        (identity === null || (identity.live ? session.status === 'exited' : session.status !== 'exited')) &&
        Date.now() < exitConfirmationDeadline
      ) {
        ensureActive()
        const remaining = exitConfirmationDeadline - Date.now()
        const delay = Promise.withResolvers<void>()
        setTimeout(delay.resolve, Math.min(WAIT_SLICE_MS, remaining))
        await delay.promise
        ensureActive()
        try {
          sessions = await listSessions(context)
        } catch (cause) {
          return { status: 'unverifiable', exactWorker: Boolean(identity), reason: messageOf(cause), identity, session }
        }
        session = sessions.find(candidate => candidate.id === record.sessionId) ?? null
        if (!session) return { status: 'missing', exactWorker: false, reason: 'The complete session inventory does not contain the recorded session.', identity, session: null }
        try {
          identity = await getIdentity(context, record.sessionId)
          identityError = null
        } catch (cause) {
          identity = null
          identityError = messageOf(cause)
          continue
        }
        if (
          identity.processIncarnation !== record.processIncarnation ||
          identity.runtimeEpoch !== record.processRuntimeEpoch ||
          identity.worktreeId !== record.worktreeId ||
          identity.sessionId !== dispatch.assigneeSessionId ||
          identity.kind !== record.mode
        ) {
          return { status: 'identity_changed', exactWorker: false, reason: 'The live process or Dispatch assignee does not match the recorded worker identity.', identity, session }
        }
      }
      if (!identity) {
        return { status: 'unverifiable', exactWorker: false, reason: identityError ?? 'The worker identity remains unavailable.', identity: null, session }
      }
      if (identity.live ? session.status === 'exited' : session.status !== 'exited') {
        return {
          status: 'unverifiable', exactWorker: true,
          reason: 'The session record and kernel process identity do not confirm the same exit state.',
          identity, session,
        }
      }
      if (identity.live) {
        let agentWait: WorkerObservation['agentWait']
        try {
          const status = await call<SessionStatusWait>(context, 'quirky.agent-status/wait', {
            session: session.id,
            until: ['working', 'blocked', 'idle'],
            timeoutMs: 0,
          })
          agentWait = { waiting: status.state === 'blocked', source: 'quirky.agent-status/wait', reason: status.state === 'blocked' ? status.kind ?? 'agent requires human input' : null }
        } catch (cause) {
          agentWait = { waiting: false, source: 'unavailable', reason: messageOf(cause) }
        }
        return { status: 'live', exactWorker: true, reason: null, identity, session, agentWait }
      }
      return { status: 'exited', exactWorker: true, reason: session.exitCause ?? 'The exact worker incarnation is no longer live.', identity, session }
    },

    async close(resource: TerminalResource) {
      ensureActive()
      let identity: SessionIdentity
      try {
        identity = await getIdentity(context, resource.sessionId)
      } catch (cause) {
        return { closed: false, reason: `Could not prove the recorded session identity: ${messageOf(cause)}` }
      }
      if (!identity.live || identity.processIncarnation !== resource.processIncarnation || identity.worktreeId !== resource.worktreeId) {
        return { closed: false, reason: 'The recorded session incarnation is not the current live identity.' }
      }
      try {
        const result = identity.kind === 'structured'
          ? await call<Record<string, unknown>>(context, 'quirky.structured/stop', { session: resource.sessionId, expectedIncarnation: resource.processIncarnation })
          : await call<Record<string, unknown>>(context, 'quirky.session/close', { session: resource.sessionId, expectedIncarnation: resource.processIncarnation })
        const positivelyClosed = result.ok === true && result.closed === true
          && result.sessionId === resource.sessionId && result.processIncarnation === resource.processIncarnation
        return positivelyClosed ? { closed: true } : { closed: false, reason: typeof result.reason === 'string' ? result.reason : 'The guarded close did not positively confirm the exact session was closed.' }
      } catch (cause) {
        return { closed: false, reason: messageOf(cause) }
      }
    },

    dispose() {
      disposed = true
    },
  }
}


async function thisObserveTerminal(
  context: PluginContext,
  sessionId: string,
  deadline: number,
  submittedNotBefore: number,
  ensureActive: () => void,
): Promise<TurnStart> {
  while (Date.now() < deadline) {
    ensureActive()
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const result = await call<SessionStatusWait>(context, 'quirky.agent-status/wait', {
        session: sessionId,
        until: ['working', 'blocked', 'idle', 'exited'],
        timeoutMs: Math.min(WAIT_SLICE_MS, remaining),
      })
      if (result.state === 'blocked') return 'permission'
      if (result.state === 'working') return 'observed'
      if (result.state === 'exited') throw failure('terminal_not_found', `Worker session ${sessionId} exited after the prompt was submitted.`)
      if (result.state === 'idle') {
        const session = (await listSessions(context)).find(candidate => candidate.id === sessionId)
        if (session?.status === 'exited') throw failure('terminal_not_found', `Worker session ${sessionId} exited after the prompt was submitted.`)
        const agentStatus = asRecord(session?.agentStatus)
        const evidenceAt = agentStatus.evidenceAt
        if (typeof evidenceAt === 'number' && evidenceAt > submittedNotBefore) return 'observed'
        const delay = Promise.withResolvers<void>()
        setTimeout(delay.resolve, Math.min(WAIT_SLICE_MS, Math.max(0, deadline - Date.now())))
        await delay.promise
      }
    } catch (cause) {
      if (codeOf(cause) === 'method_not_found' || codeOf(cause) === 'capability_unsupported') return 'unsupported'
      throw cause
    }
  }
  return 'unobserved'
}

async function thisObserveStructured(
  context: PluginContext,
  sessionId: string,
  afterSeq: number,
  expectedText: string,
  expectedIdentity: SessionIdentity,
  deadline: number,
  ensureActive: () => void,
): Promise<TurnStart> {
  while (Date.now() < deadline) {
    ensureActive()
    try {
      const messages = await call<StructuredMessage[]>(context, 'quirky.structured/messages', { session: sessionId, afterSeq })
      if (!Array.isArray(messages)) throw failure('invalid_runtime_response', 'quirky.structured/messages returned an invalid journal page.')
      for (const message of messages) {
        if (message.sessionId !== sessionId || !Number.isSafeInteger(message.seq) || message.seq <= afterSeq) continue
        if (message.role === 'assistant' || message.role === 'tool' || message.role === 'result') return 'observed'
        if (message.role !== 'user' || message.text !== expectedText) continue
        const receipt = asRecord(message.data)
        const method = receipt.method
        const threadId = receipt.threadId
        if ((method !== 'turn/start' && method !== 'turn/steer') || !nonEmptyString(threadId)) continue
        if (method === 'turn/steer' && !nonEmptyString(receipt.expectedTurnId)) continue
        const [session, identity] = await Promise.all([
          call<Session>(context, 'quirky.session/get', { session: sessionId }),
          getIdentity(context, sessionId),
        ])
        const providerThreadId = session.providerSession?.id
        if (session.id !== sessionId || session.kind !== 'structured' || session.agent !== 'codex'
          || expectedIdentity.providerId !== 'codex' || session.worktreeId !== expectedIdentity.worktreeId
          || !nonEmptyString(providerThreadId) || providerThreadId !== threadId) continue
        if (!identity.live || identity.sessionId !== expectedIdentity.sessionId
          || identity.processIncarnation !== expectedIdentity.processIncarnation
          || identity.runtimeEpoch !== expectedIdentity.runtimeEpoch
          || identity.worktreeId !== expectedIdentity.worktreeId
          || identity.kind !== 'structured' || identity.providerId !== 'codex') continue
        return 'observed'
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const delay = Promise.withResolvers<void>()
      setTimeout(delay.resolve, Math.min(WAIT_SLICE_MS, remaining))
      await delay.promise
    } catch (cause) {
      if (codeOf(cause) === 'method_not_found' || codeOf(cause) === 'capability_unsupported') return 'unsupported'
      throw cause
    }
  }
  return 'unobserved'
}
