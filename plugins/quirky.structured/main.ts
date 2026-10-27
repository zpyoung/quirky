import { isAbsolute } from 'node:path'
import type {
  AskEnvelope,
  AskSpec,
  MethodHandler,
  PluginCaller,
  PluginContext,
  Session,
  SessionStatus,
  Worktree
} from '@quirky/protocol'
import { resolveClaudeThroughLoginShell } from './claude-path'
import { createClaudeRunner } from './claude-runner'
import { Journal, journalMigrations } from './journal'
import type {
  NewStructuredMessage,
  StructuredContext,
  StructuredLaunchOptions,
  StructuredRunner,
  StructuredRunnerFactory
} from './runner'

const CLAUDE_TITLE = 'Claude'

type HomeOverride = { value: string | null; source: 'explicit' | 'inherited' | 'injected' | 'absent' }
type AccountPreparation = {
  env: Record<string, string | null>
  shellInit: string | null
  account: { provider: 'claude' | 'codex'; id: string | null; label: string; source: 'managed' | 'default' | 'custom' } | null
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
  return { env, shellInit, account }
}

function structuredEnvironment(userEnv: Record<string, string | null>, prepared: AccountPreparation): Record<string, string | null> {
  const env = { ...prepared.env }
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (Object.hasOwn(userEnv, name)) env[name] = userEnv[name] ?? null
  }
  return env
}

type LiveSession = { worktreeId: string; status: SessionStatus; lastAssistantMessage: string | null }

/** Tests replace the Claude runner by publishing a factory here before the daemon starts. */
function testRunnerFactory(): StructuredRunnerFactory | undefined {
  return (globalThis as { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }).__QUIRKY_TEST_STRUCTURED_RUNNER__
}

let shutdown: (() => Promise<void>) | undefined

/**
 * Provides `create`, `messages` and `send`: background Claude sessions registered with
 * `quirky.session`, journaled in this plugin's store, with permission prompts raised as asks.
 */
export function activate(context: PluginContext): void {
  const journal = new Journal(context.openStore(journalMigrations(context.home)))
  const live = new Map<string, LiveSession>()
  const pendingAsks = new Map<string, Set<string>>()
  let statusQueue: Promise<void> = Promise.resolve()

  const appendMessage = (msg: NewStructuredMessage) => {
    const message = journal.append({ ...msg, at: msg.at ?? Date.now() })
    const entry = live.get(msg.sessionId)
    if (entry && msg.role === 'assistant') entry.lastAssistantMessage = msg.text
    context.emit('message', { message })
    return message
  }

  const setStatus = (sessionId: string, status: SessionStatus): void => {
    const entry = live.get(sessionId)
    if (!entry) return
    const changed = entry.status !== status
    entry.status = status
    // one chain keeps the session plugin seeing statuses in the order the runner reported them
    statusQueue = statusQueue.then(() =>
      context.call('quirky.session/setStatus', { session: sessionId, status }).then(
        () => undefined,
        (error: Error) => context.log(`could not set ${sessionId} to ${status}: ${error.message}`)
      )
    )
    if (!changed || (status !== 'done' && status !== 'waiting')) return
    context.emit('settled', {
      sessionId,
      worktreeId: entry.worktreeId,
      agent: 'claude',
      state: status,
      lastAssistantMessage: entry.lastAssistantMessage,
      at: Date.now()
    })
  }

  const createAsk = async (spec: AskSpec, sessionId: string): Promise<AskEnvelope> => {
    const worktreeId = live.get(sessionId)?.worktreeId
    const { askId } = (await context.call('quirky.ask/create', {
      spec,
      session: sessionId,
      ...(worktreeId ? { worktree: worktreeId } : {})
    })) as { askId: string }
    const pending = pendingAsks.get(sessionId) ?? new Set<string>()
    pendingAsks.set(sessionId, pending)
    pending.add(askId)
    try {
      // the ask plugin caps one wait, so a prompt left open longer is waited on again
      for (;;) {
        const envelope = (await context.call('quirky.ask/wait', { askId })) as AskEnvelope
        if (envelope.status !== 'pending') return envelope
      }
    } finally {
      pending.delete(askId)
      if (pending.size === 0) pendingAsks.delete(sessionId)
    }
  }

  const structuredContext: StructuredContext = {
    appendMessage,
    setStatus,
    createAsk,
    resolveClaudePath: () => resolveClaudeThroughLoginShell(context.launch.shell)
  }
  const factory = testRunnerFactory() ?? ((runnerContext: StructuredContext) => createClaudeRunner(runnerContext))
  const runner: StructuredRunner = factory(structuredContext)

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

  const nextTitle = async (worktreeId: string): Promise<string> => {
    const sessions = (await context.call('quirky.session/list', { worktree: worktreeId })) as Session[]
    const taken = new Set(sessions.map((session) => session.title))
    for (let n = 1; ; n++) {
      const title = n === 1 ? CLAUDE_TITLE : `${CLAUDE_TITLE} ${n}`
      if (!taken.has(title)) return title
    }
  }

  const resolveStructuredLaunch = async (
    params: Record<string, unknown>
  ): Promise<{ structured: StructuredLaunchOptions; launchSettings: unknown } | null> => {
    if (params.model === undefined && params.options === undefined) return null
    return (await context.call('quirky.agents/resolveLaunch', {
      agent: params.agent,
      model: params.model,
      options: params.options,
      structured: true
    })) as { structured: StructuredLaunchOptions; launchSettings: unknown }
  }

  const create: MethodHandler = async (params, caller) => {
    if (params.agent !== 'claude') {
      throw context.error('invalid-params', 'structured sessions support only the claude agent')
    }
    if (params.extraArgs !== undefined) {
      throw context.error('invalid-params', "Extra arguments can't be applied to a structured session.")
    }
    const worktree = await resolveWorktree(params.worktree, caller)
    const title = await nextTitle(worktree.id)
    const resolution = await resolveStructuredLaunch(params)
    const accountPrepare = accountPreparationAvailable(await context.call('plugin.contributions', { kind: 'method' }))
    const userEnv = accountPrepare
      ? plannedEnvironmentOf(
          await context.call('quirky.agents/plan', {
            agent: 'claude',
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
      agent: 'claude',
      kind: 'structured',
      title,
      ...(resolution?.launchSettings ? { launchSettings: resolution.launchSettings } : {})
    })) as Session
    let prepared: AccountPreparation | null = null
    if (accountPrepare) {
      try {
        prepared = accountPreparationOf(
          await context.call('quirky.accounts/prepare', {
            agent: 'claude',
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
    live.set(registered.id, { worktreeId: worktree.id, status: registered.status, lastAssistantMessage: null })
    const environment = prepared === null ? {} : structuredEnvironment(userEnv, prepared)
    const options: StructuredLaunchOptions = {
      ...(resolution?.structured ?? {}),
      ...(Object.keys(environment).length > 0 ? { env: environment } : {})
    }
    runner.start({ ...registered, cwd: worktree.path }, params.prompt as string, options).catch((error: Error) => {
      appendMessage({ sessionId: registered.id, role: 'system', text: `could not start: ${error.message}` })
      setStatus(registered.id, 'exited')
    })
    return registered
  }

  const messages: MethodHandler = async (params) => {
    const session = await requireStructured(params.session as string)
    return journal.list(session.id, (params.afterSeq as number | undefined) ?? 0)
  }

  const send: MethodHandler = async (params) => {
    const session = await requireStructured(params.session as string)
    await runner.send(session.id, params.text as string)
    return { ok: true }
  }

  context.provide('method:quirky.structured/create', create)
  context.provide('method:quirky.structured/messages', messages)
  context.provide('method:quirky.structured/send', send)

  const cancelAsk = async (askId: string): Promise<void> => {
    try {
      await context.call('quirky.ask/cancel', { askId })
    } catch {
      // the host revokes the context before deactivate runs, so a cancel there can only fail
    }
  }

  const release = async (sessionId: string): Promise<void> => {
    await Promise.all([...(pendingAsks.get(sessionId) ?? [])].map(cancelAsk))
    await runner.stop(sessionId).catch(() => undefined)
  }

  context.subscribe(async (event) => {
    if (event.type !== 'quirky.session/removed') return
    const sessionId = (event.data as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string') return
    // forgotten first so the runner's closing status report is not sent for a session that is gone
    live.delete(sessionId)
    await release(sessionId)
    journal.remove(sessionId)
  })

  shutdown = async () => {
    const sessionIds = [...live.keys()]
    live.clear()
    await Promise.all(sessionIds.map(release))
  }
}

/** Stops every live runner and cancels its pending asks; the host closes the store afterwards. */
export async function deactivate(): Promise<void> {
  const stop = shutdown
  shutdown = undefined
  await stop?.()
}
