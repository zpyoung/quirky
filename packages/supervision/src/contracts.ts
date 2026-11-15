import type { PluginContext, QuirkyEvent, Session, StructuredMessage } from '@quirky/protocol'

export type SupervisionContext = Pick<PluginContext, 'call'> &
  Partial<Pick<PluginContext, 'subscribe' | 'log'>>

export type SupervisionClock = {
  now(): number
  setTimer(callback: () => void, ms: number): () => void
}

export type Probe<T> = { ok: true; value: T } | { ok: false; error: unknown }

export type JournalRequest = {
  session: string
  afterSeq?: number
  limit?: number
  tail?: boolean
}

export type StructuredTarget = { sessionId: string; worktreeId: string; agent: string }

export type StructuredSample = {
  target: StructuredTarget
  afterSeq: number
  session: Probe<Session>
  journal: Probe<{ messages: StructuredMessage[]; maxSeq: number }>
}

export type WatchDecision<T> = { kind: 'continue' } | { kind: 'done'; value: T }

export type StructuredWatch<T> = {
  target: StructuredTarget
  journal(): Omit<JournalRequest, 'session'>
  pollMs?: number
  signal?: AbortSignal
  onSample(sample: StructuredSample, signal: AbortSignal): WatchDecision<T> | Promise<WatchDecision<T>>
}

export type CreateInput = {
  worktree: string
  agent: 'claude' | 'codex'
  title?: string
  deferStart?: boolean
  prompt?: string
  model?: string
  options?: Record<string, string | boolean>
  background?: boolean
  lifetime?: 'plugin'
  lifetimeKey?: string
}

export type ResumeInput = {
  session: string
  prompt?: string
  lifetime?: 'plugin'
  lifetimeKey?: string
}

export type SendInput = {
  session: string
  text: string
  requireIdle?: boolean
  expectedAfterSeq?: number
  expectedIncarnation?: string
  operationId?: string
}

export type StopInput = {
  kind: 'structured' | 'terminal'
  session: string
  expectedIncarnation?: string
}

export type AgentState = 'working' | 'blocked' | 'idle' | 'unknown' | 'exited'

export type TerminalWaitResult = {
  status: 'matched' | 'pending'
  state: AgentState
  kind?: string
  at?: number
  decidedBy?: string
  rule?: string
}

export type TerminalWaitInput = {
  session: string
  until: AgentState[]
  timeoutMs: number
  sliceMs?: number
  signal?: AbortSignal
  accept?(result: TerminalWaitResult): boolean | Promise<boolean>
}

export type CheckInput = {
  checkId: string
  command: string
  cwd: string
  timeoutSeconds: number
}

export interface SupervisionEngine {
  create(input: CreateInput): Promise<unknown>
  resume(input: ResumeInput): Promise<unknown>
  send(input: SendInput): Promise<{ ok: true }>
  readMessages(input: JournalRequest): Promise<StructuredMessage[]>
  watchStructured<T>(input: StructuredWatch<T>): Promise<T>
  wake(sessionId?: string): void
  waitTerminal(input: TerminalWaitInput): Promise<TerminalWaitResult>
  runCheck(input: CheckInput, options?: { signal?: AbortSignal }): Promise<unknown>
  cancelCheck(checkId: string): Promise<void>
  stop(input: StopInput): Promise<unknown>
  stopOwned(input: { key: string }): Promise<unknown>
  dispose(): void
}

export class SupervisionError extends Error {
  readonly code: 'invalid-response' | 'send-refused' | 'duplicate-check'
  readonly data?: unknown

  constructor(code: 'invalid-response' | 'send-refused' | 'duplicate-check', message: string, data?: unknown) {
    super(message)
    this.name = 'SupervisionError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

export function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError()
}

export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const { promise: result, resolve, reject } = Promise.withResolvers<T>()
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => undefined)
    reject(createAbortError())
    return result
  }
  const onAbort = () => {
    cleanup()
    reject(createAbortError())
  }
  const cleanup = () => signal.removeEventListener('abort', onAbort)
  signal.addEventListener('abort', onAbort, { once: true })
  Promise.resolve(promise).then(
    (value) => {
      cleanup()
      resolve(value)
    },
    (error: unknown) => {
      cleanup()
      reject(error)
    }
  )
  return result
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function invalidResponse(message: string): SupervisionError {
  return new SupervisionError('invalid-response', message)
}

export function logSafely(context: SupervisionContext, message: string): void {
  if (typeof context.log !== 'function') return
  try {
    context.log(message)
  } catch {}
}

export type InternalEvent = QuirkyEvent
