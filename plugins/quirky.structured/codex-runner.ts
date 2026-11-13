import type { AskEnvelope, AskSpec, Session, SessionProviderSession } from '@quirky/protocol'
import { CodexConnection, type CodexRpcId, type CodexRpcMessage } from './codex-connection'
import type { StructuredContext, StructuredLaunchOptions, StructuredRunner, StructuredStartOptions, ToolPolicy, TurnUsage } from './runner'
import { nativeQuestionAnswers, nativeQuestionPlan, type NativeQuestionPlan } from './native-questions'

const CLIENT_INFO = { name: 'quirky', title: 'Quirky', version: '0.1.0' }
const APPROVAL_POLICY = 'on-request'
const SANDBOX = 'workspace-write'
const DENY_ALL_APPROVAL_POLICY = 'untrusted'
const DENY_ALL_SANDBOX = 'read-only'
const TOOLS_DISABLED = 'tools are disabled for this session'
const MCP_CONFIG_FAILURE = "could not read Codex's MCP servers, so a session without tools can't start"
const TOOL_STOP_FAILURE = 'could not stop a tool in a session without tools'
const DENY_ALL_SERVER_ARGS = [
  ...[
    'shell_tool',
    'unified_exec',
    'view_image',
    'sleep_tool',
    'apps',
    'plugins',
    'browser_use',
    'computer_use',
    'in_app_browser',
    'image_generation',
    'multi_agent',
    'multi_agent_v2',
    'goals'
  ].flatMap((feature) => ['--disable', feature]),
  '-c',
  'web_search="disabled"'
]
const NON_TOOL_ITEM_TYPES: Record<string, true> = {
  userMessage: true,
  agentMessage: true,
  reasoning: true,
  plan: true,
  hookPrompt: true,
  contextCompaction: true,
  enteredReviewMode: true,
  exitedReviewMode: true
}
const INTERRUPT_TIMEOUT_MS = 1_000
const MAX_DEFERRED_EVENTS = 512
const SUMMARY_LIMIT = 180

function environmentWithPatch(base: NodeJS.ProcessEnv, patch?: Record<string, string | null>): NodeJS.ProcessEnv {
  if (patch === undefined) return base
  const env = { ...base }
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete env[name]
    else env[name] = value
  }
  return env
}

type DeferredEvent =
  | { kind: 'notification'; message: CodexRpcMessage }
  | { kind: 'request'; request: { id: CodexRpcId; method: string; params: unknown } }

type PendingCompletion = { status: string; turn: Record<string, unknown> }
type TokenCounts = Partial<Record<'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningOutputTokens', number>>

function tokenCounts(value: unknown): TokenCounts | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const counts: TokenCounts = {}
  for (const [key, camel, snake] of [
    ['inputTokens', 'inputTokens', 'input_tokens'],
    ['outputTokens', 'outputTokens', 'output_tokens'],
    ['cachedInputTokens', 'cachedInputTokens', 'cached_input_tokens'],
    ['reasoningOutputTokens', 'reasoningOutputTokens', 'reasoning_output_tokens']
  ] as const) {
    const count = source[camel] ?? source[snake]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[key] = count
  }
  return Object.keys(counts).length === 0 ? null : counts
}

function tokenUsageDelta(total: TokenCounts, baseline: TokenCounts | null): TokenCounts | null {
  if (baseline === null) return null
  const delta: TokenCounts = {}
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const) {
    const current = total[key]
    const before = baseline[key] ?? 0
    if (current !== undefined && current >= before) delta[key] = current - before
  }
  return Object.keys(delta).length === 0 ? null : delta
}

function turnContextUsage(update: Record<string, unknown>, last: TokenCounts | null, delta: TokenCounts | null): TurnUsage | null {
  const counts = last ?? delta
  if (counts === null) return null
  const window = update.modelContextWindow ?? update.model_context_window
  return {
    contextTokens: (counts.inputTokens ?? 0) + (counts.outputTokens ?? 0),
    contextWindow: typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null
  }
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

type DisabledMcpServers = { mcp_servers: Record<string, { enabled: false }> }

async function readDisabledMcpServers(
  connection: CodexConnection,
  cwd: string,
  timeoutMs?: number
): Promise<DisabledMcpServers | undefined> {
  try {
    const response = await connection.request('config/read', { cwd }, timeoutMs)
    if (!isPlainMap(response) || !Object.hasOwn(response, 'config')) throw new Error()
    const config = response.config
    if (!isPlainMap(config)) throw new Error()
    const servers = Object.hasOwn(config, 'mcp_servers') ? config.mcp_servers : undefined
    if (servers === undefined || servers === null) return undefined
    if (!isPlainMap(servers)) throw new Error()
    const names = Object.keys(servers)
    if (names.length === 0) return undefined
    return {
      mcp_servers: Object.fromEntries(names.map((name) => [name, { enabled: false }] as const))
    }
  } catch {
    throw new Error(MCP_CONFIG_FAILURE)
  }
}

type Running = {
  sessionId: string
  toolPolicy: ToolPolicy
  turnUsage: TurnUsage | null
  threadId: string
  connection: CodexConnection
  options: StructuredLaunchOptions
  totalTokenUsage: TokenCounts | null
  turnUsageBaseline: TokenCounts | null
  activeTurnId: string | null
  refusedTurnId: string | null
  readingMcpConfig: boolean
  pendingToolInterrupts: number
  pendingApprovalCount: number
  pendingCompletion: PendingCompletion | null
  inputQueue: Promise<void>
  inputPending: boolean
  deferred: DeferredEvent[]
  assistantDeltas: Map<string, string>
  emittedAssistantIds: Set<string>
  emittedToolIds: Set<string>
  toolOutput: Map<string, string>
  startupFailure: Error | null
  ready: boolean
  failed: boolean
  stopped: boolean
}

type Starting = { stopped: boolean; connection?: CodexConnection; run?: Running }

export type CodexRunnerDeps = {
  /** A per-run child environment for isolated process tests. Production inherits the daemon environment. */
  env?: NodeJS.ProcessEnv
  /** How long a session without tools waits for Codex's `config/read` reply. A test may lower it. Default: 15 seconds. */
  configReadTimeoutMs?: number
}

/** Runs Codex as a native JSONL app-server conversation without allocating a terminal. */
export function createCodexRunner(context: StructuredContext, deps: CodexRunnerDeps = {}): StructuredRunner {
  return new CodexRunner(context, deps)
}

class CodexRunner implements StructuredRunner {
  private readonly running = new Map<string, Running>()
  private readonly starting = new Map<string, Starting>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  constructor(
    private readonly context: StructuredContext,
    private readonly deps: CodexRunnerDeps
  ) {}

  async start(session: Session, prompt?: string, startOptions: StructuredStartOptions = {}): Promise<void> {
    if (session.agent !== 'codex') throw new Error('structured sessions support codex only')
    const providerSession = startOptions.providerSession
    if (this.running.has(session.id) || this.starting.has(session.id)) throw new Error('session is already connected')

    const startup: Starting = { stopped: false }
    this.starting.set(session.id, startup)
    try {
      const executable = await this.context.resolveCodexPath()
      if (startup.stopped) return
      const options: StructuredLaunchOptions = {
        ...(typeof startOptions.model === 'string' ? { model: startOptions.model } : {}),
        ...(typeof startOptions.effort === 'string' ? { effort: startOptions.effort } : {})
      }
      const toolPolicy = startOptions.toolPolicy ?? 'default'
      const approvalPolicy = toolPolicy === 'deny-all' ? DENY_ALL_APPROVAL_POLICY : APPROVAL_POLICY
      const sandbox = toolPolicy === 'deny-all' ? DENY_ALL_SANDBOX : SANDBOX
      const run = this.createRun(session, executable, providerSession?.id ?? '', options, startOptions.env, toolPolicy)
      startup.run = run
      startup.connection = run.connection
      const connection = run.connection
      await connection.request('initialize', { clientInfo: CLIENT_INFO })
      if (startup.stopped) return
      connection.notify('initialized', {})
      let threadConfig: DisabledMcpServers | undefined
      if (toolPolicy === 'deny-all') {
        run.readingMcpConfig = true
        try {
          threadConfig = await readDisabledMcpServers(connection, session.cwd, this.deps.configReadTimeoutMs)
        } finally {
          run.readingMcpConfig = false
        }
      }
      if (startup.stopped) return

      if (providerSession) {
        run.threadId = providerSession.id
        const response = await connection.request('thread/resume', {
          threadId: providerSession.id,
          cwd: session.cwd,
          approvalPolicy,
          sandbox,
          ...(threadConfig === undefined ? {} : { config: threadConfig }),
          excludeTurns: true,
          ...(options.model === undefined ? {} : { model: options.model })
        })
        const resumedThreadId = this.threadIdFromResponse(response, 'thread/resume')
        if (resumedThreadId !== providerSession.id) {
          throw new Error(`Codex resumed thread ${resumedThreadId}, expected ${providerSession.id}`)
        }
        await this.context.setProviderSession(session.id, {
          id: resumedThreadId,
          transcriptPath: providerSession.transcriptPath ?? null
        })
      } else {
        const response = await connection.request('thread/start', {
          cwd: session.cwd,
          approvalPolicy,
          sandbox,
          ...(threadConfig === undefined ? {} : { config: threadConfig }),
          ...(options.model === undefined ? {} : { model: options.model })
        })
        run.threadId = this.threadIdFromResponse(response, 'thread/start')
        await this.context.setProviderSession(session.id, { id: run.threadId, transcriptPath: null })
      }
      if (startup.stopped) return
      if (run.startupFailure) throw run.startupFailure
      this.running.set(session.id, run)

      if (prompt === undefined || prompt === '') {
        run.ready = true
        this.context.setStatus(session.id, 'running')
        this.flushDeferred(run)
      } else {
        await this.submitInput(run, prompt, true)
        if (run.startupFailure) throw run.startupFailure
        if (startup.stopped) return
        run.ready = true
        this.flushDeferred(run)
      }
    } catch (error) {
      const run = startup.run
      if (run) this.running.delete(session.id)
      await startup.connection?.close()
      if (startup.stopped) return
      const failure = run?.startupFailure ?? (error instanceof Error ? error : new Error(String(error)))
      const stderrTail = startup.connection?.stderrTail
      if (!stderrTail) throw failure
      throw new Error(`${failure.message}; stderr: ${stderrTail}`, { cause: failure })
    } finally {
      if (this.starting.get(session.id) === startup) this.starting.delete(session.id)
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.failed || !run.ready) throw new Error('session is not running')
    const operation = run.inputQueue.then(() => this.submitInput(run, text))
    run.inputQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async stop(sessionId: string): Promise<void> {
    const inFlight = this.stopping.get(sessionId)
    if (inFlight) {
      await inFlight
      return
    }
    const startup = this.starting.get(sessionId)
    if (startup) startup.stopped = true
    const run = this.running.get(sessionId) ?? startup?.run
    if (!run) {
      await startup?.connection?.close()
      await this.closing.get(sessionId)
      return
    }
    if (run.stopped) {
      await this.closing.get(sessionId)
      return
    }
    run.stopped = true
    this.running.delete(sessionId)
    const stopping = this.stopRun(run)
    this.stopping.set(sessionId, stopping)
    try {
      await stopping
    } finally {
      if (this.stopping.get(sessionId) === stopping) this.stopping.delete(sessionId)
    }
  }

  private async stopRun(run: Running): Promise<void> {
    if (run.activeTurnId !== null && !run.pendingCompletion) {
      try {
        await run.connection.request(
          'turn/interrupt',
          { threadId: run.threadId, turnId: run.activeTurnId },
          INTERRUPT_TIMEOUT_MS
        )
      } catch {
        // Closing the process group below is the bounded fallback for an unresponsive interrupt.
      }
    }
    await this.closeRun(run)
    if (run.ready) this.context.setStatus(run.sessionId, 'exited')
  }

  private closeRun(run: Running): Promise<void> {
    const existing = this.closing.get(run.sessionId)
    if (existing) return existing
    const cleanup = run.connection.close()
    this.closing.set(run.sessionId, cleanup)
    void cleanup.then(
      () => {
        if (this.closing.get(run.sessionId) === cleanup) this.closing.delete(run.sessionId)
      },
      () => {
        if (this.closing.get(run.sessionId) === cleanup) this.closing.delete(run.sessionId)
      }
    )
    return cleanup
  }

  private createRun(
    session: Session,
    executable: string,
    threadId: string,
    options: StructuredLaunchOptions,
    envPatch?: Record<string, string | null>,
    toolPolicy: ToolPolicy = 'default'
  ): Running {
    let run!: Running
    const connection = new CodexConnection(
      executable,
      session.cwd,
      environmentWithPatch(this.deps.env ?? process.env, envPatch),
      {
        notification: (message) => this.onNotification(run, message),
        serverRequest: (request) => this.onServerRequest(run, request),
        failure: (error) => this.onFailure(run, error)
      },
      toolPolicy === 'deny-all' ? DENY_ALL_SERVER_ARGS : []
    )
    run = {
      sessionId: session.id,
      toolPolicy,
      turnUsage: null,
      threadId,
      connection,
      options,
      totalTokenUsage: null,
      turnUsageBaseline: threadId === '' ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } : null,
      activeTurnId: null,
      refusedTurnId: null,
      readingMcpConfig: false,
      pendingToolInterrupts: 0,
      pendingApprovalCount: 0,
      pendingCompletion: null,
      inputQueue: Promise.resolve(),
      inputPending: false,
      deferred: [],
      assistantDeltas: new Map(),
      emittedAssistantIds: new Set(),
      emittedToolIds: new Set(),
      toolOutput: new Map(),
      startupFailure: null,
      ready: false,
      failed: false,
      stopped: false
    }
    return run
  }

  private threadIdFromResponse(response: unknown, method: string): string {
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      throw new Error(`Codex app-server ${method} returned an invalid response`)
    }
    const thread = (response as Record<string, unknown>).thread
    if (typeof thread !== 'object' || thread === null || Array.isArray(thread)) {
      throw new Error(`Codex app-server ${method} returned no thread`)
    }
    const id = (thread as Record<string, unknown>).id
    if (typeof id !== 'string' || id.length === 0) throw new Error(`Codex app-server ${method} returned an invalid thread ID`)
    return id
  }

  private async submitInput(run: Running, text: string, deferEventsUntilReady = false): Promise<void> {
    if (run.stopped || run.failed || !run.ready && !this.starting.has(run.sessionId)) {
      throw new Error('session is not running')
    }
    if (run.pendingApprovalCount > 0 || run.pendingCompletion) throw new Error('session is waiting for approval')
    const expectedTurnId = run.activeTurnId
    const method = expectedTurnId === null ? 'turn/start' : 'turn/steer'
    const params =
      method === 'turn/start'
        ? {
            threadId: run.threadId,
            input: [{ type: 'text', text }],
            ...(run.options.model === undefined ? {} : { model: run.options.model }),
            ...(run.options.effort === undefined ? {} : { effort: run.options.effort })
          }
        : {
            threadId: run.threadId,
            input: [{ type: 'text', text }],
            expectedTurnId
          }
    if (run.totalTokenUsage !== null) run.turnUsageBaseline = { ...run.totalTokenUsage }
    run.inputPending = true
    try {
      const response = await run.connection.request(method, params)
      if (run.stopped || run.failed) throw run.startupFailure ?? new Error('session is not running')
      if (method === 'turn/start') {
        if (typeof response !== 'object' || response === null || Array.isArray(response)) {
          throw new Error('Codex app-server turn/start returned an invalid response')
        }
        const turn = (response as Record<string, unknown>).turn
        if (typeof turn !== 'object' || turn === null || Array.isArray(turn)) {
          throw new Error('Codex app-server turn/start returned no turn')
        }
        const turnId = (turn as Record<string, unknown>).id
        if (typeof turnId !== 'string' || turnId.length === 0) throw new Error('Codex app-server turn/start returned an invalid turn ID')
        run.activeTurnId = turnId
      } else {
        if (typeof response !== 'object' || response === null || Array.isArray(response)) {
          throw new Error('Codex app-server turn/steer returned an invalid response')
        }
        const turnId = (response as Record<string, unknown>).turnId
        if (turnId !== expectedTurnId) throw new Error('Codex app-server turn/steer accepted a different turn ID')
      }
      this.context.appendMessage({
        sessionId: run.sessionId,
        role: 'user',
        text,
        data: { method, threadId: run.threadId, ...(expectedTurnId ? { expectedTurnId } : {}) }
      })
      this.context.setStatus(run.sessionId, 'working')
      run.inputPending = false
      if (!deferEventsUntilReady) this.flushDeferred(run)
    } catch (error) {
      run.inputPending = false
      run.deferred = []
      if (run.ready && !run.stopped) this.failRun(run, error instanceof Error ? error : new Error(String(error)))
      else run.startupFailure ??= error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }

  private onNotification(run: Running, message: CodexRpcMessage): void {
    if (run.stopped || run.failed) return
    if (run.inputPending) {
      this.defer(run, { kind: 'notification', message })
      return
    }
    this.handleNotification(run, message)
  }

  private onServerRequest(
    run: Running,
    request: { id: CodexRpcId; method: string; params: unknown }
  ): void {
    if (run.stopped || run.failed) return
    if (run.inputPending) {
      this.defer(run, { kind: 'request', request })
      return
    }
    void this.handleServerRequest(run, request).catch((error: unknown) =>
      this.failRun(run, error instanceof Error ? error : new Error(String(error)))
    )
  }

  private defer(run: Running, event: DeferredEvent): void {
    if (run.deferred.length >= MAX_DEFERRED_EVENTS) {
      this.failRun(run, new Error('Codex app-server sent too many events before accepting input'))
      return
    }
    run.deferred.push(event)
  }

  private flushDeferred(run: Running): void {
    while (run.deferred.length > 0 && !run.stopped && !run.failed) {
      const event = run.deferred.shift()!
      if (event.kind === 'notification') this.handleNotification(run, event.message)
      else {
        void this.handleServerRequest(run, event.request).catch((error: unknown) =>
          this.failRun(run, error instanceof Error ? error : new Error(String(error)))
        )
      }
    }
  }

  private handleNotification(run: Running, message: CodexRpcMessage): void {
    const method = message.method
    const rawParams = message.params
    if (typeof method !== 'string' || typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) return
    const params = rawParams as Record<string, unknown>
    const foreignThread = typeof params.threadId === 'string' && params.threadId !== run.threadId
    if (run.toolPolicy === 'deny-all') {
      if (foreignThread && (method === 'item/started' || method === 'item/completed' || method === 'turn/started')) {
        this.refuseSecondAgent(run, params)
        return
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item
        if (isPlainMap(item) && (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity')) {
          this.refuseSecondAgent(run, item)
          return
        }
      }
    }
    if (foreignThread) return

    switch (method) {
      case 'thread/tokenUsage/updated': {
        const rawUsage = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>).tokenUsage
          : undefined
        if (typeof rawUsage !== 'object' || rawUsage === null || Array.isArray(rawUsage)) return
        const usage = rawUsage as Record<string, unknown>
        const total = tokenCounts(usage.total)
        const last = tokenCounts(usage.last)
        if (total) run.totalTokenUsage = total
        const turnUsage = last ?? (total ? tokenUsageDelta(total, run.turnUsageBaseline) : null)
        run.turnUsage = turnContextUsage(usage, last, turnUsage) ?? run.turnUsage
        this.context.appendMessage({
          sessionId: run.sessionId,
          role: 'system',
          text: 'Codex token usage updated',
          data: {
            type: 'thread/tokenUsage/updated',
            tokenUsage: rawUsage,
            ...(turnUsage ? { turnUsage } : {})
          }
        })
        return
      }
      case 'account/rateLimits/updated':
        this.context.appendMessage({
          sessionId: run.sessionId,
          role: 'system',
          text: 'Codex account rate limits updated',
          data: { method, params: rawParams }
        })
        return
      case 'turn/started': {
        const turn = params.turn
        if (typeof turn !== 'object' || turn === null || Array.isArray(turn)) return
        const id = (turn as Record<string, unknown>).id
        if (typeof id === 'string' && id.length > 0) run.activeTurnId = id
        return
      }
      case 'turn/completed': {
        const turn = params.turn
        if (typeof turn !== 'object' || turn === null || Array.isArray(turn)) return
        this.completeTurnNotification(run, turn as Record<string, unknown>)
        return
      }
      case 'item/agentMessage/delta': {
        const itemId = params.itemId
        const delta = params.delta
        if (typeof itemId !== 'string' || typeof delta !== 'string') return
        run.assistantDeltas.set(itemId, (run.assistantDeltas.get(itemId) ?? '') + delta)
        return
      }
      case 'item/started': {
        const item = params.item
        if (run.toolPolicy === 'deny-all' && isPlainMap(item)) {
          const type = item.type
          if (typeof type !== 'string' || !Object.hasOwn(NON_TOOL_ITEM_TYPES, type)) this.refuseToolItem(run, params, item)
        }
        return
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = params.itemId
        const delta = params.delta
        if (typeof itemId !== 'string' || typeof delta !== 'string') return
        run.toolOutput.set(itemId, (run.toolOutput.get(itemId) ?? '') + delta)
        return
      }
      case 'item/completed': {
        const item = params.item
        if (!isPlainMap(item)) return
        const type = item.type
        if (run.toolPolicy === 'deny-all' && (typeof type !== 'string' || !Object.hasOwn(NON_TOOL_ITEM_TYPES, type))) {
          this.refuseToolItem(run, params, item)
        }
        this.journalItem(run, item)
        return
      }
      case 'error': {
        const error = params.error
        const message =
          typeof error === 'object' && error !== null && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === 'string'
            ? (error as Record<string, unknown>).message as string
            : 'Codex reported an unspecified error'
        this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: `Codex error: ${message}`, data: message })
        return
      }
    }
  }

  private completeTurnNotification(run: Running, turn: Record<string, unknown>): void {
    const turnId = turn.id
    if (typeof turnId !== 'string' || (run.activeTurnId !== null && turnId !== run.activeTurnId)) return
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) this.journalItem(run, item as Record<string, unknown>)
      }
    }
    const status = turn.status
    if (status === 'interrupted' && run.refusedTurnId === turnId) {
      run.activeTurnId = null
      this.finishCompletedTurn(run, turn)
      return
    }
    if (status === 'completed') {
      run.activeTurnId = null
      if (run.pendingApprovalCount > 0) {
        run.pendingCompletion = { status, turn }
        this.context.setStatus(run.sessionId, 'waiting')
        return
      }
      this.finishCompletedTurn(run, turn)
      return
    }
    const detail =
      typeof turn.error === 'object' && turn.error !== null && !Array.isArray(turn.error) && typeof (turn.error as Record<string, unknown>).message === 'string'
        ? (turn.error as Record<string, unknown>).message as string
        : `turn ${status === 'interrupted' ? 'was interrupted' : `failed with status ${String(status)}`}`
    this.flushAssistantDeltas(run)
    this.failRun(run, new Error(`Codex ${detail}`))
  }

  private finishCompletedTurn(run: Running, turn: Record<string, unknown>): void {
    this.flushAssistantDeltas(run)
    run.pendingCompletion = null
    run.refusedTurnId = null
    const usage = run.turnUsage
    run.turnUsage = null
    this.context.appendMessage({
      sessionId: run.sessionId,
      role: 'result',
      text: 'Codex turn completed',
      data: usage ? { ...turn, contextUsage: usage } : turn
    })
    this.context.setStatus(run.sessionId, 'done')
    run.assistantDeltas.clear()
    run.emittedAssistantIds.clear()
    run.emittedToolIds.clear()
    run.toolOutput.clear()
  }

  private flushAssistantDeltas(run: Running): void {
    for (const [itemId, text] of run.assistantDeltas) {
      if (text.length === 0 || run.emittedAssistantIds.has(itemId)) continue
      this.context.appendMessage({
        sessionId: run.sessionId,
        role: 'assistant',
        text,
        data: { itemId, streamed: true }
      })
      run.emittedAssistantIds.add(itemId)
    }
  }

  /**
   * Ends a deny-all turn that started a tool anyway. The refusal is journaled once and the turn is
   * interrupted; its interrupted completion then settles the session as done, not failed.
   */
  private refuseToolItem(run: Running, params: Record<string, unknown>, item: object): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : run.activeTurnId
    if (turnId === null) {
      this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: TOOLS_DISABLED, data: item })
      this.failRun(run, new Error(TOOL_STOP_FAILURE))
      return
    }
    if (run.refusedTurnId === turnId) return
    run.refusedTurnId = turnId
    this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: TOOLS_DISABLED, data: item })
    run.pendingToolInterrupts++
    void run.connection
      .request('turn/interrupt', { threadId: run.threadId, turnId }, INTERRUPT_TIMEOUT_MS)
      .catch(() => this.failRun(run, new Error(TOOL_STOP_FAILURE)))
      .finally(() => { run.pendingToolInterrupts-- })
  }

  private refuseSecondAgent(run: Running, data: unknown): void {
    this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: TOOLS_DISABLED, data })
    this.failRun(run, new Error('Codex started a second agent in a session without tools'))
  }
  private journalItem(run: Running, item: Record<string, unknown>): void {
    const type = item.type
    const id = typeof item.id === 'string' ? item.id : undefined
    if (type === 'agentMessage') {
      if (id && run.emittedAssistantIds.has(id)) return
      const text = typeof item.text === 'string' ? item.text : (id ? run.assistantDeltas.get(id) : undefined) ?? ''
      if (text.length > 0) this.context.appendMessage({ sessionId: run.sessionId, role: 'assistant', text, data: item })
      if (id) run.emittedAssistantIds.add(id)
      return
    }
    if (type === 'commandExecution' || type === 'fileChange') {
      if (id && run.emittedToolIds.has(id)) return
      const output = id ? run.toolOutput.get(id) : undefined
      let summary: string
      if (type === 'commandExecution') {
        const command = typeof item.command === 'string' ? item.command : 'Codex command'
        summary = [command, typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : output].filter(Boolean).join('\n')
      } else {
        const changes = Array.isArray(item.changes)
          ? item.changes.map((change) => {
              if (typeof change !== 'object' || change === null || Array.isArray(change)) return ''
              const path = (change as Record<string, unknown>).path
              return typeof path === 'string' ? path : ''
            }).filter(Boolean).join('\n')
          : ''
        summary = changes ? `Codex file changes:\n${changes}` : 'Codex file change'
      }
      this.context.appendMessage({ sessionId: run.sessionId, role: 'tool', text: summary || String(type), data: item })
      if (id) run.emittedToolIds.add(id)
      return
    }
    if (typeof type === 'string' && type !== 'reasoning') {
      this.context.appendMessage({ sessionId: run.sessionId, role: 'tool', text: `Codex ${type}`, data: item })
    }
  }

  private async handleNativeQuestion(run: Running, request: { id: CodexRpcId; method: string; params: unknown }): Promise<void> {
    const params = request.params
    if (typeof params !== 'object' || params === null || !('threadId' in params) || !('turnId' in params) ||
      params.threadId !== run.threadId || params.turnId !== run.activeTurnId || run.activeTurnId === null) {
      run.connection.respondError(request.id, -32602, 'Native question does not belong to the active thread and turn')
      return
    }
    let plan: NativeQuestionPlan
    try {
      plan = nativeQuestionPlan(params, 'codex')
    } catch (error) {
      run.connection.respondError(request.id, -32602, error instanceof Error ? error.message : String(error))
      return
    }
    const threadId = run.threadId
    const turnId = run.activeTurnId
    run.pendingApprovalCount++
    this.context.setStatus(run.sessionId, 'waiting')
    try {
      let envelope: AskEnvelope | null = null
      try {
        envelope = await this.context.createAsk(plan.spec, run.sessionId, { nativeQuestion: true })
      } catch {
        // This question-only fallback is explicit non-answer text, never tool approval.
      }
      if (run.stopped || run.failed) return
      if (run.threadId !== threadId || run.activeTurnId !== turnId) {
        run.connection.respondError(request.id, -32000, 'Native question owner changed while awaiting an answer')
        return
      }
      const answers = Object.fromEntries(Object.entries(nativeQuestionAnswers(plan, envelope)).map(([id, values]) => [id, { answers: values }]))
      run.connection.respond(request.id, { answers })
    } finally {
      run.pendingApprovalCount--
      if (!run.stopped && !run.failed && run.pendingApprovalCount === 0) {
        if (run.pendingCompletion) this.finishCompletedTurn(run, run.pendingCompletion.turn)
        else if (run.activeTurnId !== null) this.context.setStatus(run.sessionId, 'working')
      }
    }
  }

  private async handleServerRequest(
    run: Running,
    request: { id: CodexRpcId; method: string; params: unknown }
  ): Promise<void> {
    if (run.toolPolicy === 'deny-all') {
      switch (request.method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          run.connection.respond(request.id, { decision: 'decline' })
          return
        case 'execCommandApproval':
        case 'applyPatchApproval':
          run.connection.respond(request.id, { decision: 'denied' })
          return
        case 'mcpServer/elicitation/request':
          run.connection.respond(request.id, { action: 'decline' })
          return
        case 'item/tool/requestUserInput':
          run.connection.respond(request.id, { answers: {} })
          return
        case 'item/tool/call':
          run.connection.respond(request.id, {
            success: false,
            contentItems: [{ type: 'inputText', text: TOOLS_DISABLED }]
          })
          return
        default:
          run.connection.respondError(request.id, -32601, `Method not found: ${request.method}`)
          return
      }
    }
    if (request.method === 'item/tool/requestUserInput') return this.handleNativeQuestion(run, request)
    if (request.method !== 'item/commandExecution/requestApproval' && request.method !== 'item/fileChange/requestApproval') {
      run.connection.respondError(request.id, -32601, `Method not found: ${request.method}`)
      return
    }
    if (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params)) {
      run.connection.respondError(request.id, -32602, 'Invalid approval request parameters')
      return
    }
    const params = request.params as Record<string, unknown>
    if (params.threadId !== run.threadId || typeof params.turnId !== 'string' || params.turnId !== run.activeTurnId) {
      run.connection.respond(request.id, { decision: 'decline' })
      return
    }

    run.pendingApprovalCount++
    this.context.setStatus(run.sessionId, 'waiting')
    const command = typeof params.command === 'string' ? params.command : ''
    const reason = typeof params.reason === 'string' ? params.reason : ''
    const summary = command.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT)
    const question =
      request.method === 'item/commandExecution/requestApproval'
        ? `Allow Codex to run ${summary || 'this command'}? ${reason}`.trim()
        : `Allow Codex to apply the proposed file changes? ${reason}`.trim()
    const spec: AskSpec = {
      questions: [
        {
          id: 'decision',
          type: 'select',
          question,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
            { value: 'always', label: 'Allow for this session' }
          ]
        }
      ]
    }
    let envelope: AskEnvelope | null = null
    try {
      envelope = await this.context.createAsk(spec, run.sessionId)
    } catch {
      envelope = null
    }
    const answer = envelope?.status === 'answered' ? envelope.answers.decision : undefined
    const value = answer && 'value' in answer ? answer.value : undefined
    const decision = value === 'allow' ? 'accept' : value === 'always' ? 'acceptForSession' : 'decline'
    try {
      if (!run.stopped && !run.failed) run.connection.respond(request.id, { decision })
    } catch (error) {
      this.failRun(run, error instanceof Error ? error : new Error(String(error)))
    } finally {
      run.pendingApprovalCount--
      if (!run.stopped && !run.failed && run.pendingApprovalCount === 0) {
        if (run.pendingCompletion) this.finishCompletedTurn(run, run.pendingCompletion.turn)
        else if (run.activeTurnId !== null) this.context.setStatus(run.sessionId, 'working')
      }
    }
  }

  private failRun(run: Running, error: Error): void {
    if (run.failed || run.stopped) return
    run.failed = true
    run.inputPending = false
    run.deferred = []
    this.running.delete(run.sessionId)
    if (!run.ready) {
      run.startupFailure = error
      return
    }
    this.context.appendMessage({
      sessionId: run.sessionId,
      role: 'system',
      text: `Codex app-server failed: ${error.message}${run.connection.stderrTail ? `; stderr: ${run.connection.stderrTail}` : ''}`
    })
    this.context.setStatus(run.sessionId, 'exited')
    void this.closeRun(run)
  }

  private onFailure(run: Running, error: Error): void {
    const failure = run.readingMcpConfig
      ? new Error(MCP_CONFIG_FAILURE)
      : run.pendingToolInterrupts > 0 ? new Error(TOOL_STOP_FAILURE) : error
    this.failRun(run, failure)
  }
}
