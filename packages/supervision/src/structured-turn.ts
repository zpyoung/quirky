import type { Session, StructuredMessage } from '@quirky/protocol'
import {
  abortable,
  createAbortError,
  invalidResponse,
  isRecord,
  logSafely,
  throwIfAborted,
  type InternalEvent,
  type JournalRequest,
  type Probe,
  type StructuredSample,
  type StructuredTarget,
  type StructuredWatch,
  type SupervisionClock,
  type SupervisionContext,
  type WatchDecision
} from './contracts'

const ROLES = ['user', 'assistant', 'tool', 'system', 'result'] as const
const DEFAULT_POLL_MS = 1000

type WatchState<T> = {
  input: StructuredWatch<T>
  pollMs: number
  controller: AbortController
  resolve(value: T): void
  reject(error: unknown): void
  settled: boolean
  running: boolean
  dirty: boolean
  timer?: () => void
  externalAbort?: () => void
  internalAbort: () => void
}

type StructuredTurn = {
  readMessages(input: JournalRequest): Promise<StructuredMessage[]>
  watchStructured<T>(input: StructuredWatch<T>): Promise<T>
  wake(sessionId?: string): void
  dispose(): void
}

function validateJournalRequest(input: JournalRequest): void {
  if (typeof input.session !== 'string' || input.session === '') throw new TypeError('session must be a non-empty string')
  if (input.afterSeq !== undefined && (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0)) {
    throw new TypeError('afterSeq must be a nonnegative safe integer')
  }
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    throw new TypeError('limit must be a positive safe integer')
  }
  if (input.tail !== undefined && typeof input.tail !== 'boolean') throw new TypeError('tail must be a boolean')
}

function validateMessages(value: unknown, sessionId: string): StructuredMessage[] {
  if (!Array.isArray(value)) throw invalidResponse('structured journal must be an array')
  let previousSeq = 0
  for (const row of value) {
    if (!isRecord(row) || row.sessionId !== sessionId || !Number.isSafeInteger(row.seq) ||
      (row.seq as number) <= 0 || (row.seq as number) <= previousSeq ||
      typeof row.role !== 'string' || !ROLES.includes(row.role as typeof ROLES[number]) || typeof row.text !== 'string' ||
      typeof row.at !== 'number' || !Number.isFinite(row.at)) {
      throw invalidResponse('structured journal contains an invalid message')
    }
    previousSeq = row.seq as number
  }
  return value as StructuredMessage[]
}

function validateSession(value: unknown, target: StructuredTarget): Session {
  if (!isRecord(value) || value.id !== target.sessionId || value.agent !== target.agent ||
    value.worktreeId !== target.worktreeId || value.kind !== 'structured') {
    throw invalidResponse('session identity does not match the structured watch target')
  }
  return value as Session
}

function capture<T>(operation: () => Promise<T>): Promise<Probe<T>> {
  return operation().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  )
}

function eventSessionId(event: InternalEvent): string | undefined {
  if (event.type === 'quirky.structured/message') {
    const message = isRecord(event.data) && isRecord(event.data.message) ? event.data.message : null
    return typeof message?.sessionId === 'string' ? message.sessionId : undefined
  }
  if (event.type === 'quirky.session/changed') {
    const session = isRecord(event.data) && isRecord(event.data.session) ? event.data.session : null
    return typeof session?.id === 'string' ? session.id : undefined
  }
  if (event.type === 'quirky.structured/settled' || event.type === 'quirky.session/removed') {
    return isRecord(event.data) && typeof event.data.sessionId === 'string' ? event.data.sessionId : undefined
  }
  return undefined
}

export function createStructuredTurn(
  context: SupervisionContext,
  clock: SupervisionClock,
  isDisposed: () => boolean
): StructuredTurn {
  const watches = new Set<WatchState<unknown>>()
  let disposed = false
  let unsubscribe: (() => void) | undefined

  function releaseSubscription(): void {
    const stop = unsubscribe
    unsubscribe = undefined
    if (!stop) return
    try {
      stop()
    } catch (error) {
      logSafely(context, `could not release structured watch subscription: ${String(error)}`)
    }
  }

  function cancelTimer<T>(watch: WatchState<T>): void {
    const stop = watch.timer
    watch.timer = undefined
    if (!stop) return
    try {
      stop()
    } catch (error) {
      logSafely(context, `could not cancel structured watch timer: ${String(error)}`)
    }
  }

  function finish<T>(watch: WatchState<T>, outcome: { ok: true; value: T } | { ok: false; error: unknown }): void {
    if (watch.settled) return
    watch.settled = true
    cancelTimer(watch)
    watch.controller.signal.removeEventListener('abort', watch.internalAbort)
    if (watch.externalAbort) watch.input.signal?.removeEventListener('abort', watch.externalAbort)
    watches.delete(watch as WatchState<unknown>)
    if (watches.size === 0) releaseSubscription()
    if (outcome.ok) watch.resolve(outcome.value)
    else watch.reject(outcome.error)
  }

  function abortWatch<T>(watch: WatchState<T>): void {
    finish(watch, { ok: false, error: createAbortError() })
  }

  function throwIfWatchStopped(watch: WatchState<unknown>): void {
    if (watch.settled || watch.controller.signal.aborted || disposed || isDisposed()) throw createAbortError()
  }

  async function sample<T>(watch: WatchState<T>): Promise<StructuredSample> {
    const { input, controller } = watch
    const target = input.target
    const nextRequest = input.journal()
    const journalRequest: JournalRequest = { ...nextRequest, session: target.sessionId }
    validateJournalRequest(journalRequest)
    const afterSeq = nextRequest.afterSeq ?? 0
    const { signal } = controller

    const sessionProbe = capture(async () => {
      const value = await abortable(
        Promise.resolve().then(() => {
          throwIfAborted(signal)
          return context.call('quirky.session/get', { session: target.sessionId })
        }),
        signal
      )
      return validateSession(value, target)
    })
    const journalProbe = capture(async () => {
      const value = await abortable(
        Promise.resolve().then(() => {
          throwIfAborted(signal)
          return context.call('quirky.structured/messages', journalRequest as unknown as Record<string, unknown>)
        }),
        signal
      )
      const messages = validateMessages(value, target.sessionId)
      const maxSeq = messages.length === 0 ? afterSeq : Math.max(afterSeq, messages[messages.length - 1]!.seq)
      return { messages, maxSeq }
    })
    const [session, journal] = await Promise.all([sessionProbe, journalProbe])
    throwIfWatchStopped(watch as WatchState<unknown>)
    return { target, afterSeq, session, journal }
  }

  async function run<T>(watch: WatchState<T>): Promise<void> {
    try {
      while (!watch.settled) {
        watch.dirty = false
        const current = await sample(watch)
        throwIfWatchStopped(watch as WatchState<unknown>)
        const decision = await abortable(
          Promise.resolve().then(() => {
            throwIfWatchStopped(watch as WatchState<unknown>)
            return watch.input.onSample(current, watch.controller.signal)
          }),
          watch.controller.signal
        ) as WatchDecision<T>
        throwIfWatchStopped(watch as WatchState<unknown>)
        if (decision.kind === 'done') {
          finish(watch, { ok: true, value: decision.value })
          return
        }
        if (watch.dirty) continue
        watch.running = false
        watch.timer = clock.setTimer(() => {
          watch.timer = undefined
          start(watch)
        }, watch.pollMs)
        return
      }
    } catch (error) {
      finish(watch, { ok: false, error })
    }
  }

  function start<T>(watch: WatchState<T>): void {
    if (watch.settled || disposed || isDisposed() || watch.controller.signal.aborted) {
      abortWatch(watch)
      return
    }
    if (watch.running) {
      watch.dirty = true
      return
    }
    cancelTimer(watch)
    watch.running = true
    void run(watch)
  }

  function wake(sessionId?: string): void {
    if (disposed || isDisposed()) return
    for (const watch of watches) {
      if (sessionId !== undefined && watch.input.target.sessionId !== sessionId) continue
      start(watch)
    }
  }

  function handleEvent(event: InternalEvent): void {
    if (event.type === 'quirky.ask/created' || event.type === 'quirky.ask/resolved') {
      wake()
      return
    }
    const sessionId = eventSessionId(event)
    if (sessionId !== undefined) wake(sessionId)
  }

  function ensureSubscription(): void {
    if (unsubscribe || typeof context.subscribe !== 'function' || disposed || isDisposed()) return
    try {
      const stop = context.subscribe(handleEvent)
      if (typeof stop === 'function') unsubscribe = stop
    } catch (error) {
      logSafely(context, `could not subscribe to structured watch events: ${String(error)}`)
    }
  }

  function readMessages(input: JournalRequest): Promise<StructuredMessage[]> {
    try {
      validateJournalRequest(input)
    } catch (error) {
      return Promise.reject(error)
    }
    try {
      return context.call('quirky.structured/messages', input as unknown as Record<string, unknown>)
        .then((value) => validateMessages(value, input.session))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function watchStructured<T>(input: StructuredWatch<T>): Promise<T> {
    if (disposed || isDisposed()) return Promise.reject(createAbortError())
    const pollMs = input.pollMs === undefined ? DEFAULT_POLL_MS : input.pollMs
    if (!Number.isFinite(pollMs) || !Number.isInteger(pollMs) || pollMs <= 0) {
      return Promise.reject(new TypeError('pollMs must be a finite positive integer'))
    }
    if (typeof input.target.sessionId !== 'string' || input.target.sessionId === '' ||
      typeof input.target.worktreeId !== 'string' || input.target.worktreeId === '' ||
      typeof input.target.agent !== 'string' || input.target.agent === '') {
      return Promise.reject(new TypeError('watch target must contain sessionId, worktreeId, and agent'))
    }
    if (input.signal?.aborted) return Promise.reject(createAbortError())

    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const controller = new AbortController()
    const watch: WatchState<T> = {
      input,
      pollMs,
      controller,
      resolve,
      reject,
      settled: false,
      running: true,
      dirty: false,
      internalAbort: () => abortWatch(watch)
    }
    controller.signal.addEventListener('abort', watch.internalAbort, { once: true })
    if (input.signal) {
      watch.externalAbort = () => controller.abort()
      input.signal.addEventListener('abort', watch.externalAbort, { once: true })
    }
    watches.add(watch as WatchState<unknown>)
    ensureSubscription()
    void run(watch)
    return promise
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const watch of watches) watch.controller.abort()
    releaseSubscription()
  }

  return { readMessages, watchStructured, wake, dispose }
}
