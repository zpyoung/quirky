import type { CanUseTool, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AskEnvelope, Session } from '@quirky/protocol'
import type { StructuredContext, StructuredSendOptions, StructuredStartOptions, StructuredRunner } from './runner'
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

export type ClaudeQueryParams = { prompt: AsyncIterable<SDKUserMessage>; options?: Options }

/** The slice of the SDK's `Query` the runner uses; the real object satisfies it. */
export type ClaudeQuery = AsyncIterable<any> & {
  interrupt(): Promise<unknown>
  close(): void
}

export type ClaudeRunnerDeps = {
  /** Replaces the SDK's `query`; tests inject a fake. The SDK is imported on first use otherwise. */
  query?: (params: ClaudeQueryParams) => ClaudeQuery
}

const DENIED = 'Denied from Quirky'
const INTERRUPT_TIMEOUT_MS = 2000

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
  calls: CallTracker
  stream: ProseStream
  turnStartedAt: number | null
  /** Prompts sent whose result has not arrived yet; a result closes one turn, not all of them. */
  openTurns: number
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
    const run: Running = {
      input,
      providerSessionId,
      providerSessionKnown: launchOptions.providerSession !== undefined,
      stopped: false,
      ended: false,
      calls: new CallTracker(),
      stream: new ProseStream(),
      turnStartedAt: hasPrompt ? Date.now() : null,
      openTurns: hasPrompt ? 1 : 0,
      query: query({
        prompt: input.messages,
        options: {
          cwd: session.cwd,
          pathToClaudeCodeExecutable,
          ...(launchOptions.providerSession === undefined ? {} : { resume: launchOptions.providerSession.id }),
          permissionMode: 'default',
          includePartialMessages: true,
          canUseTool: this.canUseTool(session.id),
          ...(launchOptions.env !== undefined ? { env: environmentOf(launchOptions.env) } : {}),
          ...(typeof launchOptions.model === 'string' ? { model: launchOptions.model } : {}),
          ...(typeof launchOptions.effort === 'string' ? { effort: launchOptions.effort as Options['effort'] } : {})
        }
      })
    }
    this.running.set(session.id, run)
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
        if (pending === 0 && this.running.has(sessionId)) this.context.setStatus(sessionId, 'working')
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
    if (msg?.type === 'assistant') run?.stream.reset()
    const failed = msg?.type === 'result' && (msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error')))
    if (msg?.type === 'result' && run) {
      for (const entry of closingEntries(run.calls, failed ? 'failed' : 'done')) this.append(sessionId, entry)
      run.openTurns = Math.max(0, run.openTurns - 1)
      run.turnStartedAt = run.openTurns > 0 ? Date.now() : null
    }
    for (const entry of claudeEntries(msg, run?.calls ?? new CallTracker())) this.append(sessionId, entry)
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
