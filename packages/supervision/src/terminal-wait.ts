import {
  abortable,
  createAbortError,
  invalidResponse,
  isRecord,
  throwIfAborted,
  type AgentState,
  type SupervisionClock,
  type SupervisionContext,
  type TerminalWaitInput,
  type TerminalWaitResult
} from './contracts'

const DEFAULT_SLICE_MS = 1000
const STATES = ['working', 'blocked', 'idle', 'unknown', 'exited'] as const

type TerminalWait = {
  waitTerminal(input: TerminalWaitInput): Promise<TerminalWaitResult>
  dispose(): void
}

function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && STATES.includes(value as AgentState)
}

function validateReply(value: unknown): TerminalWaitResult {
  if (!isRecord(value) || (value.status !== 'matched' && value.status !== 'pending') ||
    !isAgentState(value.state) ||
    (value.kind !== undefined && typeof value.kind !== 'string') ||
    (value.at !== undefined && (typeof value.at !== 'number' || !Number.isFinite(value.at))) ||
    (value.decidedBy !== undefined && typeof value.decidedBy !== 'string') ||
    (value.rule !== undefined && typeof value.rule !== 'string')) {
    throw invalidResponse('terminal wait returned a malformed result')
  }
  return value as TerminalWaitResult
}

function validateInput(input: TerminalWaitInput, sliceMs: number): void {
  if (typeof input.session !== 'string' || input.session === '') throw new TypeError('session must be a non-empty string')
  if (!Array.isArray(input.until) || !input.until.every(isAgentState)) throw new TypeError('until must contain agent states')
  if (!Number.isFinite(input.timeoutMs) || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a finite nonnegative integer')
  }
  if (!Number.isFinite(sliceMs) || !Number.isInteger(sliceMs) || sliceMs <= 0) {
    throw new TypeError('sliceMs must be a finite positive integer')
  }
  if (input.accept !== undefined && typeof input.accept !== 'function') throw new TypeError('accept must be a function')
}

function pendingResult(result: TerminalWaitResult): TerminalWaitResult {
  return result.status === 'pending' ? result : { ...result, status: 'pending' }
}

export function createTerminalWait(
  context: SupervisionContext,
  clock: SupervisionClock,
  isDisposed: () => boolean
): TerminalWait {
  const active = new Set<AbortController>()
  let disposed = false

  function delay(ms: number, signal: AbortSignal): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let cancel: (() => void) | undefined
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      const stop = cancel
      cancel = undefined
      if (!stop) return
      try {
        stop()
      } catch {}
    }
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    if (signal.aborted) {
      reject(createAbortError())
      return promise
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      cancel = clock.setTimer(() => {
        cancel = undefined
        cleanup()
        resolve()
      }, ms)
    } catch (error) {
      cleanup()
      reject(error)
    }
    if (signal.aborted) onAbort()
    return promise
  }

  async function waitTerminal(input: TerminalWaitInput): Promise<TerminalWaitResult> {
    if (disposed || isDisposed()) throw createAbortError()
    if (input.signal?.aborted) throw createAbortError()
    const sliceMs = input.sliceMs === undefined ? DEFAULT_SLICE_MS : input.sliceMs
    validateInput(input, sliceMs)

    const controller = new AbortController()
    const { signal } = controller
    const onExternalAbort = () => controller.abort()
    input.signal?.addEventListener('abort', onExternalAbort, { once: true })
    if (input.signal?.aborted) controller.abort()
    active.add(controller)
    const startedAt = clock.now()
    let consumedMs = 0
    let calls = 0
    let last: TerminalWaitResult | undefined

    try {
      for (;;) {
        throwIfAborted(signal)
        if (disposed || isDisposed()) throw createAbortError()
        const elapsed = Math.max(consumedMs, Math.max(0, clock.now() - startedAt))
        if (input.timeoutMs === 0 && calls > 0) return pendingResult(last!)
        const remainingMs = input.timeoutMs - elapsed
        if (remainingMs <= 0 && last) return pendingResult(last)
        const requestedMs = Math.min(sliceMs, Math.max(0, remainingMs))
        const sliceEndMs = elapsed + requestedMs
        calls++
        const raw = await abortable(
          Promise.resolve().then(() => {
            throwIfAborted(signal)
            return context.call('quirky.agent-status/wait', {
              session: input.session,
              until: input.until,
              timeoutMs: requestedMs
            })
          }),
          signal
        )
        const result = validateReply(raw)
        last = result
        consumedMs = Math.max(consumedMs, Math.max(0, clock.now() - startedAt))

        if (result.status === 'matched' && input.until.includes(result.state)) {
          const accepted = input.accept === undefined
            ? true
            : await abortable(Promise.resolve().then(() => input.accept!(result)), signal)
          if (accepted) return result
        }

        if (input.timeoutMs === 0) return pendingResult(result)
        const afterReplyMs = Math.max(consumedMs, Math.max(0, clock.now() - startedAt))
        if (result.status === 'pending') {
          consumedMs = Math.max(consumedMs, sliceEndMs, afterReplyMs)
          if (consumedMs >= input.timeoutMs) return result
          continue
        }
        if (afterReplyMs >= input.timeoutMs) return pendingResult(result)
        const waitMs = Math.min(input.timeoutMs, sliceEndMs) - afterReplyMs
        if (waitMs > 0) await delay(waitMs, signal)
        consumedMs = Math.max(consumedMs, sliceEndMs, Math.max(0, clock.now() - startedAt))
        if (consumedMs >= input.timeoutMs) return pendingResult(result)
      }
    } finally {
      active.delete(controller)
      input.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const controller of active) controller.abort()
  }

  return { waitTerminal, dispose }
}
