import type { AgentCommand, AskEnvelope, Session, SessionProviderSession } from '@quirky/protocol'
import { CodexConnection, type CodexRpcId, type CodexRpcMessage } from './codex-connection'
import {
  CallTracker,
  ProseStream,
  closingEntries,
  codexEntries,
  codexPlanEntry,
  errorItem,
  statusItem,
  stderrLines,
  turnEndItem,
  userItem,
  type ItemEntry
} from './items'
import { mentionsCommand, referencedCommands } from './slash-commands'
import type {
  StructuredContext,
  StructuredForkSource,
  StructuredLaunchOptions,
  StructuredRunner,
  StructuredSendOptions,
  StructuredSettings,
  StructuredStartOptions,
  ToolPolicy,
  TurnUsage
} from './runner'
import { approvalOutcome, approvalSpec, nativeQuestionAnswers, nativeQuestionPlan, type NativeQuestionPlan } from './native-questions'

const CLIENT_INFO = { name: 'quirky', title: 'Quirky', version: '0.1.0' }
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

type CodexPermissions = {
  approvalPolicy: 'on-request' | 'never' | 'untrusted'
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalsReviewer: 'user' | 'auto_review'
}

/** Internal mode of a `deny-all` session; no catalog capability offers it. */
const DENY_ALL_MODE = 'deny-all'

/** What each permission mode in the Codex capabilities asks of app-server, matching Codex's `/permissions` presets. */
const PERMISSIONS: Record<string, CodexPermissions> = {
  default: { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' },
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' },
  'auto-review': { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' },
  [DENY_ALL_MODE]: { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' }
}
const DEFAULT_PERMISSION_MODE = 'default'

const SANDBOX_POLICY_TYPES: Record<CodexPermissions['sandbox'], string> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess'
}

function permissionsFor(mode: string): CodexPermissions {
  const found = PERMISSIONS[mode]
  if (!found) throw new Error(`Codex has no permission mode ${mode}`)
  return found
}

/** The thread-level fields for `thread/start` and `thread/resume`; the default reviewer is left to app-server. */
function threadPermissions(mode: string): Record<string, string> {
  const { approvalPolicy, sandbox, approvalsReviewer } = permissionsFor(mode)
  return { approvalPolicy, sandbox, ...(approvalsReviewer === 'user' ? {} : { approvalsReviewer }) }
}

/** The `turn/start` overrides, which app-server keeps for later turns too. */
function turnPermissions(mode: string): Record<string, unknown> {
  const { approvalPolicy, sandbox, approvalsReviewer } = permissionsFor(mode)
  return { approvalPolicy, sandboxPolicy: { type: SANDBOX_POLICY_TYPES[sandbox] }, approvalsReviewer }
}

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

/** The enabled skills in a `skills/list` response; plugin skills (named `plugin:skill`) are marked as plugin entries. */
export function codexSkills(response: unknown): Map<string, { command: AgentCommand; path: string }> {
  const skills = new Map<string, { command: AgentCommand; path: string }>()
  const data = typeof response === 'object' && response !== null ? (response as { data?: unknown }).data : undefined
  for (const entry of Array.isArray(data) ? data : []) {
    const list = typeof entry === 'object' && entry !== null ? (entry as { skills?: unknown }).skills : undefined
    for (const skill of Array.isArray(list) ? list : []) {
      if (typeof skill !== 'object' || skill === null) continue
      const { name, description, shortDescription, path, enabled, pluginId } = skill as Record<string, unknown>
      if (typeof name !== 'string' || name === '' || typeof path !== 'string' || enabled === false || skills.has(name)) continue
      const summary = typeof shortDescription === 'string' && shortDescription !== '' ? shortDescription : typeof description === 'string' ? description : ''
      skills.set(name, {
        path,
        command: { name, kind: typeof pluginId === 'string' && pluginId !== '' ? 'plugin' : 'skill', ...(summary === '' ? {} : { description: summary }) }
      })
    }
  }
  return skills
}

type Running = {
  sessionId: string
  toolPolicy: ToolPolicy
  turnUsage: TurnUsage | null
  refusedTurnId: string | null
  readingMcpConfig: boolean
  pendingToolInterrupts: number
  threadId: string
  cwd: string
  /** The enabled skills `skills/list` reported, by name, with the path a `skill` input item needs. */
  skills: Map<string, { command: AgentCommand; path: string }>
  /** Settles once the first `skills/list` has answered or failed; only a message naming a command waits on it. */
  skillsLoaded: Promise<void>
  connection: CodexConnection
  options: StructuredLaunchOptions
  /** The permission mode the next turn runs in. */
  permissionMode: string
  /** The permission mode app-server last applied; a differing `permissionMode` goes out with the next `turn/start`. */
  appliedPermissionMode: string
  totalTokenUsage: TokenCounts | null
  turnUsageBaseline: TokenCounts | null
  /** The thread total the last usage report already covered, so a total-only update reports just its new spend. */
  reportedTotal: TokenCounts | null
  activeTurnId: string | null
  pendingApprovalCount: number
  pendingCompletion: PendingCompletion | null
  inputQueue: Promise<void>
  inputPending: boolean
  deferred: DeferredEvent[]
  assistantDeltas: Map<string, string>
  emittedAssistantIds: Set<string>
  emittedToolIds: Set<string>
  toolOutput: Map<string, string>
  calls: CallTracker
  stream: ProseStream
  turnStartedAt: number | null
  deniedReasons: string[]
  startupFailure: Error | null
  ready: boolean
  failed: boolean
  stopped: boolean
  /** The turn an interrupt ended; its `interrupted` completion is expected and not a failure. */
  interruptedTurnId: string | null
}

type Starting = { stopped: boolean; connection?: CodexConnection; run?: Running }

const SKILLS_TIMEOUT_MS = 5_000

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
      const permissionMode = toolPolicy === 'deny-all' ? DENY_ALL_MODE : (startOptions.permissionMode ?? DEFAULT_PERMISSION_MODE)
      const permissions = threadPermissions(permissionMode)
      const run = this.createRun(session, executable, providerSession?.id ?? '', options, startOptions.env, toolPolicy)
      run.permissionMode = permissionMode
      run.appliedPermissionMode = permissionMode
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
          ...permissions,
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
          ...permissions,
          ...(threadConfig === undefined ? {} : { config: threadConfig }),
          ...(options.model === undefined ? {} : { model: options.model })
        })
        run.threadId = this.threadIdFromResponse(response, 'thread/start')
        await this.context.setProviderSession(session.id, { id: run.threadId, transcriptPath: null })
      }
      if (startup.stopped) return
      if (run.startupFailure) throw run.startupFailure
      run.skillsLoaded = this.loadSkills(run)
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

  /**
   * Forks the source thread over a short-lived app-server of its own, so the source's live process keeps
   * its thread. The new thread holds the source history and no turn runs on it.
   */
  async fork(source: StructuredForkSource): Promise<SessionProviderSession> {
    const executable = await this.context.resolveCodexPath()
    const failures: Error[] = []
    const connection = new CodexConnection(
      this.context.process,
      executable,
      source.cwd,
      environmentWithPatch(this.deps.env ?? process.env, source.launchOptions.env),
      {
        notification: () => {},
        serverRequest: () => {},
        failure: (error) => failures.push(error)
      }
    )
    try {
      await connection.request('initialize', { clientInfo: CLIENT_INFO })
      connection.notify('initialized', {})
      const response = await connection.request('thread/fork', { threadId: source.providerSession.id, cwd: source.cwd, excludeTurns: true })
      const thread = (response as { thread?: { path?: unknown } } | null)?.thread
      return { id: this.threadIdFromResponse(response, 'thread/fork'), transcriptPath: typeof thread?.path === 'string' ? thread.path : null }
    } catch (error) {
      const stderrTail = connection.stderrTail
      const failure = failures[0] ?? (error instanceof Error ? error : new Error(String(error)))
      throw stderrTail ? new Error(`${failure.message}; stderr: ${stderrTail}`, { cause: failure }) : failure
    } finally {
      await connection.close()
    }
  }

  async configure(sessionId: string, settings: StructuredSettings): Promise<StructuredSettings> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.failed) throw new Error('session is not running')
    if (settings.model !== undefined) run.options = { ...run.options, model: settings.model }
    if (settings.effort !== undefined) run.options = { ...run.options, effort: settings.effort }
    if (settings.permissionMode !== undefined) {
      if (run.toolPolicy === 'deny-all') throw new Error('a session without tools has no permission modes')
      if (settings.permissionMode === DENY_ALL_MODE) throw new Error(`Codex has no permission mode ${settings.permissionMode}`)
      permissionsFor(settings.permissionMode)
      run.permissionMode = settings.permissionMode
    }
    return {
      ...(run.options.model === undefined ? {} : { model: run.options.model }),
      ...(run.options.effort === undefined ? {} : { effort: run.options.effort }),
      permissionMode: run.permissionMode
    }
  }

  async send(sessionId: string, text: string, options: StructuredSendOptions = {}): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.failed || !run.ready) throw new Error('session is not running')
    const operation = run.inputQueue.then(() => this.submitInput(run, text, false, options))
    run.inputQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async interrupt(sessionId: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.failed || !run.ready || run.turnStartedAt === null) return
    const turnId = run.activeTurnId
    run.activeTurnId = null
    run.pendingCompletion = null
    this.flushAssistantDeltas(run)
    this.closeTurn(run, 'stopped')
    run.assistantDeltas.clear()
    run.emittedAssistantIds.clear()
    run.emittedToolIds.clear()
    run.toolOutput.clear()
    if (turnId !== null) {
      run.interruptedTurnId = turnId
      try {
        await run.connection.request('turn/interrupt', { threadId: run.threadId, turnId }, INTERRUPT_TIMEOUT_MS)
      } catch {
        run.interruptedTurnId = null
        await this.stop(sessionId)
        return
      }
    }
    if (run.stopped || run.failed) return
    this.context.setStatus(sessionId, 'done')
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
    this.closeTurn(run, 'stopped')
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
      this.context.process,
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
      refusedTurnId: null,
      readingMcpConfig: false,
      pendingToolInterrupts: 0,
      threadId,
      cwd: session.cwd,
      skills: new Map(),
      skillsLoaded: Promise.resolve(),
      connection,
      options,
      permissionMode: DEFAULT_PERMISSION_MODE,
      appliedPermissionMode: DEFAULT_PERMISSION_MODE,
      totalTokenUsage: null,
      reportedTotal: null,
      turnUsageBaseline: threadId === '' ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } : null,
      activeTurnId: null,
      pendingApprovalCount: 0,
      pendingCompletion: null,
      inputQueue: Promise.resolve(),
      inputPending: false,
      deferred: [],
      assistantDeltas: new Map(),
      emittedAssistantIds: new Set(),
      emittedToolIds: new Set(),
      toolOutput: new Map(),
      calls: new CallTracker(),
      stream: new ProseStream(),
      turnStartedAt: null,
      deniedReasons: [],
      startupFailure: null,
      ready: false,
      failed: false,
      stopped: false,
      interruptedTurnId: null
    }
    return run
  }

  /**
   * Reports the skills Codex offers for the session's folder; Codex has no listing for its TUI
   * slash commands or custom prompts, so skills are the whole list. A failure leaves the list as it was.
   */
  private async loadSkills(run: Running): Promise<void> {
    try {
      const response = await run.connection.request('skills/list', { cwds: [run.cwd] }, SKILLS_TIMEOUT_MS, { optional: true })
      if (run.stopped || run.failed) return
      run.skills = codexSkills(response)
      this.context.reportCommands?.(run.sessionId, [...run.skills.values()].map((skill) => skill.command))
    } catch {
      // an app-server without skills/list offers no commands
    }
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

  private async submitInput(
    run: Running,
    text: string,
    deferEventsUntilReady = false,
    options: StructuredSendOptions = {}
  ): Promise<void> {
    if (mentionsCommand(text)) await run.skillsLoaded
    if (run.stopped || run.failed || !run.ready && !this.starting.has(run.sessionId)) {
      throw new Error('session is not running')
    }
    if (run.pendingApprovalCount > 0 || run.pendingCompletion) throw new Error('session is waiting for approval')
    const expectedTurnId = run.activeTurnId
    const method = expectedTurnId === null ? 'turn/start' : 'turn/steer'
    const commands = [...run.skills.values()].map((skill) => skill.command)
    const input = [
      ...(text === '' ? [] : [{ type: 'text', text }]),
      ...(options.images ?? []).map((path) => ({ type: 'localImage', path })),
      ...referencedCommands(text, commands).map((name) => ({ type: 'skill', name, path: run.skills.get(name)!.path }))
    ]
    const sentPermissionMode = run.permissionMode
    const params =
      method === 'turn/start'
        ? {
            threadId: run.threadId,
            input,
            ...(run.options.model === undefined ? {} : { model: run.options.model }),
            ...(run.options.effort === undefined ? {} : { effort: run.options.effort }),
            ...(sentPermissionMode === run.appliedPermissionMode ? {} : turnPermissions(sentPermissionMode))
          }
        : {
            threadId: run.threadId,
            input,
            expectedTurnId
          }
    if (run.totalTokenUsage !== null) run.turnUsageBaseline = { ...run.totalTokenUsage }
    run.reportedTotal = null
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
        run.turnStartedAt ??= Date.now()
        run.appliedPermissionMode = sentPermissionMode
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
        data: { method, threadId: run.threadId, ...(expectedTurnId ? { expectedTurnId } : {}) },
        item: userItem(text, options.images, options.queuedId)
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
      case 'skills/changed':
        void this.loadSkills(run)
        return
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
        const spent = last ?? (total ? tokenUsageDelta(total, run.reportedTotal ?? run.turnUsageBaseline) : null)
        if (total) run.reportedTotal = total
        if (spent) {
          const cached = spent.cachedInputTokens ?? 0
          this.context.reportUsage?.(run.sessionId, {
            tokens: {
              input: Math.max(0, (spent.inputTokens ?? 0) - cached),
              output: (spent.outputTokens ?? 0) + (spent.reasoningOutputTokens ?? 0),
              cacheRead: cached,
              cacheWrite: 0
            }
          })
        }
        this.context.appendMessage({
          sessionId: run.sessionId,
          role: 'system',
          text: 'Codex token usage updated',
          data: {
            type: 'thread/tokenUsage/updated',
            tokenUsage: rawUsage,
            ...(turnUsage ? { turnUsage } : {})
          },
          item: statusItem('Codex token usage updated')
        })
        return
      }
      case 'account/rateLimits/updated':
        this.context.appendMessage({
          sessionId: run.sessionId,
          role: 'system',
          text: 'Codex account rate limits updated',
          data: { method, params: rawParams },
          item: statusItem('Codex account rate limits updated')
        })
        return
      case 'turn/started': {
        const turn = params.turn
        if (typeof turn !== 'object' || turn === null || Array.isArray(turn)) return
        const id = (turn as Record<string, unknown>).id
        if (typeof id !== 'string' || id.length === 0 || id === run.interruptedTurnId) return
        run.activeTurnId = id
        if (run.turnStartedAt === null) {
          run.turnStartedAt = Date.now()
          if (run.pendingApprovalCount === 0) this.context.setStatus(run.sessionId, 'working')
        }
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
        const partial = run.stream.push(itemId, delta, Date.now())
        if (partial && partial.kind === 'prose') {
          this.context.appendMessage({
            sessionId: run.sessionId,
            role: 'system',
            text: partial.text,
            data: { itemId, streaming: true },
            item: partial
          })
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
      case 'item/started': {
        const item = params.item
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return
        if (run.toolPolicy === 'deny-all' && isPlainMap(item)) {
          const type = item.type
          if (typeof type !== 'string' || !Object.hasOwn(NON_TOOL_ITEM_TYPES, type)) {
            this.refuseToolItem(run, params, item)
            return
          }
        }
        this.journalStarted(run, item as Record<string, unknown>)
        return
      }
      case 'turn/plan/updated': {
        const turnId = typeof params.turnId === 'string' ? params.turnId : (run.activeTurnId ?? 'turn')
        this.append(run, codexPlanEntry(`plan-${turnId}`, params.plan))
        return
      }
      case 'item/completed': {
        const item = params.item
        if (!isPlainMap(item)) return
        const type = item.type
        if (run.toolPolicy === 'deny-all' && (typeof type !== 'string' || !Object.hasOwn(NON_TOOL_ITEM_TYPES, type))) {
          this.refuseToolItem(run, params, item)
        }
        if (run.toolPolicy === 'deny-all' && typeof type !== 'string') return
        this.journalItem(run, item)
        return
      }
      case 'error': {
        const error = params.error
        const message =
          typeof error === 'object' && error !== null && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === 'string'
            ? (error as Record<string, unknown>).message as string
            : 'Codex reported an unspecified error'
        this.context.appendMessage({
          sessionId: run.sessionId,
          role: 'system',
          text: `Codex error: ${message}`,
          data: message,
          item: statusItem(`Codex error: ${message}`)
        })
        return
      }
    }
  }

  private completeTurnNotification(run: Running, turn: Record<string, unknown>): void {
    const turnId = turn.id
    if (turnId === run.interruptedTurnId) {
      run.interruptedTurnId = null
      return
    }
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
    for (const entry of closingEntries(run.calls, 'done')) this.append(run, entry)
    run.refusedTurnId = null
    const usage = run.turnUsage
    run.turnUsage = null
    this.context.appendMessage({
      sessionId: run.sessionId,
      role: 'result',
      text: 'Codex turn completed',
      data: usage ? { ...turn, contextUsage: usage } : turn,
      item: turnEndItem('done', run.turnStartedAt === null ? undefined : Date.now() - run.turnStartedAt)
    })
    run.turnStartedAt = null
    this.context.reportUsage?.(run.sessionId, { turnEnded: true })
    this.context.setStatus(run.sessionId, 'done')
    run.stream.reset()
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
        data: { itemId, streamed: true },
        item: { kind: 'prose', text }
      })
      run.emittedAssistantIds.add(itemId)
    }
  }

  private append(run: Running, entry: ItemEntry): void {
    this.context.appendMessage({ sessionId: run.sessionId, role: entry.role, text: entry.text, data: entry.data, item: entry.item })
  }

  /** Closes calls still running and ends the turn when one is open; a turn that is not open is left alone. */
  private closeTurn(run: Running, state: 'stopped' | 'failed'): void {
    if (run.turnStartedAt === null) return
    for (const entry of closingEntries(run.calls, state)) this.append(run, entry)
    this.context.appendMessage({
      sessionId: run.sessionId,
      role: 'result',
      text: state === 'stopped' ? 'Turn stopped' : 'Turn failed',
      item: turnEndItem(state, Date.now() - run.turnStartedAt)
    })
    run.turnStartedAt = null
    run.stream.reset()
  }

  private journalStarted(run: Running, item: Record<string, unknown>): void {
    for (const entry of codexEntries(item, 'started', run.calls)) this.append(run, entry)
  }

  /**
   * Ends a deny-all turn that started a tool anyway. The refusal is journaled once and the turn is
   * interrupted; its interrupted completion then settles the session as done, not failed.
   */
  private refuseToolItem(run: Running, params: Record<string, unknown>, item: object): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : run.activeTurnId
    if (turnId === null) {
      this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: TOOLS_DISABLED, data: item, item: statusItem(TOOLS_DISABLED) })
      this.failRun(run, new Error(TOOL_STOP_FAILURE))
      return
    }
    if (run.refusedTurnId === turnId) return
    run.refusedTurnId = turnId
    this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: TOOLS_DISABLED, data: item, item: statusItem(TOOLS_DISABLED) })
    run.pendingToolInterrupts++
    void run.connection
      .request('turn/interrupt', { threadId: run.threadId, turnId }, INTERRUPT_TIMEOUT_MS)
      .catch(() => this.failRun(run, new Error(TOOL_STOP_FAILURE)))
      .finally(() => { run.pendingToolInterrupts-- })
  }

  private refuseSecondAgent(run: Running, data: unknown): void {
    this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: TOOLS_DISABLED, data, item: statusItem(TOOLS_DISABLED) })
    this.failRun(run, new Error('Codex started a second agent in a session without tools'))
  }
  private journalItem(run: Running, item: Record<string, unknown>): void {
    const type = item.type
    const id = typeof item.id === 'string' ? item.id : undefined
    if (type === 'agentMessage') {
      if (id && run.emittedAssistantIds.has(id)) return
      const text = typeof item.text === 'string' ? item.text : (id ? run.assistantDeltas.get(id) : undefined) ?? ''
      if (text.length > 0) {
        this.context.appendMessage({ sessionId: run.sessionId, role: 'assistant', text, data: item, item: { kind: 'prose', text } })
      }
      if (id) {
        run.emittedAssistantIds.add(id)
        run.stream.reset(id)
      }
      return
    }
    if (type === 'commandExecution' || type === 'fileChange') {
      if (id && run.emittedToolIds.has(id)) return
      const output = id ? run.toolOutput.get(id) : undefined
      for (const entry of codexEntries(item, 'completed', run.calls, output)) this.append(run, entry)
      if (id) run.emittedToolIds.add(id)
      return
    }
    if (type === 'reasoning') return
    for (const entry of codexEntries(item, 'completed', run.calls)) this.append(run, entry)
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
    let envelope: AskEnvelope | null = null
    try {
      envelope = await this.context.createAsk(approvalSpec(question), run.sessionId)
    } catch {
      envelope = null
    }
    const outcome = approvalOutcome(envelope, true)
    const decision = outcome.decision === 'allow' ? 'accept' : outcome.decision === 'always' ? 'acceptForSession' : 'decline'
    if (outcome.reason !== undefined) run.deniedReasons.push(outcome.reason)
    try {
      if (!run.stopped && !run.failed) run.connection.respond(request.id, { decision })
    } catch (error) {
      this.failRun(run, error instanceof Error ? error : new Error(String(error)))
    } finally {
      run.pendingApprovalCount--
      if (!run.stopped && !run.failed && run.pendingApprovalCount === 0) {
        if (run.pendingCompletion) this.finishCompletedTurn(run, run.pendingCompletion.turn)
        else if (run.activeTurnId !== null) this.context.setStatus(run.sessionId, 'working')
        this.sendDenialReasons(run)
      }
    }
  }

  /** Tells the agent why a command was declined, once no approval is still pending. */
  private sendDenialReasons(run: Running): void {
    if (run.deniedReasons.length === 0) return
    const text = run.deniedReasons.splice(0).map((reason) => `Denied: ${reason}`).join('\n')
    void this.send(run.sessionId, text).catch(() => {})
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
    this.closeTurn(run, 'failed')
    this.context.appendMessage({
      sessionId: run.sessionId,
      role: 'system',
      text: `Codex app-server failed: ${error.message}${run.connection.stderrTail ? `; stderr: ${run.connection.stderrTail}` : ''}`,
      item: errorItem('exited', stderrLines(run.connection.stderrTail || error.message), run.threadId !== '')
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
