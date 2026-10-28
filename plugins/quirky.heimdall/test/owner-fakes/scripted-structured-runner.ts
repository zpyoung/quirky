import type { ProcessScope } from '../../../../scripts/test-support/process-scope'
import type { StructuredContext, StructuredRunner, StructuredRunnerFactory, StructuredStartOptions } from '../../../quirky.structured/runner'
import type { Session } from '@quirky/protocol'
import { join } from 'node:path'

const SCRIPTED_CLAUDE = join(import.meta.dir, 'scripted-claude.ts')
const RESPONSE_TIMEOUT_MS = 10_000

type JsonRecord = Record<string, unknown>
type ScriptedChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>
type ScriptedProcess = {
  child: ScriptedChild
  providerSessionId: string
  reader: ReadableStreamDefaultReader<Uint8Array>
  decoder: TextDecoder
  buffered: string
  exited: Promise<number>
  exitCode: number | null
  loadedTurns: number | null
  loadedModel: string | null
  loadedEffort: string | null
}

export type LoadedProviderOptions = { model: string | null; effort: string | null }
type StartedTurn = { providerSessionId: string; turn: number; response: string }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function spawnScriptedClaude(scope: ProcessScope, cwd: string, providerSessionId: string, options?: StructuredStartOptions): ScriptedChild {
  const env: Record<string, string> = {
    HOME: scope.home,
    QUIRKY_HOME: scope.home,
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '/usr/bin:/bin'
  }
  return scope.spawn([process.execPath, SCRIPTED_CLAUDE, providerSessionId, options?.model ?? '', options?.effort ?? ''], {
    cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
}

/** A Claude-shaped scripted provider backed by one real, scope-owned child per structured session. */
export class ScriptedStructuredRunner implements StructuredRunner {
  private readonly processes = new Map<string, ScriptedProcess>()

  constructor(private readonly context: StructuredContext, private readonly scope: ProcessScope) {}
  get liveProcessCount(): number {
    return [...this.processes.values()].filter((processState) => processState.exitCode === null).length
  }

  async start(session: Session, prompt?: string, options?: StructuredStartOptions): Promise<void> {
    if (this.processes.has(session.id)) throw new Error(`scripted provider already owns ${session.id}`)

    const existingProvider = options?.providerSession ?? session.providerSession ?? null
    const providerSessionId = existingProvider?.id ?? `acceptance-claude-thread:${session.id}`
    await this.context.setProviderSession(session.id, { id: providerSessionId, transcriptPath: existingProvider?.transcriptPath ?? null })

    const child = spawnScriptedClaude(this.scope, session.cwd, providerSessionId, options)
    const processState: ScriptedProcess = {
      child,
      providerSessionId,
      reader: child.stdout.getReader(),
      decoder: new TextDecoder(),
      buffered: '',
      exited: Promise.resolve(-1),
      exitCode: null,
      loadedTurns: null,
      loadedModel: null,
      loadedEffort: null
    }
    processState.exited = child.exited.then((code) => {
      processState.exitCode = code
      return code
    })
    this.processes.set(session.id, processState)
    void new Response(child.stderr).text()

    try {
      const ready = await this.readReply(processState, 'provider startup')
      if (
        ready.type !== 'ready' ||
        ready.providerSessionId !== providerSessionId ||
        typeof ready.turns !== 'number' ||
        (ready.model !== null && typeof ready.model !== 'string') ||
        (ready.effort !== null && typeof ready.effort !== 'string')
      ) throw new Error(`scripted provider started with invalid native conversation state for ${session.id}`)
      processState.loadedTurns = ready.turns
      processState.loadedModel = typeof ready.model === 'string' ? ready.model : null
      processState.loadedEffort = typeof ready.effort === 'string' ? ready.effort : null
      if (prompt !== undefined) {
        this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt })
        const reply = await this.sendTurn(processState, prompt)
        this.context.appendMessage({ sessionId: session.id, role: 'assistant', text: reply.response })
      }
      this.context.setStatus(session.id, 'working')
    } catch (error) {
      await this.terminate(processState)
      throw error
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    const processState = this.processFor(sessionId)
    if (processState.exitCode !== null) throw new Error(`scripted provider for ${sessionId} has exited`)
    this.context.appendMessage({ sessionId, role: 'user', text })
    const reply = await this.sendTurn(processState, text)
    this.context.appendMessage({ sessionId, role: 'assistant', text: reply.response })
    this.context.setStatus(sessionId, 'working')
  }

  async stop(sessionId: string): Promise<void> {
    const processState = this.processes.get(sessionId)
    if (!processState || processState.exitCode !== null) return

    try {
      const reply = await this.writeAndRead(processState, { type: 'stop' }, 'provider stop')
      if (
        reply.type !== 'stopped' ||
        reply.providerSessionId !== processState.providerSessionId ||
        typeof reply.turns !== 'number'
      ) throw new Error(`scripted provider did not acknowledge stop for ${sessionId}`)
      try {
        processState.child.stdin.end()
      } catch {
        // The child may close its input pipe after acknowledging stop.
      }
      const exitCode = await this.withTimeout(processState, processState.exited, 'provider exit')
      if (exitCode !== 0) throw new Error(`scripted provider for ${sessionId} exited ${exitCode}`)
    } catch (error) {
      await this.terminate(processState)
      throw error
    }
  }

  hasProcess(sessionId: string): boolean {
    return this.processes.has(sessionId)
  }

  isAlive(sessionId: string): boolean {
    const processState = this.processes.get(sessionId)
    return !!processState && processState.exitCode === null
  }

  exitCode(sessionId: string): number | undefined {
    return this.processes.get(sessionId)?.exitCode ?? undefined
  }
  loadedTurnCount(sessionId: string): number | undefined {
    return this.processes.get(sessionId)?.loadedTurns ?? undefined
  }
  loadedProviderOptions(sessionId: string): LoadedProviderOptions | undefined {
    const processState = this.processes.get(sessionId)
    return processState === undefined || processState.loadedModel === null && processState.loadedEffort === null
      ? undefined
      : { model: processState.loadedModel, effort: processState.loadedEffort }
  }

  async waitForExit(sessionId: string): Promise<number> {
    const processState = this.processes.get(sessionId)
    if (!processState) throw new Error(`scripted provider does not own ${sessionId}`)
    return await processState.exited
  }

  private processFor(sessionId: string): ScriptedProcess {
    const processState = this.processes.get(sessionId)
    if (!processState) throw new Error(`scripted provider does not own ${sessionId}`)
    return processState
  }

  private async sendTurn(processState: ScriptedProcess, text: string): Promise<StartedTurn> {
    const reply = await this.writeAndRead(processState, { type: 'turn', text }, 'provider turn')
    if (
      reply.type !== 'ack' ||
      reply.providerSessionId !== processState.providerSessionId ||
      typeof reply.turn !== 'number' ||
      typeof reply.response !== 'string'
    ) throw new Error('scripted provider returned an invalid turn acknowledgement')
    return { providerSessionId: reply.providerSessionId, turn: reply.turn, response: reply.response }
  }

  private async writeAndRead(processState: ScriptedProcess, message: JsonRecord, label: string): Promise<JsonRecord> {
    processState.child.stdin.write(`${JSON.stringify(message)}\n`)
    await processState.child.stdin.flush()
    const reply = await this.readReply(processState, label)
    if (reply.type === 'error') throw new Error(`scripted provider rejected ${label}: ${String(reply.message)}`)
    return reply
  }

  private async readReply(processState: ScriptedProcess, label: string): Promise<JsonRecord> {
    const line = await this.withTimeout(processState, this.readLine(processState), label)
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`scripted provider returned malformed JSON during ${label}`, { cause: error })
    }
    if (!isRecord(parsed)) throw new Error(`scripted provider returned a non-object during ${label}`)
    return parsed
  }

  private async readLine(processState: ScriptedProcess): Promise<string> {
    while (true) {
      const newline = processState.buffered.indexOf('\n')
      if (newline >= 0) {
        const line = processState.buffered.slice(0, newline).replace(/\r$/, '')
        processState.buffered = processState.buffered.slice(newline + 1)
        if (line.length > 0) return line
        continue
      }
      const { value, done } = await processState.reader.read()
      if (done) throw new Error(`scripted provider ${processState.providerSessionId} closed stdout unexpectedly`)
      processState.buffered += processState.decoder.decode(value, { stream: true })
    }
  }

  private async withTimeout<T>(processState: ScriptedProcess, work: Promise<T>, label: string): Promise<T> {
    // Real OS children need a watchdog; fake timers cannot terminate them.
    const { promise: timeout, reject } = Promise.withResolvers<never>()
    const timer = setTimeout(() => {
      try {
        processState.child.kill('SIGKILL')
      } catch {
        // ProcessScope will reap any surviving descendant at cleanup.
      }
      reject(new Error(`scripted provider timed out during ${label}`))
    }, RESPONSE_TIMEOUT_MS)
    try {
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  private async terminate(processState: ScriptedProcess): Promise<void> {
    if (processState.exitCode !== null) return
    try {
      processState.child.kill('SIGKILL')
    } catch {
      // The child may have exited between the check and signal.
    }
    await processState.exited
  }
}

export function createScriptedStructuredRunnerFactory(
  scope: ProcessScope,
  onCreate: (runner: ScriptedStructuredRunner) => void
): StructuredRunnerFactory {
  return (context) => {
    const runner = new ScriptedStructuredRunner(context, scope)
    onCreate(runner)
    return runner
  }
}
