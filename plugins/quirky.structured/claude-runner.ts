import { randomUUID } from 'node:crypto'
import type { CanUseTool, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AskEnvelope, Session } from '@quirky/protocol'
import type { StructuredContext, StructuredRunner, StructuredStartOptions } from './runner'

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
const SUMMARY_LIMIT = 160
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
  providerSessionId: string
  stopped: boolean
  ended: boolean
}

function userMessage(text: string, claudeSessionId: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: claudeSessionId
  } as SDKUserMessage
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

function oneLine(text: string, limit = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value) return oneLine(value)
  }
  return oneLine(JSON.stringify(input) ?? '')
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function resultText(msg: any): string {
  const summary =
    typeof msg.result === 'string' && msg.result
      ? msg.result
      : [msg.subtype, ...(Array.isArray(msg.errors) ? msg.errors : [])].filter(Boolean).join(': ') || 'finished'
  const details: string[] = []
  if (typeof msg.total_cost_usd === 'number') details.push(`$${msg.total_cost_usd.toFixed(4)}`)
  if (typeof msg.duration_ms === 'number') details.push(`${(msg.duration_ms / 1000).toFixed(1)}s`)
  return details.length ? `${summary}\n(${details.join(', ')})` : summary
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

  async start(session: Session, prompt?: string, launchOptions: StructuredStartOptions = {}): Promise<void> {
    if (session.agent !== 'claude') throw new Error('structured sessions support claude only')
    const providerSession = launchOptions.providerSession
    if (prompt === undefined && providerSession === undefined) {
      throw new Error('a structured Claude session needs an initial prompt or provider session')
    }
    const providerSessionId = providerSession?.id ?? randomUUID()
    const startup = { stopped: false }
    this.starting.set(session.id, startup)
    try {
      // Load this provider only when the runtime provider registry selects Claude, not for Codex sessions.
      const query = this.deps.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query
      if (startup.stopped) return
      const pathToClaudeCodeExecutable = await this.context.resolveClaudePath()
      if (startup.stopped) return
      await this.context.setProviderSession(session.id, {
        id: providerSessionId,
        transcriptPath: providerSession?.transcriptPath ?? null
      })
      if (startup.stopped) return
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
    providerSessionId: string
  ): void {
    const input = createInputStream()
    if (prompt !== undefined) {
      const first = userMessage(prompt, providerSessionId)
      this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt, data: first })
      input.push(first)
    }
    this.context.setStatus(session.id, prompt === undefined ? 'running' : 'working')
    const run: Running = {
      input,
      providerSessionId,
      stopped: false,
      ended: false,
      query: query({
        prompt: input.messages,
        options: {
          cwd: session.cwd,
          pathToClaudeCodeExecutable,
          ...(launchOptions.providerSession === undefined
            ? { sessionId: providerSessionId }
            : { resume: providerSessionId }),
          permissionMode: 'default',
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

  async send(sessionId: string, text: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.ended) throw new Error('session is not running')
    const message = userMessage(text, run.providerSessionId)
    this.context.appendMessage({ sessionId, role: 'user', text, data: message })
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
        envelope = await this.context.createAsk(
          {
            questions: [
              {
                id: 'decision',
                type: 'select',
                question: `Allow ${toolName}? ${summarizeInput(input)}`.trim(),
                options: [
                  { value: 'allow', label: 'Allow' },
                  { value: 'deny', label: 'Deny' },
                  { value: 'always', label: 'Always allow', description: `${toolName} for the rest of this session` }
                ]
              }
            ]
          },
          sessionId
        )
      } catch {
        envelope = null
      } finally {
        pending--
        if (pending === 0 && this.running.has(sessionId)) this.context.setStatus(sessionId, 'working')
      }
      const answer = envelope?.status === 'answered' ? envelope.answers.decision : undefined
      const value = answer && 'value' in answer ? answer.value : undefined
      if (value === 'allow') return { behavior: 'allow', updatedInput: input }
      if (value === 'always') {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [
            { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }
          ]
        }
      }
      return { behavior: 'deny', message: DENIED }
    }
  }

  private async pump(sessionId: string, run: Running): Promise<void> {
    let failure: Error | null = null
    try {
      for await (const msg of run.query) {
        if (run.stopped || run.ended) break
        this.journal(sessionId, msg)
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    run.ended = true
    if (run.stopped || this.running.get(sessionId) !== run) return
    this.running.delete(sessionId)
    if (failure) {
      this.context.appendMessage({ sessionId, role: 'system', text: `claude failed: ${failure.message}` })
    }
    this.context.setStatus(sessionId, 'exited')
  }

  private journal(sessionId: string, msg: any): void {
    const append = (role: Parameters<StructuredContext['appendMessage']>[0]['role'], text: string, data: unknown) =>
      this.context.appendMessage({ sessionId, role, text, data })
    switch (msg?.type) {
      case 'assistant': {
        const content: any[] = Array.isArray(msg.message?.content) ? msg.message.content : []
        const toolUses = content.filter((block) => block?.type === 'tool_use')
        const text = content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        if (text || toolUses.length === 0) append('assistant', text, msg)
        for (const block of toolUses) append('tool', `${block.name}: ${summarizeInput(block.input)}`, block)
        return
      }
      case 'user': {
        const content = msg.message?.content
        if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) {
          const text = content
            .filter((block: any) => block?.type === 'tool_result')
            .map((block: any) => blockText(block.content))
            .join('\n')
          append('tool', text, msg)
        } else {
          append('user', blockText(content), msg)
        }
        return
      }
      case 'system':
        append('system', msg.subtype === 'init' ? `session started${msg.model ? ` (${msg.model})` : ''}` : `system: ${msg.subtype ?? 'event'}`, msg)
        return
      case 'result':
        append('result', resultText(msg), msg)
        const failed = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))
        if (failed) {
          const run = this.running.get(sessionId)
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
        return
      default:
        append('system', String(msg?.type ?? 'event'), msg)
    }
  }
}
