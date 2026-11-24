import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { OrchestrationDb, RunRow } from '../../runtime/orchestration/db'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import {
  orchestrationCallerIdentity,
  resolveRunScope
} from '../../runtime/rpc/methods/orchestration/runs/run-scope'
import { startLocalWorker } from '../../runtime/rpc/methods/orchestration/worker/local-worker-start'
import { inspectWorkerTerminal } from '../../runtime/rpc/methods/orchestration/worker/worker-observation'
import type { WorkerReleaseReceipt } from '../../runtime/rpc/methods/orchestration/worker/worker-release-completion'
import { assertWorkerStartTaskSpecWithinPromptBudget } from '../../runtime/rpc/methods/orchestration/worker/worker-start-prompt-budget'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../../runtime/rpc/methods/orchestration-worker-start-mode'
import { getOrchestrationMutationExecutor } from '../../runtime/rpc/orchestration-mutation-executor'
import {
  hashCanonical,
  replayStableCallerParams
} from '../../runtime/rpc/orchestration-mutation-receipt'
import type { RpcRequest } from '../../runtime/rpc/core'
import type {
  DispatchResult,
  DispatchWorkerInput
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherCommandResult, WatcherWorker } from '../../../shared/fork-heimdall/fleet-types'
import type { EvidenceEntry, LedgerEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { resolveWorkerStartReadinessTimeoutMs } from '../../../shared/orchestration-timing-budgets'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import { readAuthoritativeWorkerReportEvidence } from './authoritative-worker-report'
import { coordinatorIdentityFingerprint } from './coordinator-identity'
import { coordinatorRuntimeFacade } from './coordinator-runtime-facade'
import {
  dispatchResultWithTerminal,
  workerStartParams,
  workspaceRuntimeId
} from './worker-dispatch-routing'
import {
  CoordinatorSeatLostError,
  orchestrationRequestIdForAttemptFingerprint,
  QuestionAlreadyAnsweredError,
  WorkerPromptUndeliverableError,
  type DispatchObservation,
  type HeimdallOrchestrationAdapter,
  type HeimdallOrchestrationPersistence,
  type RecoverDispatchResult,
  type WatcherQuestionState,
  type WorkerIdleObservation
} from './orchestration-contract'
import { drainHeimdallMailbox, type MailboxDrainInput } from './mailbox-drain'
import { answerWatcherQuestion, readWatcherQuestion } from './question-answer'
import { listWatcherWorkers, releaseWatcherWorker, stopWatcherWorker } from './worker-controls'
import { observeEnrolledWorkerIdle } from './worker-idle-observation'
import { sendEnrolledWorkerPrompt } from './worker-prompt-send'
import {
  dispatchResultFromReceipt,
  parseWorkerStartReceipt,
  type WorkerStartReceipt
} from './worker-start-receipt'

export {
  CoordinatorSeatLostError,
  orchestrationRequestIdForAttemptFingerprint,
  QuestionAlreadyAnsweredError,
  WorkerPromptUndeliverableError,
  workspaceRuntimeId
}
export type { DispatchResult, DispatchWorkerInput }
export type {
  DispatchObservation,
  HeimdallOrchestrationAdapter,
  HeimdallOrchestrationPersistence,
  RecoverDispatchResult,
  WatcherQuestionState,
  WorkerIdleObservation
}
export type { CoordinatorIdentity } from '../../../shared/fork-heimdall/watcher-types'
export type { MailboxCursor, MailboxDrainInput } from './mailbox-drain'

const CAPABILITY_ERROR_CODES: Record<string, true> = {
  capability_invalid: true,
  capability_unsupported: true,
  invalid_argument: true,
  request_mismatch: true,
  task_not_startable: true,
  worker_prompt_too_large: true
}
const PLACEMENT_ERROR_CODES: Record<string, true> = {
  folder_worktree_unsupported: true,
  repo_not_found: true,
  selector_ambiguous: true,
  selector_not_found: true,
  terminal_worktree_mismatch: true,
  worktree_not_found: true,
  worktree_not_found_on_server: true
}

export class RuntimeHeimdallOrchestrationAdapter implements HeimdallOrchestrationAdapter {
  constructor(
    private readonly runtime: QuirkyRuntimeService,
    private readonly persistence: HeimdallOrchestrationPersistence
  ) {}

  async ensureRun(enrollment: WatcherEnrollment): Promise<{ runId: string }> {
    const identity = enrollment.coordinatorIdentity
    if (enrollment.orchestrationRunId) {
      const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
      return { runId: run.id }
    }

    const db = this.runtime.getOrchestrationDb()
    const current = db.getCurrentRunForPane(identity.paneKey)
    const run =
      current ??
      db.createRun({
        objective: `Supervise Heimdall watcher ${enrollment.watcherId}`,
        coordinatorHandle: identity.handle,
        coordinatorPaneKey: identity.paneKey
      })
    this.assertRunIdentity(enrollment, run)
    await this.persistence.persistOrchestrationRunId(enrollment.watcherId, run.id)
    return { runId: run.id }
  }

  async dispatchWorker(input: DispatchWorkerInput): Promise<DispatchResult> {
    const requestId = orchestrationRequestIdForAttemptFingerprint(input.attemptFingerprint)
    let run: RunRow
    let db: OrchestrationDb
    try {
      const ensured = await this.ensureRun(input.enrollment)
      run = this.resolvePersistedRun(input.enrollment, ensured.runId)
      db = this.runtime.getOrchestrationDb()
    } catch (error) {
      if (
        error instanceof CoordinatorSeatLostError ||
        isOrchestrationError(error, 'consumer_fenced')
      ) {
        return refused('fenced', error)
      }
      return refused('pre-dispatch-failure', error)
    }

    const identity = input.enrollment.coordinatorIdentity
    let workerStartInvoked = false

    try {
      const params = workerStartParams(input)
      await assertWorkerStartTaskSpecWithinPromptBudget(input.spec)
      const mode = decideWorkerStartMode({
        params,
        settings: readWorkerStartModeSettings(this.runtime)
      })
      const request: RpcRequest = {
        id: `heimdall-${requestId}`,
        authToken: '',
        method: 'orchestration.workerStart',
        params,
        orchestrationRequestId: requestId,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrchestrationMutationExecutor.run is intentionally typed Promise<unknown>; the invoked handler's actual receipt shape is this call's only source of truth.
      const receipt = (await getOrchestrationMutationExecutor(this.runtime).run(
        request,
        params,
        (mutation) => {
          const startInput = {
            params: {
              ...params,
              timeoutMs: resolveWorkerStartReadinessTimeoutMs(undefined)
            },
            runtime: coordinatorRuntimeFacade(
              this.runtime,
              input.enrollment,
              workspaceRuntimeId(input.enrollment)
            ),
            db,
            run,
            coordinator: orchestrationCallerIdentity(this.runtime, {
              handle: identity.handle,
              paneKey: identity.paneKey,
              session: undefined
            }),
            orchestrationMutation: mutation?.identity,
            mode
          }
          workerStartInvoked = true
          return startLocalWorker(startInput)
        },
        coordinatorIdentityFingerprint(identity)
      )) as WorkerStartReceipt
      return dispatchResultWithTerminal(db, dispatchResultFromReceipt(receipt, requestId))
    } catch (error) {
      if (isOrchestrationError(error, 'operation_unknown')) {
        return { status: 'indeterminate', requestId }
      }
      if (isOrchestrationError(error, 'consumer_fenced')) {
        return refused('fenced', error)
      }
      if (error instanceof OrchestrationError && CAPABILITY_ERROR_CODES[error.code]) {
        return refused('capability-invalid', error)
      }
      if (error instanceof OrchestrationError && PLACEMENT_ERROR_CODES[error.code]) {
        return refused('placement-unavailable', error)
      }
      if (!workerStartInvoked) {
        return refused('pre-dispatch-failure', error)
      }
      return { status: 'indeterminate', requestId }
    }
  }

  async recoverDispatch(input: DispatchWorkerInput): Promise<RecoverDispatchResult> {
    const requestId = orchestrationRequestIdForAttemptFingerprint(input.attemptFingerprint)
    if (!input.enrollment.orchestrationRunId) {
      return { status: 'absent' }
    }
    this.resolvePersistedRun(input.enrollment, input.enrollment.orchestrationRunId)
    const db = this.runtime.getOrchestrationDb()
    const params = workerStartParams(input)
    const callerFingerprint = coordinatorIdentityFingerprint(input.enrollment.coordinatorIdentity)
    const receipt = db.getMutationReceipt(callerFingerprint, requestId)
    if (!receipt) {
      return { status: 'absent' }
    }
    const payloadHash = hashCanonical({
      method: 'orchestration.workerStart',
      params: replayStableCallerParams(this.runtime, params)
    })
    if (receipt.method !== 'orchestration.workerStart' || receipt.payload_hash !== payloadHash) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: `Mutation request ${requestId} was already used with different input.`
      }
    }
    if (receipt.state === 'pending') {
      return { status: 'indeterminate', requestId }
    }
    const completed = parseWorkerStartReceipt(receipt.receipt)
    return completed
      ? dispatchResultWithTerminal(db, dispatchResultFromReceipt(completed, requestId))
      : { status: 'indeterminate', requestId }
  }

  async readDispatch(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<DispatchObservation> {
    if (!dispatchId.trim()) {
      throw new Error('dispatchId must be non-empty')
    }
    const ensured = await this.ensureRun(enrollment)
    const db = this.runtime.getOrchestrationDb()
    const run = this.resolvePersistedRun(enrollment, ensured.runId)
    const dispatch = db.getDispatchContextById(dispatchId)
    if (!dispatch) {
      return { status: 'unverifiable', reason: `Dispatch ${dispatchId} was not found` }
    }
    if (dispatch.run_id !== run.id) {
      return {
        status: 'unverifiable',
        reason: `Dispatch ${dispatchId} does not belong to Run ${run.id}`
      }
    }

    const handle =
      db.getWorkerDispatch(dispatchId)?.agent_terminal_handle ?? dispatch.assignee_handle
    if (isStructuredWorkerHandle(handle)) {
      try {
        await this.runtime.ensureStructuredAgentSessionHost()
      } catch (error) {
        return {
          status: 'unverifiable',
          reason: `Structured worker host unavailable: ${errorDetail(error)}`
        }
      }
    }

    let observation: Awaited<ReturnType<typeof inspectWorkerTerminal>>
    try {
      observation = await inspectWorkerTerminal(this.runtime, db, dispatchId)
    } catch (error) {
      return { status: 'unverifiable', reason: errorDetail(error) }
    }
    if (observation.status === 'live' || observation.status === 'exited') {
      return { status: observation.status }
    }
    if (observation.status === 'unverifiable') {
      return observation.reason
        ? { status: 'unverifiable', reason: observation.reason }
        : { status: 'unverifiable' }
    }
    if (!dispatch.process_incarnation) {
      return {
        status: 'unverifiable',
        reason: `Dispatch ${dispatchId} has no exact process incarnation`
      }
    }

    try {
      const status = await this.runtime.inspectTerminalProcessIncarnationLiveness(
        dispatch.process_incarnation,
        dispatch.host_scope
      )
      return status === 'unverifiable'
        ? {
            status,
            reason:
              observation.reason ??
              `Dispatch ${dispatchId} process liveness is unavailable from its execution host`
          }
        : { status }
    } catch (error) {
      return { status: 'unverifiable', reason: errorDetail(error) }
    }
  }

  async readAuthoritativeWorkerReport(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<EvidenceEntry | null> {
    if (!dispatchId.trim()) {
      throw new Error('dispatchId must be non-empty')
    }
    if (!enrollment.orchestrationRunId) {
      return null
    }
    const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
    return readAuthoritativeWorkerReportEvidence({
      db: this.runtime.getOrchestrationDb(),
      enrollment,
      runId: run.id,
      dispatchId
    })
  }

  async listWorkers(enrollment: WatcherEnrollment): Promise<WatcherWorker[]> {
    if (!enrollment.orchestrationRunId) {
      return []
    }
    const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
    return listWatcherWorkers(this.runtime, enrollment, run)
  }

  async stopWorker(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<WatcherCommandResult> {
    if (!dispatchId.trim()) {
      return {
        status: 'refused',
        reason: 'invalid-command',
        detail: 'dispatchId must be non-empty'
      }
    }
    if (!enrollment.orchestrationRunId) {
      return {
        status: 'refused',
        reason: 'worker-unverifiable',
        detail: `Watcher ${enrollment.watcherId} has no orchestration Run`
      }
    }
    const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
    return stopWatcherWorker(this.runtime, enrollment, run, dispatchId, () => {
      this.resolvePersistedRun(enrollment, run.id)
    })
  }

  async releaseWorker(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<WorkerReleaseReceipt> {
    if (!dispatchId.trim()) {
      throw new OrchestrationError('invalid_argument', 'dispatchId must be non-empty')
    }
    if (!enrollment.orchestrationRunId) {
      throw new OrchestrationError(
        'run_required',
        `Watcher ${enrollment.watcherId} has no orchestration Run`
      )
    }
    const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
    return releaseWatcherWorker(this.runtime, enrollment, run, dispatchId, () => {
      this.resolvePersistedRun(enrollment, run.id)
    })
  }

  async drainMailbox(input: MailboxDrainInput): Promise<LedgerEntry[]> {
    const ensured = await this.ensureRun(input.enrollment)
    const run = this.resolvePersistedRun(input.enrollment, ensured.runId)
    try {
      return await drainHeimdallMailbox({
        runtime: this.runtime,
        enrollment: input.enrollment,
        run,
        cursor: input.cursor
      })
    } catch (error) {
      if (isOrchestrationError(error, 'consumer_fenced')) {
        throw new CoordinatorSeatLostError(input.enrollment.watcherId, error)
      }
      throw error
    }
  }

  async answerQuestion(
    enrollment: WatcherEnrollment,
    messageId: string,
    body: string
  ): Promise<void> {
    if (!messageId.trim() || !body.trim()) {
      throw new Error('messageId and body must be non-empty')
    }
    const ensured = await this.ensureRun(enrollment)
    const run = this.resolvePersistedRun(enrollment, ensured.runId)
    try {
      answerWatcherQuestion(this.runtime, run, messageId, body)
    } catch (error) {
      if (isOrchestrationError(error, 'consumer_fenced')) {
        throw new CoordinatorSeatLostError(enrollment.watcherId, error)
      }
      if (isOrchestrationError(error, 'answer_conflict')) {
        throw new QuestionAlreadyAnsweredError(messageId, error)
      }
      throw error
    }
  }

  async readQuestion(
    enrollment: WatcherEnrollment,
    messageId: string
  ): Promise<WatcherQuestionState> {
    if (!messageId.trim()) {
      throw new Error('messageId must be non-empty')
    }
    if (!enrollment.orchestrationRunId) {
      return { status: 'absent' }
    }
    try {
      return readWatcherQuestion(
        this.runtime,
        this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId),
        messageId
      )
    } catch (error) {
      // a seat we cannot reach is not evidence the question settled, so it stays answerable
      return {
        status: 'unverifiable',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  observeWorkerIdle(enrollment: WatcherEnrollment, dispatchId: string) {
    return observeEnrolledWorkerIdle(this.runtime, enrollment, dispatchId, (runId) =>
      this.resolvePersistedRun(enrollment, runId)
    )
  }

  sendWorkerPrompt(enrollment: WatcherEnrollment, dispatchId: string, text: string) {
    return sendEnrolledWorkerPrompt(this.runtime, enrollment, dispatchId, text, (runId) =>
      this.resolvePersistedRun(enrollment, runId)
    )
  }

  private resolvePersistedRun(enrollment: WatcherEnrollment, runId: string): RunRow {
    try {
      const run = resolveRunScope(this.runtime, {
        runId,
        callerTerminalHandle: enrollment.coordinatorIdentity.handle,
        callerPaneKey: enrollment.coordinatorIdentity.paneKey,
        callerSession: undefined,
        requireCurrentConsumer: true
      })
      this.assertRunIdentity(enrollment, run)
      return run
    } catch (error) {
      if (
        error instanceof OrchestrationError &&
        ['consumer_fenced', 'run_not_found', 'run_required'].includes(error.code)
      ) {
        throw new CoordinatorSeatLostError(enrollment.watcherId, error)
      }
      throw error
    }
  }

  private assertRunIdentity(enrollment: WatcherEnrollment, run: RunRow): void {
    const identity = enrollment.coordinatorIdentity
    if (
      run.coordinator_handle !== identity.handle ||
      run.coordinator_pane_key !== identity.paneKey
    ) {
      throw new CoordinatorSeatLostError(
        enrollment.watcherId,
        new Error('Persisted coordinator identity does not own the resolved Run')
      )
    }
  }
}

function refused(
  reason: Extract<DispatchResult, { status: 'refused' }>['reason'],
  error: unknown
): DispatchResult {
  return {
    status: 'refused',
    reason,
    detail: error instanceof Error ? error.message : String(error)
  }
}

function isOrchestrationError(error: unknown, code: string): error is OrchestrationError {
  return error instanceof OrchestrationError && error.code === code
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
