import { randomUUID } from 'node:crypto'
import type { AskDb, AskRow } from './ask-db'
import { AskPaneQueue } from './ask-registry-pane-queue'
import { buildTimeoutResult } from './ask-registry-timeout-answers'
import { buildResultSummary } from './ask-answer-value-parsing'
import {
  isTerminalAskStatus,
  pendingEnvelope,
  type AskAnswers,
  type AskEnvelope,
  type AskResultBody,
  type PersistedAskStatus
} from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskPartial,
  AskRegistryEvent,
  AskSpec
} from '../../shared/fork-ask-question-tool/ask-question-schema'

/**
 * Grace window between a pane detaching and its surfaced ask resolving `unavailable` (tech.md
 * C2), anchored against the 30s pane-recovery and 45s WS-liveness budgets but sized for a human
 * rather than a transport. A new symbol, never `orchestration-ask-timeout.ts`'s constants.
 */
export const ASK_LIVENESS_GRACE_MS = 10 * 60 * 1000

/** Orchestration identity captured by C3 when an ask hands off to the coordinator (C7). */
export type AskHandoffOrigin = { runId: string; dispatchId: string; askerHandle: string }

/** Where an ask's answer will be sought, already resolved by C3 before `register` is called. */
export type AskOrigin = {
  paneKey: string | null
  worktreeId: string | null
  handoff?: AskHandoffOrigin
}

export type AskRegisterOptions = { requestId: string; timeoutMs?: number }
export type RegisterResult = { askId: string }
export type CommitResult = { committed: boolean }
export type Unsubscribe = () => void

type LiveAsk = {
  askId: string
  paneKey: string | null
  spec: AskSpec
  surfaced: boolean
  timeoutTimer: ReturnType<typeof setTimeout> | null
  livenessGraceTimer: ReturnType<typeof setTimeout> | null
  waiters: Set<(envelope: AskEnvelope) => void>
}

function assertValidAskId(askId: string): void {
  if (typeof askId !== 'string' || askId.length === 0) {
    throw new Error('askId must be a non-empty string')
  }
}

function filterPartialToKnownQuestions(spec: AskSpec, partial: AskPartial): AskPartial {
  const ids = new Set(spec.questions.map((question) => question.id))
  return Object.fromEntries(Object.entries(partial).filter(([id]) => ids.has(id)))
}

/**
 * Lifecycle owner for the `quirky ask` registry (tech.md C2): the only writer of terminal
 * statuses, and the source every card, pending count, and `wait` reads from. Domain outcomes are
 * always returned as envelopes; only a programmer error (invalid askId shape) throws.
 */
export class AskRegistry {
  private readonly epoch = randomUUID()
  private readonly listeners = new Set<(event: AskRegistryEvent) => void>()
  private readonly live = new Map<string, LiveAsk>()
  private readonly paneQueue = new AskPaneQueue()

  constructor(private readonly db: AskDb) {}

  /** Stable for this instance's lifetime, fresh on every construction — how clients detect a host restart. */
  getEpoch(): string {
    return this.epoch
  }

  /** Durably inserts before returning the id, on every path; idempotent on `options.requestId`. */
  async register(
    spec: AskSpec,
    origin: AskOrigin,
    options: AskRegisterOptions
  ): Promise<RegisterResult> {
    const askId = `ask_${randomUUID()}`
    const specJson = JSON.stringify(spec)
    const { row, created } = this.db.registerAsk({
      askId,
      requestId: options.requestId,
      paneKey: origin.paneKey,
      worktreeId: origin.worktreeId,
      origin: origin.handoff ? 'handoff' : 'cli',
      specJson,
      timeoutMs: options.timeoutMs ?? null,
      handoff: origin.handoff ? { ...origin.handoff, questionId: null } : null
    })

    if (!created) {
      if (row.spec_json !== specJson) {
        throw new Error(
          `requestId ${options.requestId} was already registered with a different ask spec`
        )
      }
      return { askId: row.ask_id }
    }

    const live: LiveAsk = {
      askId: row.ask_id,
      paneKey: row.pane_key,
      spec,
      surfaced: row.pane_key === null,
      timeoutTimer: null,
      livenessGraceTimer: null,
      waiters: new Set()
    }
    this.live.set(live.askId, live)
    this.scheduleTimeoutTimer(live, row.expires_at)

    if (live.paneKey !== null) {
      live.surfaced = this.paneQueue.enqueue(live.paneKey, live.askId)
    }
    if (live.surfaced) {
      this.emit({
        seq: row.seq,
        epoch: this.epoch,
        askId: live.askId,
        paneKey: live.paneKey,
        status: 'registered',
        spec
      })
    }
    return { askId: live.askId }
  }

  /** Pending blocks up to `chunkMs`; resolved returns the terminal envelope immediately and repeatably; unknown/expired is `unavailable`. */
  async waitChunk(askId: string, chunkMs: number, signal: AbortSignal): Promise<AskEnvelope> {
    assertValidAskId(askId)
    const live = this.loadLive(askId)
    if (!live) {
      const row = this.db.getAsk(askId)
      return row ? this.envelopeFromRow(row) : this.unknownAskEnvelope(askId)
    }

    return new Promise<AskEnvelope>((resolve) => {
      let settled = false
      let chunkTimer: ReturnType<typeof setTimeout> | undefined

      // A mid-chunk transport abort only releases this waiter: it resolves with `pending` and
      // never touches the ask's status, so a later waitChunk on the same id resumes it untouched.
      const release = (envelope: AskEnvelope): void => {
        if (settled) {
          return
        }
        settled = true
        if (chunkTimer !== undefined) {
          clearTimeout(chunkTimer)
        }
        signal.removeEventListener('abort', onAbort)
        live.waiters.delete(release)
        resolve(envelope)
      }
      const onAbort = (): void => release(pendingEnvelope(askId))

      if (signal.aborted) {
        release(pendingEnvelope(askId))
        return
      }
      live.waiters.add(release)
      signal.addEventListener('abort', onAbort, { once: true })
      chunkTimer = setTimeout(() => release(pendingEnvelope(askId)), chunkMs)
    })
  }

  answer(askId: string, answers: AskAnswers, skipped: string[]): CommitResult {
    assertValidAskId(askId)
    const live = this.loadLive(askId)
    if (!live) {
      return { committed: false }
    }
    const status: PersistedAskStatus = skipped.length === 0 ? 'answered' : 'partial'
    const summary = buildResultSummary(live.spec, answers)
    this.commitTerminal(live, status, { answers, skipped, summary })
    return { committed: true }
  }

  updatePartial(askId: string, partial: AskPartial): void {
    assertValidAskId(askId)
    const live = this.loadLive(askId)
    if (!live) {
      return
    }
    const filtered = filterPartialToKnownQuestions(live.spec, partial)
    const row = this.db.updatePartial(askId, JSON.stringify(filtered))
    if (!live.surfaced) {
      return
    }
    this.emit({
      seq: row.seq,
      epoch: this.epoch,
      askId,
      paneKey: row.pane_key,
      status: 'registered',
      spec: live.spec,
      partial: filtered
    })
  }

  cancel(askId: string, _by: 'user' | 'agent' | 'interrupt'): CommitResult {
    assertValidAskId(askId)
    const live = this.loadLive(askId)
    if (!live) {
      return { committed: false }
    }
    const skipped = live.spec.questions.map((question) => question.id)
    this.commitTerminal(live, 'declined', { answers: {}, skipped, summary: '' })
    return { committed: true }
  }

  onAskChanged(listener: (event: AskRegistryEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts the surfaced ask's liveness grace timer for `paneKey`; a no-op when one is already running. */
  notePaneDetached(paneKey: string): void {
    const live = this.surfacedAskForPane(paneKey)
    if (!live || live.livenessGraceTimer) {
      return
    }
    live.livenessGraceTimer = setTimeout(
      () => this.resolveLivenessExpiry(live.askId),
      ASK_LIVENESS_GRACE_MS
    )
  }

  /** Cancels the surfaced ask's liveness grace timer for `paneKey`, if one is running. */
  notePaneAttached(paneKey: string): void {
    const live = this.surfacedAskForPane(paneKey)
    if (!live?.livenessGraceTimer) {
      return
    }
    clearTimeout(live.livenessGraceTimer)
    live.livenessGraceTimer = null
  }

  private surfacedAskForPane(paneKey: string): LiveAsk | undefined {
    const headId = this.paneQueue.head(paneKey)
    return headId ? this.live.get(headId) : undefined
  }

  private scheduleTimeoutTimer(live: LiveAsk, expiresAt: string | null): void {
    if (expiresAt === null) {
      return
    }
    const remaining = Date.parse(expiresAt) - Date.now()
    live.timeoutTimer = setTimeout(() => this.resolveTimeout(live.askId), Math.max(remaining, 0))
  }

  // Loading a row this instance never registered (a resumed wait after a restart) has no way to
  // learn whether an older sibling is still ahead of it on the same pane, since the pane FIFO
  // only tracks asks this instance enqueued; treating it as already surfaced is the safe default.
  private loadLive(askId: string): LiveAsk | undefined {
    const cached = this.live.get(askId)
    if (cached) {
      return cached
    }
    const row = this.db.getAsk(askId)
    if (!row || isTerminalAskStatus(row.status)) {
      return undefined
    }
    const live: LiveAsk = {
      askId: row.ask_id,
      paneKey: row.pane_key,
      spec: JSON.parse(row.spec_json) as AskSpec,
      surfaced: true,
      timeoutTimer: null,
      livenessGraceTimer: null,
      waiters: new Set()
    }
    this.live.set(askId, live)
    this.scheduleTimeoutTimer(live, row.expires_at)
    return live
  }

  private resolveTimeout(askId: string): void {
    const live = this.live.get(askId)
    if (!live) {
      return
    }
    const row = this.db.getAsk(askId)
    const partial: AskPartial = row?.partial_json ? JSON.parse(row.partial_json) : {}
    this.commitTerminal(live, 'timed_out', buildTimeoutResult(live.spec, partial))
  }

  private resolveLivenessExpiry(askId: string): void {
    const live = this.live.get(askId)
    if (!live) {
      return
    }
    const skipped = live.spec.questions.map((question) => question.id)
    this.commitTerminal(live, 'unavailable', {
      answers: {},
      skipped,
      summary: `pane ${live.paneKey} disconnected and did not reconnect within the grace window`
    })
  }

  private commitTerminal(
    live: LiveAsk,
    status: Exclude<PersistedAskStatus, 'registered'>,
    result: AskResultBody
  ): void {
    if (live.timeoutTimer) {
      clearTimeout(live.timeoutTimer)
    }
    if (live.livenessGraceTimer) {
      clearTimeout(live.livenessGraceTimer)
    }
    const row = this.db.commitAskResult(live.askId, { status, answersJson: JSON.stringify(result) })
    this.live.delete(live.askId)

    const envelope = this.envelopeFromRow(row)
    this.emit({
      seq: row.seq,
      epoch: this.epoch,
      askId: live.askId,
      paneKey: row.pane_key,
      status,
      result
    })
    for (const release of live.waiters) {
      release(envelope)
    }

    this.promoteAfterResolution(live)
  }

  private promoteAfterResolution(live: LiveAsk): void {
    if (live.paneKey === null) {
      return
    }
    const promotedId = this.paneQueue.remove(live.paneKey, live.askId)
    if (!promotedId) {
      return
    }
    const next = this.live.get(promotedId)
    if (!next || next.surfaced) {
      return
    }
    next.surfaced = true
    const nextRow = this.db.getAsk(promotedId)
    if (nextRow) {
      this.emit({
        seq: nextRow.seq,
        epoch: this.epoch,
        askId: promotedId,
        paneKey: next.paneKey,
        status: 'registered',
        spec: next.spec
      })
    }
  }

  private envelopeFromRow(row: AskRow): AskEnvelope {
    const result: AskResultBody = row.answers_json
      ? (JSON.parse(row.answers_json) as AskResultBody)
      : { answers: {}, skipped: [], summary: '' }
    const askId = row.ask_id
    switch (row.status) {
      case 'answered':
        return { status: 'answered', askId, ...result }
      case 'partial':
        return { status: 'partial', askId, ...result }
      case 'declined':
        return { status: 'declined', askId, ...result }
      case 'timed_out':
        return { status: 'timed_out', askId, ...result }
      case 'unavailable':
        // No dedicated column holds the unavailable reason; it rides in `summary`, which
        // otherwise carries no per-question content for a status with no real answers.
        return { status: 'unavailable', askId, reason: result.summary, ...result }
      case 'registered':
        throw new Error(`ask ${askId} has non-terminal status ${row.status}`)
    }
  }

  private unknownAskEnvelope(askId: string): AskEnvelope {
    return {
      status: 'unavailable',
      askId,
      reason: `ask ${askId} is unknown or has expired`,
      answers: {},
      skipped: [],
      summary: ''
    }
  }

  private emit(event: AskRegistryEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
