import { defineMethod, defineStreamingMethod } from '../../core'
import { isTerminalAskStatus } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import {
  ASK_DEFAULT_CHUNK_MS,
  validateAskSpec,
  type AskPartial,
  type AskRegistryEvent,
  type AskSpec
} from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskDb } from '../../../../fork-ask-question-tool/ask-db'
import { validateAskAnswerSubmission } from './ask-answer-validation'
import { registryEventFromRow } from './ask-envelope-from-row'
import {
  cancelHandoff,
  commitHandoffAnswer,
  onHandoffAskChanged,
  resolveForcedHandoff,
  resolveHandoffDispatch,
  updatePartialHandoff,
  waitHandoffChunk
} from './ask-handoff-lifecycle'
import { resolveAskAttribution, type AskAttribution } from './ask-pane-attribution'
import {
  AskAnswerParams,
  AskCancelParams,
  AskRegisterParams,
  AskSnapshotParams,
  AskSubscribeParams,
  AskUpdatePartialParams,
  AskWaitParams
} from './ask-schemas'

function buildNoUiUnavailableReason(attribution: AskAttribution): string {
  return attribution.anyIdentityClaimed
    ? 'no attached UI and no active orchestration run to hand off to'
    : 'no attached UI: set QUIRKY_PANE_KEY, QUIRKY_TERMINAL_HANDLE, QUIRKY_WORKTREE_ID, or QUIRKY_WORKSPACE_ID'
}

function formatSpecErrors(errors: { path: string; message: string }[]): string {
  return errors
    .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
    .join('; ')
}

// Why: the watermark is the store's true head seq, not a max over pending (or paneKey-filtered)
// rows — a resolved ask can hold a higher seq than any pending one, so that max would under-report
// the head. A watermark too low only replays events the client already has (harmless); one too
// high silently skips events forever, so the true head is the only safe choice.
function buildPendingSnapshot(
  db: AskDb,
  epoch: string,
  paneKeyFilter?: string
): { asks: AskRegistryEvent[]; maxSeq: number } {
  const rows = db.listPending()
  const filtered =
    paneKeyFilter === undefined ? rows : rows.filter((row) => row.pane_key === paneKeyFilter)
  return { asks: filtered.map((row) => registryEventFromRow(row, epoch)), maxSeq: db.currentSeq() }
}

let askSubscriptionSeq = 0

export const ASK_METHODS = [
  defineMethod({
    name: 'ask.register',
    permission: 'workspace',
    params: AskRegisterParams,
    // C3/C4 own attribution and capability gating: register never blocks, and an ask is never
    // durably inserted for a surface no attached client can render.
    handler: async (params, { runtime }) => {
      const validation = validateAskSpec(params.spec)
      if (!validation.ok) {
        throw new Error(formatSpecErrors(validation.errors))
      }
      const attribution = await resolveAskAttribution(params, runtime)
      const { registry, roster } = runtime.getAskServices()

      const forced = resolveForcedHandoff(runtime, {
        handle: attribution.dispatchLookupHandle,
        paneKey: attribution.paneKey
      })
      if (forced) {
        return registry.register(
          validation.spec,
          { paneKey: null, worktreeId: attribution.worktreeId, handoff: forced },
          { requestId: params.requestId, timeoutMs: params.timeoutMs }
        )
      }

      if (attribution.paneKey && roster.hasCapableOwner(attribution.paneKey)) {
        return registry.register(
          validation.spec,
          { paneKey: attribution.paneKey, worktreeId: attribution.worktreeId },
          { requestId: params.requestId, timeoutMs: params.timeoutMs }
        )
      }

      const handoff = resolveHandoffDispatch(attribution, runtime)
      if (handoff) {
        return registry.register(
          validation.spec,
          { paneKey: null, worktreeId: attribution.worktreeId, handoff },
          { requestId: params.requestId, timeoutMs: params.timeoutMs }
        )
      }

      return { status: 'unavailable' as const, reason: buildNoUiUnavailableReason(attribution) }
    }
  }),

  defineMethod({
    name: 'ask.wait',
    permission: 'workspace',
    params: AskWaitParams,
    handler: async (params, { runtime, signal }) => {
      const { db, registry, waitGate } = runtime.getAskServices()
      const chunkMs = params.chunkMs ?? ASK_DEFAULT_CHUNK_MS
      const waitSignal = signal ?? new AbortController().signal
      const row = db.getAsk(params.askId)
      return waitGate.run(() =>
        row?.origin === 'handoff'
          ? waitHandoffChunk(runtime, db, params.askId, chunkMs, waitSignal)
          : registry.waitChunk(params.askId, chunkMs, waitSignal)
      )
    }
  }),

  defineMethod({
    name: 'ask.answer',
    permission: 'workspace',
    params: AskAnswerParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const row = db.getAsk(params.askId)
      if (!row || isTerminalAskStatus(row.status)) {
        return { committed: false }
      }
      const spec = JSON.parse(row.spec_json) as AskSpec
      const validation = validateAskAnswerSubmission(spec, params.answers, params.skipped)
      if (!validation.ok) {
        throw new Error(
          validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ')
        )
      }
      if (row.origin === 'handoff') {
        return commitHandoffAnswer(
          runtime,
          db,
          params.askId,
          validation.answers,
          validation.skipped
        )
      }
      return registry.answer(params.askId, validation.answers, validation.skipped)
    }
  }),

  defineMethod({
    name: 'ask.updatePartial',
    permission: 'workspace',
    params: AskUpdatePartialParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const row = db.getAsk(params.askId)
      if (row?.origin === 'handoff') {
        updatePartialHandoff(runtime, db, params.askId, params.partial as AskPartial)
      } else {
        registry.updatePartial(params.askId, params.partial as AskPartial)
      }
      return { ok: true as const }
    }
  }),

  defineMethod({
    name: 'ask.cancel',
    permission: 'workspace',
    params: AskCancelParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const row = db.getAsk(params.askId)
      if (row?.origin === 'handoff') {
        return cancelHandoff(runtime, db, params.askId)
      }
      registry.cancel(params.askId, 'agent')
      // Why: cancel() returns a bare CommitResult; waitChunk on the now-terminal ask resolves the
      // envelope immediately (its resolved-ask fast path) without reimplementing envelope-building.
      return registry.waitChunk(params.askId, 0, new AbortController().signal)
    }
  }),

  defineMethod({
    name: 'ask.snapshot',
    permission: 'workspace',
    params: AskSnapshotParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const epoch = registry.getEpoch()
      const { asks, maxSeq } = buildPendingSnapshot(db, epoch, params.paneKey)
      return { asks, seq: maxSeq, epoch }
    }
  }),

  defineStreamingMethod({
    name: 'ask.subscribe',
    permission: 'workspace',
    params: AskSubscribeParams,
    handler: async (params, { runtime, connectionId }, emit) => {
      const { db, registry } = runtime.getAskServices()
      const epoch = registry.getEpoch()
      const needsSnapshot = params.sinceSeq === undefined || params.epoch !== epoch

      await new Promise<void>((resolve) => {
        let liveMode = false
        const buffered: AskRegistryEvent[] = []
        const relay = (event: AskRegistryEvent): void => {
          if (liveMode) {
            emit({ type: 'event', event })
          } else {
            buffered.push(event)
          }
        }
        const unsubscribeRegistry = registry.onAskChanged(relay)
        const unsubscribeHandoff = onHandoffAskChanged(runtime, relay)

        // Why: everything below reads state after already listening live, so nothing published
        // between that read and now can be missed — only double-delivered, which the trailing
        // buffered-event filter below (seq > catchupThroughSeq) prevents.
        let catchupThroughSeq: number
        if (needsSnapshot) {
          const { asks, maxSeq } = buildPendingSnapshot(db, epoch)
          for (const event of asks) {
            emit({ type: 'snapshot', event })
          }
          catchupThroughSeq = maxSeq
          emit({ type: 'watermark', seq: catchupThroughSeq, epoch })
        } else {
          const sinceSeq = params.sinceSeq as number
          const missed = db.listSinceSeq(sinceSeq)
          for (const row of missed) {
            emit({ type: 'event', event: registryEventFromRow(row, epoch) })
          }
          catchupThroughSeq = missed.at(-1)?.seq ?? sinceSeq
        }
        for (const event of buffered) {
          if (event.seq > catchupThroughSeq) {
            emit({ type: 'event', event })
          }
        }
        buffered.length = 0
        liveMode = true

        const subscriptionId = `ask-${connectionId ?? 'inproc'}-${++askSubscriptionSeq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribeRegistry()
            unsubscribeHandoff()
            emit({ type: 'end', reason: 'closed' })
            resolve()
          },
          connectionId
        )
      })
    }
  })
]
