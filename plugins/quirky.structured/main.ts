import type {
  Ask,
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
import type { NewStructuredMessage, StructuredContext, StructuredRunner, StructuredRunnerFactory } from './runner'

const CLAUDE_TITLE = 'Claude'
const NOTIFICATIONS_SETTING = 'setting:quirky.agent-status/notifications'

type LiveSession = { title: string; worktreeId: string; worktreeName: string; status: SessionStatus }

/** Tests replace the Claude runner by publishing a factory here before the daemon starts. */
function testRunnerFactory(): StructuredRunnerFactory | undefined {
  return (globalThis as { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }).__QUIRKY_TEST_STRUCTURED_RUNNER__
}

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
    context.emit('message', { message })
    return message
  }

  const notifyEnabled = (): boolean => {
    try {
      return context.getSetting(NOTIFICATIONS_SETTING) !== false
    } catch {
      return true
    }
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
    context.notify({
      title: entry.worktreeName,
      body: status === 'done' ? `${entry.title} finished` : `${entry.title} needs input`,
      sessionId,
      worktreeId: entry.worktreeId,
      open: { view: 'view:quirky.session/worktree', input: { worktree: entry.worktreeId, session: sessionId } },
      desktop: notifyEnabled()
    })
  }

  const createAsk = async (spec: AskSpec, sessionId: string): Promise<AskEnvelope> => {
    const worktreeId = live.get(sessionId)?.worktreeId
    const ask = (await context.call('quirky.ask/create', {
      spec,
      session: sessionId,
      ...(worktreeId ? { worktree: worktreeId } : {})
    })) as Ask
    const pending = pendingAsks.get(sessionId) ?? new Set<string>()
    pendingAsks.set(sessionId, pending)
    pending.add(ask.id)
    try {
      // the ask plugin caps one wait, so a prompt left open longer is waited on again
      for (;;) {
        const envelope = (await context.call('quirky.ask/wait', { askId: ask.id })) as AskEnvelope
        if (envelope.status !== 'pending') return envelope
      }
    } finally {
      pending.delete(ask.id)
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

  const create: MethodHandler = async (params, caller) => {
    if (params.agent !== 'claude') {
      throw context.error('invalid-params', 'structured sessions support only the claude agent')
    }
    const worktree = await resolveWorktree(params.worktree, caller)
    const title = await nextTitle(worktree.id)
    const registered = (await context.call('quirky.session/register', {
      worktree: worktree.id,
      agent: 'claude',
      kind: 'structured',
      title
    })) as Session
    live.set(registered.id, { title, worktreeId: worktree.id, worktreeName: worktree.name, status: registered.status })
    runner.start({ ...registered, cwd: worktree.path }, params.prompt as string).catch((error: Error) => {
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

  context.subscribe(async (event) => {
    if (event.type !== 'quirky.session/removed') return
    const sessionId = (event.data as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string') return
    // forgotten first so the runner's closing status report is not sent for a session that is gone
    live.delete(sessionId)
    await Promise.all(
      [...(pendingAsks.get(sessionId) ?? [])].map((askId) =>
        context.call('quirky.ask/cancel', { askId }).catch(() => undefined)
      )
    )
    await runner.stop(sessionId).catch(() => undefined)
    journal.remove(sessionId)
  })
}
