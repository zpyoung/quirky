import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Session } from '@quirky/protocol'
import type { StructuredContext, StructuredRunner, StructuredStartOptions, ToolPolicy } from './runner'

const TOOLS_DISABLED = 'tools are disabled for this session'
const STDERR_TAIL_CHARS = 16 * 1024
const MAX_FRAME_BYTES = 256 * 1024 * 1024
const TERM_GRACE_MS = 2_000
const SUMMARY_LIMIT = 160
const STATE_REQUEST_ID = 'quirky-state'

type PiAgent = 'pi' | 'omp'

// omp rejects --no-mcp, so its offered tools must be checked rather than switched off
const DENY_ALL_ARGS = { pi: ['--no-tools', '--no-extensions', '--no-mcp'], omp: ['--no-tools', '--no-extensions'] }

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
  return (count(u.totalTokens) || count(u.input) + count(u.output) + count(u.cacheRead) + count(u.cacheWrite)) || null
}

type Running = {
  session: Session
  agent: PiAgent
  toolPolicy: ToolPolicy
  child: ChildProcessWithoutNullStreams
  frameChunks: Buffer[]
  frameBytes: number
  stderr: string
  contextWindow: number | null
  lastContextTokens: number | null
  working: boolean
  agentRunning: boolean
  commandOut: boolean
  checkSequence: number
  checkId: string | null
  checkTimer: NodeJS.Timeout | null
  abortTimer: NodeJS.Timeout | null
  waitingCommands: Record<string, unknown>[]
  stopped: boolean
  exited: boolean
  closed: Promise<void>
}

/** Limits a test may lower. Defaults: 256 MiB, 30 seconds, 10 seconds. */
export type PiRunnerLimits = { maxFrameBytes?: number; checkTimeoutMs?: number; abortTimeoutMs?: number }

/**
 * Runs Pi and Oh My Pi sessions in the background through their `--mode rpc` stdio protocol, with
 * no PTY: JSON lines in (prompts), JSON lines out (events). Assistant messages are journaled as
 * they end; `agent_settled` or `session_settled` closes the turn once automatic work is finished.
 * A picked model and thinking level are passed to the CLI as `--model` and `--thinking`.
 *
 * A `deny-all` session is checked before each message and ends when the check fails.
 * Tool execution aborts the turn; a tool result other than "not found" or a stuck abort ends the session.
 * Extension dialogs are always cancelled, never answered.
 */
export function createPiRunner(context: StructuredContext, limits?: PiRunnerLimits): StructuredRunner {
  return new PiRunner(context, limits?.maxFrameBytes ?? MAX_FRAME_BYTES, limits?.checkTimeoutMs ?? 30_000, limits?.abortTimeoutMs ?? 10_000)
}

class PiRunner implements StructuredRunner {
  private readonly running = new Map<string, Running>()
  private readonly starting = new Map<string, { stopped: boolean }>()

  constructor(
    private readonly context: StructuredContext,
    private readonly maxFrameBytes: number,
    private readonly checkTimeoutMs: number,
    private readonly abortTimeoutMs: number
  ) {}

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
      ...(toolPolicy === 'deny-all' ? DENY_ALL_ARGS[agent] : []),
      ...(typeof options.model === 'string' ? ['--model', options.model] : []),
      ...(typeof options.effort === 'string' ? ['--thinking', options.effort] : [])
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
      frameChunks: [],
      frameBytes: 0,
      stderr: '',
      contextWindow: null,
      lastContextTokens: null,
      working: false,
      agentRunning: false,
      commandOut: false,
      checkSequence: 0,
      checkId: null,
      checkTimer: null,
      abortTimer: null,
      waitingCommands: [],
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
    if (agent === 'pi' || toolPolicy !== 'deny-all') this.write(run, { id: STATE_REQUEST_ID, type: 'get_state' })
    if (prompt === undefined || prompt === '') {
      this.context.setStatus(session.id, 'running')
      this.checkAndWrite(run)
      return
    }
    this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt, data: { type: 'prompt', message: prompt } })
    this.context.setStatus(session.id, 'working')
    run.working = true
    this.checkAndWrite(run, { type: 'prompt', message: prompt })
  }

  async send(sessionId: string, text: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (!run || run.stopped || run.exited) throw new Error('session is not running')
    // a bare steer sent to idle pi is queued and never answered
    const command = run.working
      ? { type: 'prompt', message: text, streamingBehavior: 'steer' }
      : { type: 'prompt', message: text }
    this.context.appendMessage({ sessionId, role: 'user', text, data: command })
    this.context.setStatus(sessionId, 'working')
    run.working = true
    this.checkAndWrite(run, command)
  }

  async stop(sessionId: string): Promise<void> {
    const startup = this.starting.get(sessionId)
    if (startup) startup.stopped = true
    const run = this.running.get(sessionId)
    if (!run || run.stopped) return
    run.stopped = true
    this.clearCheck(run)
    this.clearAbort(run)
    run.frameChunks = []
    run.frameBytes = 0
    this.running.delete(sessionId)
    this.terminate(run)
    await Promise.race([run.closed, new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS * 2))])
    this.context.setStatus(sessionId, 'exited')
  }

  private checkAndWrite(run: Running, command?: Record<string, unknown>): void {
    if (command) run.waitingCommands.push(command)
    // pi drops a prompt written before it has answered the one before
    if (run.commandOut || run.checkId !== null) return
    if (run.toolPolicy !== 'deny-all') {
      this.writeNext(run)
      return
    }
    run.checkTimer = setTimeout(() => this.fail(run, `${run.agent} did not answer the no-tools check`), this.checkTimeoutMs)
    run.checkId = `quirky-check-${++run.checkSequence}`
    this.write(run, { id: run.checkId, type: run.agent === 'pi' ? 'get_commands' : 'get_state' })
  }

  private writeNext(run: Running): void {
    const command = run.waitingCommands.shift()
    if (!command) return
    run.commandOut = true
    this.write(run, command)
  }

  private clearCheck(run: Running): void {
    if (run.checkTimer !== null) clearTimeout(run.checkTimer)
    run.checkTimer = null
    run.checkId = null
  }

  private fail(run: Running, reason: string): void {
    this.append(run, 'system', reason)
    void this.stop(run.session.id)
  }

  private checked(run: Running, event: Record<string, any>): void {
    if (event.success !== true) {
      const reason = typeof event.error === 'string' && event.error.trim() ? oneLine(event.error) : 'the check was refused'
      this.fail(run, `${run.agent} could not confirm it has no tools: ${reason}`)
      return
    }
    const list = run.agent === 'pi' ? event.data?.commands : event.data?.dumpTools
    if (!Array.isArray(list)) {
      this.fail(run, `${run.agent} could not confirm it has no tools: the reply lists no ${run.agent === 'pi' ? 'commands' : 'tools'}`)
      return
    }
    const offered = run.agent === 'pi' ? list.filter((entry) => entry?.source === 'extension') : list
    if (offered.length > 0) {
      const names = offered.slice(0, 8).map((entry) => typeof entry?.name === 'string' ? oneLine(entry.name, 80) : 'unnamed').join(', ')
      const remaining = offered.length > 8 ? ` and ${offered.length - 8} more` : ''
      this.fail(run, run.agent === 'pi'
        ? `pi loaded extensions in a session that must have no tools: ${names}${remaining}`
        : `omp offers tools to a session that must have none: ${names}${remaining}`)
      return
    }
    this.clearCheck(run)
    this.writeNext(run)
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

  private clearAbort(run: Running): void {
    if (run.abortTimer !== null) clearTimeout(run.abortTimer)
    run.abortTimer = null
  }

  private exit(run: Running, settle: () => void, reason: string): void {
    if (run.exited) return
    run.exited = true
    this.clearCheck(run)
    this.clearAbort(run)
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
    if (run.stopped || run.exited) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      const frameBytes = run.frameBytes + part.length
      if (frameBytes > this.maxFrameBytes) {
        this.append(run, 'system', `${run.agent} sent an rpc frame too large to read`)
        void this.stop(run.session.id)
        return
      }
      if (newline < 0) {
        run.frameChunks.push(part)
        run.frameBytes = frameBytes
        return
      }
      let frame = part
      if (run.frameChunks.length > 0) {
        if (part.length > 0) run.frameChunks.push(part)
        frame = Buffer.concat(run.frameChunks, frameBytes)
        run.frameChunks = []
      }
      run.frameBytes = 0
      offset = newline + 1
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, frame.length - 1)
      if (frame.length === 0) continue
      const line = frame.toString('utf8')
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        this.append(run, 'system', `unreadable ${run.agent} output: ${oneLine(line)}`)
        continue
      }
      if (typeof event === 'object' && event !== null && !Array.isArray(event)) this.handle(run, event as Record<string, any>)
      if (run.stopped || run.exited) return
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
        }
        if (run.checkId !== null && event.id === run.checkId) {
          this.checked(run, event)
          return
        }
        if (event.command === 'get_state' && event.success === true) {
          return
        }
        if (event.success === false) {
          this.append(run, 'system', `${run.agent} rejected ${String(event.command ?? 'command')}: ${String(event.error ?? 'unknown error')}`, event)
        }
        if (event.command === 'prompt') {
          run.commandOut = false
          if (run.waitingCommands.length > 0) this.checkAndWrite(run)
          if (event.success === false || (event.success === true && event.data?.disposition === 'handled')) this.closeTurn(run)
        }
        return
      }
      case 'agent_start':
        run.agentRunning = true
        return
      case 'message_end': {
        const message = event.message
        if (typeof message !== 'object' || message === null || message.role !== 'assistant') return
        if (run.working) run.lastContextTokens = contextTokensOf(message) ?? run.lastContextTokens
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
          if (run.working && run.abortTimer === null) {
            run.abortTimer = setTimeout(() => this.fail(run, `${run.agent} did not stop after a tool started`), this.abortTimeoutMs)
          }
          return
        }
        this.append(run, 'tool', `${String(event.toolName ?? 'tool')}: ${summarizeArgs(event.args)}`, event)
        return
      }
      case 'tool_execution_end': {
        const toolName = String(event.toolName ?? 'tool')
        const text = textOf(event.result?.content)
        if (run.toolPolicy === 'deny-all' && event.isError === true && text === `Tool ${toolName} not found`) return
        this.append(run, 'tool', text || toolName, event)
        if (run.toolPolicy === 'deny-all') this.fail(run, `${run.agent} ran ${toolName} in a session that must have no tools`)
        return
      }
      case 'extension_ui_request': {
        if (typeof event.id === 'string' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
          this.write(run, { type: 'extension_ui_response', id: event.id, cancelled: true })
        }
        return
      }
      case 'prompt_result':
        if (run.working && event.agentInvoked === false) this.closeTurn(run)
        return
      case 'agent_settled':
      case 'session_settled': {
        run.agentRunning = false
        if (!run.working) return
        const contextUsage =
          run.lastContextTokens === null ? null : { contextTokens: run.lastContextTokens, contextWindow: run.contextWindow }
        this.append(run, 'result', `${run.agent} turn completed`, {
          type: 'agent_end',
          ...(contextUsage ? { contextUsage } : {})
        })
        run.lastContextTokens = null
        this.clearAbort(run)
        this.closeTurn(run)
        return
      }
    }
  }

  private closeTurn(run: Running): void {
    if (!run.working || run.agentRunning || run.commandOut || run.waitingCommands.length > 0) return
    this.clearAbort(run)
    run.working = false
    run.lastContextTokens = null
    this.context.setStatus(run.session.id, 'done')
  }
}
