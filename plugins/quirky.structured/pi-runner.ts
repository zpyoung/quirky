import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Session } from '@quirky/protocol'
import type { StructuredContext, StructuredRunner, StructuredStartOptions, ToolPolicy } from './runner'

const TOOLS_DISABLED = 'tools are disabled for this session'
const STDERR_TAIL_CHARS = 16 * 1024
const MAX_FRAME_CHARS = 4 * 1024 * 1024
const TERM_GRACE_MS = 2_000
const SUMMARY_LIMIT = 160
const STATE_REQUEST_ID = 'quirky-state'

type PiAgent = 'pi' | 'omp'

/**
 * Finds the user's `pi` or `omp` executable the way their terminal would: `command -v` in a login
 * shell, so PATH entries added by shell profiles count. Throws when nothing is found.
 */
export async function resolvePiThroughLoginShell(shell: string, agent: PiAgent): Promise<string> {
  const child = spawn(shell, ['-l', '-c', `command -v ${agent}`], { stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = Promise.withResolvers<number | null>()
  child.once('error', closed.reject)
  child.once('close', (code) => closed.resolve(code))
  const output = (async () => {
    let text = ''
    for await (const chunk of child.stdout) text += Buffer.from(chunk).toString('utf8')
    return text
  })()
  const [text, exitCode] = await Promise.all([output, closed.promise])
  const executable = text.trim().split('\n').at(-1) ?? ''
  if (exitCode !== 0 || !executable) throw new Error(`could not find the ${agent} executable on the login shell PATH`)
  return executable
}

function environmentWithPatch(patch?: Record<string, string | null>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (value === null) delete env[name]
    else env[name] = value
  }
  return env
}

function oneLine(text: string, limit = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  for (const key of ['command', 'path', 'file_path', 'pattern', 'url', 'query']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value) return oneLine(value)
  }
  return oneLine(JSON.stringify(args) ?? '')
}

function contextTokensOf(message: Record<string, unknown>): number | null {
  const usage = message.usage
  if (typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>
  return count(u.totalTokens) || count(u.input) + count(u.output) + count(u.cacheRead) + count(u.cacheWrite)
}

type Running = {
  session: Session
  agent: PiAgent
  toolPolicy: ToolPolicy
  child: ChildProcessWithoutNullStreams
  buffer: string
  stderr: string
  contextWindow: number | null
  lastContextTokens: number | null
  working: boolean
  stopped: boolean
  exited: boolean
  closed: Promise<void>
}

/**
 * Runs Pi and Oh My Pi sessions in the background through their `--mode rpc` stdio protocol, with
 * no PTY: JSON lines in (prompts), JSON lines out (events). Assistant messages are journaled as
 * they end and `agent_end` settles the session as done.
 *
 * A `deny-all` session starts the CLI with no tools; any tool execution that happens anyway aborts
 * the turn and is journaled as refused. Extension dialogs are always cancelled, never answered.
 */
export function createPiRunner(context: StructuredContext): StructuredRunner {
  return new PiRunner(context)
}

class PiRunner implements StructuredRunner {
  private readonly running = new Map<string, Running>()
  private readonly starting = new Map<string, { stopped: boolean }>()

  constructor(private readonly context: StructuredContext) {}

  async start(session: Session, prompt?: string, options: StructuredStartOptions = {}): Promise<void> {
    if (session.agent !== 'pi' && session.agent !== 'omp') throw new Error('structured sessions support pi and omp only')
    if (options.providerSession !== undefined) throw new Error(`${session.agent} sessions cannot be resumed`)
    if (this.running.has(session.id) || this.starting.has(session.id)) throw new Error('session is already connected')
    const agent: PiAgent = session.agent
    const startup = { stopped: false }
    this.starting.set(session.id, startup)
    try {
      const resolvePath = this.context.resolvePiPath
      if (!resolvePath) throw new Error(`no way to resolve the ${agent} executable`)
      const executable = await resolvePath.call(this.context, agent)
      if (startup.stopped) return
      this.launch(session, agent, executable, prompt, options)
    } finally {
      if (this.starting.get(session.id) === startup) this.starting.delete(session.id)
    }
  }

  private launch(session: Session, agent: PiAgent, executable: string, prompt: string | undefined, options: StructuredStartOptions): void {
    const toolPolicy = options.toolPolicy ?? 'default'
    const args = [
      '--mode',
      'rpc',
      ...(toolPolicy === 'deny-all' ? ['--no-tools'] : []),
      ...(typeof options.model === 'string' ? ['--model', options.model] : [])
    ]
    const child = spawn(executable, args, {
      cwd: session.cwd,
      env: environmentWithPatch(options.env),
      stdio: 'pipe',
      detached: process.platform !== 'win32'
    })
    const closed = Promise.withResolvers<void>()
    const run: Running = {
      session,
      agent,
      toolPolicy,
      child,
      buffer: '',
      stderr: '',
      contextWindow: null,
      lastContextTokens: null,
      working: false,
      stopped: false,
      exited: false,
      closed: closed.promise
    }
    this.running.set(session.id, run)
    child.stdout.on('data', (chunk: Buffer) => this.read(run, chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      run.stderr = (run.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    child.stdin.on('error', () => {})
    child.once('error', (error) => this.exit(run, closed.resolve, `could not start ${agent}: ${error.message}`))
    child.once('close', (code, signal) =>
      this.exit(run, closed.resolve, `${agent} exited${code === null ? ` (${signal})` : ` with code ${code}`}`)
    )
    this.write(run, { id: STATE_REQUEST_ID, type: 'get_state' })
    if (prompt === undefined || prompt === '') {
      this.context.setStatus(session.id, 'running')
      return
    }
    this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt, data: { type: 'prompt', message: prompt } })
    this.context.setStatus(session.id, 'working')
    run.working = true
    this.write(run, { type: 'prompt', message: prompt })
  }

  async send(sessionId: string, text: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.exited) throw new Error('session is not running')
    const command = run.working ? { type: 'steer', message: text } : { type: 'prompt', message: text }
    this.context.appendMessage({ sessionId, role: 'user', text, data: command })
    this.context.setStatus(sessionId, 'working')
    run.working = true
    this.write(run, command)
  }

  async stop(sessionId: string): Promise<void> {
    const startup = this.starting.get(sessionId)
    if (startup) startup.stopped = true
    const run = this.running.get(sessionId)
    if (!run || run.stopped) return
    run.stopped = true
    this.running.delete(sessionId)
    this.terminate(run)
    await Promise.race([run.closed, new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS * 2))])
    this.context.setStatus(sessionId, 'exited')
  }

  private write(run: Running, command: Record<string, unknown>): void {
    if (run.stopped || run.exited) return
    try {
      run.child.stdin.write(`${JSON.stringify(command)}\n`)
    } catch {
      // the close event reports a dead process
    }
  }

  private terminate(run: Running): void {
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && run.child.pid !== undefined) process.kill(-run.child.pid, name)
        else run.child.kill(name)
      } catch {
        // already gone
      }
    }
    try {
      run.child.stdin.end()
    } catch {
      // already closed
    }
    signal('SIGTERM')
    const timer = setTimeout(() => signal('SIGKILL'), TERM_GRACE_MS)
    void run.closed.then(() => clearTimeout(timer))
  }

  private exit(run: Running, settle: () => void, reason: string): void {
    if (run.exited) return
    run.exited = true
    settle()
    if (run.stopped || this.running.get(run.session.id) !== run) return
    this.running.delete(run.session.id)
    const tail = run.stderr.trim()
    this.context.appendMessage({
      sessionId: run.session.id,
      role: 'system',
      text: tail ? `${reason}; stderr: ${oneLine(tail, 400)}` : reason
    })
    this.context.setStatus(run.session.id, 'exited')
  }

  private read(run: Running, chunk: Buffer): void {
    run.buffer += chunk.toString('utf8')
    if (run.buffer.length > MAX_FRAME_CHARS) {
      run.buffer = ''
      this.append(run, 'system', 'dropped an oversized rpc frame')
      return
    }
    for (;;) {
      const newline = run.buffer.indexOf('\n')
      if (newline < 0) return
      const line = run.buffer.slice(0, newline).replace(/\r$/, '')
      run.buffer = run.buffer.slice(newline + 1)
      if (!line) continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        this.append(run, 'system', `unreadable ${run.agent} output: ${oneLine(line)}`)
        continue
      }
      if (typeof event === 'object' && event !== null && !Array.isArray(event)) this.handle(run, event as Record<string, any>)
    }
  }

  private append(run: Running, role: Parameters<StructuredContext['appendMessage']>[0]['role'], text: string, data?: unknown): void {
    if (run.stopped) return
    this.context.appendMessage({ sessionId: run.session.id, role, text, ...(data === undefined ? {} : { data }) })
  }

  private handle(run: Running, event: Record<string, any>): void {
    if (run.stopped) return
    switch (event.type) {
      case 'response': {
        if (event.command === 'get_state' && event.success === true) {
          const window = event.data?.model?.contextWindow
          if (typeof window === 'number' && Number.isFinite(window) && window > 0) run.contextWindow = window
          return
        }
        if (event.success === false) {
          this.append(run, 'system', `${run.agent} rejected ${String(event.command ?? 'command')}: ${String(event.error ?? 'unknown error')}`, event)
          if (event.command === 'prompt' || event.command === 'steer') {
            run.working = false
            this.context.setStatus(run.session.id, 'done')
          }
        }
        return
      }
      case 'message_end': {
        const message = event.message
        if (typeof message !== 'object' || message === null || message.role !== 'assistant') return
        run.lastContextTokens = contextTokensOf(message) ?? run.lastContextTokens
        const text = textOf(message.content)
        if (text) this.append(run, 'assistant', text, message)
        if (message.stopReason === 'error' && typeof message.errorMessage === 'string') {
          this.append(run, 'system', `${run.agent} error: ${message.errorMessage}`, message)
        }
        return
      }
      case 'tool_execution_start': {
        if (run.toolPolicy === 'deny-all') {
          this.append(run, 'system', TOOLS_DISABLED, event)
          this.write(run, { type: 'abort' })
          return
        }
        this.append(run, 'tool', `${String(event.toolName ?? 'tool')}: ${summarizeArgs(event.args)}`, event)
        return
      }
      case 'tool_execution_end': {
        if (run.toolPolicy === 'deny-all') return
        this.append(run, 'tool', textOf(event.result?.content) || String(event.toolName ?? 'tool'), event)
        return
      }
      case 'extension_ui_request': {
        if (typeof event.id === 'string' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
          this.write(run, { type: 'extension_ui_response', id: event.id, cancelled: true })
        }
        return
      }
      case 'agent_end': {
        const usage =
          run.lastContextTokens === null ? null : { contextTokens: run.lastContextTokens, contextWindow: run.contextWindow }
        run.lastContextTokens = null
        run.working = false
        this.append(run, 'result', `${run.agent} turn completed`, { type: 'agent_end', ...(usage ? { usage } : {}) })
        this.context.setStatus(run.session.id, 'done')
        return
      }
    }
  }
}
