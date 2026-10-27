import { existsSync, statSync } from 'node:fs'
import type {
  AskEnvelope,
  AskSpec,
  MethodHandler,
  PluginCaller,
  PluginContext,
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
  stopping: boolean
}

const AGENT_TITLES: Record<StructuredAgent, string> = { claude: 'Claude', codex: 'Codex' }
const MAX_PROVIDER_SESSION_ID = 512
const INVALID_PROVIDER_ID = /[\x00-\x1f\x7f-\x9f]/

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
  let statusQueue: Promise<void> = Promise.resolve()
  const ensureActive = (): void => {
    if (!active) throw new Error('structured plugin is deactivated')
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
    if (entry.stopping && (status === 'done' || status === 'waiting')) return
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
    const registered = (await context.call('quirky.session/register', {
      worktree: worktree.id,
      agent,
      kind: 'structured',
      title,
      ...(resolution?.launchSettings ? { launchSettings: resolution.launchSettings } : {})
    })) as Session
    if (!active) return registered
    const token: OwnerToken = { key: '', sessionId: registered.id }
    live.set(registered.id, {
      worktreeId: worktree.id,
      agent,
      status: registered.status,
      lastAssistantMessage: null,
      owner: token,
      stopping: false
    })
    ownersBySession.set(registered.id, token)
    try {
      journal.setLaunchOptions(registered.id, resolution?.structured ?? {})
    } catch (error) {
      startupFailed(registered.id, token, error)
      return registered
    }
    startRunner(registered, agent, prompt, resolution?.structured ?? {}, token)
    return registered
  }

  const resume: MethodHandler = async (params) => {
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
    try {
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

    token.sessionId = registered.id
    ownersBySession.set(registered.id, token)
    live.set(registered.id, {
      worktreeId: old.worktreeId,
      agent,
      status: registered.status,
      lastAssistantMessage: null,
      owner: token,
      stopping: false
    })
    try {
      journal.setLaunchOptions(registered.id, options)
      startRunner(
        registered,
        agent,
        params.prompt as string | undefined,
        { ...options, providerSession },
        token
      )
    } catch (error) {
      startupFailed(registered.id, token, error)
    }
    return registered
  }

  const messages: MethodHandler = async (params) => {
    const session = await requireStructured(params.session as string)
    return journal.list(session.id, (params.afterSeq as number | undefined) ?? 0)
  }

  const send: MethodHandler = async (params) => {
    const session = await requireStructured(params.session as string)
    if (!isStructuredAgent(session.agent)) throw context.error('conflict', `structured sessions cannot send to provider ${session.agent}`)
    await startTasks.get(session.id)
    ensureActive()
    const runner = runnerBySession.get(session.id) ?? runnerFor(session.agent)
    await runner.send(session.id, params.text as string)
    return { ok: true }
  }

  const stop: MethodHandler = async (params) => {
    const session = await requireStructured(params.session as string)
    const entry = live.get(session.id)
    if (entry) entry.stopping = true
    const runner = runnerBySession.get(session.id)
    try {
      await runner?.stop(session.id)
    } finally {
      await cancelPendingAsks(session.id)
      setStatus(session.id, 'exited')
      releaseOwner(session.id)
      runnerBySession.delete(session.id)
    }
    return { ok: true }
  }

  context.provide('method:quirky.structured/create', create)
  context.provide('method:quirky.structured/resume', resume)
  context.provide('method:quirky.structured/messages', messages)
  context.provide('method:quirky.structured/send', send)
  context.provide('method:quirky.structured/stop', stop)

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
