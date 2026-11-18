import type { CanUseTool, Options, PermissionMode, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { AskEnvelope, PermissionModeName, PlanItem, Session } from '@quirky/protocol'
import type { StructuredContext, StructuredSendOptions, StructuredSettings, StructuredStartOptions, StructuredRunner } from './runner'
import {
  CallTracker,
  ProseStream,
  claudeEntries,
  claudeTextDelta,
  closingEntries,
  errorItem,
  statusItem,
  stderrLines,
  summarizeInput,
  turnEndItem,
  userItem,
  type ItemEntry
} from './items'
import { MAX_IMAGE_BYTES } from './queue'
import { approvalOutcome, approvalSpec, nativeQuestionAnswers, nativeQuestionPlan } from './native-questions'
import { planDecision, planSpec, planText } from './plan'

export type ClaudeQueryParams = { prompt: AsyncIterable<SDKUserMessage>; options?: Options }

/** The slice of the SDK's `Query` the runner uses; the real object satisfies it. */
export type ClaudeQuery = AsyncIterable<any> & {
  interrupt(): Promise<unknown>
  close(): void
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: { effortLevel?: Options['effort'] | null }): Promise<void>
  initializationResult?(): Promise<{ models?: { value: string; supportsAutoMode?: boolean }[] }>
}

export type ClaudeRunnerDeps = {
  /** Replaces the SDK's `query`; tests inject a fake. The SDK is imported on first use otherwise. */
  query?: (params: ClaudeQueryParams) => ClaudeQuery
  /** Where Claude keeps plan files; defaults to `plans` under the session's Claude config directory. */
  plansDir?: string
}

const DENIED = 'Denied from Quirky'
const INTERRUPT_TIMEOUT_MS = 2000
const KEEP_PLANNING = 'Keep planning.'
const EMPTY_PLAN = 'The plan was empty. Present the plan again.'
const STOPPED_PLAN = 'The user stopped before answering. The plan was not approved; stay in plan mode.'
const AUTO_REFUSED = "Auto mode isn't available. Using Accept edits."

const MODES: readonly PermissionModeName[] = ['default', 'acceptEdits', 'auto', 'plan']
const MODE_LABELS: Record<PermissionModeName, string> = { default: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan' }

function isModeName(value: unknown): value is PermissionModeName {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/** What ends the wait on a plan before the user answers its ask. */
type PlanInterrupt = { kind: 'feedback'; text: string } | { kind: 'mode-switch'; mode: PermissionModeName } | { kind: 'stopped' }

type PendingPlan = {
  askId: string | null
  /** Set by whoever claims the plan first: an answer, feedback, a mode switch or a stop. */
  settled: boolean
  interrupt: PromiseWithResolvers<PlanInterrupt>
  /** Resolves once the plan's final item is journaled. */
  done: PromiseWithResolvers<void>
}

type ModelAvailability = { value: string; supportsAutoMode?: boolean }

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
  settings: { model?: string; effort?: string }
  /** The mode Claude is in as far as Quirky knows; the newest `mode` item mirrors it. */
  mode: PermissionModeName
  autoAvailable: boolean
  initModel: string | undefined
  models: ModelAvailability[] | null
  initialized: boolean
  plansDir: string
  planVersion: number
  lastPlanText: string | null
  /** The newest journaled item of each plan version, so a status change can journal a full copy. */
  plans: Map<number, PlanItem>
  pendingPlan: PendingPlan | null
  /** The mode an approval asked Claude to switch to, until the turn's result confirms it. */
  pendingApprovalTarget: 'auto' | 'acceptEdits' | 'default' | null
  approvedVersion: number | null
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
  const content = images.length === 0 ? text : [{ type: 'text', text }, ...images]
  return {
    type: 'user',
    message: { role: 'user', content } as SDKUserMessage['message'],
    parent_tool_use_id: null,
    ...(providerSessionId === undefined ? {} : { session_id: providerSessionId })
  }
}

function configDirOf(env: Record<string, string | null> | undefined): string {
  const configured = env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.claude')
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
      const first = userMessage(prompt, providerSessionId)
      this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt, data: first, item: userItem(prompt) })
      input.push(first)
    }
    this.context.setStatus(session.id, hasPrompt ? 'working' : 'running')
    const mode = isModeName(launchOptions.permissionMode) ? launchOptions.permissionMode : 'default'
    const run: Running = {
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
      mode,
      autoAvailable: false,
      initModel: undefined,
      models: null,
      initialized: false,
      plansDir: this.deps.plansDir ?? join(configDirOf(launchOptions.env), 'plans'),
      planVersion: launchOptions.planVersion ?? 0,
      lastPlanText: launchOptions.lastPlanText ?? null,
      plans: new Map(launchOptions.lastPlan === undefined ? [] : [[launchOptions.lastPlan.version, launchOptions.lastPlan]]),
      pendingPlan: null,
      pendingApprovalTarget: null,
      approvedVersion: null,
      settings: {
        ...(typeof launchOptions.model === 'string' ? { model: launchOptions.model } : {}),
        ...(typeof launchOptions.effort === 'string' ? { effort: launchOptions.effort } : {})
      },
      query: query({
        prompt: input.messages,
        options: {
          cwd: session.cwd,
          pathToClaudeCodeExecutable,
          ...(launchOptions.providerSession === undefined ? {} : { resume: launchOptions.providerSession.id }),
          permissionMode: mode,
          includePartialMessages: true,
          canUseTool: this.canUseTool(session.id),
          ...(launchOptions.env !== undefined ? { env: environmentOf(launchOptions.env) } : {}),
          ...(typeof launchOptions.model === 'string' ? { model: launchOptions.model } : {}),
          ...(typeof launchOptions.effort === 'string' ? { effort: launchOptions.effort as Options['effort'] } : {})
        }
      })
    }
    this.running.set(session.id, run)
    this.appendMode(session.id, run)
    void this.pump(session.id, run)
  }

  async send(sessionId: string, text: string, options: StructuredSendOptions = {}): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.ended) throw new Error('session is not running')
    const images = options.images !== undefined && options.images.length > 0 ? await Promise.all(options.images.map(encodeImage)) : []
    if (run.stopped || run.ended) throw new Error('session is not running')
    const message = userMessage(text, run.providerSessionId, images)
    this.context.appendMessage({
      sessionId,
      role: 'user',
      text,
      data: message,
      item: userItem(text, options.images, options.queuedId)
    })
    run.openTurns++
    run.turnStartedAt ??= Date.now()
    this.context.setStatus(sessionId, 'working')
    run.input.push(message)
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
      this.refreshAutoAvailable(sessionId, run)
    }
    if (settings.effort !== undefined) {
      await run.query.applyFlagSettings({ effortLevel: settings.effort as Options['effort'] })
      current.effort = settings.effort
    }
    if (settings.permissionMode !== undefined) await this.switchMode(sessionId, run, settings.permissionMode)
    return { ...current, permissionMode: run.mode }
  }

  /** Moves Claude to `target`, first telling a waiting plan it was not approved so it never outlives the switch. */
  private async switchMode(sessionId: string, run: Running, target: string): Promise<void> {
    if (!isModeName(target)) throw new Error(`unsupported permission mode ${target}`)
    const pending = run.pendingPlan
    if (pending && target !== run.mode && !pending.settled) {
      pending.settled = true
      pending.interrupt.resolve({ kind: 'mode-switch', mode: target })
      await pending.done.promise
    }
    await run.query.setPermissionMode(target)
    run.pendingApprovalTarget = null
    if (target === run.mode) return
    run.mode = target
    this.appendMode(sessionId, run)
  }

  autoAvailable(sessionId: string): boolean {
    return this.running.get(sessionId)?.autoAvailable ?? false
  }

  planWaiting(sessionId: string): boolean {
    const pending = this.running.get(sessionId)?.pendingPlan
    return pending !== undefined && pending !== null && pending.askId !== null && !pending.settled
  }

  planFeedback(sessionId: string, text: string): boolean {
    if (!this.planWaiting(sessionId)) return false
    const pending = this.running.get(sessionId)!.pendingPlan!
    pending.settled = true
    pending.interrupt.resolve({ kind: 'feedback', text })
    return true
  }

  async interrupt(sessionId: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.ended || run.turnStartedAt === null) return
    this.settlePlan(run, { kind: 'stopped' })
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
    this.settlePlan(run, { kind: 'stopped' })
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
      const run = this.running.get(sessionId)
      if (toolName === 'EnterPlanMode' && run) {
        this.recordMode(sessionId, run, 'plan')
        return { behavior: 'allow', updatedInput: input }
      }
      pending++
      this.context.setStatus(sessionId, 'waiting')
      const settle = (): void => {
        pending--
        if (pending === 0 && this.running.get(sessionId)?.turnStartedAt != null) this.context.setStatus(sessionId, 'working')
      }
      if (toolName === 'ExitPlanMode' && run) {
        try {
          return await this.exitPlanMode(sessionId, run, input)
        } finally {
          settle()
        }
      }
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
        settle()
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

  /**
   * Presents Claude's plan and waits for the user. Only an answered approve exit with a non-empty plan
   * allows the tool; every other ending denies it and leaves Claude in plan mode.
   */
  private async exitPlanMode(sessionId: string, run: Running, input: Record<string, unknown>): Promise<PermissionResult> {
    const found = planText(input, run.lastPlanText, run.plansDir)
    for (const earlier of [...run.plans.values()]) {
      if (earlier.status === 'waiting' || earlier.status === 'not-answered') {
        this.appendPlan(sessionId, run, { ...withoutAsk(earlier), status: 'revised' })
      }
    }
    const version = ++run.planVersion
    const unchanged = !found.empty && found.text === run.lastPlanText
    if (!found.empty) run.lastPlanText = found.text
    const base: PlanItem = {
      kind: 'plan',
      version,
      status: 'waiting',
      text: found.text,
      ...(found.filePath === undefined ? {} : { filePath: found.filePath }),
      ...(found.empty ? { empty: true } : {}),
      ...(unchanged ? { unchanged: true } : {})
    }
    const pending: PendingPlan = {
      askId: null,
      settled: false,
      interrupt: Promise.withResolvers<PlanInterrupt>(),
      done: Promise.withResolvers<void>()
    }
    run.pendingPlan = pending
    const notAnswered = (reason: NonNullable<PlanItem['reason']>): void =>
      this.appendPlan(sessionId, run, { ...base, status: 'not-answered', reason })
    const keepPlanning = (message: string): PermissionResult => {
      notAnswered('feedback')
      return { behavior: 'deny', message }
    }
    try {
      const answered = (async (): Promise<{ kind: 'answer'; envelope: AskEnvelope | null }> => {
        try {
          const envelope = await this.context.createAsk(planSpec(), sessionId, {
            silent: true,
            onAsk: (askId) => {
              if (pending.settled) {
                void this.context.cancelAsk(askId).catch(() => {})
                return
              }
              pending.askId = askId
              this.appendPlan(sessionId, run, { ...base, askId })
            }
          })
          pending.settled = true
          return { kind: 'answer', envelope }
        } catch {
          pending.settled = true
          return { kind: 'answer', envelope: null }
        }
      })()
      const outcome = await Promise.race([answered, pending.interrupt.promise])
      if (outcome.kind !== 'answer' && pending.askId !== null) await this.context.cancelAsk(pending.askId).catch(() => {})
      if (outcome.kind === 'feedback') return keepPlanning(outcome.text.trim() === '' ? KEEP_PLANNING : outcome.text)
      if (outcome.kind === 'mode-switch') {
        notAnswered('mode-switch')
        return { behavior: 'deny', message: `The user switched to ${MODE_LABELS[outcome.mode]} mode. The plan was not approved.` }
      }
      if (outcome.kind === 'stopped') {
        notAnswered('stopped')
        return { behavior: 'deny', message: STOPPED_PLAN }
      }
      const decision = planDecision(outcome.envelope)
      if (decision.decision === 'keep') return keepPlanning(decision.message === '' ? KEEP_PLANNING : decision.message)
      if (decision.decision === 'stopped') {
        notAnswered('stopped')
        return { behavior: 'deny', message: STOPPED_PLAN }
      }
      if (found.empty) return keepPlanning(EMPTY_PLAN)
      const target = decision.decision === 'approve-auto' ? (run.autoAvailable ? 'auto' : 'acceptEdits') : 'default'
      this.appendPlan(sessionId, run, { ...base, status: 'approved', approvedMode: target })
      run.pendingApprovalTarget = target
      run.approvedVersion = version
      this.recordMode(sessionId, run, target)
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: target, destination: 'session' }]
      }
    } finally {
      run.pendingPlan = null
      pending.settled = true
      pending.done.resolve()
    }
  }

  /** Ends the wait on a plan that has not been answered or claimed yet. */
  private settlePlan(run: Running, interrupt: PlanInterrupt): void {
    const pending = run.pendingPlan
    if (!pending || pending.settled) return
    pending.settled = true
    pending.interrupt.resolve(interrupt)
  }

  private appendPlan(sessionId: string, run: Running, item: PlanItem): void {
    run.plans.set(item.version, item)
    this.context.appendMessage({ sessionId, role: 'system', text: `Plan v${item.version}: ${item.status}`, item })
  }

  private appendMode(sessionId: string, run: Running): void {
    this.context.appendMessage({
      sessionId,
      role: 'system',
      text: `Mode: ${MODE_LABELS[run.mode]}`,
      item: { kind: 'mode', mode: run.mode, autoAvailable: run.autoAvailable }
    })
  }

  /** Journals a mode change; a mode Claude already holds is not repeated. */
  private recordMode(sessionId: string, run: Running, mode: PermissionModeName): void {
    if (run.mode === mode) return
    run.mode = mode
    this.appendMode(sessionId, run)
  }

  private refreshAutoAvailable(sessionId: string, run: Running): void {
    if (run.models === null) return
    const current = run.settings.model ?? run.initModel
    const info = run.models.find((model) => model.value === current) ?? (run.settings.model === undefined ? run.models.find((model) => model.value === 'default') : undefined)
    const available = info?.supportsAutoMode === true
    if (available === run.autoAvailable) return
    run.autoAvailable = available
    this.appendMode(sessionId, run)
  }

  /** Learns which models offer Auto; best effort, so a failure leaves Auto unavailable. */
  private async loadModels(sessionId: string, run: Running): Promise<void> {
    if (!run.query.initializationResult) return
    try {
      const result = await run.query.initializationResult()
      if (run.stopped || run.ended) return
      run.models = result.models ?? []
      this.refreshAutoAvailable(sessionId, run)
    } catch {
      // without the model list Auto stays unavailable
    }
  }

  /** Follows the mode Claude reports, and corrects an approval into Auto that Claude did not honour. */
  private async reportMode(sessionId: string, run: Running, reported: unknown): Promise<void> {
    if (!isModeName(reported)) return
    if (run.pendingApprovalTarget === 'auto' && reported !== 'auto') {
      run.pendingApprovalTarget = null
      try {
        await run.query.setPermissionMode('acceptEdits')
      } catch {
        // the journaled mode still tells the user where Claude is headed
      }
      run.autoAvailable = false
      run.mode = 'acceptEdits'
      const approved = run.approvedVersion === null ? undefined : run.plans.get(run.approvedVersion)
      if (approved) this.appendPlan(sessionId, run, { ...approved, status: 'approved', approvedMode: 'acceptEdits' })
      this.appendMode(sessionId, run)
      this.context.appendMessage({ sessionId, role: 'system', text: AUTO_REFUSED, item: statusItem(AUTO_REFUSED) })
      return
    }
    this.recordMode(sessionId, run, reported)
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
    this.settlePlan(run, { kind: 'stopped' })
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
    if (msg?.type === 'system' && msg.subtype === 'init') {
      const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [])
      this.context.reportCommands?.(sessionId, [
        ...names(msg.slash_commands).map((name) => ({ name, kind: 'command' as const })),
        ...names(msg.skills).map((name) => ({ name, kind: 'skill' as const }))
      ])
      if (run && !run.initialized) {
        run.initialized = true
        run.initModel = typeof msg.model === 'string' ? msg.model : undefined
        void this.loadModels(sessionId, run)
      }
    }
    if (msg?.type === 'result' && run) run.pendingApprovalTarget = null
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
    for (const entry of claudeEntries(msg, run?.calls ?? new CallTracker())) this.append(sessionId, entry)
    if (run && msg?.type === 'system' && (msg.subtype === 'init' || msg.subtype === 'status')) {
      await this.reportMode(sessionId, run, msg.permissionMode)
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

function withoutAsk(item: PlanItem): PlanItem {
  const { askId: _askId, ...rest } = item
  return rest
}
