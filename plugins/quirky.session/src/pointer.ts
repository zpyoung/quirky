import { createHash } from 'node:crypto'
import { RpcErrorCode, type PluginContext, type Session } from '@quirky/protocol'
import type { SessionRecords, PointerOperationRecord, PointerOperationResult } from './records'

type RuntimeSessionIdentity = {
  sessionId: string
  live: true
  runtimeEpoch: string
  processIncarnation: string
  source: 'terminal_launch' | 'structured_lease' | 'restored_authority'
}

export type SessionIdentity = RuntimeSessionIdentity & {
  kind: 'terminal' | 'structured'
  providerId: string | null
  worktreeId: string
}

export type SessionPointerResult = { operationId: string; result: PointerOperationResult }

type PointerParams = {
  session: string
  expectedIncarnation: string
  operationId: string
  text: string
  purpose: 'mailbox_pointer' | 'worker_start'
}

type PointerFlight = { payloadHash: string; promise: Promise<SessionPointerResult> }

const POINTER_ENTER_DELAY_MS = 500
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function pointerText(text: string): string {
  return `\u001b[200~${text.replace(/\r?\n/g, '\r').replaceAll('\u001b', '␛')}\u001b[201~`
}

function payloadHash(params: PointerParams, sessionId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, params.expectedIncarnation, params.text, params.purpose]))
    .digest('hex')
}

function paramsOf(context: PluginContext, params: Record<string, unknown>): PointerParams {
  for (const key of ['session', 'expectedIncarnation', 'operationId', 'text'] as const) {
    if (typeof params[key] !== 'string') throw context.error('invalid-params', `${key} must be a string`)
  }
  if (params.operationId === '') throw context.error('invalid-params', 'operationId must be a non-empty string')
  const purpose = params.purpose === undefined ? 'mailbox_pointer' : params.purpose
  if (purpose !== 'mailbox_pointer' && purpose !== 'worker_start') {
    throw context.error('invalid-params', 'purpose must be mailbox_pointer or worker_start')
  }
  return {
    session: params.session as string,
    expectedIncarnation: params.expectedIncarnation as string,
    operationId: params.operationId as string,
    text: params.text as string,
    purpose
  }
}

export class SessionPointers {
  private readonly byOperation = new Map<string, PointerFlight>()
  private readonly bySession = new Map<string, { operationId: string; promise: Promise<SessionPointerResult> }>()

  constructor(
    private readonly context: PluginContext,
    private readonly records: SessionRecords
  ) {}

  identity(session: Session): SessionIdentity {
    const identity = this.context.launch.sessionIdentity(session.id)
    if (!identity || !this.matchesKind(session, identity)) {
      throw this.context.error('not-found', `session ${session.id} has no live runtime identity`)
    }
    return {
      ...identity,
      kind: session.kind,
      providerId: session.agent === 'shell' ? null : session.agent,
      worktreeId: session.worktreeId
    }
  }

  async pointer(session: Session, input: Record<string, unknown>): Promise<SessionPointerResult> {
    const params = paramsOf(this.context, input)
    const id = session.id
    const hash = payloadHash(params, id)
    const inflight = this.byOperation.get(params.operationId)
    if (inflight) {
      this.assertPayload(inflight.payloadHash, hash)
      return inflight.promise
    }

    let operation = this.records.pointerOperation(params.operationId)
    if (operation) {
      this.assertRecord(operation, id, params, hash)
      if (operation.phase === 'settled') return this.result(params.operationId, operation.result)
      if (operation.phase === 'write_attempted' || operation.phase === 'enter_attempted') {
        return this.result(params.operationId, this.unknown(operation.phase))
      }
    } else {
      operation = this.records.reservePointerOperation(
        {
          operationId: params.operationId,
          sessionId: id,
          expectedIncarnation: params.expectedIncarnation,
          payloadHash: hash
        },
        Date.now()
      ) ?? null
      if (!operation) throw this.context.error('conflict', 'session pointer operation ledger is full')
    }

    const targetFlight = this.bySession.get(id)
    if (targetFlight) {
      const deferred = { status: 'deferred', reason: 'flight_active' } as const
      this.records.updatePointerOperation(params.operationId, 'settled', deferred, Date.now())
      return this.result(params.operationId, deferred)
    }

    const promise = Promise.resolve().then(() => this.deliver(session, params))
    const flight: PointerFlight = { payloadHash: hash, promise }
    this.byOperation.set(params.operationId, flight)
    this.bySession.set(id, { operationId: params.operationId, promise })
    try {
      return await promise
    } finally {
      if (this.byOperation.get(params.operationId) === flight) this.byOperation.delete(params.operationId)
      if (this.bySession.get(id)?.operationId === params.operationId) this.bySession.delete(id)
    }
  }

  private async deliver(session: Session, params: PointerParams): Promise<SessionPointerResult> {
    const id = session.id
    const firstIdentity = this.recipientResult(session, params.expectedIncarnation)
    if (firstIdentity) return this.settle(params.operationId, firstIdentity)

    if (session.kind === 'structured') {
      const result = await this.submitStructured(session, params)
      if (result.status === 'deferred' && params.purpose === 'mailbox_pointer') {
        return { operationId: params.operationId, result }
      }
      return this.settle(params.operationId, result)
    }

    const firstState = await this.status(id)
    const beforeWrite = this.recipientResult(session, params.expectedIncarnation)
    if (beforeWrite) return this.settle(params.operationId, beforeWrite)
    const firstRefusal = this.stateRefusal(firstState)
    if (firstRefusal) return this.settle(params.operationId, firstRefusal)

    this.records.updatePointerOperation(params.operationId, 'write_attempted', null, Date.now())
    try {
      this.context.pty.write(id, pointerText(params.text))
    } catch {
      return this.settle(params.operationId, this.unknown('write_attempted'))
    }

    if (session.agent === 'cursor' && params.purpose === 'mailbox_pointer') {
      return this.settle(params.operationId, { status: 'text_only', reason: 'cursor_no_auto_enter' })
    }

    await Bun.sleep(POINTER_ENTER_DELAY_MS)
    const secondState = await this.status(id)
    const beforeEnter = this.recipientResult(session, params.expectedIncarnation)
    if (beforeEnter) return this.settle(params.operationId, beforeEnter)
    if (this.submitRefusal(secondState)) {
      return this.settle(params.operationId, this.unknown('write_attempted'))
    }

    this.records.updatePointerOperation(params.operationId, 'enter_attempted', null, Date.now())
    try {
      this.context.pty.write(id, '\r')
    } catch {
      return this.settle(params.operationId, this.unknown('enter_attempted'))
    }
    return this.settle(params.operationId, { status: 'submitted', transport: 'terminal_enter' })
  }

  private async submitStructured(session: Session, params: PointerParams): Promise<PointerOperationResult> {
    const beforeSend = this.recipientResult(session, params.expectedIncarnation)
    if (beforeSend) return beforeSend
    const current = this.records.get(session.id)
    if (!current) return { status: 'released', reason: 'recipient_gone' }
    const turnRefusal = this.structuredRefusal(current)
    if (turnRefusal) {
      const afterCheck = this.recipientResult(session, params.expectedIncarnation)
      return afterCheck ?? turnRefusal
    }
    const beforeAttempt = this.recipientResult(session, params.expectedIncarnation)
    if (beforeAttempt) return beforeAttempt
    this.records.updatePointerOperation(params.operationId, 'write_attempted', null, Date.now())
    try {
      const result = await this.context.call('quirky.structured/send', {
        session: session.id,
        text: params.text,
        operationId: params.operationId,
        expectedIncarnation: params.expectedIncarnation
      })
      if (!isPlainObject(result)) return this.unknown('write_attempted')
      if (result.ok === true) return { status: 'submitted', transport: 'structured_session' }
      if (result.reason === 'recipient_changed') return { status: 'released', reason: 'recipient_changed' }
      if (result.reason === 'recipient_gone') return { status: 'released', reason: 'recipient_gone' }
      return this.unknown('write_attempted')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === RpcErrorCode.Conflict) {
        throw error
      }
      const afterFailure = this.recipientResult(session, params.expectedIncarnation)
      return afterFailure ?? this.unknown('write_attempted')
    }
  }


  private async status(sessionId: string): Promise<{ state: string; kind?: string }> {
    try {
      const result = await this.context.call('quirky.agent-status/explain', { session: sessionId })
      if (!isPlainObject(result) || typeof result.state !== 'string' || !isPlainObject(result.screen)) {
        return { state: 'unknown' }
      }
      const screenNotQuiescent =
        result.state === 'idle' &&
        (result.screen.pendingQuiet !== undefined || result.screen.unavailable !== undefined)
      return {
        state: screenNotQuiescent ? 'unknown' : result.state,
        ...(typeof result.kind === 'string' ? { kind: result.kind } : {})
      }
    } catch {
      return { state: 'unknown' }
    }
  }

  private stateRefusal(state: { state: string; kind?: string }): PointerOperationResult | null {
    if (state.state === 'blocked' || state.kind === 'approval' || state.kind === 'question') {
      return { status: 'deferred', reason: 'blocked_dialog' }
    }
    if (state.state === 'working') return { status: 'deferred', reason: 'not_idle' }
    if (state.state !== 'idle') return { status: 'deferred', reason: 'not_quiescent' }
    return null
  }

  private submitRefusal(state: { state: string; kind?: string }): PointerOperationResult | null {
    if (state.state === 'blocked' || state.kind === 'approval' || state.kind === 'question') {
      return { status: 'deferred', reason: 'blocked_dialog' }
    }
    return state.state === 'idle' || state.state === 'working'
      ? null
      : { status: 'deferred', reason: 'not_quiescent' }
  }

  private structuredRefusal(session: Session): PointerOperationResult | null {
    if (session.kind !== 'structured') return { status: 'released', reason: 'recipient_changed' }
    if (session.status === 'starting') return { status: 'deferred', reason: 'flight_active' }
    if (session.status === 'working') return { status: 'deferred', reason: 'not_idle' }
    if (session.status === 'waiting') return { status: 'deferred', reason: 'blocked_dialog' }
    if (session.status === 'exited') return { status: 'deferred', reason: 'not_quiescent' }
    return null
  }

  private recipientResult(session: Session, expectedIncarnation: string): PointerOperationResult | null {
    const identity = this.context.launch.sessionIdentity(session.id)
    if (!identity || !this.matchesKind(session, identity)) return { status: 'released', reason: 'recipient_gone' }
    if (identity.processIncarnation !== expectedIncarnation) return { status: 'released', reason: 'recipient_changed' }
    return null
  }

  private matchesKind(session: Session, identity: RuntimeSessionIdentity): boolean {
    return identity.sessionId === session.id && identity.live &&
      (session.kind === 'structured' ? identity.source === 'structured_lease' : identity.source !== 'structured_lease')
  }

  private assertRecord(record: PointerOperationRecord, sessionId: string, params: PointerParams, hash: string): void {
    if (
      record.sessionId !== sessionId ||
      record.expectedIncarnation !== params.expectedIncarnation ||
      record.payloadHash !== hash
    ) {
      throw this.context.error('conflict', `pointer operation ${params.operationId} was reused with different input`)
    }
  }

  private assertPayload(actual: string, expected: string): void {
    if (actual !== expected) throw this.context.error('conflict', 'pointer operation was reused with different input')
  }

  private unknown(phase: 'write_attempted' | 'enter_attempted'): PointerOperationResult {
    return { status: 'outcome_unknown', attemptedPhase: phase, retryEnter: false }
  }

  private settle(operationId: string, result: PointerOperationResult): SessionPointerResult {
    const saved = this.records.updatePointerOperation(operationId, 'settled', result, Date.now())
    if (!saved) throw new Error('session pointer operation disappeared before settlement')
    return { operationId, result }
  }

  private result(operationId: string, result: PointerOperationResult | null): SessionPointerResult {
    if (result === null) throw new Error(`session pointer operation ${operationId} has no settled result`)
    return { operationId, result }
  }
}
