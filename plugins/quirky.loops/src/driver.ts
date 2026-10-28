import { appendFileSync } from 'node:fs'
import { RpcErrorCode, type PluginContext, type Session, type StructuredMessage } from '@quirky/protocol'
import { decideNext } from './decision'
import { computePacing } from './pacing'
import { sessionCumulativeCostUsd } from './evidence'
import { buildIterationPrompt } from './prompt'
import { LoopStore, type LoopRequests, type SteerNote } from './store'
import type {
  DecisionInput,
  EvidenceEngineContract,
  IterationDetail,
  IterationEvidence,
  LoopDecision,
  LoopSnapshot,
  LoopTiming,
  PauseReason
} from './types'

const DEFAULT_POLL_MS = 1000
const DEFAULT_USER_IDLE_MS = 20_000
const DEFAULT_NO_BUSY_EDGE_MS = 120_000
const READY_TIMEOUT_MS = 120_000
const MESSAGE_LIMIT = 300
const HISTORY_LIMIT = 1000
const MAX_WAIT_SLICE_MS = 30_000
const OUTPUT_LIMIT = 16_384
const RATE_LIMIT_EVENT = /rate[-_]?limit/i

class DriverCancelled extends Error {}
class StopNow extends Error {}
class Unverifiable extends Error {}

export type LoopDriverHooks = {
  publish(previous: LoopSnapshot, current: LoopSnapshot): void
  finished(driver: LoopDriver): void
}

export type LoopDriverOptions = {
  context: PluginContext
  store: LoopStore
  evidence: EvidenceEngineContract
  loopId: string
  timing?: LoopTiming
  hooks: LoopDriverHooks
}

type Observation = { kind: 'settled' } | { kind: 'crashed'; detail: string }
type PendingPrompt = { sessionId: string; text: string; afterSeq: number; candidates: number[] }
type AcceptedPrompt = { sessionId: string; text: string; afterSeq: number; claimed: boolean }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sessionOf(value: unknown): Session {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.status !== 'string' || typeof value.worktreeId !== 'string') {
    throw new Error('structured session API returned an invalid session')
  }
  return value as unknown as Session
}

function messagesOf(value: unknown): StructuredMessage[] {
  if (!Array.isArray(value)) throw new Unverifiable('structured messages API returned an invalid journal')
  const messages: StructuredMessage[] = []
  for (const item of value) {
    if (!isObject(item) || typeof item.sessionId !== 'string' || typeof item.seq !== 'number' ||
      !Number.isInteger(item.seq) || item.seq < 1 ||
      (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'tool' && item.role !== 'system' && item.role !== 'result') ||
      typeof item.text !== 'string' || typeof item.at !== 'number' || !Number.isFinite(item.at)) {
      throw new Unverifiable('structured messages API returned an invalid journal entry')
    }
    const message = item as unknown as StructuredMessage
    messages.push(message)
  }
  return messages
}


function pendingSessionAsk(value: unknown, sessionId: string): boolean {
  if (!Array.isArray(value)) throw new Unverifiable('pending approvals could not be read')
  return value.some((ask) => isObject(ask) && ask.sessionId === sessionId &&
    (!isObject(ask.envelope) || ask.envelope.status === 'pending'))
}

function isBusy(status: Session['status']): boolean {
  return status === 'working'
}

function isIdle(status: Session['status']): boolean {
  return status === 'done' || status === 'running'
}

function messageHasRateLimit(message: StructuredMessage): boolean {
  if (message.role !== 'system' || !isObject(message.data)) return false
  const type = message.data.type
  const event = message.data.event
  return message.data.method === 'account/rateLimits/updated' ||
    (typeof type === 'string' && RATE_LIMIT_EVENT.test(type)) ||
    (typeof event === 'string' && RATE_LIMIT_EVENT.test(event)) ||
    'rateLimit' in message.data || 'rate_limit' in message.data
}


function lastHumanMessageAt(messages: StructuredMessage[], store: LoopStore, loopId: string, sessionId: string): number | null {
  let latest: number | null = null
  for (const message of messages) {
    if (message.role !== 'user' || store.isOwnedMessage(loopId, sessionId, message.seq)) continue
    latest = latest === null ? message.at : Math.max(latest, message.at)
  }
  return latest
}

function latestPreviousCheck(history: IterationDetail[]): IterationDetail['check'] {
  for (let index = history.length - 1; index >= 0; index--) {
    const attempt = history[index]!
    if (attempt.endReason === 'settled') return attempt.check
  }
  return null
}

function pauseDetailFor(decision: Extract<LoopDecision, { kind: 'pause' }>): string | null {
  return decision.detail === undefined ? null : decision.detail.slice(0, 500)
}
export function appendLoopLog(context: PluginContext, detail: IterationDetail, loop: LoopSnapshot): void {
  const check = detail.check === null ? 'none' : detail.check.pass ? 'pass' : 'fail'
  const diff = detail.diff === null ? 'n/a' : `+${detail.diff.added} -${detail.diff.removed}`
  const cost = detail.costUsd === null ? 'n/a' : `$${detail.costUsd.toFixed(2)}`
  try {
    const skippedTicks = detail.endedAt === null ? 0 : computePacing({
      pacing: detail.pacingConfig ?? loop.config.pacing,
      createdAt: loop.createdAt,
      iterationStartedAt: detail.startedAt,
      iterationEndedAt: detail.endedAt,
    }).skippedTicks
    const skipped = skippedTicks > 0 ? ` | skipped ${skippedTicks} ticks` : ''
    appendFileSync(loop.notesPath.replace(/notes\.md$/, 'log.md'), `#${detail.n} ${detail.endReason} | check ${check} | diff ${diff} | cost ${cost}${skipped}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    context.log(`could not append loop ${loop.id} log: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export class LoopDriver {
  private readonly context: PluginContext
  private readonly store: LoopStore
  private readonly evidence: EvidenceEngineContract
  private readonly loopId: string
  private readonly hooks: LoopDriverHooks
  private readonly pollMs: number
  private readonly userIdleMs: number
  private readonly noBusyEdgeMs: number
  private readonly now: () => number
  private readonly wakeWaiters = new Set<() => void>()
  private readonly shutdownWaiters = new Set<() => void>()
  private readonly acceptedPrompts: AcceptedPrompt[] = []
  private pendingPrompt: PendingPrompt | null = null
  private currentController: AbortController | null = null
  private runPromise: Promise<void> | null = null
  private shuttingDown = false
  private stopNowRequested = false
  private activeSince: number | null = null
  private turnSentAt: number | null = null
  private busyEdgeAt: number | null = null
  private lastHumanAt: number | null = null
  private lastRateLimit: StructuredMessage | null = null

  constructor(options: LoopDriverOptions) {
    this.context = options.context
    this.store = options.store
    this.evidence = options.evidence
    this.loopId = options.loopId
    this.hooks = options.hooks
    this.pollMs = options.timing?.pollMs ?? DEFAULT_POLL_MS
    this.userIdleMs = options.timing?.userIdleMs ?? DEFAULT_USER_IDLE_MS
    this.noBusyEdgeMs = options.timing?.noBusyEdgeMs ?? DEFAULT_NO_BUSY_EDGE_MS
    this.now = options.timing?.now ?? Date.now
  }

  start(): void {
    if (this.runPromise !== null) return
    this.runPromise = this.run().finally(() => this.hooks.finished(this))
  }
  waitForFinish(): Promise<void> {
    return this.runPromise ?? Promise.resolve()
  }

  waitForFinish(): Promise<void> {
    return this.runPromise ?? Promise.resolve()
  }

  wake(): void {
    for (const resolve of this.wakeWaiters) resolve()
    this.wakeWaiters.clear()
  }

  observeMessage(message: StructuredMessage): void {
    const loop = this.store.getLoop(this.loopId)
    if (!loop || message.sessionId !== loop.sessionId) return
    if (messageHasRateLimit(message)) this.lastRateLimit = message
    if (message.role === 'user') {
      const pending = this.pendingPrompt
      if (pending && pending.sessionId === message.sessionId && message.seq > pending.afterSeq && message.text === pending.text) {
        pending.candidates.push(message.seq)
      } else if (!this.isAcceptedPrompt(message) &&
        !this.store.isOwnedMessage(this.loopId, message.sessionId, message.seq)) {
        this.recordHumanMessage(message.at)
        this.setEligible(false)
      }
    }
    this.wake()
  }

  observeSettled(sessionId: string, at: number): void {
    const loop = this.store.getLoop(this.loopId)
    if (loop?.sessionId !== sessionId || this.turnSentAt === null || at < this.turnSentAt) return
    this.busyEdgeAt = at
    this.wake()
  }

  async stopNow(): Promise<void> {
    try {
      this.setEligible(false)
    } catch (error) {
      this.context.log(`could not account active time before stopping loop ${this.loopId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.stopNowRequested = true
    this.currentController?.abort(new StopNow())
    this.wake()
    await Promise.allSettled([
      this.evidence.cancel(this.loopId),
      this.stopOwnedSession()
    ])
    await this.runPromise
  }

  async shutdown(): Promise<void> {
    try {
      this.setEligible(false)
    } catch (error) {
      this.context.log(`could not account active time before shutting down loop ${this.loopId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.shuttingDown = true
    for (const resolve of this.shutdownWaiters) resolve()
    this.shutdownWaiters.clear()
    this.currentController?.abort(new DriverCancelled())
    this.wake()
    await Promise.allSettled([
      this.evidence.cancel(this.loopId),
      this.stopOwnedSession()
    ])
    await this.runPromise
  }

  private current(): LoopSnapshot | null {
    return this.store.getLoop(this.loopId)
  }

  private requireLoop(): LoopSnapshot {
    const loop = this.current()
    if (!loop) throw new Error(`Loop ${this.loopId} disappeared from the store`)
    return loop
  }
  private skippedTicksFor(detail: IterationDetail, loop: LoopSnapshot): number {
    return computePacing({
      pacing: detail.pacingConfig ?? loop.config.pacing,
      createdAt: loop.createdAt,
      iterationStartedAt: detail.startedAt,
      iterationEndedAt: detail.endedAt,
    }).skippedTicks
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.shuttingDown) throw new DriverCancelled()
    if (signal?.aborted) {
      if (this.stopNowRequested) throw new StopNow()
      throw new DriverCancelled()
    }
    if (this.stopNowRequested) throw new StopNow()
  }

  private async awaitCall<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return await operation
    if (this.shuttingDown) throw new DriverCancelled()
    const { promise, resolve } = Promise.withResolvers<void>()
    const wakeOnShutdown = () => resolve()
    const onAbort = () => {
      if (this.shuttingDown || signal.reason instanceof DriverCancelled) wakeOnShutdown()
    }
    this.shutdownWaiters.add(wakeOnShutdown)
    signal.addEventListener('abort', onAbort, { once: true })
    if (this.shuttingDown) wakeOnShutdown()
    try {
      return await Promise.race([
        operation,
        promise.then(() => { throw new DriverCancelled() })
      ])
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.shutdownWaiters.delete(wakeOnShutdown)
    }
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    acceptStopNowResult = false
  ): Promise<unknown> {
    this.assertActive(signal)
    const result = await this.awaitCall(this.context.call(method, params), signal)
    if (acceptStopNowResult && this.stopNowRequested && !this.shuttingDown) return result
    this.assertActive(signal)
    return result
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    this.assertActive(signal)
    if (ms <= 0) return
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let finished = false
    const timer = setTimeout(() => finish(), ms)
    const onAbort = () => finish(signal?.reason ?? new DriverCancelled())
    const onWake = () => finish()
    const finish = (error?: unknown): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.wakeWaiters.delete(onWake)
      if (error === undefined) resolve()
      else reject(error)
    }
    this.wakeWaiters.add(onWake)
    signal?.addEventListener('abort', onAbort, { once: true })
    await promise
    this.assertActive(signal)
  }

  private commit(snapshot: LoopSnapshot, attempt?: IterationDetail, requests?: LoopRequests): LoopSnapshot {
    const previous = this.store.getLoop(snapshot.id)
    snapshot.updatedAt = this.now()
    if (attempt) this.store.saveLoopAndAttempt(snapshot, attempt, requests)
    else this.store.saveLoop(snapshot, requests)
    const current = this.store.getLoop(snapshot.id) ?? snapshot
    this.hooks.publish(previous ?? current, current)
    return current
  }

  private updatePhase(phase: LoopSnapshot['phase']): LoopSnapshot {
    const snapshot = this.requireLoop()
    if (snapshot.phase === phase) return snapshot
    snapshot.phase = phase
    return this.commit(snapshot)
  }

  private setEligible(eligible: boolean): void {
    if (eligible && this.activeSince !== null) return
    if (!eligible && this.activeSince === null) return
    const now = this.now()
    if (this.activeSince !== null) {
      const elapsed = Math.max(0, now - this.activeSince)
      this.activeSince = null
      if (elapsed > 0 && !this.shuttingDown) {
        const snapshot = this.current()
        if (snapshot?.state === 'running') {
          snapshot.activeMs += elapsed
          this.commit(snapshot)
        }
      }
    }
    if (eligible && !this.shuttingDown && !this.stopNowRequested && this.current()?.state === 'running') this.activeSince = now
  }

  private recordHumanMessage(at: number): void {
    this.lastHumanAt = this.lastHumanAt === null ? at : Math.max(this.lastHumanAt, at)
  }

  private isAcceptedPrompt(message: StructuredMessage): boolean {
    const accepted = this.acceptedPrompts.find((candidate) => !candidate.claimed && candidate.sessionId === message.sessionId &&
      message.seq > candidate.afterSeq && message.text === candidate.text)
    if (!accepted) return false
    accepted.claimed = true
    this.store.markOwnedMessage(this.loopId, message.sessionId, message.seq)
    return true
  }

  private async readMessages(sessionId: string, afterSeq: number, signal?: AbortSignal): Promise<StructuredMessage[]> {
    let result: unknown
    try {
      result = await this.call('quirky.structured/messages', {
        session: sessionId,
        afterSeq,
        limit: MESSAGE_LIMIT,
        tail: true
      }, signal)
    } catch (error) {
      if (error instanceof DriverCancelled || error instanceof StopNow) throw error
      throw new Unverifiable(error instanceof Error ? error.message : String(error))
    }
    const messages = messagesOf(result)
    let maxSeq = afterSeq
    for (const message of messages) {
      maxSeq = Math.max(maxSeq, message.seq)
      if (messageHasRateLimit(message)) this.lastRateLimit = message
      if (message.role === 'user' && !this.isAcceptedPrompt(message) &&
        !this.store.isOwnedMessage(this.loopId, sessionId, message.seq)) this.recordHumanMessage(message.at)
    }
    if (maxSeq > afterSeq && !this.store.readOnly) this.store.saveJournalCursor(this.loopId, sessionId, maxSeq)
    return messages
  }

  private async latestJournal(sessionId: string, signal?: AbortSignal): Promise<StructuredMessage[]> {
    return this.readMessages(sessionId, this.store.journalCursor(this.loopId, sessionId), signal)
  }

  private async session(sessionId: string, signal?: AbortSignal): Promise<Session | null> {
    try {
      return sessionOf(await this.call('quirky.session/get', { session: sessionId }, signal))
    } catch (error) {
      if (error instanceof DriverCancelled || error instanceof StopNow) throw error
      return null
    }
  }
  private async startStructuredSession(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Session> {
    this.assertActive(signal)
    const operation = this.context.call(method, params)
    let value: unknown
    try {
      value = await this.awaitCall(operation, signal)
    } catch (error) {
      if (this.shuttingDown) {
        void operation.then((lateValue) => this.cleanupLateStructuredSession(lateValue), () => undefined)
      }
      throw error
    }
    const session = sessionOf(value)
    try {
      this.assertActive(signal)
    } catch (error) {
      await this.cleanupLateStructuredSession(session)
      throw error
    }
    return session
  }

  private async cleanupLateStructuredSession(value: unknown): Promise<void> {
    let session: Session
    try {
      session = sessionOf(value)
    } catch {
      return
    }
    await Promise.allSettled([
      this.stopOwnedSession(session.id),
      this.closeOwnedSession(session.id)
    ])
  }

  private async approvalPending(sessionId: string, signal?: AbortSignal): Promise<boolean | null> {
    try {
      return pendingSessionAsk(await this.call('quirky.ask/list', { pendingOnly: true }, signal), sessionId)
    } catch (error) {
      if (error instanceof DriverCancelled || error instanceof StopNow) throw error
      return null
    }
  }

  private async waitForReady(sessionId: string, signal: AbortSignal): Promise<Session> {
    const started = this.now()
    while (true) {
      this.assertActive(signal)
      const requests = this.store.requests(this.loopId)
      if (requests.stop || requests.pause) throw new DriverCancelled()
      const current = await this.session(sessionId, signal)
      this.assertActive(signal)
      if (current?.status === 'exited') throw new Error(`structured session ${sessionId} exited before it became ready`)
      const asks = await this.approvalPending(sessionId, signal)
      this.assertActive(signal)
      if (asks === true || current?.status === 'waiting') {
        this.setNeedsYou()
      } else if (asks === false && current && isIdle(current.status)) {
        this.setRunningFromNeedsYou()
        return current
      }
      if (asks !== true && current !== null && current.status !== 'waiting' && this.now() - started > READY_TIMEOUT_MS) {
        throw new Error(`structured session ${sessionId} did not become ready`)
      }
      await this.delay(this.pollMs, signal)
      this.assertActive(signal)
    }
  }

  private setNeedsYou(): void {
    if (this.current()?.state === 'needs-you') return
    this.setEligible(false)
    const current = this.requireLoop()
    if (current.state === 'needs-you') return
    this.commit({ ...current, state: 'needs-you', phase: 'waiting' })
  }

  private setRunningFromNeedsYou(): LoopSnapshot {
    const current = this.requireLoop()
    if (current.state !== 'needs-you') return current
    return this.commit({ ...current, state: 'running', phase: 'working', pauseReason: null, pauseDetail: null })
  }

  private async stopOwnedSession(sessionId?: string | null): Promise<void> {
    const target = sessionId ?? this.current()?.sessionId
    if (!target) return
    try {
      await this.context.call('quirky.structured/stop', { session: target })
    } catch (error) {
      if (!this.shuttingDown && !this.stopNowRequested) this.context.log(`could not stop loop session ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  private async closeOwnedSession(sessionId: string | null): Promise<void> {
    if (sessionId === null) return
    try {
      await this.context.call('quirky.session/close', { session: sessionId })
      this.store.forgetOwnedMessages(this.loopId, sessionId)
    } catch (error) {
      if (!this.shuttingDown && !this.stopNowRequested) this.context.log(`could not close loop session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async loadWorktreeSession(forceFresh: boolean, signal: AbortSignal): Promise<{ sessionId: string; newConversation: boolean }> {
    const loop = this.requireLoop()
    const requests = this.store.requests(this.loopId)
    const latest = this.store.latestAttempt(this.loopId)
    const crashedRetry = latest !== null && latest.n > loop.iterationsCompleted && latest.endReason === 'crashed'
    const needsNativeResume = requests.resumeNative && loop.config.sessionPolicy === 'continue' && loop.sessionId !== null
    const wantsFresh = forceFresh || crashedRetry || loop.config.sessionPolicy === 'fresh' || loop.sessionId === null
    const previousSession = loop.sessionId
    let session: Session
    let newConversation: boolean

    if (needsNativeResume) {
      session = await this.startStructuredSession('quirky.structured/resume', { session: loop.sessionId, prompt: '' }, signal)
      newConversation = false
    } else if (!wantsFresh && loop.sessionId !== null) {
      session = await this.waitForReady(loop.sessionId, signal)
      this.assertActive(signal)
      newConversation = false
    } else {
      const params: Record<string, unknown> = {
        worktree: `id:${loop.worktreeId}`,
        agent: loop.agent,
        prompt: '',
        ...(loop.model === undefined ? {} : { model: loop.model }),
        ...(loop.options === undefined ? {} : { options: loop.options })
      }
      session = await this.startStructuredSession('quirky.structured/create', params, signal)
      newConversation = true
    }

    if (session.worktreeId !== loop.worktreeId || session.agent !== loop.agent) {
      await this.stopOwnedSession(session.id)
      await this.closeOwnedSession(session.id)
      throw new Error('structured session does not belong to the loop worktree and agent')
    }
    if (session.id !== previousSession) {
      this.lastHumanAt = null
      this.lastRateLimit = null
      this.acceptedPrompts.length = 0
      const current = this.requireLoop()
      current.sessionId = session.id
      current.phase = newConversation ? 'relaunching' : 'sending'
      this.commit(current)
    }
    let ready = session
    if (newConversation || needsNativeResume) {
      try {
        ready = await this.waitForReady(session.id, signal)
        this.assertActive(signal)
      } catch (error) {
        if (error instanceof DriverCancelled || error instanceof StopNow) throw error
        if (session.id !== previousSession) {
          await this.stopOwnedSession(session.id)
          await this.closeOwnedSession(session.id)
        }
        if (previousSession !== null && newConversation) {
          await this.stopOwnedSession(previousSession)
          await this.closeOwnedSession(previousSession)
        }
        throw error
      }
    }
    if (previousSession !== null && previousSession !== session.id) {
      if (!needsNativeResume) {
        await this.stopOwnedSession(previousSession)
        this.assertActive(signal)
      }
      await this.closeOwnedSession(previousSession)
      this.assertActive(signal)
    }
    const current = this.requireLoop()
    current.sessionId = session.id
    current.phase = 'sending'
    current.pauseReason = null
    current.pauseDetail = null
    this.commit(current)
    const latestRequests = this.store.requests(this.loopId)
    if (latestRequests.needsResume && !this.store.readOnly) {
      this.store.saveRequests(this.loopId, { ...latestRequests, needsResume: false, resumeNative: false })
    }
    return { sessionId: ready.id, newConversation }
  }


  private async waitForSendEligibility(sessionId: string, signal: AbortSignal): Promise<{ messages: StructuredMessage[]; expectedAfterSeq: number }> {
    while (true) {
      this.assertActive(signal)
      const loop = this.requireLoop()
      const requests = this.store.requests(this.loopId)
      if (requests.stopNow) throw new StopNow()
      if (requests.stop || requests.pause) throw new DriverCancelled()

      let current: Session | null
      try {
        current = await this.session(sessionId, signal)
      } catch (error) {
        this.assertActive(signal)
        throw error
      }
      this.assertActive(signal)
      if (current?.status === 'exited') throw new Error(`structured session ${sessionId} exited before prompt delivery`)
      const asks = await this.approvalPending(sessionId, signal)
      this.assertActive(signal)
      if (asks === true || current?.status === 'waiting') this.setNeedsYou()
      else if (asks === false && current) this.setRunningFromNeedsYou()

      let messages: StructuredMessage[]
      try {
        messages = await this.latestJournal(sessionId, signal)
      } catch (error) {
        if (error instanceof Unverifiable) {
          this.setEligible(false)
          this.updatePhase('waiting')
          await this.delay(this.pollMs, signal)
          this.assertActive(signal)
          continue
        }
        throw error
      }
      this.assertActive(signal)
      const expectedAfterSeq = messages.reduce((seq, message) => Math.max(seq, message.seq), this.store.journalCursor(this.loopId, sessionId))
      const mostRecentHuman = lastHumanMessageAt(messages, this.store, this.loopId, sessionId)
      if (mostRecentHuman !== null) this.recordHumanMessage(mostRecentHuman)
      const userQuiet = this.lastHumanAt === null || this.now() - this.lastHumanAt >= this.userIdleMs
      const idle = current !== null && isIdle(current.status)
      if (asks === false && idle && userQuiet) {
        this.setRunningFromNeedsYou()
        this.setEligible(false)
        return { messages, expectedAfterSeq }
      }
      this.setEligible(false)
      this.updatePhase('waiting')
      await this.delay(this.pollMs, signal)
      this.assertActive(signal)
      void loop
    }
  }

  private tryMarkPromptMessages(sessionId: string, prompt: string, afterSeq: number, messages: StructuredMessage[]): void {
    const promptMessage = messages.find((message) => message.sessionId === sessionId && message.role === 'user' &&
      message.seq > afterSeq && message.text === prompt)
    const accepted = this.acceptedPrompts.find((candidate) => candidate.sessionId === sessionId &&
      candidate.afterSeq === afterSeq && candidate.text === prompt)
    if (promptMessage) this.store.markOwnedMessage(this.loopId, sessionId, promptMessage.seq)
    if (accepted) accepted.claimed = true
    else if (promptMessage) this.acceptedPrompts.push({ sessionId, text: prompt, afterSeq, claimed: true })
  }

  private async sendPrompt(
    loopAtTurnStart: LoopSnapshot,
    configAtTurnStart: LoopSnapshot['config'],
    body: string,
    sessionId: string,
    newConversation: boolean,
    n: number,
    signal: AbortSignal,
    onDelivered: (prompt: string, treeBefore: string | null, cursor: number) => void
  ): Promise<{ prompt: string; expectedAfterSeq: number; costBefore: number | null; treeBefore: string | null }> {
    const history = this.store.iterations(this.loopId, HISTORY_LIMIT)
    const previousCheck = latestPreviousCheck(history)

    while (true) {
      const ready = await this.waitForSendEligibility(sessionId, signal)
      this.assertActive(signal)
      let sessionHistory: StructuredMessage[]
      try {
        sessionHistory = await this.readMessages(sessionId, 0, signal)
      } catch (error) {
        if (!(error instanceof Unverifiable)) throw error
        this.setEligible(false)
        this.updatePhase('waiting')
        await this.delay(this.pollMs, signal)
        this.assertActive(signal)
        continue
      }
      this.assertActive(signal)
      const lastHumanAt = lastHumanMessageAt(sessionHistory, this.store, this.loopId, sessionId)
      if (lastHumanAt !== null) this.recordHumanMessage(lastHumanAt)
      if (this.lastHumanAt !== null && this.now() - this.lastHumanAt < this.userIdleMs) continue
      const expectedAfterSeq = sessionHistory.reduce((seq, message) => Math.max(seq, message.seq), ready.expectedAfterSeq)
      const treeBefore = await this.evidence.snapshot(loopAtTurnStart.cwd)
      this.assertActive(signal)
      let currentMessages: StructuredMessage[]
      try {
        currentMessages = await this.latestJournal(sessionId, signal)
      } catch (error) {
        if (!(error instanceof Unverifiable)) throw error
        this.setEligible(false)
        this.updatePhase('waiting')
        await this.delay(this.pollMs, signal)
        this.assertActive(signal)
        continue
      }
      this.assertActive(signal)
      const currentHumanAt = lastHumanMessageAt(currentMessages, this.store, this.loopId, sessionId)
      if (currentHumanAt !== null) this.recordHumanMessage(currentHumanAt)
      if (this.lastHumanAt !== null && this.now() - this.lastHumanAt < this.userIdleMs) continue
      const finalRequests = this.store.requests(this.loopId)
      if (finalRequests.stop || finalRequests.pause || finalRequests.stopNow) throw new DriverCancelled()
      const finalSession = await this.session(sessionId, signal)
      this.assertActive(signal)
      const finalAsks = await this.approvalPending(sessionId, signal)
      this.assertActive(signal)
      if (finalAsks === true) this.setNeedsYou()
      if (finalSession?.status === 'exited') throw new Error(`structured session ${sessionId} exited before prompt delivery`)
      if (finalSession === null || !isIdle(finalSession.status) || finalAsks !== false) {
        this.setEligible(false)
        this.updatePhase('waiting')
        await this.delay(this.pollMs, signal)
        this.assertActive(signal)
        continue
      }
      const cursor = currentMessages.reduce((seq, message) => Math.max(seq, message.seq), expectedAfterSeq)
      const baselineMessages = [...sessionHistory, ...currentMessages]
      const measuredCost = sessionCumulativeCostUsd(baselineMessages)
      const costBefore = newConversation ? 0 : measuredCost
      const notes: SteerNote[] = this.store.steerNotes(this.loopId)
      const prompt = buildIterationPrompt({
        body,
        n,
        ...(configAtTurnStart.caps.maxIterations === undefined ? {} : { maxIterations: configAtTurnStart.caps.maxIterations }),
        notesPath: loopAtTurnStart.notesPath,
        newSession: newConversation,
        previousCheck,
        steerNotes: notes.map((note) => note.body)
      })
      this.pendingPrompt = { sessionId, text: prompt, afterSeq: cursor, candidates: [] }
      this.turnSentAt = this.now()
      this.busyEdgeAt = null
      try {
        const sent = await this.call('quirky.structured/send', {
          session: sessionId,
          text: prompt,
          requireIdle: true,
          expectedAfterSeq: cursor
        }, signal, true)
        if (!isObject(sent) || sent.ok !== true) {
          this.assertActive(signal)
          throw new Error('structured send did not confirm prompt delivery')
        }
        onDelivered(prompt, treeBefore, cursor)
        this.store.consumeSteerNotes(this.loopId, notes.map((note) => note.id), n)
        this.assertActive(signal)
        const pending = this.pendingPrompt
        if (pending) {
          for (const seq of pending.candidates) this.store.markOwnedMessage(this.loopId, sessionId, seq)
        }
        this.acceptedPrompts.push({
          sessionId,
          text: prompt,
          afterSeq: cursor,
          claimed: pending !== null && pending.candidates.length > 0
        })
        this.pendingPrompt = null
        let journal: StructuredMessage[] = []
        try {
          journal = await this.readMessages(sessionId, cursor, signal)
        } catch (error) {
          if (!(error instanceof Unverifiable)) throw error
        }
        this.assertActive(signal)
        this.tryMarkPromptMessages(sessionId, prompt, cursor, journal)
        return { prompt, expectedAfterSeq: cursor, costBefore, treeBefore }
      } catch (error) {
        const pending = this.pendingPrompt
        this.pendingPrompt = null
        this.turnSentAt = null
        this.busyEdgeAt = null
        if (pending && !this.stopNowRequested && !this.shuttingDown) {
          for (const seq of pending.candidates) {
            const human = currentMessages.find((message) => message.seq === seq)
            if (human) this.recordHumanMessage(human.at)
          }
        }
        if (this.stopNowRequested || error instanceof StopNow) throw new StopNow()
        if (this.shuttingDown || error instanceof DriverCancelled) throw new DriverCancelled()
        if (isObject(error) && (error.code === RpcErrorCode.Conflict || error.code === 'conflict')) {
          let refreshed: StructuredMessage[]
          try {
            refreshed = await this.latestJournal(sessionId, signal)
          } catch (refreshError) {
            if (!(refreshError instanceof Unverifiable)) throw refreshError
            this.setEligible(false)
            this.updatePhase('waiting')
            await this.delay(this.pollMs, signal)
            this.assertActive(signal)
            continue
          }
          this.assertActive(signal)
          const humanAt = lastHumanMessageAt(refreshed, this.store, this.loopId, sessionId)
          if (humanAt !== null) this.recordHumanMessage(humanAt)
          await this.delay(this.pollMs, signal)
          this.assertActive(signal)
          continue
        }
        throw error
      }
    }
  }

  private async observeTurn(sessionId: string, sentSeq: number, signal: AbortSignal): Promise<Observation> {
    let busyEdge = this.busyEdgeAt !== null && this.turnSentAt !== null && this.busyEdgeAt >= this.turnSentAt
    let noBusyEligibleMs = 0
    const sentAt = this.turnSentAt ?? this.now()
    let lastTick = sentAt
    let observedSeq = sentSeq
    while (true) {
      this.assertActive(signal)
      const current = await this.session(sessionId, signal)
      this.assertActive(signal)
      if (current?.status === 'exited') return { kind: 'crashed', detail: `structured session ${sessionId} exited` }

      const asks = await this.approvalPending(sessionId, signal)
      this.assertActive(signal)
      if (asks === true || current?.status === 'waiting') this.setNeedsYou()
      else if (asks === false && current) this.setRunningFromNeedsYou()

      let messages: StructuredMessage[] = []
      let journalKnown = true
      try {
        messages = await this.readMessages(sessionId, observedSeq, signal)
        observedSeq = messages.reduce((seq, message) => Math.max(seq, message.seq), observedSeq)
      } catch (error) {
        if (!(error instanceof Unverifiable)) throw error
        journalKnown = false
      }
      this.assertActive(signal)
      const humanAt = lastHumanMessageAt(messages, this.store, this.loopId, sessionId)
      if (humanAt !== null) this.recordHumanMessage(humanAt)
      if (current && isBusy(current.status)) busyEdge = true
      if (this.busyEdgeAt !== null && this.turnSentAt !== null && this.busyEdgeAt >= this.turnSentAt) busyEdge = true

      const now = this.now()
      const userQuiet = this.lastHumanAt === null || now - this.lastHumanAt >= this.userIdleMs
      const eligible = current !== null && current.status !== 'waiting' && asks === false && journalKnown && userQuiet
      if (eligible) {
        this.setRunningFromNeedsYou()
        this.setEligible(true)
        if (isIdle(current.status)) {
          if (!busyEdge) noBusyEligibleMs += Math.max(0, now - lastTick)
          if (busyEdge || noBusyEligibleMs >= this.noBusyEdgeMs) {
            this.acceptedPrompts.splice(0, this.acceptedPrompts.length, ...this.acceptedPrompts.filter(
              (candidate) => candidate.sessionId !== sessionId || candidate.afterSeq !== sentSeq
            ))
            return { kind: 'settled' }
          }
        }
      } else {
        this.setEligible(false)
        if (!journalKnown || current === null) this.updatePhase('waiting')
      }
      lastTick = now
      await this.delay(this.pollMs, signal)
      this.assertActive(signal)
    }
  }

  private async gatherMessages(sessionId: string, sentSeq: number, signal: AbortSignal): Promise<StructuredMessage[]> {
    while (true) {
      try {
        const messages = await this.readMessages(sessionId, sentSeq, signal)
        this.assertActive(signal)
        if (this.lastRateLimit && this.lastRateLimit.seq > sentSeq && this.lastRateLimit.sessionId === sessionId &&
          !messages.some((message) => message.seq === this.lastRateLimit?.seq)) return [...messages, this.lastRateLimit]
        return messages
      } catch (error) {
        if (!(error instanceof Unverifiable)) throw error
        this.setEligible(false)
        this.updatePhase('waiting')
        await this.delay(this.pollMs, signal)
        this.assertActive(signal)
      }
    }
  }

  private async runIteration(forceFreshSession: boolean): Promise<void> {
    const initial = this.requireLoop()
    const loopAtTurnStart = structuredClone(initial)
    const latest = this.store.latestAttempt(this.loopId)
    const retrying = latest !== null && latest.n > initial.iterationsCompleted &&
      (latest.endReason === 'crashed' || latest.endReason === 'interrupted')
    const n = retrying ? latest.n : initial.iterationsCompleted + 1
    const attemptNo = latest?.n === n ? latest.attempt + 1 : 1
    const startedAt = this.now()
    const capturedConfig = structuredClone(initial.config)
    let detail: IterationDetail = {
      loopId: this.loopId,
      n,
      attempt: attemptNo,
      sessionId: initial.sessionId,
      promptSent: '',
      startedAt,
      endedAt: null,
      endReason: null,
      doneConfig: structuredClone(capturedConfig.done),
      pacingConfig: structuredClone(capturedConfig.pacing),
      check: null,
      evaluator: null,
      markers: { done: false },
      diff: null,
      treeBefore: null,
      treeAfter: null,
      protectedPathHits: [],
      checkpointCommit: null,
      costUsd: null,
      usageLimit: null,
      outputTail: ''
    }
    const sending = this.requireLoop()
    sending.phase = 'sending'
    sending.nextIterationAt = null
    sending.updatedAt = this.now()
    let promptBody: string
    if (capturedConfig.promptSource.kind === 'queue') {
      if (initial.preset !== 'queue') throw new Error('queue prompt source requires a queue preset')
      const claim = this.store.claimQueueAttempt(sending, detail, capturedConfig.promptSource.repeatQueue)
      if (claim === null) {
        if (retrying) throw new Error('could not reclaim the in-flight queue item for a retry')
        return
      }
      promptBody = claim.body
      this.hooks.publish(initial, this.store.getLoop(this.loopId) ?? sending)
    } else {
      if (initial.preset === 'queue') throw new Error('queue preset is missing its queue prompt source')
      promptBody = capturedConfig.promptSource.body
      this.commit(sending, detail)
    }
    this.currentController = new AbortController()
    const signal = this.currentController.signal
    let sessionId: string | null = null
    let sentSeq = 0
    try {
      this.assertActive(signal)
      const session = await this.loadWorktreeSession(forceFreshSession, signal)
      this.assertActive(signal)
      sessionId = session.sessionId
      detail.sessionId = sessionId
      this.commit(this.requireLoop(), detail)
      if (this.store.requests(this.loopId).stopNow) throw new StopNow()

      const sent = await this.sendPrompt(loopAtTurnStart, capturedConfig, promptBody, sessionId, session.newConversation, n, signal, (prompt, treeBefore, cursor) => {
        detail.promptSent = prompt
        detail.treeBefore = treeBefore
        sentSeq = cursor
        const working = this.requireLoop()
        working.sessionId = sessionId
        working.phase = 'working'
        this.activeSince = this.now()
        this.commit(working, detail)
      })
      this.assertActive(signal)
      sentSeq = sent.expectedAfterSeq
      const observation = await this.observeTurn(sessionId, sentSeq, signal)
      this.assertActive(signal)
      if (observation.kind === 'crashed') {
        detail.endedAt = this.now()
        detail.endReason = 'crashed'
        detail.error = observation.detail
        this.setEligible(false)
        const failed = this.requireLoop()
        const previous = { ...failed }
        failed.phase = null
        failed.updatedAt = this.now()
        const current = this.store.saveEndedAttempt(
          failed,
          detail,
          detail.queueItemId ?? null,
          this.skippedTicksFor(detail, failed)
        )
        this.hooks.publish(previous, current)
        appendLoopLog(this.context, detail, current)
        await this.stopOwnedSession(sessionId)
        return
      }

      const turnMessages = await this.gatherMessages(sessionId, sentSeq, signal)
      this.assertActive(signal)
      this.setEligible(true)
      this.updatePhase('checking')
      const loopForEvidence = this.requireLoop()
      loopForEvidence.config = capturedConfig
      const evidence = await this.evidence.gather({
        loop: loopForEvidence,
        n,
        attempt: attemptNo,
        treeBefore: sent.treeBefore,
        messages: turnMessages,
        signal,
        costBefore: sent.costBefore,
        onPhase: (phase) => {
          if (signal.aborted || this.stopNowRequested || this.shuttingDown) return
          const current = this.current()
          if (!current || current.phase === phase) return
          current.phase = phase
          try {
            this.commit(current)
          } catch (error) {
            this.context.log(`could not publish loop ${this.loopId} phase ${phase}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })
      this.assertActive(signal)
      const latestAttempt = this.store.latestAttempt(this.loopId) ?? detail
      detail = {
        ...latestAttempt,
        ...evidence,
        loopId: this.loopId,
        n,
        attempt: attemptNo,
        sessionId,
        promptSent: sent.prompt,
        startedAt,
        endedAt: this.now(),
        endReason: 'settled',
        doneConfig: structuredClone(capturedConfig.done),
        pacingConfig: latestAttempt.pacingConfig ?? structuredClone(capturedConfig.pacing),
        treeBefore: sent.treeBefore
      }
      this.setEligible(false)
      const finished = this.requireLoop()
      const previous = { ...finished }
      const priorCostUsd = finished.iterationsCompleted === 0 ? 0 : finished.costUsd
      finished.iterationsCompleted += 1
      finished.phase = null
      finished.sessionId = sessionId
      finished.costUsd = priorCostUsd === null || evidence.costUsd === null ? null : priorCostUsd + evidence.costUsd
      finished.nextIterationAt = computePacing({
        pacing: finished.config.pacing,
        createdAt: finished.createdAt,
        iterationStartedAt: startedAt,
        iterationEndedAt: detail.endedAt,
      }).nextIterationAt
      finished.updatedAt = this.now()
      const current = this.store.saveEndedAttempt(
        finished,
        detail,
        detail.queueItemId ?? null,
        this.skippedTicksFor(detail, finished)
      )
      this.hooks.publish(previous, current)
      appendLoopLog(this.context, detail, current)
    } catch (error) {
      if (this.shuttingDown) {
        this.setEligible(false)
        return
      }
      if (this.stopNowRequested || error instanceof StopNow) {
        this.setEligible(false)
        await this.finishStoppedAttempt(detail, sessionId)
        return
      }
      if (error instanceof DriverCancelled) {
        this.setEligible(false)
        const latestRequests = this.store.requests(this.loopId)
        if (latestRequests.stop) {
          await this.finishStoppedAttempt(detail, sessionId)
        } else if (latestRequests.pause) {
          detail.endedAt = this.now()
          detail.endReason = 'interrupted'
          detail.error = 'paused before prompt delivery'
          const paused = this.requireLoop()
          const previous = { ...paused }
          paused.phase = null
          paused.updatedAt = this.now()
          const current = this.store.saveEndedAttempt(
            paused,
            detail,
            detail.queueItemId ?? null,
            this.skippedTicksFor(detail, paused)
          )
          this.hooks.publish(previous, current)
          appendLoopLog(this.context, detail, current)
        }
        return
      }
      this.setEligible(false)
      detail.endedAt = this.now()
      detail.endReason = 'crashed'
      detail.error = error instanceof Error ? error.message.slice(0, OUTPUT_LIMIT) : String(error).slice(0, OUTPUT_LIMIT)
      const failed = this.current()
      if (failed) {
        const previous = { ...failed }
        failed.phase = null
        failed.updatedAt = this.now()
        try {
          const current = this.store.saveEndedAttempt(
            failed,
            detail,
            detail.queueItemId ?? null,
            this.skippedTicksFor(detail, failed)
          )
          this.hooks.publish(previous, current)
          appendLoopLog(this.context, detail, current)
        } catch (persistError) {
          this.context.log(`could not persist crashed loop attempt ${this.loopId}: ${persistError instanceof Error ? persistError.message : String(persistError)}`)
          await this.stopOwnedSession(sessionId)
          throw persistError
        }
      }
      await this.stopOwnedSession(sessionId)
    } finally {
      this.currentController = null
      this.setEligible(false)
    }
  }

  private async finishStoppedAttempt(detail: IterationDetail, sessionId: string | null): Promise<void> {
    detail.endedAt = this.now()
    detail.endReason = 'stopped'
    if (detail.promptSent === '') detail.error = 'stopped before prompt delivery'
    else delete detail.error
    const snapshot = this.current()
    if (!snapshot) return
    const previous = { ...snapshot }
    snapshot.state = 'stopped'
    snapshot.pauseReason = null
    snapshot.pauseDetail = null
    snapshot.endedAt = this.now()
    snapshot.updatedAt = snapshot.endedAt
    snapshot.phase = null
    snapshot.nextIterationAt = null
    snapshot.sessionId = sessionId ?? snapshot.sessionId
    const current = this.store.saveEndedAttempt(
      snapshot,
      detail,
      detail.queueItemId ?? null,
      this.skippedTicksFor(detail, snapshot),
      { pause: false, stop: false, stopNow: false, needsResume: false, resumeNative: false }
    )
    this.hooks.publish(previous, current)
    appendLoopLog(this.context, detail, current)
    this.store.pruneEndedAttempts()
    await this.stopOwnedSession(sessionId)
    await this.closeOwnedSession(sessionId)
  }


  private async handleDecision(decision: LoopDecision): Promise<'again' | 'done'> {
    if (decision.kind === 'complete') {
      await this.finishState('completed', null, null)
      const sessionId = this.requireLoop().sessionId
      await this.stopOwnedSession(sessionId)
      await this.closeOwnedSession(sessionId)
      return 'done'
    }
    if (decision.kind === 'stop') {
      await this.finishState('stopped', null, null)
      const sessionId = this.requireLoop().sessionId
      await this.stopOwnedSession(sessionId)
      await this.closeOwnedSession(sessionId)
      return 'done'
    }
    if (decision.kind === 'pause') {
      await this.finishState('paused', decision.reason, pauseDetailFor(decision))
      const loop = this.requireLoop()
      if (loop.config.sessionPolicy === 'fresh' || decision.reason === 'crashed') {
        await this.stopOwnedSession(loop.sessionId)
        await this.closeOwnedSession(loop.sessionId)
      }
      return 'done'
    }
    if (decision.kind === 'wait') {
      this.updatePhase('waiting')
      const waitMs = decision.until === undefined ? this.pollMs : Math.max(0, decision.until - this.now())
      await this.delay(Math.min(MAX_WAIT_SLICE_MS, waitMs))
      this.assertActive()
      return 'again'
    }
    return 'again'
  }

  private async finishState(state: LoopSnapshot['state'], reason: PauseReason | null, detail: string | null): Promise<void> {
    this.setEligible(false)
    const snapshot = this.requireLoop()
    snapshot.state = state
    snapshot.pauseReason = reason
    snapshot.pauseDetail = detail
    snapshot.phase = null
    if (state === 'stopped' || state === 'completed') snapshot.nextIterationAt = null
    snapshot.endedAt = state === 'stopped' || state === 'completed' ? this.now() : null
    snapshot.updatedAt = this.now()
    this.commit(snapshot, undefined, { pause: false, stop: false, stopNow: false, needsResume: false, resumeNative: false })
    if (state === 'stopped' || state === 'completed') this.store.pruneEndedAttempts()
  }

  private async run(): Promise<void> {
    try {
      while (!this.shuttingDown) {
        this.assertActive()
        const loop = this.current()
        if (!loop || (loop.state !== 'running' && loop.state !== 'needs-you')) return
        const requests = this.store.requests(this.loopId)
        if (requests.stopNow || this.stopNowRequested) {
          const unfinished = this.store.unfinishedAttempt(this.loopId)
          if (unfinished) await this.finishStoppedAttempt(unfinished, unfinished.sessionId)
          else await this.finishState('stopped', null, null)
          return
        }
        const latest = this.store.latestAttempt(this.loopId)
        const history = this.store.iterations(this.loopId, HISTORY_LIMIT)
        const input: DecisionInput = {
          loop,
          latest: requests.needsResume ? null : latest,
          history,
          stopRequested: requests.stop,
          pauseRequested: requests.pause,
          now: this.now()
        }
        const decision = decideNext(input)
        if (decision.kind === 'retry-crashed') {
          await this.runIteration(true)
          continue
        }
        if (decision.kind === 'start-iteration') {
          await this.runIteration(decision.freshSession)
          continue
        }
        if (await this.handleDecision(decision) === 'done') return
      }
    } catch (error) {
      if (this.shuttingDown || error instanceof DriverCancelled) return
      if (this.stopNowRequested || error instanceof StopNow) {
        const attempt = this.store.unfinishedAttempt(this.loopId)
        if (attempt) await this.finishStoppedAttempt(attempt, attempt.sessionId)
        else await this.finishState('stopped', null, null)
        return
      }
      this.setEligible(false)
      const loop = this.current()
      if (!loop || loop.state === 'stopped' || loop.state === 'completed') return
      const message = error instanceof Error ? error.message : String(error)
      const unfinished = this.store.unfinishedAttempt(this.loopId)
      if (unfinished) {
        unfinished.endedAt = this.now()
        unfinished.endReason = 'crashed'
        unfinished.error = message.slice(0, OUTPUT_LIMIT)
      }
      const failed = this.requireLoop()
      const previous = { ...failed }
      failed.state = 'paused'
      failed.pauseReason = 'crashed'
      failed.pauseDetail = message.slice(0, 500)
      failed.phase = null
      failed.updatedAt = this.now()
      try {
        if (unfinished) {
          const current = this.store.saveEndedAttempt(
            failed,
            unfinished,
            unfinished.queueItemId ?? null,
            this.skippedTicksFor(unfinished, failed)
          )
          this.hooks.publish(previous, current)
          appendLoopLog(this.context, unfinished, current)
        } else {
          this.commit(failed)
        }
      } catch (persistError) {
        this.context.log(`could not pause failed loop ${this.loopId}: ${persistError instanceof Error ? persistError.message : String(persistError)}`)
      }
      await this.stopOwnedSession()
      await this.closeOwnedSession(this.current()?.sessionId ?? null)
    }
  }
}
