import {
  createAbortError,
  invalidResponse,
  isRecord,
  SupervisionError,
  type CheckInput,
  type CreateInput,
  type JournalRequest,
  type ResumeInput,
  type SendInput,
  type StopInput,
  type StructuredWatch,
  type SupervisionClock,
  type SupervisionContext,
  type SupervisionEngine,
  type TerminalWaitInput
} from './contracts'
import { createCheckStep } from './check-step'
import { createStructuredTurn } from './structured-turn'
import { createTerminalWait } from './terminal-wait'

export type {
  AgentState,
  CheckInput,
  CreateInput,
  JournalRequest,
  Probe,
  ResumeInput,
  SendInput,
  StopInput,
  StructuredSample,
  StructuredTarget,
  StructuredWatch,
  SupervisionClock,
  SupervisionContext,
  SupervisionEngine,
  TerminalWaitInput,
  TerminalWaitResult,
  WatchDecision
} from './contracts'
export { SupervisionError } from './contracts'

const productionClock: SupervisionClock = {
  now: () => Date.now(),
  setTimer(callback, ms) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  }
}

/** Shares agent lifecycles without owning supervisor policy or persistence. */
export function createSupervision(
  context: SupervisionContext,
  options?: { clock?: SupervisionClock }
): SupervisionEngine {
  let disposed = false
  const clock = options?.clock ?? productionClock
  const structured = createStructuredTurn(context, clock, () => disposed)
  const terminal = createTerminalWait(context, clock, () => disposed)
  const checks = createCheckStep(context, () => disposed)

  async function create(input: CreateInput): Promise<unknown> {
    if (disposed) throw createAbortError()
    return context.call('quirky.structured/create', input as unknown as Record<string, unknown>)
  }

  async function resume(input: ResumeInput): Promise<unknown> {
    if (disposed) throw createAbortError()
    return context.call('quirky.structured/resume', input as unknown as Record<string, unknown>)
  }

  async function send(input: SendInput): Promise<{ ok: true }> {
    if (disposed) throw createAbortError()
    const receipt = await context.call('quirky.structured/send', input as unknown as Record<string, unknown>)
    if (isRecord(receipt) && receipt.ok === true && Object.keys(receipt).length === 1) return receipt as { ok: true }
    if (isRecord(receipt) && receipt.ok === false &&
      (receipt.reason === 'operation_unknown' || receipt.reason === 'recipient_gone' || receipt.reason === 'recipient_changed')) {
      throw new SupervisionError('send-refused', `structured send was refused: ${receipt.reason}`, receipt)
    }
    throw invalidResponse('structured send returned a malformed receipt')
  }

  function stop(input: StopInput): Promise<unknown> {
    const params: Record<string, unknown> = { session: input.session }
    if (input.expectedIncarnation !== undefined) params.expectedIncarnation = input.expectedIncarnation
    return context.call(input.kind === 'structured' ? 'quirky.structured/stop' : 'quirky.session/close', params)
  }

  function stopOwned(input: { key: string }): Promise<unknown> {
    return context.call('quirky.structured/stopOwned', input)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    structured.dispose()
    terminal.dispose()
    checks.dispose()
  }

  return {
    create,
    resume,
    send,
    readMessages: (input: JournalRequest) => structured.readMessages(input),
    watchStructured: <T>(input: StructuredWatch<T>) => structured.watchStructured(input),
    wake: (sessionId?: string) => structured.wake(sessionId),
    waitTerminal: (input: TerminalWaitInput) => terminal.waitTerminal(input),
    runCheck: (input: CheckInput, runOptions?: { signal?: AbortSignal }) => checks.runCheck(input, runOptions),
    cancelCheck: (checkId: string) => checks.cancelCheck(checkId),
    stop,
    stopOwned,
    dispose
  }
}
