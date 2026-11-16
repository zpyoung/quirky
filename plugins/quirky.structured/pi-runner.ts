import { constants, existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AskEnvelope, AskSpec, Session } from '@quirky/protocol'
import { capabilitiesFor } from './capabilities'
import {
  CallTracker,
  ProseStream,
  closingEntries,
  errorItem,
  oneLine,
  piEntries,
  statusItem,
  stderrLines,
  turnEndItem,
  userItem,
  type ItemEntry
} from './items'
import { approvalOutcome, approvalSpec, nativeQuestionPlan } from './native-questions'
import { MAX_IMAGE_BYTES } from './queue'
import {
  PiRpc,
  PiRpcError,
  describeExit,
  piLaunchArgs,
  spawnPiTransport,
  type PiExit,
  type PiFrame,
  type PiTransportFactory,
  type PiVariant
} from './pi-rpc'
import type { StructuredContext, StructuredRunner, StructuredSendOptions, StructuredStartOptions } from './runner'

export type PiRunnerDeps = {
  /** Replaces the child process; tests inject a scripted fake. */
  transport?: PiTransportFactory
  /** The base child environment before the launch patch; production inherits the daemon's. */
  env?: NodeJS.ProcessEnv
}

const STARTUP_TIMEOUT_MS = 60_000
const SEND_TIMEOUT_MS = 45_000
const ABORT_TIMEOUT_MS = 2_000
const QUESTION_LIMIT = 300

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

type EncodedImage = { type: 'image'; data: string; mimeType: string }

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
    return { type: 'image', data: data.toString('base64'), mimeType: IMAGE_MEDIA_TYPES[extname(path).toLowerCase()] ?? 'image/png' }
  } finally {
    await handle.close()
  }
}

const ALLOW_LABEL = /^(allow|yes|approve|accept|ok|proceed|continue|run)\b/i
const DENY_LABEL = /^(deny|no|block|reject|decline|cancel|abort|stop|don't|do not)\b/i

type Running = {
  sessionId: string
  rpc: PiRpc
  ready: boolean
  ended: boolean
  stopped: boolean
  working: boolean
  idleStatus: 'running' | 'done'
  failedTurn: boolean
  turnStartedAt: number | null
  calls: CallTracker
  stream: ProseStream
  pendingDialogs: number
  cancelledDialogs: Set<string>
  deniedReasons: string[]
}

type Starting = { stopped: boolean; run?: Running }

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function environmentWithPatch(base: NodeJS.ProcessEnv, patch?: Record<string, string | null>): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (value === null) delete env[name]
    else env[name] = value
  }
  return env
}

/** The allow and deny labels of a select that is a yes/no approval, or null when it is a real choice. */
function approvalOptions(options: string[]): { allow: string; deny: string } | null {
  const allow = options.find((option) => ALLOW_LABEL.test(option))
  const deny = options.find((option) => DENY_LABEL.test(option))
  return allow !== undefined && deny !== undefined && allow !== deny ? { allow, deny } : null
}

/**
 * Runs pi or omp sessions in the background over their `--mode rpc` JSON protocol, with no PTY:
 * one child per Quirky session, every event journaled as a chat item through `context`, and
 * extension dialogs and omp's `ask` surfaced as asks.
 *
 * `deps.transport` is the test seam; production callers pass only the context and variant.
 */
export function createPiRunner(context: StructuredContext, variant: PiVariant, deps: PiRunnerDeps = {}): StructuredRunner {
  return new PiRunner(context, variant, deps)
}

class PiRunner implements StructuredRunner {
  private readonly running = new Map<string, Running>()
  private readonly starting = new Map<string, Starting>()

  constructor(
    private readonly context: StructuredContext,
    private readonly variant: PiVariant,
    private readonly deps: PiRunnerDeps
  ) {}

  async start(session: Session, prompt: string | undefined, options: StructuredStartOptions = {}): Promise<void> {
    if (session.agent !== this.variant) throw new Error(`this runner serves ${this.variant} sessions only`)
    if (this.running.has(session.id) || this.starting.has(session.id)) throw new Error('session is already connected')
    const startup: Starting = { stopped: false }
    this.starting.set(session.id, startup)
    try {
      const executable = await this.context.resolvePiPath(this.variant)
      if (startup.stopped) return
      const providerSession = options.providerSession
      const resume =
        providerSession === undefined
          ? undefined
          : providerSession.transcriptPath && existsSync(providerSession.transcriptPath)
            ? providerSession.transcriptPath
            : providerSession.id
      const run = this.createRun(session, executable, options, resume)
      startup.run = run
      try {
        const state = record(await run.rpc.request('get_state', {}, STARTUP_TIMEOUT_MS))
        if (startup.stopped) return
        const sessionId = text(state?.sessionId)
        if (sessionId === '') throw new Error(`${this.variant} did not report a session id`)
        if (providerSession !== undefined && sessionId !== providerSession.id) {
          throw new Error(`${this.variant} resumed session ${sessionId}, expected ${providerSession.id}`)
        }
        await this.context.setProviderSession(session.id, {
          id: sessionId,
          transcriptPath: text(state?.sessionFile) || null
        })
        if (startup.stopped) return
        if (this.variant === 'omp') await run.rpc.request('set_ask_dialog', { enabled: true }).catch(() => undefined)
        if (startup.stopped) return
        this.running.set(session.id, run)
        run.ready = true
        if (prompt === undefined || prompt === '') this.context.setStatus(session.id, 'running')
        else await this.submit(run, prompt, {})
      } catch (error) {
        await run.rpc.close()
        if (startup.stopped) return
        throw error instanceof PiRpcError ? new Error(error.message, { cause: error }) : error
      }
    } finally {
      if (this.starting.get(session.id) === startup) this.starting.delete(session.id)
    }
  }

  async send(sessionId: string, message: string, options: StructuredSendOptions = {}): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.ended || !run.ready) throw new Error('session is not running')
    await this.submit(run, message, options)
  }

  async stop(sessionId: string): Promise<void> {
    const startup = this.starting.get(sessionId)
    if (startup) {
      startup.stopped = true
      await startup.run?.rpc.close()
    }
    const run = this.running.get(sessionId)
    if (!run || run.stopped) return
    run.stopped = true
    this.running.delete(sessionId)
    this.closeTurn(run, 'stopped')
    try {
      await run.rpc.request('abort', {}, ABORT_TIMEOUT_MS)
    } catch {
      // closing the child below is the bounded fallback for an agent that does not answer the abort
    }
    await run.rpc.close()
    this.context.setStatus(sessionId, 'exited')
  }

  private createRun(session: Session, executable: string, options: StructuredStartOptions, resume: string | undefined): Running {
    const run: Running = {
      sessionId: session.id,
      rpc: undefined as unknown as PiRpc,
      ready: false,
      ended: false,
      stopped: false,
      working: false,
      idleStatus: 'running',
      failedTurn: false,
      turnStartedAt: null,
      calls: new CallTracker(),
      stream: new ProseStream(),
      pendingDialogs: 0,
      cancelledDialogs: new Set(),
      deniedReasons: []
    }
    run.rpc = new PiRpc(
      {
        executable,
        args: piLaunchArgs(this.variant, {
          ...(typeof options.model === 'string' ? { model: options.model } : {}),
          ...(typeof options.effort === 'string' ? { effort: options.effort } : {}),
          ...(resume === undefined ? {} : { resume })
        }),
        cwd: session.cwd,
        env: environmentWithPatch(this.deps.env ?? process.env, options.env)
      },
      { event: (frame) => this.onFrame(run, frame), exit: (exit) => this.onExit(run, exit) },
      this.context.process,
      this.deps.transport ?? spawnPiTransport
    )
    return run
  }

  private append(run: Running, entry: ItemEntry): void {
    this.context.appendMessage({ sessionId: run.sessionId, role: entry.role, text: entry.text, data: entry.data, item: entry.item })
  }

  private beginTurn(run: Running): void {
    if (run.working) return
    run.working = true
    run.failedTurn = false
    run.turnStartedAt = Date.now()
    this.context.setStatus(run.sessionId, 'working')
  }

  /** Ends the open turn: closes calls still running, journals `turn-end` and reports the session idle. */
  private finishTurn(run: Running, state: 'done' | 'failed'): void {
    if (!run.working) return
    this.closeTurn(run, state)
    run.idleStatus = 'done'
    this.context.setStatus(run.sessionId, 'done')
    this.sendDenialReasons(run)
  }

  /** Journals the end of the open turn without changing the session status; a turn that is not open is left alone. */
  private closeTurn(run: Running, state: 'done' | 'stopped' | 'failed'): void {
    if (!run.working) return
    for (const entry of closingEntries(run.calls, state)) this.append(run, entry)
    this.context.appendMessage({
      sessionId: run.sessionId,
      role: 'result',
      text: state === 'done' ? 'Turn finished' : state === 'stopped' ? 'Turn stopped' : 'Turn failed',
      item: turnEndItem(state, run.turnStartedAt === null ? undefined : Date.now() - run.turnStartedAt)
    })
    run.working = false
    run.turnStartedAt = null
    run.stream.reset()
  }

  private async submit(run: Running, message: string, options: StructuredSendOptions): Promise<void> {
    const images = options.images !== undefined && options.images.length > 0 ? await Promise.all(options.images.map(encodeImage)) : []
    if (run.stopped || run.ended) throw new Error('session is not running')
    this.context.appendMessage({
      sessionId: run.sessionId,
      role: 'user',
      text: message,
      data: { text: message, ...(options.images === undefined ? {} : { images: options.images }) },
      item: userItem(message, options.images, options.queuedId)
    })
    const steering = run.working
    if (!steering) this.beginTurn(run)
    const params = { message, ...(images.length > 0 ? { images } : {}), ...(steering ? {} : { streamingBehavior: 'steer' }) }
    try {
      const data = record(await run.rpc.request(steering ? 'steer' : 'prompt', params, SEND_TIMEOUT_MS))
      if (!steering && (data?.disposition === 'handled' || data?.agentInvoked === false)) this.finishTurn(run, 'done')
    } catch (error) {
      if (run.stopped || run.ended) return
      const reason = error instanceof Error ? error.message : String(error)
      this.context.appendMessage({
        sessionId: run.sessionId,
        role: 'system',
        text: `${this.variant} did not accept the message: ${reason}`,
        item: errorItem('protocol', stderrLines(reason), true)
      })
      if (!steering) {
        run.failedTurn = true
        this.finishTurn(run, 'failed')
      }
    }
  }

  private onFrame(run: Running, frame: PiFrame): void {
    if (run.stopped || run.ended) return
    try {
      this.handleFrame(run, frame)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: `${this.variant} event ${text(frame.type)}: ${message}`, item: statusItem(`could not read a ${text(frame.type)} event`) })
    }
  }

  private handleFrame(run: Running, frame: PiFrame): void {
    switch (frame.type) {
      case 'agent_start':
        this.beginTurn(run)
        return
      case 'message_update': {
        const delta = record(frame.assistantMessageEvent)
        if (delta?.type !== 'text_delta' || typeof delta.delta !== 'string') return
        const item = run.stream.push(text(frame.messageId) || 'assistant', delta.delta, Date.now())
        if (item && item.kind === 'prose') {
          this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: item.text, data: { streaming: true }, item })
        }
        return
      }
      case 'message_end': {
        const message = record(frame.message)
        if (message?.role !== 'assistant') return
        run.stream.reset()
        const content = Array.isArray(message.content) ? message.content : []
        const body = content
          .map((part) => (record(part)?.type === 'text' ? text(record(part)?.text) : ''))
          .join('')
        if (body !== '') this.context.appendMessage({ sessionId: run.sessionId, role: 'assistant', text: body, data: frame, item: { kind: 'prose', text: body } })
        if (message.stopReason === 'error') {
          run.failedTurn = true
          const reason = text(message.errorMessage) || `${this.variant} stopped with an error`
          this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: reason, data: frame, item: statusItem(oneLine(reason)) })
        }
        return
      }
      case 'tool_execution_start':
      case 'tool_execution_end':
        for (const entry of piEntries(frame, run.calls)) this.append(run, entry)
        return
      case 'agent_settled':
        this.finishTurn(run, run.failedTurn ? 'failed' : 'done')
        return
      case 'agent_end':
        if (this.variant === 'omp' && frame.isTerminal !== false && frame.yielded !== false) {
          this.finishTurn(run, run.failedTurn ? 'failed' : 'done')
        }
        return
      case 'extension_ui_request':
        this.onUiRequest(run, frame)
        return
      case 'auto_retry_start':
        this.status(run, `Retrying after an error${text(frame.errorMessage) ? `: ${oneLine(text(frame.errorMessage))}` : ''}`, frame)
        return
      case 'auto_compaction_start':
      case 'manual_compaction_start':
      case 'compaction_start':
        this.status(run, 'Compacting the conversation', frame)
        return
      case 'extension_error':
        this.status(run, `Extension error: ${oneLine(text(frame.error))}`, frame)
        return
      case 'notice':
        this.status(run, oneLine(text(frame.message)) || 'Notice', frame)
        return
      case 'prompt_result': {
        const error = record(frame.error)
        if (frame.status === 'error') this.status(run, oneLine(text(error?.message)) || `${this.variant} could not finish the prompt`, frame)
        return
      }
      default:
        return
    }
  }

  private status(run: Running, message: string, data: unknown): void {
    this.context.appendMessage({ sessionId: run.sessionId, role: 'system', text: message, data, item: statusItem(message) })
  }

  private onExit(run: Running, exit: PiExit): void {
    if (run.stopped || run.ended) return
    run.ended = true
    if (!run.ready) return
    this.running.delete(run.sessionId)
    const wasWorking = run.working
    this.closeTurn(run, 'failed')
    const tail = exit.stderrTail.length > 0 ? exit.stderrTail : stderrLines(describeExit(exit))
    if (exit.protocolError !== undefined || exit.code !== 0 || wasWorking || exit.stderrTail.length > 0) {
      this.context.appendMessage({
        sessionId: run.sessionId,
        role: 'system',
        text: `${this.variant} ${describeExit(exit)}`,
        item: errorItem(exit.protocolError === undefined ? 'exited' : 'protocol', tail, capabilitiesFor(this.variant)?.resume.ok === true)
      })
    }
    this.context.setStatus(run.sessionId, 'exited')
    void run.rpc.close()
  }

  private onUiRequest(run: Running, frame: PiFrame): void {
    const id = text(frame.id)
    switch (frame.method) {
      case 'select':
      case 'confirm':
      case 'input':
      case 'editor':
      case 'ask':
        if (id !== '') void this.dialog(run, id, frame)
        return
      case 'cancel':
        run.cancelledDialogs.add(text(frame.targetId))
        return
      case 'notify':
        if (text(frame.message) !== '') this.status(run, oneLine(text(frame.message)), frame)
        return
      default:
        return
    }
  }

  private async dialog(run: Running, id: string, frame: PiFrame): Promise<void> {
    run.pendingDialogs++
    this.context.setStatus(run.sessionId, 'waiting')
    let response: PiFrame
    try {
      response = await this.answer(run, frame)
    } catch {
      response = { cancelled: true }
    } finally {
      run.pendingDialogs--
      if (!run.stopped && !run.ended && run.pendingDialogs === 0) {
        this.context.setStatus(run.sessionId, run.working ? 'working' : run.idleStatus)
      }
    }
    if (run.stopped || run.ended) return
    if (!run.cancelledDialogs.delete(id)) {
      try {
        run.rpc.send({ type: 'extension_ui_response', id, ...response })
      } catch {
        // an agent that closed its input ends the run through the exit handler
      }
    }
    this.sendDenialReasons(run)
  }

  private async ask(run: Running, spec: AskSpec): Promise<AskEnvelope | null> {
    try {
      return await this.context.createAsk(spec, run.sessionId, { nativeQuestion: true })
    } catch {
      return null
    }
  }

  private async approve(run: Running, question: string): Promise<boolean> {
    let envelope: AskEnvelope | null = null
    try {
      envelope = await this.context.createAsk(approvalSpec(oneLine(question, QUESTION_LIMIT)), run.sessionId)
    } catch {
      envelope = null
    }
    const outcome = approvalOutcome(envelope, false)
    if (outcome.reason !== undefined) run.deniedReasons.push(outcome.reason)
    return outcome.decision !== 'deny'
  }

  private async answer(run: Running, frame: PiFrame): Promise<PiFrame> {
    const title = text(frame.title)
    switch (frame.method) {
      case 'confirm':
        return { confirmed: await this.approve(run, [title, text(frame.message)].filter(Boolean).join(': ') || 'Allow this?') }
      case 'select': {
        const options = (Array.isArray(frame.options) ? frame.options : []).filter((option): option is string => typeof option === 'string')
        const approval = approvalOptions(options)
        if (approval) return { value: (await this.approve(run, title || 'Allow this?')) ? approval.allow : approval.deny }
        const envelope = await this.ask(run, {
          questions: [{ id: 'answer', type: 'select', question: title || 'Choose one', options: options.map((label, index) => ({ value: `o${index + 1}`, label })) }]
        })
        const answer = envelope?.status === 'answered' || envelope?.status === 'partial' ? envelope.answers.answer : undefined
        if (!answer || !('value' in answer) || typeof answer.value !== 'string') return { cancelled: true }
        const index = /^o(\d+)$/.exec(answer.value)?.[1]
        return { value: options[Number(index) - 1] ?? answer.label ?? answer.value }
      }
      case 'input':
      case 'editor': {
        if (frame.secret === true) return { cancelled: true }
        const prefill = text(frame.prefill)
        const envelope = await this.ask(run, {
          questions: [
            {
              id: 'answer',
              type: 'text',
              question: title || 'Your input is needed',
              multiline: frame.method === 'editor',
              ...(prefill === '' ? {} : { default: prefill })
            }
          ]
        })
        const answer = envelope?.status === 'answered' || envelope?.status === 'partial' ? envelope.answers.answer : undefined
        return answer && 'value' in answer && typeof answer.value === 'string' ? { value: answer.value } : { cancelled: true }
      }
      case 'ask':
        return this.answerQuestions(run, frame)
      default:
        return { cancelled: true }
    }
  }

  /** Answers omp's multi-question `ask` request; a skipped question fails the whole ask rather than guessing. */
  private async answerQuestions(run: Running, frame: PiFrame): Promise<PiFrame> {
    const questions = (Array.isArray(frame.questions) ? frame.questions : []).flatMap((entry) => {
      const fields = record(entry)
      if (!fields) return []
      const options = (Array.isArray(fields.options) ? fields.options : []).flatMap((option) => {
        const label = text(record(option)?.label)
        return label === '' ? [] : [{ label, ...(text(record(option)?.description) ? { description: text(record(option)?.description) } : {}) }]
      })
      return [{ id: text(fields.id) || undefined, question: text(fields.question), header: text(fields.header) || undefined, multiSelect: fields.multi === true, options }]
    })
    let plan: ReturnType<typeof nativeQuestionPlan>
    try {
      plan = nativeQuestionPlan({ questions }, 'codex')
    } catch {
      return { cancelled: true }
    }
    const envelope = await this.ask(run, plan.spec)
    if (envelope?.status !== 'answered' && envelope?.status !== 'partial') return { cancelled: true }
    const answers = []
    for (const { id } of plan.keys) {
      const answer = envelope.answers[id]
      if (!answer) return { cancelled: true }
      if ('values' in answer) {
        answers.push({ id, selectedOptions: answer.labels, ...(answer.other ? { customInput: answer.other } : {}) })
      } else if ('label' in answer && typeof answer.label === 'string' && answer.source === 'option') {
        answers.push({ id, selectedOptions: [answer.label] })
      } else {
        answers.push({ id, selectedOptions: [], customInput: String(answer.value) })
      }
    }
    return { answers }
  }

  /** Tells the agent why a request was denied, once no dialog is still pending; the agent's RPC has no field for a reason. */
  private sendDenialReasons(run: Running): void {
    if (run.pendingDialogs > 0 || run.deniedReasons.length === 0 || run.stopped || run.ended) return
    const reasons = run.deniedReasons.splice(0).map((reason) => `Denied: ${reason}`).join('\n')
    void this.send(run.sessionId, reasons).catch(() => {})
  }
}
