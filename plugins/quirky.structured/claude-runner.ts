import type { CanUseTool, ModelInfo, Options, PermissionMode, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AgentCommand, AskEnvelope, Session } from '@quirky/protocol'
import type { StructuredContext, StructuredSendOptions, StructuredSettings, StructuredStartOptions, StructuredRunner, TurnUsage } from './runner'
import {
  CallTracker,
  ProseStream,
  claudeEntries,
  claudeTextDelta,
  closingEntries,
  errorItem,
  stderrLines,
  summarizeInput,
  turnEndItem,
  userItem,
  type ItemEntry
} from './items'
import { MAX_IMAGE_BYTES } from './queue'
import { approvalOutcome, approvalSpec, nativeQuestionAnswers, nativeQuestionPlan } from './native-questions'
import { hoistCommand } from './slash-commands'

const TOOLS_DISABLED = 'tools are disabled for this session'
const denyEveryTool: CanUseTool = async () => ({ behavior: 'deny', message: TOOLS_DISABLED })

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The context footprint of a result message, or null when the SDK reported no usage. */
function resultUsage(msg: any): TurnUsage | null {
  const usage = msg?.usage
  if (typeof usage !== 'object' || usage === null) return null
  const windows =
    typeof msg.modelUsage === 'object' && msg.modelUsage !== null
      ? Object.values<any>(msg.modelUsage)
          .map((entry) => entry?.contextWindow)
          .filter((value): value is number => typeof value === 'number' && value > 0)
      : []
  return {
    contextTokens:
      numberOr0(usage.input_tokens) +
      numberOr0(usage.cache_read_input_tokens) +
      numberOr0(usage.cache_creation_input_tokens) +
      numberOr0(usage.output_tokens),
    contextWindow: windows.length > 0 ? Math.max(...windows) : null
  }
}

export type ClaudeQueryParams = { prompt: AsyncIterable<SDKUserMessage>; options?: Options }

/** The slice of the SDK's `Query` the runner uses; the real object satisfies it. */
export type ClaudeQuery = AsyncIterable<any> & {
  interrupt(): Promise<unknown>
  close(): void
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: { effortLevel?: Options['effort'] | null }): Promise<void>
  supportedModels?(): Promise<ModelInfo[]>
  supportedCommands?(): Promise<ClaudeSlashCommand[]>
}

/** One entry of the SDK's `supportedCommands()` list or `commands_changed` push. */
export type ClaudeSlashCommand = { name: string; description?: string; argumentHint?: string; builtin?: boolean }

export type ClaudeRunnerDeps = {
  /** Replaces the SDK's `query`; tests inject a fake. The SDK is imported on first use otherwise. */
  query?: (params: ClaudeQueryParams) => ClaudeQuery
}

const DENIED = 'Denied from Quirky'
const INTERRUPT_TIMEOUT_MS = 2000
const COMMANDS_TIMEOUT_MS = 10_000
const MCP_PROMPT = /^(.+):(\S+) \(MCP\)$/
const SOURCE_SUFFIX = / \((user|project)\)$/

/**
 * Sorts the SDK's command list into the kinds Quirky shows. `skills` are the names `system/init`
 * reports as skills; until the first turn starts it is null and a `(user)` or `(project)` suffix,
 * which the CLI adds to `.claude/commands` entries, tells a command from a skill. Built-ins stay
 * start-only unless init names them as skills, since `/clear` or `/compact` mid-message must not run.
 */
export function claudeCommands(list: readonly ClaudeSlashCommand[], skills: ReadonlySet<string> | null): AgentCommand[] {
  return list.flatMap((entry): AgentCommand[] => {
    if (typeof entry?.name !== 'string' || entry.name === '' || entry.name.startsWith('__')) return []
    const hint = typeof entry.argumentHint === 'string' ? entry.argumentHint.trim() : ''
    const raw = typeof entry.description === 'string' ? entry.description.trim() : ''
    const details = (description: string) => ({ ...(description === '' ? {} : { description }), ...(hint === '' ? {} : { argumentHint: hint }) })
    const mcp = MCP_PROMPT.exec(entry.name)
    // the CLI lists an MCP prompt by its display name but runs it as /mcp__<server>__<prompt>
    if (mcp) return [{ name: `mcp__${mcp[1]!.replace(/[^\w-]/g, '_')}__${mcp[2]}`, kind: 'mcp', ...details(raw) }]
    if (entry.builtin === true) {
      return skills?.has(entry.name) ? [{ name: entry.name, kind: 'skill', ...details(raw) }] : [{ name: entry.name, kind: 'builtin', startOnly: true, ...details(raw) }]
    }
    const colon = entry.name.indexOf(':')
    if (colon > 0) {
      const prefix = `(${entry.name.slice(0, colon)}) `
      return [{ name: entry.name, kind: 'plugin', ...details(raw.startsWith(prefix) ? raw.slice(prefix.length) : raw) }]
    }
    const isSkill = skills ? skills.has(entry.name) : !SOURCE_SUFFIX.test(raw)
    return [{ name: entry.name, kind: isSkill ? 'skill' : 'command', ...details(raw.replace(SOURCE_SUFFIX, '')) }]
  })
}

/** The list built from `system/init` names alone, for a CLI whose SDK has no `supportedCommands()`. */
function initCommands(slashCommands: readonly string[], skills: ReadonlySet<string>): AgentCommand[] {
  return [
    ...slashCommands
      .filter((name) => !skills.has(name))
      .map((name): AgentCommand => ({ name, kind: name.startsWith('mcp__') ? 'mcp' : name.includes(':') ? 'plugin' : 'command' })),
    ...[...skills].map((name): AgentCommand => ({ name, kind: name.includes(':') ? 'plugin' : 'skill' }))
  ]
}

type InputStream = {
  messages: AsyncIterable<SDKUserMessage>
  push(message: SDKUserMessage): void
  end(): void
}

function createInputStream(): InputStream {
  const queue: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  let ended = false
  async function* drain(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (ended) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }
  const notify = () => {
    wake?.()
    wake = null
  }
  return {
    messages: drain(),
    push(message) {
      queue.push(message)
      notify()
    },
    end() {
      ended = true
      notify()
    }
  }
}

type Running = {
  query: ClaudeQuery
  input: InputStream
  providerSessionId: string | undefined
  providerSessionKnown: boolean
  stopped: boolean
  ended: boolean
  /** An interrupt was issued and its non-success result has not been swallowed yet. */
  interrupted: boolean
  calls: CallTracker
  stream: ProseStream
  turnStartedAt: number | null
  /** Prompts sent whose result has not arrived yet; a result closes one turn, not all of them. */
  openTurns: number
  /** A `deny-all` session refuses every tool and cannot leave that by changing its permission mode. */
  denyAll: boolean
  settings: { model?: string; effort?: string; permissionMode: string; planMode: boolean }
  /** The SDK's command list, or null until `supportedCommands()` answers. */
  slashCommands: ClaudeSlashCommand[] | null
  /** The skill names from `system/init`, or null until the first turn starts. */
  skills: Set<string> | null
  /** The list last reported, which decides how an outgoing message is rewritten. */
  commands: AgentCommand[]
  /** Settles once the command list has loaded or failed; messages are written to the CLI after it. */
  commandsLoaded: Promise<void>
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

type EncodedImage = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/**
 * Reads an image for the agent without ever blocking on it: the file is opened non-blocking and
 * checked on the open descriptor, so a path swapped for a FIFO or device since it was validated
 * is refused instead of hanging the daemon.
 */
async function encodeImage(path: string): Promise<EncodedImage> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`image ${path} is not a regular file`)
    if (stats.size > MAX_IMAGE_BYTES) throw new Error(`image ${path} is larger than 20 MB`)
    const data = await handle.readFile()
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: IMAGE_MEDIA_TYPES[extname(path).toLowerCase()] ?? 'image/png',
        data: data.toString('base64')
      }
    }
  } finally {
    await handle.close()
  }
}

function userMessage(text: string, providerSessionId?: string, images: EncodedImage[] = []): SDKUserMessage {
  // the api rejects an empty text block, so an image-only message carries the images alone
  const content = images.length === 0 ? text : [...(text === '' ? [] : [{ type: 'text', text }]), ...images]
  return {
    type: 'user',
    message: { role: 'user', content } as SDKUserMessage['message'],
    parent_tool_use_id: null,
    ...(providerSessionId === undefined ? {} : { session_id: providerSessionId })
  }
}

function environmentOf(patch: Record<string, string | null>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete env[name]
    else env[name] = value
  }
  return env
}

/**
 * Runs Claude Code sessions in the background through the Agent SDK, with no PTY: one SDK
 * `query()` per Quirky session in streaming-input mode, every SDK message journaled through
 * `context`, and tool permission prompts surfaced as asks.
 *
 * `deps.query` is the test seam; production callers pass only the context.
 */
export function createClaudeRunner(context: StructuredContext, deps: ClaudeRunnerDeps = {}): StructuredRunner {
  return new ClaudeRunner(context, deps)
}

class ClaudeRunner implements StructuredRunner {
  private readonly running = new Map<string, Running>()
  private readonly starting = new Map<string, { stopped: boolean }>()

  constructor(
    private readonly context: StructuredContext,
    private readonly deps: ClaudeRunnerDeps
  ) {}

  async start(session: Session, prompt: string | undefined, launchOptions: StructuredStartOptions = {}): Promise<void> {
    if (session.agent !== 'claude') throw new Error('structured sessions support claude only')
    const providerSession = launchOptions.providerSession
    const providerSessionId = providerSession?.id
    const startup = { stopped: false }
    this.starting.set(session.id, startup)
    try {
      // Load this provider only when the runtime provider registry selects Claude, not for Codex sessions.
      const query = this.deps.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query
      if (startup.stopped) return
      const pathToClaudeCodeExecutable = await this.context.resolveClaudePath()
      if (startup.stopped) return
      if (providerSession !== undefined) {
        await this.context.setProviderSession(session.id, {
          id: providerSession.id,
          transcriptPath: providerSession.transcriptPath ?? null
        })
        if (startup.stopped) return
      }
      this.launch(session, prompt, query, pathToClaudeCodeExecutable, launchOptions, providerSessionId)
    } finally {
      if (this.starting.get(session.id) === startup) this.starting.delete(session.id)
    }
  }

  private launch(
    session: Session,
    prompt: string | undefined,
    query: NonNullable<ClaudeRunnerDeps['query']>,
    pathToClaudeCodeExecutable: string,
    launchOptions: StructuredStartOptions,
    providerSessionId: string | undefined
  ): void {
    const input = createInputStream()
    const hasPrompt = prompt !== undefined && prompt !== ''
    if (hasPrompt) {
      this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt, data: userMessage(prompt, providerSessionId), item: userItem(prompt) })
    }
    this.context.setStatus(session.id, hasPrompt ? 'working' : 'running')
    const denyAll = launchOptions.toolPolicy === 'deny-all'
    const permissionMode = denyAll ? 'default' : (launchOptions.permissionMode ?? 'default')
    const planMode = !denyAll && launchOptions.planMode === true
    const run: Running = {
      denyAll,
      input,
      providerSessionId,
      providerSessionKnown: launchOptions.providerSession !== undefined,
      stopped: false,
      ended: false,
      interrupted: false,
      calls: new CallTracker(),
      stream: new ProseStream(),
      turnStartedAt: hasPrompt ? Date.now() : null,
      openTurns: hasPrompt ? 1 : 0,
      slashCommands: null,
      skills: null,
      commands: [],
      commandsLoaded: Promise.resolve(),
      settings: {
        permissionMode,
        planMode,
        ...(typeof launchOptions.model === 'string' ? { model: launchOptions.model } : {}),
        ...(typeof launchOptions.effort === 'string' ? { effort: launchOptions.effort } : {})
      },
      query: query({
        prompt: input.messages,
        options: {
          cwd: session.cwd,
          pathToClaudeCodeExecutable,
          ...(launchOptions.providerSession === undefined ? {} : { resume: launchOptions.providerSession.id }),
          permissionMode: (planMode ? 'plan' : permissionMode) as PermissionMode,
          // lets the user switch into bypass permissions mid-session; the mode itself stays as picked
          allowDangerouslySkipPermissions: !denyAll,
          includePartialMessages: true,
          canUseTool: denyAll ? denyEveryTool : this.canUseTool(session.id),
          ...(denyAll ? { tools: [], mcpServers: {}, strictMcpConfig: true } : {}),
          ...(launchOptions.env !== undefined ? { env: environmentOf(launchOptions.env) } : {}),
          ...(typeof launchOptions.model === 'string' ? { model: launchOptions.model } : {}),
          ...(typeof launchOptions.effort === 'string' ? { effort: launchOptions.effort as Options['effort'] } : {})
        }
      })
    }
    this.running.set(session.id, run)
    run.commandsLoaded = this.loadCommands(session.id, run)
    if (hasPrompt) this.write(run, prompt)
    void this.pump(session.id, run)
  }

  /** Asks the CLI for its commands as soon as it starts, so the list is there before the first message. */
  private async loadCommands(sessionId: string, run: Running): Promise<void> {
    if (typeof run.query.supportedCommands !== 'function') return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const list = await Promise.race([
        run.query.supportedCommands(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), COMMANDS_TIMEOUT_MS)
        })
      ])
      if (!Array.isArray(list) || run.stopped || run.slashCommands !== null) return
      run.slashCommands = list
      this.reportCommands(sessionId, run)
    } catch {
      // a CLI that cannot list commands still reports names in system/init
    } finally {
      clearTimeout(timer)
    }
  }

  private reportCommands(sessionId: string, run: Running): void {
    run.commands = claudeCommands(run.slashCommands ?? [], run.skills)
    this.context.reportCommands?.(sessionId, run.commands)
  }

  /** Writes a user message to the CLI once the command list is known, so a mid-message command can open it. */
  private write(run: Running, text: string, images: EncodedImage[] = []): void {
    void run.commandsLoaded.then(() => {
      if (run.stopped || run.ended) return
      run.input.push(userMessage(hoistCommand(text, run.commands), run.providerSessionId, images))
    })
  }

  async send(sessionId: string, text: string, options: StructuredSendOptions = {}): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.ended) throw new Error('session is not running')
    const images = options.images !== undefined && options.images.length > 0 ? await Promise.all(options.images.map(encodeImage)) : []
    if (run.stopped || run.ended) throw new Error('session is not running')
    this.context.appendMessage({
      sessionId,
      role: 'user',
      text,
      data: userMessage(text, run.providerSessionId, images),
      item: userItem(text, options.images, options.queuedId)
    })
    run.openTurns++
    run.turnStartedAt ??= Date.now()
    this.context.setStatus(sessionId, 'working')
    this.write(run, text, images)
  }

  private configureChains = new Map<string, Promise<unknown>>()

  /** Applies settings changes for one session in call order, so the returned settings match what the SDK was last told. */
  configure(sessionId: string, settings: StructuredSettings): Promise<StructuredSettings> {
    const previous = this.configureChains.get(sessionId) ?? Promise.resolve()
    const result = previous.then(() => this.applySettings(sessionId, settings))
    const settled = result.then(() => undefined, () => undefined)
    this.configureChains.set(sessionId, settled)
    void settled.then(() => {
      if (this.configureChains.get(sessionId) === settled) this.configureChains.delete(sessionId)
    })
    return result
  }

  private async applySettings(sessionId: string, settings: StructuredSettings): Promise<StructuredSettings> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.ended) throw new Error('session is not running')
    const current = run.settings
    if (settings.model !== undefined) {
      await run.query.setModel(settings.model)
      current.model = settings.model
    }
    if (settings.effort !== undefined) {
      await run.query.applyFlagSettings({ effortLevel: settings.effort as Options['effort'] })
      current.effort = settings.effort
    }
    if (settings.permissionMode !== undefined || settings.planMode !== undefined) {
      if (run.denyAll) throw new Error('a session without tools has no permission modes')
      const permissionMode = settings.permissionMode ?? current.permissionMode
      const planMode = settings.planMode ?? current.planMode
      if (!planMode && permissionMode === 'auto' && current.permissionMode !== 'auto') await this.requireAutoModeModel(run)
      await run.query.setPermissionMode((planMode ? 'plan' : permissionMode) as PermissionMode)
      current.permissionMode = permissionMode
      current.planMode = planMode
    }
    return { ...current }
  }

  /** Refuses auto mode when Claude reports that the session's model cannot use it; an unknown answer lets Claude decide. */
  private async requireAutoModeModel(run: Running): Promise<void> {
    let models: ModelInfo[]
    try {
      models = (await run.query.supportedModels?.()) ?? []
    } catch {
      return
    }
    const model = run.settings.model ?? 'default'
    const found = models.find((entry) => entry.value === model || entry.resolvedModel === model)
    if (found?.supportsAutoMode === false) throw new Error(`${found.displayName || model} does not support auto mode`)
  }

  async interrupt(sessionId: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.ended || run.turnStartedAt === null) return
    this.closeTurn(sessionId, run, 'stopped')
    run.interrupted = true
    const honoured = await Promise.race([
      run.query.interrupt().then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS))
    ])
    if (!honoured) {
      run.interrupted = false
      await this.stop(sessionId)
      return
    }
    if (run.stopped || run.ended || this.running.get(sessionId) !== run) return
    this.context.setStatus(sessionId, 'done')
  }

  async stop(sessionId: string): Promise<void> {
    const startup = this.starting.get(sessionId)
    if (startup) startup.stopped = true
    const run = this.running.get(sessionId)
    if (!run || run.stopped) return
    run.stopped = true
    this.running.delete(sessionId)
    this.closeTurn(sessionId, run, 'stopped')
    run.input.end()
    await Promise.race([
      run.query.interrupt().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, INTERRUPT_TIMEOUT_MS))
    ])
    run.query.close()
    this.context.setStatus(sessionId, 'exited')
  }

  private canUseTool(sessionId: string): CanUseTool {
    let pending = 0
    return async (toolName, input) => {
      pending++
      this.context.setStatus(sessionId, 'waiting')
      let envelope: AskEnvelope | null = null
      try {
        if (toolName === 'AskUserQuestion') {
          const plan = nativeQuestionPlan(input, 'claude')
          try {
            envelope = await this.context.createAsk(plan.spec, sessionId, { nativeQuestion: true })
          } catch {
            // Question-only unavailability is returned as explicit non-answer text, never permission.
          }
          const answers = Object.fromEntries(Object.entries(nativeQuestionAnswers(plan, envelope)).map(([question, values]) => [question, values.join(', ')]))
          return { behavior: 'allow', updatedInput: { ...input, answers } }
        }
        envelope = await this.context.createAsk(
          approvalSpec(`Allow ${toolName}? ${summarizeInput(input)}`.trim()),
          sessionId
        )
      } catch {
        envelope = null
      } finally {
        pending--
        if (pending === 0 && this.running.get(sessionId)?.turnStartedAt != null) this.context.setStatus(sessionId, 'working')
      }
      const outcome = approvalOutcome(envelope, true)
      if (outcome.decision === 'allow') return { behavior: 'allow', updatedInput: input }
      if (outcome.decision === 'always') {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [
            { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }
          ]
        }
      }
      return { behavior: 'deny', message: outcome.reason ?? DENIED }
    }
  }

  private async pump(sessionId: string, run: Running): Promise<void> {
    let failure: Error | null = null
    try {
      for await (const msg of run.query) {
        if (run.stopped) break
        await this.journal(sessionId, msg)
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    run.ended = true
    if (run.stopped || this.running.get(sessionId) !== run) return
    this.running.delete(sessionId)
    const wasWorking = run.turnStartedAt !== null
    this.closeTurn(sessionId, run, 'failed')
    if (failure) {
      this.context.appendMessage({
        sessionId,
        role: 'system',
        text: `claude failed: ${failure.message}`,
        item: errorItem('exited', stderrLines(failure.message), run.providerSessionKnown)
      })
    } else if (wasWorking) {
      this.context.appendMessage({
        sessionId,
        role: 'system',
        text: 'claude exited',
        item: errorItem('exited', [], run.providerSessionKnown)
      })
    }
    this.context.setStatus(sessionId, 'exited')
  }

  private append(sessionId: string, entry: ItemEntry): void {
    this.context.appendMessage({ sessionId, role: entry.role, text: entry.text, data: entry.data, item: entry.item })
  }

  /** Closes calls still running and ends the turn when one is open; a turn that is not open is left alone. */
  private closeTurn(sessionId: string, run: Running, state: 'stopped' | 'failed'): void {
    if (run.turnStartedAt === null) return
    for (const entry of closingEntries(run.calls, state)) this.append(sessionId, entry)
    this.context.appendMessage({
      sessionId,
      role: 'result',
      text: state === 'stopped' ? 'Turn stopped' : 'Turn failed',
      item: turnEndItem(state, Date.now() - run.turnStartedAt)
    })
    run.turnStartedAt = null
    run.openTurns = 0
    run.stream.reset()
  }

  private async journal(sessionId: string, msg: any): Promise<void> {
    const run = this.running.get(sessionId)
    const delta = claudeTextDelta(msg)
    if (delta !== null) {
      const item = run?.stream.push('assistant', delta, Date.now())
      if (item && item.kind === 'prose') this.context.appendMessage({ sessionId, role: 'system', text: item.text, data: { streaming: true }, item })
      return
    }
    if (msg?.type === 'system' && msg.subtype === 'init') {
      const nativeSessionId = msg.session_id
      if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) {
        throw new Error('Claude initialized without a native session ID')
      }
      if (run) {
        if (run.providerSessionKnown) {
          if (run.providerSessionId !== nativeSessionId) {
            throw new Error(`Claude resumed session ${run.providerSessionId}, received ${nativeSessionId}`)
          }
        } else {
          run.providerSessionId = nativeSessionId
          run.providerSessionKnown = true
          await this.context.setProviderSession(sessionId, { id: nativeSessionId, transcriptPath: null })
        }
      }
    }
    if (msg?.type === 'system' && msg.subtype === 'init' && run) {
      const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [])
      run.skills = new Set(names(msg.skills))
      if (run.slashCommands) this.reportCommands(sessionId, run)
      else {
        run.commands = initCommands(names(msg.slash_commands), run.skills)
        this.context.reportCommands?.(sessionId, run.commands)
      }
    }
    if (msg?.type === 'system' && msg.subtype === 'commands_changed' && run && Array.isArray(msg.commands)) {
      run.slashCommands = msg.commands
      this.reportCommands(sessionId, run)
      return
    }
    if (msg?.type === 'result' && run?.interrupted) {
      run.interrupted = false
      // the result of the turn that was interrupted is already journaled as stopped
      if (msg.subtype !== 'success') return
    }
    if (msg?.type === 'user' && run?.interrupted) return
    if (msg?.type === 'assistant') run?.stream.reset()
    const failed = msg?.type === 'result' && (msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error')))
    if (msg?.type === 'result' && run) {
      for (const entry of closingEntries(run.calls, failed ? 'failed' : 'done')) this.append(sessionId, entry)
      run.openTurns = Math.max(0, run.openTurns - 1)
      run.turnStartedAt = run.openTurns > 0 ? Date.now() : null
    }
    const usage = msg?.type === 'result' ? resultUsage(msg) : null
    for (const entry of claudeEntries(msg, run?.calls ?? new CallTracker())) {
      this.append(sessionId, usage !== null && entry.role === 'result' ? { ...entry, data: { ...(entry.data as object), contextUsage: usage } } : entry)
    }
    if (msg?.type !== 'result') return
    if (failed) {
      if (run) {
        run.ended = true
        run.input.end()
        run.query.close()
        this.running.delete(sessionId)
      }
      this.context.setStatus(sessionId, 'exited')
    } else {
      this.context.setStatus(sessionId, 'done')
    }
  }
}
