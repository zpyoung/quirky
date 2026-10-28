import type { Ask, AskEnvelope, Session, SessionStatus, Worktree } from '@quirky/protocol'

const WORKTREE_DEFAULTS = {
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null
} as const

type PluginCtx = { error(kind: 'invalid-params' | 'not-found' | 'conflict', message: string): Error }

type FakeAccountPreparation = {
  env: Record<string, string | null>
  shellInit: string | null
  account: { provider: 'claude' | 'codex'; id: string | null; label: string; source: 'managed' | 'default' | 'custom' } | null
  resumeTranscriptPath?: string
}

/**
 * The in-memory state behind the fake `quirky.session`, `quirky.worktree` and `quirky.ask`
 * plugins. Tests publish an instance on `globalThis.__structuredFakes` before the daemon starts.
 */
export class FakeWorld {
  readonly worktree: Worktree = {
    id: 'wt_1',
    repoId: 'r_1',
    path: '/fake/alpha',
    branch: 'main',
    head: 'abc123',
    isMain: true,
    kind: 'git',
    name: 'main',
    ...WORKTREE_DEFAULTS
  }
  readonly sessions = new Map<string, Session>()
  readonly statusLog: { sessionId: string; status: SessionStatus }[] = []
  readonly resolveCalls: Record<string, unknown>[] = []
  readonly registerCalls: Record<string, unknown>[] = []
  readonly resolveLaunchCalls: Record<string, unknown>[] = []
  readonly askCreateCalls: Record<string, unknown>[] = []
  readonly planCalls: Record<string, unknown>[] = []
  readonly accountPrepareCalls: Record<string, unknown>[] = []
  agentPlanEnv: Record<string, string | null> = {}
  accountPreparationResult: FakeAccountPreparation = { env: {}, shellInit: null, account: null }
  accountPreparationFailure: string | null = null
  /** Replaces the fake `quirky.agents/resolveLaunch` answer; it may throw to refuse the pick. */
  resolveLaunchOverride: ((params: Record<string, unknown>, context: PluginCtx) => unknown) | null = null
  readonly asks = new Map<string, Ask>()
  /** How long a fake `wait` holds before returning the ask still pending. */
  askWaitCapMs = 25
  emitRemoved: (sessionId: string) => void = () => {}
  private nextSession = 1
  private nextAsk = 1
  private readonly waiters = new Map<string, Set<() => void>>()

  readonly session = {
    register: (params: any, context: PluginCtx) => {
      this.registerCalls.push(params)
      this.resolveWorktree({ selector: params.worktree }, context)
      const now = Date.now()
      const session: Session = {
        id: `s_${this.nextSession++}`,
        kind: params.kind,
        agent: params.agent,
        worktreeId: this.worktree.id,
        cwd: params.cwd ?? this.worktree.path,
        title: params.title,
        status: 'starting',
        createdAt: now,
        lastActivityAt: now,
        exitCode: null,
        exitSignal: null,
        exitCause: null,
        restorable: false,
        launchSettings: params.launchSettings ?? null,
        providerSession: null,
        resumedFrom: params.resumedFrom ?? null
      }
      this.sessions.set(session.id, session)
      return session
    },
    setStatus: (params: any, context: PluginCtx) => {
      const session = this.require(params.session, context)
      this.statusLog.push({ sessionId: session.id, status: params.status })
      session.status = params.status
      return session
    },
    setProviderSession: (params: Record<string, unknown>, context: PluginCtx) => {
      if (typeof params.session !== 'string') throw context.error('invalid-params', 'session must be a string')
      const session = this.require(params.session, context)
      const id = params.id
      if (typeof id !== 'string') throw context.error('invalid-params', 'id must be a string')
      if (id.length === 0) throw context.error('invalid-params', "provider session id can't be empty")
      if (id.length > 512) {
        throw context.error('invalid-params', "provider session id can't be longer than 512 characters")
      }
      if (id.startsWith('-')) throw context.error('invalid-params', "provider session id can't start with '-'")
      if (/[\x00-\x1f\x7f-\x9f]/.test(id)) {
        throw context.error('invalid-params', "provider session id can't contain control characters")
      }
      const transcriptPath = params.transcriptPath
      if (transcriptPath !== undefined && typeof transcriptPath !== 'string') {
        throw context.error('invalid-params', 'transcriptPath must be a string')
      }
      const updated: Session = {
        ...session,
        providerSession: { id, transcriptPath: transcriptPath ?? null }
      }
      this.sessions.set(updated.id, updated)
      return updated
    },
    get: (params: any, context: PluginCtx) => this.require(params.session, context),
    list: (params: any) =>
      [...this.sessions.values()].filter((s) => params.worktree === undefined || s.worktreeId === this.worktree.id),
    close: (params: any, context: PluginCtx) => {
      this.require(params.session, context)
      this.sessions.delete(params.session)
      this.emitRemoved(params.session)
      return { ok: true }
    }
  }

  readonly agents = {
    resolveLaunch: (params: Record<string, unknown>, context: PluginCtx) => {
      this.resolveLaunchCalls.push(params)
      if (this.resolveLaunchOverride) return this.resolveLaunchOverride(params, context)
      const structured: Record<string, string | boolean> = {}
      const model = params.model
      if (typeof model === 'string' || typeof model === 'boolean') structured.model = model
      const options = params.options
      if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
        for (const key of Object.keys(options)) {
          const value = Reflect.get(options, key)
          if (typeof value === 'string' || typeof value === 'boolean') structured[key] = value
        }
      }
      return { added: [], args: '', structured, shadowed: [], launchSettings: null }
    },
    plan: (params: Record<string, unknown>) => {
      this.planCalls.push(params)
      const env = { ...this.agentPlanEnv }
      const record = { command: 'claude', args: '', env }
      return { agent: 'claude', command: 'claude', env, record, promptDelivery: null, paste: null, launchSettings: null }
    }
  }

  prepareAccount(params: Record<string, unknown>, context: PluginCtx): FakeAccountPreparation {
    this.accountPrepareCalls.push(params)
    if (this.accountPreparationFailure !== null) throw context.error('conflict', this.accountPreparationFailure)
    const result = { ...this.accountPreparationResult, env: { ...this.accountPreparationResult.env } }
    if (params.resume === undefined) delete result.resumeTranscriptPath
    return result
  }

  readonly ask = {
    create: (params: any) => {
      this.askCreateCalls.push(params)
      const id = `ask_${this.nextAsk++}`
      const ask: Ask = {
        id,
        spec: params.spec,
        sessionId: params.session ?? null,
        worktreeId: params.worktree ?? null,
        createdAt: Date.now(),
        envelope: { status: 'pending', askId: id, answers: {}, skipped: [], summary: '' },
        seq: 0,
        queued: false,
        partial: {},
        expiresAt: null
      }
      this.asks.set(id, ask)
      return { askId: id }
    },
    wait: async (params: any, context: PluginCtx): Promise<AskEnvelope> => {
      const ask = this.requireAsk(params.askId, context)
      if (ask.envelope.status !== 'pending') return ask.envelope
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.askWaitCapMs)
        const waiters = this.waiters.get(ask.id) ?? new Set()
        this.waiters.set(ask.id, waiters)
        function done() {
          clearTimeout(timer)
          resolve()
        }
        waiters.add(done)
      })
      return ask.envelope
    },
    answer: (params: any, context: PluginCtx) =>
      this.settle(this.requireAsk(params.askId, context), 'answered', params.answers ?? {}),
    cancel: (params: any, context: PluginCtx) => this.settle(this.requireAsk(params.askId, context), 'declined', {}),
    list: (params: any) =>
      [...this.asks.values()].filter((ask) => !params.pendingOnly || ask.envelope.status === 'pending')
  }

  resolveWorktree(params: any, context: PluginCtx): Worktree {
    this.resolveCalls.push(params)
    const selector = params.selector
    if (selector === 'current' || selector === this.worktree.id || selector === this.worktree.name ||
      selector === `id:${this.worktree.id}` || selector === `path:${this.worktree.path}`) return this.worktree
    throw context.error('not-found', `no worktree matches ${selector}`)
  }

  /** Adds a terminal session the structured plugin must refuse to treat as its own. */
  addTerminalSession(): Session {
    const session: Session = {
      id: `s_${this.nextSession++}`,
      kind: 'terminal',
      agent: 'shell',
      worktreeId: this.worktree.id,
      cwd: this.worktree.path,
      title: 'Shell',
      status: 'running',
      createdAt: 1,
      lastActivityAt: 1,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false
    }
    this.sessions.set(session.id, session)
    return session
  }

  /** Adds a structured session record, as if an earlier daemon had registered it. */
  addStructuredSession(id: string): Session {
    const session: Session = { ...this.addTerminalSession(), id, kind: 'structured', agent: 'claude', title: 'Claude' }
    this.sessions.set(id, session)
    return session
  }

  private settle(ask: Ask, status: AskEnvelope['status'], answers: AskEnvelope['answers']): AskEnvelope {
    ask.envelope = { status, askId: ask.id, answers, skipped: [], summary: '' }
    for (const wake of this.waiters.get(ask.id) ?? []) wake()
    this.waiters.delete(ask.id)
    return ask.envelope
  }

  private require(id: string, context: PluginCtx): Session {
    const session = this.sessions.get(id)
    if (!session) throw context.error('not-found', `no such session: ${id}`)
    return session
  }

  private requireAsk(id: string, context: PluginCtx): Ask {
    const ask = this.asks.get(id)
    if (!ask) throw context.error('not-found', `no such ask: ${id}`)
    return ask
  }
}
