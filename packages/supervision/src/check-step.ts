import {
  createAbortError,
  logSafely,
  SupervisionError,
  type CheckInput,
  type SupervisionContext
} from './contracts'

type CheckOperation = {
  checkId: string
  cancelPromise?: Promise<void>
  signal?: AbortSignal
  onAbort?: () => void
}

type CheckStep = {
  runCheck(input: CheckInput, options?: { signal?: AbortSignal }): Promise<unknown>
  cancelCheck(checkId: string): Promise<void>
  dispose(): void
}

export function createCheckStep(context: SupervisionContext, isDisposed: () => boolean): CheckStep {
  const active = new Map<string, CheckOperation>()
  let disposed = false

  function requestCancellation(operation: CheckOperation): Promise<void> {
    if (operation.cancelPromise) return operation.cancelPromise
    const { promise, resolve } = Promise.withResolvers<void>()
    operation.cancelPromise = promise
    try {
      void context.call('quirky.checks/cancel', { checkId: operation.checkId }).then(
        () => resolve(),
        (error: unknown) => {
          logSafely(context, `could not cancel check ${operation.checkId}: ${String(error)}`)
          resolve()
        }
      )
    } catch (error) {
      logSafely(context, `could not cancel check ${operation.checkId}: ${String(error)}`)
      resolve()
    }
    return promise
  }

  async function runCheck(input: CheckInput, options?: { signal?: AbortSignal }): Promise<unknown> {
    if (disposed || isDisposed()) throw createAbortError()
    const { signal } = options ?? {}
    if (signal?.aborted) throw createAbortError()
    if (active.has(input.checkId)) {
      throw new SupervisionError('duplicate-check', `check ${input.checkId} is already active`)
    }

    const operation: CheckOperation = { checkId: input.checkId, cancelRequested: false, signal }
    active.set(input.checkId, operation)
    if (signal) {
      operation.onAbort = () => { void requestCancellation(operation) }
      signal.addEventListener('abort', operation.onAbort, { once: true })
      if (signal.aborted) void requestCancellation(operation)
    }

    try {
      return await context.call('quirky.checks/run', input as unknown as Record<string, unknown>)
    } finally {
      if (active.get(input.checkId) === operation) active.delete(input.checkId)
      if (operation.signal && operation.onAbort) operation.signal.removeEventListener('abort', operation.onAbort)
    }
  }

  function cancelCheck(checkId: string): Promise<void> {
    const operation = active.get(checkId)
    return operation ? requestCancellation(operation) : Promise.resolve()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const operation of active.values()) void requestCancellation(operation)
  }

  return { runCheck, cancelCheck, dispose }
}
