import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type {
  AskEnvelope,
  AskSpec,
  MethodHandler,
  PluginCaller,
  PluginContext,
  PluginInfo,
  Session,
  SessionProviderSession,
  SessionStatus,
  StructuredMessage,
  Worktree
} from '@quirky/protocol'
import { resolveClaudeThroughLoginShell } from './claude-path'
import { createClaudeRunner } from './claude-runner'
import { resolveCodexThroughLoginShell } from './codex-path'
import { createCodexRunner } from './codex-runner'
import { Journal, journalMigrations } from './journal'
import type {
  NewStructuredMessage,
  StructuredContext,
  StructuredLaunchOptions,
  StructuredRunner,
  StructuredRunnerFactory,
  StructuredStartOptions
} from './runner'

type StructuredAgent = 'claude' | 'codex'
type OwnerToken = { key: string; sessionId: string | null }
type LiveSession = {
  worktreeId: string
  agent: StructuredAgent
  status: SessionStatus
  lastAssistantMessage: string | null
  owner: OwnerToken
  ownerPluginId: string | null
  hasSent: boolean
  stopping: boolean
}

const AGENT_TITLES: Record<StructuredAgent, string> = { claude: 'Claude', codex: 'Codex' }
const MAX_PROVIDER_SESSION_ID = 512
const INVALID_PROVIDER_ID = /[\x00-\x1f\x7f-\x9f]/

type HomeOverride = { value: string | null; source: 'explicit' | 'inherited' | 'injected' | 'absent' }
type AccountPreparation = {
  env: Record<string, string | null>
  shellInit: string | null
  account: { provider: 'claude' | 'codex'; id: string | null; label: string; source: 'managed' | 'default' | 'custom' } | null
  resumeTranscriptPath?: string
}

const ACCOUNT_PREPARE_METHOD = 'method:quirky.accounts/prepare'

function accountPreparationAvailable(value: unknown): boolean {
  if (!Array.isArray(value)) throw new Error('plugin.contributions returned an invalid list')
  return value.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      'id' in entry &&
      entry.id === ACCOUNT_PREPARE_METHOD &&
      'kind' in entry &&
      entry.kind === 'method' &&
      'status' in entry &&
      entry.status === 'effective'
  )
}

function environmentOf(value: unknown, method: string): Record<string, string | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${method} returned an invalid environment`)
  }
  const env: Record<string, string | null> = {}
  for (const name of Object.keys(value)) {
    const entry = Reflect.get(value, name)
    if (entry !== null && typeof entry !== 'string') throw new Error(`${method} returned an invalid environment value for ${name}`)
    env[name] = entry
  }
  return env
}

function plannedEnvironmentOf(value: unknown): Record<string, string | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('record' in value)) {
    throw new Error('quirky.agents/plan returned an invalid launch record')
  }
  const record = value.record
  if (typeof record !== 'object' || record === null || Array.isArray(record) || !('env' in record)) {
    throw new Error('quirky.agents/plan returned an invalid launch record')
  }
  return environmentOf(record.env, 'quirky.agents/plan')
}

function homeOverrideOf(name: string, userEnv: Record<string, string | null>): HomeOverride {
  if (Object.hasOwn(userEnv, name)) return { value: userEnv[name] ?? null, source: 'explicit' }
  const inherited = process.env[name]
  return inherited === undefined ? { value: null, source: 'absent' } : { value: inherited, source: 'inherited' }
}

function homeOverridesOf(userEnv: Record<string, string | null>): {
  claude: HomeOverride
  codex: HomeOverride
} {
  return {
    claude: homeOverrideOf('CLAUDE_CONFIG_DIR', userEnv),
    codex: homeOverrideOf('CODEX_HOME', userEnv)
  }
}

function accountPreparationOf(value: unknown): AccountPreparation {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('env' in value) ||
    !('shellInit' in value) ||
    !('account' in value)
  ) {
    throw new Error('quirky.accounts/prepare returned an invalid result')
  }
  const env = environmentOf(value.env, 'quirky.accounts/prepare')
  const shellInit = value.shellInit
  if (shellInit !== null && typeof shellInit !== 'string') throw new Error('quirky.accounts/prepare returned an invalid shell init path')
  if (typeof shellInit === 'string' && !isAbsolute(shellInit)) throw new Error('quirky.accounts/prepare returned a non-absolute shell init path')
  let account: AccountPreparation['account'] = null
  const candidate = value.account
  if (candidate !== null) {
    if (
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      !('provider' in candidate) ||
      !('id' in candidate) ||
      !('label' in candidate) ||
      !('source' in candidate)
    ) {
      throw new Error('quirky.accounts/prepare returned an invalid account')
    }
    const provider = candidate.provider
    const id = candidate.id
    const source = candidate.source
    if (
      (provider !== 'claude' && provider !== 'codex') ||
      (id !== null && typeof id !== 'string') ||
      typeof candidate.label !== 'string' ||
      (source !== 'managed' && source !== 'default' && source !== 'custom')
    ) {
      throw new Error('quirky.accounts/prepare returned an invalid account')
    }
    account = { provider, id, label: candidate.label, source }
  }
  const resumeTranscriptPath = 'resumeTranscriptPath' in value ? value.resumeTranscriptPath : undefined
  if (resumeTranscriptPath !== undefined && (typeof resumeTranscriptPath !== 'string' || !isAbsolute(resumeTranscriptPath))) {
    throw new Error('quirky.accounts/prepare returned an invalid resume transcript path')
  }
  return { env, shellInit, account, ...(resumeTranscriptPath === undefined ? {} : { resumeTranscriptPath }) }
}

function structuredEnvironment(userEnv: Record<string, string | null>, prepared: AccountPreparation): Record<string, string | null> {
  const env = { ...prepared.env }
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (Object.hasOwn(userEnv, name)) env[name] = userEnv[name] ?? null
  }
  return env
}

const isStructuredAgent = (value: unknown): value is StructuredAgent => value === 'claude' || value === 'codex'

/** Tests inject one runner through this seam; production runners are selected by provider. */
function testRunnerFactory(): StructuredRunnerFactory | undefined {
  return (globalThis as { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }).__QUIRKY_TEST_STRUCTURED_RUNNER__
}

let shutdown: (() => Promise<void>) | undefined

/**
 * Provides native structured sessions, their append-only journals and permission prompts.
 */
export function activate(context: PluginContext): void {
  let active = true
  const journal = new Journal(context.openStore(journalMigrations(context.home)))
  const live = new Map<string, LiveSession>()
  const pendingAsks = new Map<string, Set<string>>()
  const owners = new Map<string, OwnerToken>()
  const ownersBySession = new Map<string, OwnerToken>()
  const agentRunners = new Map<StructuredAgent, StructuredRunner>()
  const runnerBySession = new Map<string, StructuredRunner>()
  const startTasks = new Map<string, Promise<void>>()
  const sendTails = new Map<string, Promise<void>>()
  let statusQueue: Promise<void> = Promise.resolve()
  const ensureActive = (): void => {
    if (!active) throw new Error('structured plugin is deactivated')
  }
  const ownerPluginFor = async (caller: PluginCaller): Promise<string | null> => {
    if (caller.role !== 'plugin') return null
    try {
      const plugins = await context.call('plugin.list') as PluginInfo[]
      return Array.isArray(plugins) && plugins.some((plugin) => plugin.id === caller.pluginId)
        ? caller.pluginId
        : null
    } catch (error) {
      context.log(`could not identify structured session owner: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  const enqueueSend = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = sendTails.get(sessionId) ?? Promise.resolve()
    const next = Promise.withResolvers<void>()
    sendTails.set(sessionId, next.promise)
    await previous
    try {
      return await operation()
    } finally {
      next.resolve()
      if (sendTails.get(sessionId) === next.promise) sendTails.delete(sessionId)
    }
  }

  const releaseOwnerToken = (token: OwnerToken): void => {
    if (token.key && owners.get(token.key) === token) owners.delete(token.key)
    if (token.sessionId && ownersBySession.get(token.sessionId) === token) ownersBySession.delete(token.sessionId)
    token.key = ''
    token.sessionId = null
  }

  const releaseOwner = (sessionId: string): void => {
    const token = ownersBySession.get(sessionId) ?? live.get(sessionId)?.owner
    if (token) releaseOwnerToken(token)
  }

  const appendMessage = (msg: NewStructuredMessage): StructuredMessage => {
    const entry = live.get(msg.sessionId)
    if (!active || !entry) {
      return {
        sessionId: msg.sessionId,
        seq: 0,
        role: msg.role,
        text: msg.text,
        at: msg.at ?? Date.now(),
        ...(msg.data === undefined ? {} : { data: msg.data })
      }
    }
    const message = journal.append({ ...msg, at: msg.at ?? Date.now() })
    if (msg.role === 'assistant') entry.lastAssistantMessage = msg.text
    context.emit('message', { message })
    return message
  }

  const setStatus = (sessionId: string, status: SessionStatus): void => {
    const entry = live.get(sessionId)
    if (!active || !entry) return
    if (entry.stopping && status !== 'exited') return
    const changed = entry.status !== status
    entry.status = status
    if (status === 'exited') {
      releaseOwner(sessionId)
      void cancelPendingAsks(sessionId)
    }
    statusQueue = statusQueue.then(async () => {
      if (!active || !live.has(sessionId)) return
      try {
        await context.call('quirky.session/setStatus', { session: sessionId, status })
      } catch (error) {
        if (active) context.log(`could not set ${sessionId} to ${status}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    if (!changed || (status !== 'done' && status !== 'waiting')) return
    context.emit('settled', {
      sessionId,
      worktreeId: entry.worktreeId,
      agent: entry.agent,
      state: status,
      lastAssistantMessage: entry.lastAssistantMessage,
      at: Date.now()
    })
  }

  const cancelAsk = async (askId: string): Promise<void> => {
    try {
      await context.call('quirky.ask/cancel', { askId })
    } catch {
      // Ask ownership cleanup handles revoked-context shutdown; a closed ask needs no retry here.
    }
  }

  const cancelPendingAsks = async (sessionId: string): Promise<void> => {
    await Promise.all([...(pendingAsks.get(sessionId) ?? [])].map(cancelAsk))
  }

  const createAsk = async (spec: AskSpec, sessionId: string): Promise<AskEnvelope> => {
    const entry = live.get(sessionId)
    if (!active || !entry) throw new Error('structured session is not active')
    const { askId } = (await context.call('quirky.ask/create', {
      spec,
      session: sessionId,
      ...(entry.worktreeId ? { worktree: entry.worktreeId } : {})
    })) as { askId: string }
    const pending = pendingAsks.get(sessionId) ?? new Set<string>()
    pendingAsks.set(sessionId, pending)
    pending.add(askId)
    try {
      for (;;) {
        const envelope = (await context.call('quirky.ask/wait', { askId })) as AskEnvelope
        if (envelope.status !== 'pending') return envelope
      }
    } finally {
      pending.delete(askId)
      if (pending.size === 0) pendingAsks.delete(sessionId)
    }
  }

  const providerSessionIdProblem = (id: string): string | null => {
    if (id.length === 0) return "provider session id can't be empty"
    if (id.length > MAX_PROVIDER_SESSION_ID) {
      return `provider session id can't be longer than ${MAX_PROVIDER_SESSION_ID} characters`
    }
    if (id.startsWith('-')) return "provider session id can't start with '-'"
    if (INVALID_PROVIDER_ID.test(id)) return "provider session id can't contain control characters"
    return null
  }

  const persistProviderSession = async (
    sessionId: string,
    providerSession: SessionProviderSession
  ): Promise<Session> => {
    if (!active) throw new Error('structured plugin is deactivated')
    const entry = live.get(sessionId)
    if (!entry) throw new Error('structured session is not active')
    const problem = providerSessionIdProblem(providerSession.id)
    if (problem) throw context.error('invalid-params', problem)
    const key = `${entry.agent}:${providerSession.id}`
    if (entry.owner.key && entry.owner.key !== key) {
      throw context.error('conflict', 'a connected structured session cannot change provider identity')
    }
    const owner = owners.get(key)
    if (owner && owner !== entry.owner) {
      throw context.error('conflict', `the ${entry.agent} conversation already has a connected owner`)
    }
    owners.set(key, entry.owner)
    entry.owner.key = key
    entry.owner.sessionId = sessionId
    ownersBySession.set(sessionId, entry.owner)
    try {
      return (await context.call('quirky.session/setProviderSession', {
        session: sessionId,
        id: providerSession.id,
        ...(providerSession.transcriptPath == null ? {} : { transcriptPath: providerSession.transcriptPath })
      })) as Session
    } catch (error) {
      releaseOwnerToken(entry.owner)
      throw error
    }
  }

  const structuredContext: StructuredContext = {
    appendMessage,
    setStatus,
    createAsk,
    async setProviderSession(sessionId, providerSession) {
      await persistProviderSession(sessionId, providerSession)
    },
    resolveClaudePath: () => resolveClaudeThroughLoginShell(context.launch.shell),
    resolveCodexPath: () => resolveCodexThroughLoginShell(context.launch.shell)
  }

  const injectedRunner = testRunnerFactory()?.(structuredContext)
  const runnerFor = (agent: StructuredAgent): StructuredRunner => {
    if (injectedRunner) return injectedRunner
    const cached = agentRunners.get(agent)
    if (cached) return cached
    const runner = agent === 'claude' ? createClaudeRunner(structuredContext) : createCodexRunner(structuredContext)
    agentRunners.set(agent, runner)
    return runner
  }

  const requireStructured = async (sessionId: string): Promise<Session> => {
    const session = (await context.call('quirky.session/get', { session: sessionId })) as Session
    if (session.kind !== 'structured') {
      throw context.error('invalid-params', `session ${sessionId} is not a structured session`)
    }
    return session
  }

  const resolveWorktree = async (selector: unknown, caller: PluginCaller): Promise<Worktree> => {
    const client = caller.role === 'plugin' ? undefined : caller
    return (await context.call('quirky.worktree/resolve', {
      selector: typeof selector === 'string' ? selector : 'current',
      ...(client?.cwd ? { cwd: client.cwd } : {}),
      ...(client?.worktreeId ? { worktreeId: client.worktreeId } : {})
    })) as Worktree
  }

  const nextTitle = async (worktreeId: string, agent: StructuredAgent): Promise<string> => {
    const base = AGENT_TITLES[agent]
    const sessions = (await context.call('quirky.session/list', { worktree: worktreeId })) as Session[]
    const taken = new Set(sessions.map((session) => session.title))
    for (let n = 1; ; n++) {
      const title = n === 1 ? base : `${base} ${n}`
      if (!taken.has(title)) return title
    }
  }

  const resolveStructuredLaunch = async (
    params: Record<string, unknown>
  ): Promise<{ structured: StructuredLaunchOptions; launchSettings: unknown } | null> => {
    if (params.model === undefined && params.options === undefined) return null
    const raw = await context.call('quirky.agents/resolveLaunch', {
      agent: params.agent,
      model: params.model,
      options: params.options,
      structured: true
    })
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw context.error('invalid-params', 'agent catalog returned malformed structured launch options')
    }
    const resolution = raw as Record<string, unknown>
    const rawStructured = resolution.structured
    if (typeof rawStructured !== 'object' || rawStructured === null || Array.isArray(rawStructured)) {
      throw context.error('invalid-params', 'agent catalog returned malformed structured launch options')
    }
    const selected = rawStructured as Record<string, unknown>
    const structured: StructuredLaunchOptions = {}
    for (const key of Object.keys(selected)) {
      const value = selected[key]
      if (key !== 'model' && key !== 'effort') {
        throw context.error('invalid-params', `structured launch option "${key}" is unsupported`)
      }
      if (typeof value !== 'string') {
        throw context.error('invalid-params', `structured launch option "${key}" must resolve to a string`)
      }
      if (key === 'model') structured.model = value
      else structured.effort = value
    }
    return { structured, launchSettings: resolution.launchSettings ?? null }
  }

  const launchOptionsFromSnapshot = (session: Session): StructuredLaunchOptions => {
    const snapshot = session.launchSettings
    if (snapshot === null || snapshot === undefined) return {}
    if (snapshot.agent !== session.agent) {
      throw context.error('conflict', `session ${session.id} has mismatched structured launch settings`)
    }
    if (snapshot.args && snapshot.args.value !== '') {
      throw context.error('conflict', `session ${session.id} has launch arguments that a structured runner cannot replay`)
    }
    const rawOptions = snapshot.options as unknown
    if (typeof rawOptions !== 'object' || rawOptions === null || Array.isArray(rawOptions)) {
      throw context.error('conflict', `session ${session.id} has malformed structured launch settings`)
    }
    const values = rawOptions as Record<string, unknown>
    const unsupported = Object.keys(values).find((key) => key !== 'model' && key !== 'effort')
    if (unsupported !== undefined) {
      throw context.error('conflict', `session ${session.id} has unsupported structured launch option "${unsupported}"`)
    }
    const options: StructuredLaunchOptions = {}
    for (const key of ['model', 'effort'] as const) {
      const selected = values[key]
      if (selected === undefined) continue
      if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) {
        throw context.error('conflict', `session ${session.id} has malformed structured ${key}`)
      }
      const value = (selected as Record<string, unknown>).value
      if (value === undefined) continue
      if (typeof value !== 'string') {
        throw context.error('conflict', `session ${session.id} has non-string structured ${key}`)
      }
      options[key] = value
    }
    return options
  }

  const startupFailed = (sessionId: string, token: OwnerToken, error: unknown): void => {
    const entry = live.get(sessionId)
    if (!active || !entry) {
      releaseOwnerToken(token)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    appendMessage({ sessionId, role: 'system', text: `could not start: ${message}` })
    setStatus(sessionId, 'exited')
    releaseOwnerToken(token)
  }

  const startRunner = (
    session: Session,
    agent: StructuredAgent,
    prompt: string | undefined,
    options: StructuredStartOptions,
    token: OwnerToken
  ): void => {
    const runner = runnerFor(agent)
    runnerBySession.set(session.id, runner)
    const task = Promise.resolve()
      .then(async () => {
        const entry = live.get(session.id)
        if (!active || !entry || entry.stopping) return
        await runner.start(session, prompt, options)
      })
      .catch((error: unknown) => startupFailed(session.id, token, error))
    startTasks.set(session.id, task)
    void task.then(() => {
      if (startTasks.get(session.id) === task) startTasks.delete(session.id)
    })
  }

  const create: MethodHandler = async (params, caller) => {
    const ownerPluginId = await ownerPluginFor(caller)
    if (!isStructuredAgent(params.agent)) {
      throw context.error('invalid-params', 'structured sessions support only the claude or codex agent')
    }
    if (params.extraArgs !== undefined) {
      throw context.error('invalid-params', "Extra arguments can't be applied to a structured session.")
    }
    const unsupported = Object.keys(params).find(
      (key) => !['worktree', 'agent', 'prompt', 'model', 'options', 'extraArgs'].includes(key)
    )
    if (unsupported !== undefined) throw context.error('invalid-params', `structured create does not support ${unsupported}`)
    if (typeof params.prompt !== 'string') throw context.error('invalid-params', 'prompt must be a string')
    const agent = params.agent
    const prompt = params.prompt
    const worktree = await resolveWorktree(params.worktree, caller)
    ensureActive()
    const resolution = await resolveStructuredLaunch(params)
    ensureActive()
    const title = await nextTitle(worktree.id, agent)
    ensureActive()
    const accountPrepare = accountPreparationAvailable(await context.call('plugin.contributions', { kind: 'method' }))
    const userEnv = accountPrepare
      ? plannedEnvironmentOf(
          await context.call('quirky.agents/plan', {
            agent,
            cwd: worktree.path,
            ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
            ...(params.submitPrompt === undefined ? {} : { submitPrompt: params.submitPrompt }),
            ...(params.model === undefined ? {} : { model: params.model }),
            ...(params.options === undefined ? {} : { options: params.options })
          })
        )
      : {}
    const registered = (await context.call('quirky.session/register', {
      worktree: worktree.id,
      agent,
      kind: 'structured',
      title,
      ...(resolution?.launchSettings ? { launchSettings: resolution.launchSettings } : {})
    })) as Session
    if (!active) return registered
    let prepared: AccountPreparation | null = null
    if (accountPrepare) {
      try {
        prepared = accountPreparationOf(
          await context.call('quirky.accounts/prepare', {
            agent,
            sessionId: registered.id,
            worktreeId: worktree.id,
            cwd: worktree.path,
            homeOverrides: homeOverridesOf(userEnv)
          })
        )
      } catch (error) {
        try {
          await context.call('quirky.session/close', { session: registered.id })
        } catch (closeError) {
          context.log(
            `could not remove structured session ${registered.id} after account preparation failed: ${
              closeError instanceof Error ? closeError.message : String(closeError)
            }`
          )
        }
        throw error
      }
    }
    if (!active) return registered
    const environment = prepared === null ? {} : structuredEnvironment(userEnv, prepared)
    const launchOptions: StructuredLaunchOptions = {
      ...(resolution?.structured ?? {}),
      ...(Object.keys(environment).length > 0 ? { env: environment } : {})
    }
    const token: OwnerToken = { key: '', sessionId: registered.id }
    live.set(registered.id, {
      worktreeId: worktree.id,
      agent,
      status: registered.status,
      lastAssistantMessage: null,
      owner: token,
      ownerPluginId,
      hasSent: false,
      stopping: false
    })
    ownersBySession.set(registered.id, token)
    try {
      journal.setLaunchOptions(registered.id, resolution?.structured ?? {})
    } catch (error) {
      startupFailed(registered.id, token, error)
      return registered
    }
    startRunner(registered, agent, prompt, launchOptions, token)
    return registered
  }

  const resume: MethodHandler = async (params, caller) => {
    const ownerPluginId = await ownerPluginFor(caller)
    const unsupported = Object.keys(params).find((key) => key !== 'session' && key !== 'prompt')
    if (unsupported !== undefined) throw context.error('invalid-params', `structured resume does not support ${unsupported}`)
    if (typeof params.prompt !== 'undefined' && typeof params.prompt !== 'string') {
      throw context.error('invalid-params', 'prompt must be a string')
    }
    const old = await requireStructured(params.session as string)
    ensureActive()
    if (!isStructuredAgent(old.agent)) {
      throw context.error('conflict', `structured sessions cannot resume provider ${old.agent}`)
    }
    const agent = old.agent
    const providerSession = old.providerSession
    if (!providerSession || typeof providerSession.id !== 'string') {
      throw context.error('conflict', `session ${old.id} has no provider session and cannot be resumed`)
    }
    const problem = providerSessionIdProblem(providerSession.id)
    if (problem) throw context.error('invalid-params', problem)
    let originalIsDirectory = false
    try {
      originalIsDirectory = existsSync(old.cwd) && statSync(old.cwd).isDirectory()
    } catch {
      originalIsDirectory = false
    }
    if (!originalIsDirectory) throw context.error('conflict', `the session's folder ${old.cwd} no longer exists`)

    let options: StructuredLaunchOptions
    try {
      options = journal.getLaunchOptions(old.id) ?? launchOptionsFromSnapshot(old)
    } catch (error) {
      throw context.error('conflict', `session ${old.id} cannot replay its structured launch options: ${error instanceof Error ? error.message : String(error)}`)
    }
    const key = `${agent}:${providerSession.id}`
    if (owners.has(key)) throw context.error('conflict', `the ${agent} conversation already has a connected owner`)
    const token: OwnerToken = { key, sessionId: null }
    owners.set(key, token)

    let registered: Session
    let accountPrepare = false
    let userEnv: Record<string, string | null> = {}
    try {
      ensureActive()
      accountPrepare = accountPreparationAvailable(await context.call('plugin.contributions', { kind: 'method' }))
      if (accountPrepare) {
        userEnv = plannedEnvironmentOf(
          await context.call('quirky.agents/plan', {
            agent,
            cwd: old.cwd,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.effort === undefined ? {} : { options: { effort: options.effort } })
          })
        )
      }
      ensureActive()
      const title = await nextTitle(old.worktreeId, agent)
      ensureActive()
      registered = (await context.call('quirky.session/register', {
        worktree: old.worktreeId,
        cwd: old.cwd,
        resumedFrom: old.id,
        agent,
        kind: 'structured',
        title,
        ...(old.launchSettings === null || old.launchSettings === undefined ? {} : { launchSettings: old.launchSettings })
      })) as Session
      if (!active) {
        releaseOwnerToken(token)
        return registered
      }
    } catch (error) {
      releaseOwnerToken(token)
      throw error
    }

    let prepared: AccountPreparation | null = null
    if (accountPrepare) {
      try {
        prepared = accountPreparationOf(
          await context.call('quirky.accounts/prepare', {
            agent,
            sessionId: registered.id,
            worktreeId: old.worktreeId,
            cwd: old.cwd,
            homeOverrides: homeOverridesOf(userEnv),
            resume: { sourceSessionId: old.id, providerSession }
          })
        )
      } catch (error) {
        try {
          await context.call('quirky.session/close', { session: registered.id })
        } catch (closeError) {
          context.log(
            `could not remove structured session ${registered.id} after account preparation failed: ${
              closeError instanceof Error ? closeError.message : String(closeError)
            }`
          )
        }
        releaseOwnerToken(token)
        throw error
      }
    }
    if (!active) {
      releaseOwnerToken(token)
      return registered
    }
    const environment = prepared === null ? {} : structuredEnvironment(userEnv, prepared)
    const launchOptions: StructuredLaunchOptions = {
      ...options,
      ...(Object.keys(environment).length > 0 ? { env: environment } : {})
    }
    const preparedProviderSession =
      prepared?.resumeTranscriptPath === undefined
        ? providerSession
        : { ...providerSession, transcriptPath: prepared.resumeTranscriptPath }
    token.sessionId = registered.id
    ownersBySession.set(registered.id, token)
    live.set(registered.id, {
      worktreeId: old.worktreeId,
      agent,
      status: registered.status,
      lastAssistantMessage: null,
      owner: token,
      ownerPluginId,
      hasSent: false,
      stopping: false
    })
    try {
      journal.setLaunchOptions(registered.id, options)
      startRunner(
        registered,
        agent,
        params.prompt as string | undefined,
        { ...launchOptions, providerSession: preparedProviderSession },
        token
      )
    } catch (error) {
      startupFailed(registered.id, token, error)
    }
    return registered
  }

  const messages: MethodHandler = async (params) => {
    const unsupported = Object.keys(params).find((key) => !['session', 'afterSeq', 'limit', 'tail'].includes(key))
    if (unsupported !== undefined) throw context.error('invalid-params', `structured messages does not support ${unsupported}`)
    const session = await requireStructured(params.session as string)
    const afterSeq = params.afterSeq ?? 0
    if (!Number.isInteger(afterSeq) || (afterSeq as number) < 0) throw context.error('invalid-params', 'afterSeq must be a non-negative integer')
    const limit = params.limit
    if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 1000)) {
      throw context.error('invalid-params', 'limit must be an integer from 1 to 1000')
    }
    const tail = params.tail
    if (tail !== undefined && typeof tail !== 'boolean') throw context.error('invalid-params', 'tail must be a boolean')
    return journal.list(session.id, afterSeq as number, limit as number | undefined, tail === true)
  }

  const send: MethodHandler = async (params) => {
    const unsupported = Object.keys(params).find((key) => !['session', 'text', 'requireIdle', 'expectedAfterSeq'].includes(key))
    if (unsupported !== undefined) throw context.error('invalid-params', `structured send does not support ${unsupported}`)
    if (typeof params.requireIdle !== 'undefined' && typeof params.requireIdle !== 'boolean') {
      throw context.error('invalid-params', 'requireIdle must be a boolean')
    }
    const expectedAfterSeq = params.expectedAfterSeq
    if (expectedAfterSeq !== undefined && (!Number.isInteger(expectedAfterSeq) || (expectedAfterSeq as number) < 0)) {
      throw context.error('invalid-params', 'expectedAfterSeq must be a non-negative integer')
    }
    const session = await requireStructured(params.session as string)
    if (!isStructuredAgent(session.agent)) throw context.error('conflict', `structured sessions cannot send to provider ${session.agent}`)
    return enqueueSend(session.id, async () => {
      await startTasks.get(session.id)
      ensureActive()
      const entry = live.get(session.id)
      const rejectGuard = (reason: 'agent-busy' | 'stale-evidence'): never => {
        const error = context.error('conflict', `structured send refused: ${reason}`)
        Object.assign(error, { data: { reason } })
        throw error
      }
      if (params.requireIdle === true && (
        !entry ||
        entry.stopping ||
        !(entry.status === 'done' || (entry.status === 'running' && !entry.hasSent))
      )) {
        rejectGuard('agent-busy')
      }
      if (expectedAfterSeq !== undefined) {
        const latestSeq = journal.list(session.id, 0, 1, true)[0]?.seq ?? 0
        if (latestSeq !== expectedAfterSeq) rejectGuard('stale-evidence')
      }
      if (entry) entry.hasSent = true
      const runner = runnerBySession.get(session.id) ?? runnerFor(session.agent)
      if (entry?.stopping) rejectGuard('agent-busy')
      await runner.send(session.id, params.text as string)
      return { ok: true }
    })
  }

  const stopSession = async (sessionId: string): Promise<void> => {
    const entry = live.get(sessionId)
    if (entry?.stopping || entry?.status === 'exited') return
    if (entry) entry.stopping = true
    const runner = runnerBySession.get(sessionId)
    try {
      await runner?.stop(sessionId)
    } finally {
      await cancelPendingAsks(sessionId)
      setStatus(sessionId, 'exited')
      releaseOwner(sessionId)
      runnerBySession.delete(sessionId)
    }
  }

  const stop: MethodHandler = async (params) => {
    const session = await requireStructured(params.session as string)
    await stopSession(session.id)
    return { ok: true }
  }

  const reconcileOwnedSessions = async (): Promise<void> => {
    if (!active) return
    try {
      const plugins = await context.call('plugin.list') as PluginInfo[]
      const activeIds = new Set(plugins.filter((plugin) => plugin.state === 'active').map((plugin) => plugin.id))
      const abandoned = [...live].filter(([, entry]) =>
        entry.ownerPluginId !== null && !activeIds.has(entry.ownerPluginId) && !entry.stopping && entry.status !== 'exited'
      )
      await Promise.all(abandoned.map(async ([sessionId]) => {
        try {
          await stopSession(sessionId)
        } catch (error) {
          context.log(`could not stop structured session ${sessionId} after its owner was disabled: ${error instanceof Error ? error.message : String(error)}`)
        }
      }))
    } catch (error) {
      context.log(`could not reconcile structured session owners: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  context.provide('method:quirky.structured/create', create)
  context.provide('method:quirky.structured/resume', resume)
  context.provide('method:quirky.structured/messages', messages)
  context.provide('method:quirky.structured/send', send)
  context.provide('method:quirky.structured/stop', stop)

  context.subscribe((event) => {
    if (active && event.type === 'plugin.changed') void reconcileOwnedSessions()
  })
  const release = async (sessionId: string): Promise<void> => {
    const runner = runnerBySession.get(sessionId)
    await runner?.stop(sessionId).catch(() => undefined)
    await startTasks.get(sessionId)
    await cancelPendingAsks(sessionId)
    runnerBySession.delete(sessionId)
    releaseOwner(sessionId)
  }

  context.subscribe(async (event) => {
    if (!active || event.type !== 'quirky.session/removed') return
    const sessionId = (event.data as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string') return
    live.delete(sessionId)
    await release(sessionId)
    if (active) journal.remove(sessionId)
  })

  shutdown = async () => {
    active = false
    const sessionIds = [...live.keys()]
    live.clear()
    await Promise.all(sessionIds.map(release))
    runnerBySession.clear()
    owners.clear()
    ownersBySession.clear()
    await statusQueue
  }
}

/** Stops every live runner and cancels its pending asks; the host closes the store afterwards. */
export async function deactivate(): Promise<void> {
  const stop = shutdown
  shutdown = undefined
  await stop?.()
}
