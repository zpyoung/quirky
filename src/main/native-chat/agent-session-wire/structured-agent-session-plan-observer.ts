// What the host derives from a journal commit for plan mode: a `plan` row per proposed version, the
// row's settling when its approval resolves, and the `mode` rows that mark plan mode and every
// permission-mode change.
//
// WHY THE HOST DERIVES THEM FROM THE JOURNAL: Claude writes its own approval rows (only ACP and pi
// go through the provider timeline assembler), so the commit that carries a plan approval, and the
// later one that resolves it, are the one place every way a plan ends shows up alike.
//
// The observer is the only writer of `mode` rows, so its in-memory ordinal and last mode are the
// whole truth between journal opens; it reads both from the journal when it first sees one.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalCursor,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { isPlanApprovalSubject } from '../../../shared/agent-session-approval-subject'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import {
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type {
  AgentJournalChatMode,
  AgentJournalPlanItem
} from '../../../shared/agent-session-journal-v1-items'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalItemLinkageVisitor } from '../agent-session-journal/journal-store-contracts'
import {
  modeIdentity,
  modeItem,
  planIdentity,
  planSettlement,
  settledPlanItem,
  waitingPlanItem,
  type PlanSettlement
} from '../agent-session-timeline/plan-mode-items'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** The part of a journal the observer reads and writes. */
export type PlanObserverJournal = {
  cursor(): AgentJournalCursor
  itemBody(itemId: string): AgentJournalItemBody | null
  visitItemsWithLinkage(visit: JournalItemLinkageVisitor): void
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: { fence: number; turnScope: AgentJournalTurnScope }
  ): Promise<unknown>
}

export type StructuredAgentSessionPlanObserverDeps = {
  /** The fence a host-written row is stamped with. */
  fence: (sessionId: string) => number
  /** The permission mode the chat's record holds now; what a mode marker names when no marker
   *  was written yet. */
  permissionMode: (sessionId: string) => AgentChatPermissionMode | undefined
  logger: StructuredAgentSessionLogger
  /** False when this process may not write the journal. */
  canWrite?: () => boolean
}

type TrackedPlan = {
  plan: AgentJournalPlanItem
  turnScope: AgentJournalTurnScope
  /** The approval was already pending when this process first saw the journal. */
  outlivedHost: boolean
}

// weak so an idle-released journal is not kept alive by the observer
type SessionState = {
  journalRef: WeakRef<PlanObserverJournal>
  epoch: string
  sequence: number
  nextVersion: number
  lastPlanText: string | null
  modeCount: number
  lastMode: AgentJournalChatMode | undefined
  /** The mode plan mode was entered from; where an approved plan returns to. */
  modeBeforePlan: AgentChatPermissionMode | undefined
  waiting: Map<string, TrackedPlan>
  writes: Promise<void>
}

const MAX_OBSERVED_SESSIONS = 64
const ENTER_PLAN_MODE_TOOL = 'EnterPlanMode'

export class StructuredAgentSessionPlanObserver {
  private readonly states = new Map<string, SessionState>()
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly deps: StructuredAgentSessionPlanObserverDeps) {}

  /** Resolves once every write started so far has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending)
    }
  }

  /** One journal commit. */
  observe(sessionId: string, journal: PlanObserverJournal): void {
    try {
      this.scan(sessionId, journal)
    } catch (error) {
      // Derived rows are extras: a commit's own delivery must never fail for them.
      this.deps.logger.warn('scanning a journal commit for plan items failed', {
        scope: 'plan-items',
        sessionId,
        error
      })
    }
  }

  /**
   * The person changed the chat's permission mode. `previous` is the mode the record held before
   * the change; a change to the mode already in force writes nothing.
   */
  recordPermissionMode(
    sessionId: string,
    journal: PlanObserverJournal,
    mode: AgentChatPermissionMode,
    previous: AgentChatPermissionMode | undefined
  ): void {
    try {
      const state = this.stateFor(sessionId, journal)
      if (mode === (state.lastMode ?? previous)) {
        return
      }
      this.writeMode(sessionId, state, mode, state.lastMode ?? previous)
    } catch (error) {
      this.deps.logger.warn('recording a permission mode marker failed', {
        scope: 'plan-items',
        sessionId,
        error
      })
    }
  }

  private scan(sessionId: string, journal: PlanObserverJournal): void {
    const known = this.states.get(sessionId)
    const state = this.stateFor(sessionId, journal)
    if (state !== known) {
      return
    }
    this.settleWaiting(sessionId, state)
    const cursor = journal.cursor()
    if (cursor.sequence > state.sequence) {
      const floor = state.sequence
      state.sequence = cursor.sequence
      journal.visitItemsWithLinkage((itemId, sequence, body, attribution) => {
        if (sequence > floor && isRootAgentJournalItem(attribution)) {
          this.observeNewItem(sessionId, state, itemId, body, attribution.turnScope)
        }
      })
    }
  }

  /** The session's state, built from the journal when it is new, replaced, or rewound. */
  private stateFor(sessionId: string, journal: PlanObserverJournal): SessionState {
    const cursor = journal.cursor()
    const held = this.states.get(sessionId)
    if (
      held &&
      held.journalRef.deref() === journal &&
      held.epoch === cursor.epoch &&
      cursor.sequence >= held.sequence
    ) {
      return held
    }
    const state = this.readState(journal, cursor)
    this.states.delete(sessionId)
    this.states.set(sessionId, state)
    for (const oldest of [...this.states.keys()].slice(
      0,
      Math.max(0, this.states.size - MAX_OBSERVED_SESSIONS)
    )) {
      this.states.delete(oldest)
    }
    this.reconcile(sessionId, state, journal)
    return state
  }

  private readState(journal: PlanObserverJournal, cursor: AgentJournalCursor): SessionState {
    const state: SessionState = {
      journalRef: new WeakRef(journal),
      epoch: cursor.epoch,
      sequence: cursor.sequence,
      nextVersion: 1,
      lastPlanText: null,
      modeCount: 0,
      lastMode: undefined,
      modeBeforePlan: undefined,
      waiting: new Map(),
      writes: Promise.resolve()
    }
    let newestPlan = 0
    let newestMode = 0
    journal.visitItemsWithLinkage((_itemId, sequence, body) => {
      if (body.kind === 'plan') {
        state.nextVersion = Math.max(state.nextVersion, body.version + 1)
        if (body.version > newestPlan) {
          newestPlan = body.version
          state.lastPlanText = body.text.trim() === '' ? null : body.text
        }
      } else if (body.kind === 'mode') {
        state.modeCount += 1
        if (sequence > newestMode) {
          newestMode = sequence
          state.lastMode = body.mode
          if (body.mode === 'plan' && body.previous && body.previous !== 'plan') {
            state.modeBeforePlan = body.previous
          }
        }
      }
    })
    return state
  }

  /** Plans a past run left waiting: their approvals ended while nothing here was watching. */
  private reconcile(sessionId: string, state: SessionState, journal: PlanObserverJournal): void {
    const scopes = new Map<string, AgentJournalTurnScope>()
    const plans: AgentJournalPlanItem[] = []
    const answered = new Set<string>()
    const rootItemIds = new Set<string>()
    const unplanned: { itemId: string; body: AgentJournalItemBody }[] = []
    journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
      scopes.set(itemId, attribution.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE)
      if (isRootAgentJournalItem(attribution)) {
        rootItemIds.add(itemId)
      }
      if (body.kind === 'plan') {
        if (body.approvalItemId) {
          answered.add(body.approvalItemId)
        }
        if (body.status === 'waiting') {
          plans.push(body)
        }
      } else if (
        body.kind === 'approval' &&
        isPlanApprovalSubject(body.subject) &&
        body.resolution.state === 'pending'
      ) {
        unplanned.push({ itemId, body })
      }
    })
    // A plan approval that is still open but has no row yet: the commit that raised it came first.
    for (const { itemId, body } of unplanned) {
      if (!answered.has(itemId) && rootItemIds.has(itemId)) {
        this.observeNewItem(sessionId, state, itemId, body, scopes.get(itemId))
      }
    }
    for (const body of plans) {
      const approvalId = body.approvalItemId
      if (!approvalId) {
        continue
      }
      const tracked: TrackedPlan = {
        plan: body,
        turnScope: scopes.get(approvalId) ?? AGENT_JOURNAL_THREAD_SCOPE,
        outlivedHost: true
      }
      state.waiting.set(approvalId, tracked)
    }
    this.settleWaiting(sessionId, state)
  }

  private observeNewItem(
    sessionId: string,
    state: SessionState,
    itemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope | undefined
  ): void {
    if (body.kind === 'tool-call' && body.name === ENTER_PLAN_MODE_TOOL) {
      if (body.state !== 'failed' && state.lastMode !== 'plan') {
        this.writeMode(sessionId, state, 'plan', undefined)
      }
      return
    }
    if (body.kind !== 'approval' || state.waiting.has(itemId)) {
      return
    }
    const plan = waitingPlanItem(body, itemId, state.nextVersion, state.lastPlanText)
    if (!plan) {
      return
    }
    state.nextVersion += 1
    state.lastPlanText = plan.empty ? null : plan.text
    const scope = turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    // A plan approval means plan mode, however it was entered (a chat started in it writes no tool call).
    if (state.lastMode !== 'plan') {
      this.writeMode(sessionId, state, 'plan', undefined)
    }
    state.waiting.set(itemId, { plan, turnScope: scope, outlivedHost: false })
    this.write(sessionId, state, planIdentity(plan.version), plan, scope)
    this.settleWaiting(sessionId, state)
  }

  private settleWaiting(sessionId: string, state: SessionState): void {
    for (const [approvalId, tracked] of state.waiting) {
      const settlement = this.settlementOf(state, approvalId, tracked)
      if (!settlement) {
        continue
      }
      state.waiting.delete(approvalId)
      this.write(
        sessionId,
        state,
        planIdentity(tracked.plan.version),
        settledPlanItem(tracked.plan, settlement),
        tracked.turnScope
      )
      if (settlement.status === 'approved') {
        this.leavePlanMode(sessionId, state)
      }
    }
  }

  private settlementOf(
    state: SessionState,
    approvalId: string,
    tracked: TrackedPlan
  ): PlanSettlement | null {
    const journal = state.journalRef.deref()
    if (!journal) {
      return null
    }
    const approval = journal.itemBody(approvalId)
    if (approval?.kind !== 'approval') {
      return { status: 'not-answered', reason: tracked.outlivedHost ? 'restarted' : 'stopped' }
    }
    const settled = planSettlement(approval.resolution, tracked.outlivedHost)
    if (settled) {
      return settled
    }
    // Still pending, but the turn that raised it is over: nobody can answer it for that turn.
    const scope = tracked.turnScope
    if (scope.kind === 'turn') {
      const turn = readAgentJournalTurn(journal.itemBody(scope.turnItemId) ?? undefined)
      if (turn && turn.state !== 'running') {
        return { status: 'not-answered', reason: tracked.outlivedHost ? 'restarted' : 'stopped' }
      }
    }
    return null
  }

  private leavePlanMode(sessionId: string, state: SessionState): void {
    const target = state.modeBeforePlan ?? this.deps.permissionMode(sessionId) ?? 'ask'
    if (target !== state.lastMode) {
      this.writeMode(sessionId, state, target, 'plan')
    }
  }

  private writeMode(
    sessionId: string,
    state: SessionState,
    mode: AgentJournalChatMode,
    previous: AgentJournalChatMode | undefined
  ): void {
    const before = previous ?? state.lastMode ?? this.deps.permissionMode(sessionId)
    if (mode === 'plan' && before && before !== 'plan') {
      state.modeBeforePlan = before
    }
    state.modeCount += 1
    state.lastMode = mode
    this.write(sessionId, state, modeIdentity(state.modeCount), modeItem(mode, before), {
      kind: 'thread'
    })
  }

  /** Writes land in the order they were asked for, so a proposal precedes its settling. */
  private write(
    sessionId: string,
    state: SessionState,
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope
  ): void {
    const done = state.writes.then(() => this.append(sessionId, state, identity, body, turnScope))
    state.writes = done
    this.track(done)
  }

  private async append(
    sessionId: string,
    state: SessionState,
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope
  ): Promise<void> {
    // A rewind or restore replaced the rows this was derived from.
    const journal = state.journalRef.deref()
    if (!journal || this.deps.canWrite?.() === false || journal.cursor().epoch !== state.epoch) {
      return
    }
    try {
      await journal.appendItem(identity, body, {
        fence: this.deps.fence(sessionId),
        turnScope
      })
    } catch (error) {
      this.deps.logger.warn('writing a plan or mode item failed', {
        scope: 'plan-items',
        sessionId,
        item: agentJournalItemKey(identity),
        error
      })
    }
  }

  private track(work: Promise<unknown>): void {
    const settled: Promise<void> = work.then(
      () => undefined,
      () => undefined
    )
    this.pending.add(settled)
    void settled.finally(() => this.pending.delete(settled))
  }
}

/** The observer a host runs: rows are stamped with the conversation's current fence, and a mode
 *  marker with no earlier one names the permission mode the chat's record holds. */
export function createHostPlanObserver(
  deps: () => Pick<StructuredAgentSessionHostDeps, 'store' | 'logger'>
): StructuredAgentSessionPlanObserver {
  return new StructuredAgentSessionPlanObserver({
    fence: (sessionId) => structuredAgentSessionConversationFence(deps().store, sessionId),
    permissionMode: (sessionId) => recordPermissionMode(deps().store.getRecord(sessionId)),
    canWrite: () => !deps().store.readOnly,
    get logger() {
      return deps().logger
    }
  })
}

/** The record's saved permission mode, when it names one this build knows. */
export function recordPermissionMode(
  record: { permissionMode?: string; options?: Record<string, string> } | undefined | null
): AgentChatPermissionMode | undefined {
  const saved = record?.permissionMode ?? record?.options?.permissionMode
  return isAgentChatPermissionMode(saved) ? saved : undefined
}
