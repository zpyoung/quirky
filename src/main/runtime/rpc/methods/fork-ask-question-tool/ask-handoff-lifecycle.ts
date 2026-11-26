import { clampOrchestrationAskTimeoutMs } from '../../../../../shared/orchestration-ask-timeout'
import {
  isTerminalAskStatus,
  pendingEnvelope,
  type AskAnswers,
  type AskEnvelope,
  type AskResultBody,
  type PersistedAskStatus
} from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskPartial,
  AskRegistryEvent,
  AskSpec
} from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskDb, AskRow } from '../../../../fork-ask-question-tool/ask-db'
import { buildResultSummary } from '../../../../../shared/fork-ask-question-tool/ask-answer-value-parsing'
import {
  flattenAskSpecToQuestion,
  mapCoordinatorReply
} from '../../../../fork-ask-question-tool/ask-handoff-flatten'
import { sanitizeAskPartial } from '../../../../fork-ask-question-tool/ask-partial-draft-sanitizer'
import { buildTimeoutResult } from '../../../../fork-ask-question-tool/ask-registry-timeout-answers'
import { getForcedHandoffPolicy } from '../../../../fork-ask-question-tool/forced-handoff-policy'
import type { OrchestrationDb } from '../../../orchestration/db'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { DispatchContextRow } from '../../../orchestration/types'
import type { QuirkyRuntimeService } from '../../../quirky-runtime'
import { envelopeFromAskRow, unknownAskEnvelope } from './ask-envelope-from-row'
import type { AskAttribution } from './ask-pane-attribution'

export type AskHandoffOrigin = { runId: string; dispatchId: string; askerHandle: string }
type HandoffListener = (event: AskRegistryEvent) => void

const listenersByRuntime = new WeakMap<object, Set<HandoffListener>>()

function listenersFor(runtime: QuirkyRuntimeService): Set<HandoffListener> {
  let listeners = listenersByRuntime.get(runtime)
  if (!listeners) {
    listeners = new Set()
    listenersByRuntime.set(runtime, listeners)
  }
  return listeners
}

/**
 * Live feed of hand-off-origin transitions this module commits directly (see
 * `commitHandoffTerminal` for why those never go through `AskRegistry`) — the counterpart
 * `ask.subscribe` merges alongside `AskRegistry.onAskChanged` (tech.md C7).
 */
export function onHandoffAskChanged(
  runtime: QuirkyRuntimeService,
  listener: HandoffListener
): () => void {
  const listeners = listenersFor(runtime)
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitHandoff(runtime: QuirkyRuntimeService, event: AskRegistryEvent): void {
  for (const listener of listenersFor(runtime)) {
    listener(event)
  }
}

// Why: no read API resolves a dispatch by worktree directly — this recovery listing is the only
// one that carries worker_dispatches.worktree_id, so the workspace-scoped branch (C3 rule 3) has
// to filter it rather than call a dedicated lookup.
function findActiveDispatchForWorktree(
  db: OrchestrationDb,
  worktreeId: string | null
): DispatchContextRow | undefined {
  if (!worktreeId) {
    return undefined
  }
  const active = db
    .listLegacyWorkerTerminalRecoveryRows()
    .filter(
      (row) =>
        row.worktree_id === worktreeId &&
        (row.dispatch_status === 'pending' || row.dispatch_status === 'dispatched')
    )
  const newest = active.at(-1)
  return newest ? db.getDispatchContextById(newest.dispatch_id) : undefined
}

function resolveIdentityDispatch(
  db: OrchestrationDb,
  handle: string,
  paneKey: string | null
): DispatchContextRow | undefined {
  return db.getActiveDispatchForIdentity(handle, paneKey ?? undefined)
}

function handoffOriginFor(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  handle: string
): AskHandoffOrigin | null {
  const run = db.getRun(dispatch.run_id)
  if (!run || run.legacy === 1) {
    return null
  }
  return {
    runId: run.id,
    dispatchId: dispatch.id,
    askerHandle: handle || dispatch.assignee_handle || 'unknown'
  }
}

/** Active-run lookup for the no-UI path (tech.md C3/C7): the identity `register` persists and the first `waitChunk` hands off to. */
export function resolveHandoffDispatch(
  attribution: AskAttribution,
  runtime: QuirkyRuntimeService
): AskHandoffOrigin | null {
  const db = runtime.getOrchestrationDb()
  const dispatch =
    resolveIdentityDispatch(db, attribution.dispatchLookupHandle, attribution.paneKey) ??
    findActiveDispatchForWorktree(db, attribution.worktreeId)
  return dispatch ? handoffOriginFor(db, dispatch, attribution.dispatchLookupHandle) : null
}

/**
 * The hand-off an ask must take regardless of any attached UI: its asker holds an active dispatch
 * on a run the installed policy forces. Only a validated pane identity qualifies — a worktree-scope
 * match cannot prove which process asked, so it never overrides a card.
 */
export function resolveForcedHandoff(
  runtime: QuirkyRuntimeService,
  identity: { handle: string; paneKey: string | null }
): AskHandoffOrigin | null {
  const policy = getForcedHandoffPolicy()
  if (!policy || !identity.paneKey) {
    return null
  }
  try {
    const db = runtime.getOrchestrationDb()
    const dispatch = resolveIdentityDispatch(db, identity.handle, identity.paneKey)
    if (!dispatch || !policy.isForcedRun(dispatch.run_id)) {
      return null
    }
    return handoffOriginFor(db, dispatch, identity.handle)
  } catch {
    // an unreadable orchestration store cannot take a hand-off, so the ask keeps its normal route.
    return null
  }
}

// Why: AskDb.commitAskResult has no status guard and nothing else ever writes a handoff-origin
// row's terminal status outside this function, so a synchronous re-check-then-write here (no
// await between them) is enough to make first-commit-wins hold with no separate lock.
function commitHandoffTerminal(
  runtime: QuirkyRuntimeService,
  askDb: AskDb,
  askId: string,
  status: Exclude<PersistedAskStatus, 'registered'>,
  result: AskResultBody
): AskEnvelope {
  const current = askDb.getAsk(askId)
  if (!current) {
    return unknownAskEnvelope(askId)
  }
  if (isTerminalAskStatus(current.status)) {
    return envelopeFromAskRow(current)
  }
  const row = askDb.commitAskResult(askId, { status, answersJson: JSON.stringify(result) })
  emitHandoff(runtime, {
    seq: row.seq,
    epoch: runtime.getAskServices().registry.getEpoch(),
    askId,
    paneKey: row.pane_key,
    status,
    result,
    worktreeId: row.worktree_id
  })
  runtime.getAskServices().registry.releaseCommittedExternally(askId)
  closeHandoffQuestion(runtime, row)
  // Why: a waitHandoffChunk parked on this dispatch (F2) only polls orchestrationDb's question,
  // which a direct answer/cancel never touches — wake it so it re-reads askDb and sees terminal.
  if (row.handoff_dispatch_id) {
    runtime.notifyMessageArrived(`dispatch:${row.handoff_dispatch_id}`, 'status')
  }
  return envelopeFromAskRow(row)
}

// Why: a coordinator must not see a question open once its ask resolved without the coordinator's
// reply (timeout, decline, a direct answer); closing a question already answered is a no-op.
function closeHandoffQuestion(runtime: QuirkyRuntimeService, row: AskRow): void {
  if (!row.handoff_question_id) {
    return
  }
  try {
    runtime.getOrchestrationDb().closeQuestion(row.handoff_question_id)
  } catch (error) {
    console.error('[ask] closing the hand-off question failed:', error)
  }
}

function skippedIds(spec: AskSpec): string[] {
  return spec.questions.map((question) => question.id)
}

// askDb and orchestrationDb are two separate SQLite files with no shared transaction, so a
// process kill between createQuestion and setHandoffQuestionId is possible — not "in one
// transaction". The writes are merely ordered and synchronous with no await between them, which
// keeps that window narrow. findExistingHandoffQuestion below is what makes a restart into that
// window recover (adopt the orphaned question) instead of creating a second one.
function findExistingHandoffQuestion(orchestrationDb: OrchestrationDb, row: AskRow): string | null {
  const dispatchHandle = `dispatch:${row.handoff_dispatch_id}`
  const messages = orchestrationDb.getAllMessagesForHandle(`run:${row.handoff_run_id}`, 500, [
    'question'
  ])
  for (const message of messages) {
    if (message.from_handle !== dispatchHandle) {
      continue
    }
    const question = orchestrationDb.getQuestion(message.id)
    if (question?.status === 'pending' && question.asker_handle === row.handoff_asker) {
      return message.id
    }
  }
  return null
}

function ensureHandoffQuestionCreated(
  runtime: QuirkyRuntimeService,
  askDb: AskDb,
  row: AskRow
):
  | { status: 'ok'; questionId: string; dispatchId: string }
  | { status: 'unavailable'; envelope: AskEnvelope } {
  if (row.handoff_question_id) {
    return {
      status: 'ok',
      questionId: row.handoff_question_id,
      dispatchId: row.handoff_dispatch_id as string
    }
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  const orchestrationDb = runtime.getOrchestrationDb()

  const existingQuestionId = findExistingHandoffQuestion(orchestrationDb, row)
  if (existingQuestionId) {
    askDb.setHandoffQuestionId(row.ask_id, existingQuestionId)
    return {
      status: 'ok',
      questionId: existingQuestionId,
      dispatchId: row.handoff_dispatch_id as string
    }
  }

  try {
    const created = orchestrationDb.createQuestion({
      runId: row.handoff_run_id as string,
      dispatchId: row.handoff_dispatch_id as string,
      askerHandle: row.handoff_asker as string,
      question: flattenAskSpecToQuestion(spec)
    })
    askDb.setHandoffQuestionId(row.ask_id, created.question.message_id)
    runtime.notifyMessageArrived(`run:${row.handoff_run_id}`, created.message.type)
    return {
      status: 'ok',
      questionId: created.question.message_id,
      dispatchId: row.handoff_dispatch_id as string
    }
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'dispatch_inactive') {
      const envelope = commitHandoffTerminal(runtime, askDb, row.ask_id, 'unavailable', {
        answers: {},
        skipped: skippedIds(spec),
        summary: error.message
      })
      return { status: 'unavailable', envelope }
    }
    throw error
  }
}

/**
 * Blocks up to `chunkMs` on the coordinator's reply (tech.md C7): creates the orchestration
 * question on the first call (idempotent across a restart via `handoff_question_id`), then polls
 * it against the orchestration-ask wall-clock deadline (`clampOrchestrationAskTimeoutMs`, anchored
 * to the ask's own `created_at` so it too survives a restart) rather than the registry's
 * liveness-based expiry, which cannot apply to a pane-less ask.
 */
export async function waitHandoffChunk(
  runtime: QuirkyRuntimeService,
  askDb: AskDb,
  askId: string,
  chunkMs: number,
  signal: AbortSignal
): Promise<AskEnvelope> {
  const initial = askDb.getAsk(askId)
  if (!initial) {
    return unknownAskEnvelope(askId)
  }
  if (isTerminalAskStatus(initial.status)) {
    return envelopeFromAskRow(initial)
  }

  const ensured = ensureHandoffQuestionCreated(runtime, askDb, initial)
  if (ensured.status === 'unavailable') {
    return ensured.envelope
  }

  const spec = JSON.parse(initial.spec_json) as AskSpec
  const orchestrationDb = runtime.getOrchestrationDb()
  const overallDeadline =
    Date.parse(initial.created_at) + clampOrchestrationAskTimeoutMs(initial.timeout_ms ?? undefined)
  const chunkDeadline = Date.now() + chunkMs

  while (true) {
    // Why: a concurrent ask.answer/ask.cancel (F2) commits straight to askDb without ever
    // touching the orchestration question, so the terminal status can only be seen here.
    const current = askDb.getAsk(askId)
    if (current && isTerminalAskStatus(current.status)) {
      return envelopeFromAskRow(current)
    }
    const question = orchestrationDb.getQuestion(ensured.questionId)
    if (!question || question.status === 'closed') {
      return commitHandoffTerminal(runtime, askDb, askId, 'unavailable', {
        answers: {},
        skipped: skippedIds(spec),
        summary: `orchestration question ${ensured.questionId} closed because its Dispatch is inactive`
      })
    }
    if (question.status === 'answered') {
      const mapped = mapCoordinatorReply(spec, question.answer_body ?? '')
      const status: PersistedAskStatus = mapped.skipped.length === 0 ? 'answered' : 'partial'
      return commitHandoffTerminal(runtime, askDb, askId, status, mapped)
    }
    if (signal.aborted) {
      return pendingEnvelope(askId)
    }
    const now = Date.now()
    if (now >= overallDeadline) {
      const partial: AskPartial = current?.partial_json ? JSON.parse(current.partial_json) : {}
      return commitHandoffTerminal(
        runtime,
        askDb,
        askId,
        'timed_out',
        buildTimeoutResult(spec, partial)
      )
    }
    if (now >= chunkDeadline) {
      return pendingEnvelope(askId)
    }
    await runtime.waitForMessage(`dispatch:${ensured.dispatchId}`, {
      timeoutMs: Math.min(overallDeadline - now, chunkDeadline - now),
      signal
    })
  }
}

export function cancelHandoff(
  runtime: QuirkyRuntimeService,
  askDb: AskDb,
  askId: string
): AskEnvelope {
  const row = askDb.getAsk(askId)
  if (!row) {
    return unknownAskEnvelope(askId)
  }
  if (isTerminalAskStatus(row.status)) {
    return envelopeFromAskRow(row)
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  return commitHandoffTerminal(runtime, askDb, askId, 'declined', {
    answers: {},
    skipped: skippedIds(spec),
    summary: ''
  })
}

export function commitHandoffAnswer(
  runtime: QuirkyRuntimeService,
  askDb: AskDb,
  askId: string,
  answers: AskAnswers,
  skipped: string[]
): { committed: boolean } {
  const row = askDb.getAsk(askId)
  if (!row || isTerminalAskStatus(row.status)) {
    return { committed: false }
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  const status: PersistedAskStatus = skipped.length === 0 ? 'answered' : 'partial'
  commitHandoffTerminal(runtime, askDb, askId, status, {
    answers,
    skipped,
    summary: buildResultSummary(spec, answers)
  })
  return { committed: true }
}

export function updatePartialHandoff(
  runtime: QuirkyRuntimeService,
  askDb: AskDb,
  askId: string,
  partial: Record<string, unknown>
): void {
  const row = askDb.getAsk(askId)
  if (!row || isTerminalAskStatus(row.status)) {
    return
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  const filtered = sanitizeAskPartial(spec, partial)
  const updated = askDb.updatePartial(askId, JSON.stringify(filtered))
  emitHandoff(runtime, {
    seq: updated.seq,
    epoch: runtime.getAskServices().registry.getEpoch(),
    askId,
    paneKey: updated.pane_key,
    status: 'registered',
    spec,
    partial: filtered,
    worktreeId: updated.worktree_id
  })
}
