import { randomUUID } from 'node:crypto'
import type { WatcherCommandResult, WatcherWorker } from '../../../shared/fork-heimdall/fleet-types'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { parseWorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { OrchestrationDb, RunRow } from '../../runtime/orchestration/db'
import { exposeUtcTimestamp } from '../../runtime/orchestration/db/utc-timestamp'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { ORCHESTRATION_WORKER_LIST_METHOD } from '../../runtime/rpc/methods/orchestration/worker/worker-list-method'
import { ORCHESTRATION_WORKER_RELEASE_METHODS } from '../../runtime/rpc/methods/orchestration/worker/worker-release'
import type { WorkerReleaseReceipt } from '../../runtime/rpc/methods/orchestration/worker/worker-release-completion'
import { WorkerDispatchParams } from '../../../shared/rpc-contract/orchestration-worker-release-schemas-params'
import { ORCHESTRATION_WORKER_STOP_METHODS } from '../../runtime/rpc/methods/orchestration/worker/worker-stop'
import { getOrchestrationMutationExecutor } from '../../runtime/rpc/orchestration-mutation-executor'
import type { RpcRequest } from '../../runtime/rpc/core'
import { getErrorCode } from '../../git/worktree-operation-options'
import { coordinatorIdentityFingerprint } from './coordinator-identity'

type OrchestrationWorkerListRow = {
  dispatchId: string
  taskId: string
  runId: string
  dispatchStatus: string
  projection: {
    liveness: { verdict: WatcherWorker['liveness']; reason?: string }
    evidence: { lastObservedAt: number | null }
  }
}

type OrchestrationWorkerListPage = {
  workers: OrchestrationWorkerListRow[]
  page: { hasMore: boolean; nextCursor: string | null }
}

type WorkerStopReceipt = {
  state?: string
  processAction?: string
  warning?: string
  lastError?: string | null
}

type PendingQuestionRow = {
  message_id: string
  dispatch_id: string
  body: string
}

type WorkerNavigationSource = {
  worktreeId: string | null
  paneKey: string | null
  hostScope: string | null
}

const ACTIVE_DISPATCH_STATUSES: Record<string, true> = {
  pending: true,
  dispatched: true
}
const SETTLED_WORKER_STATES: Record<string, true> = {
  succeeded: true,
  failed: true,
  abandoned: true
}
const WORKER_STOP_METHOD = ORCHESTRATION_WORKER_STOP_METHODS.find(
  (method) => method.name === 'orchestration.workerStop'
)
const WORKER_RELEASE_METHOD = ORCHESTRATION_WORKER_RELEASE_METHODS.find(
  (method) => method.name === 'orchestration.workerRelease'
)

export async function listWatcherWorkers(
  runtime: QuirkyRuntimeService,
  enrollment: WatcherEnrollment,
  run: RunRow
): Promise<WatcherWorker[]> {
  const active = await listActiveWorkerRows(runtime, run.id)
  const db = runtime.getOrchestrationDb()
  const tasks = new Map(db.listTasks({ runId: run.id }).map((task) => [task.id, task]))
  const questions = pendingQuestionsByDispatch(
    db,
    run.id,
    active.map((worker) => worker.dispatchId)
  )
  const workerRows = new Map(
    db
      .listWorkerTerminalResources({ dispatchIds: active.map((worker) => worker.dispatchId) })
      .map((worker) => [worker.dispatchId, worker])
  )
  const federatedDispatchIds = new Set(
    db
      .listFederatedDispatchesByIds(active.map((worker) => worker.dispatchId))
      .map((dispatch) => dispatch.dispatch_id)
  )
  const result: WatcherWorker[] = []
  for (const worker of active) {
    const dispatch = db.getDispatchContextById(worker.dispatchId)
    const task = tasks.get(worker.taskId)
    const workerRow = workerRows.get(worker.dispatchId)
    if (!dispatch || dispatch.run_id !== run.id || !task) {
      continue
    }
    result.push({
      dispatchId: worker.dispatchId,
      task: task.display_name ?? task.task_title ?? task.spec,
      dispatchedAtMs: parseStoredTimestamp(dispatch.dispatched_at ?? dispatch.created_at),
      lastContactAtMs: latestConfirmedContactAtMs(
        worker.projection.liveness,
        worker.projection.evidence.lastObservedAt,
        dispatch.last_heartbeat_at
      ),
      liveness: worker.projection.liveness.verdict,
      reason:
        worker.projection.liveness.verdict === 'unverifiable'
          ? (worker.projection.liveness.reason ?? 'Worker liveness is unavailable')
          : null,
      question: questions.get(worker.dispatchId) ?? null,
      navigation: federatedDispatchIds.has(worker.dispatchId)
        ? null
        : watcherWorkerNavigation(enrollment.executionHostId, {
            worktreeId: workerRow?.worktreeId ?? null,
            paneKey: workerRow?.paneKey ?? null,
            hostScope: workerRow?.resource?.host_scope ?? dispatch.host_scope
          })
    })
  }
  return result
}

function watcherWorkerNavigation(
  ownerExecutionHostId: ExecutionHostId,
  worker: WorkerNavigationSource
): NonNullable<WatcherWorker['navigation']> | null {
  if (!worker.worktreeId || !worker.paneKey || !parsePaneKey(worker.paneKey)) {
    return null
  }
  const hostScope = parseWorkerTerminalHostScope(worker.hostScope)
  if (!hostScope) {
    return null
  }
  const executionHostId =
    hostScope.kind === 'ssh' && ownerExecutionHostId === 'local'
      ? toSshExecutionHostId(hostScope.targetId)
      : ownerExecutionHostId
  return {
    worktreeId: worker.worktreeId,
    executionHostId,
    paneKey: worker.paneKey
  }
}

async function listActiveWorkerRows(
  runtime: QuirkyRuntimeService,
  runId: string
): Promise<OrchestrationWorkerListRow[]> {
  const active: OrchestrationWorkerListRow[] = []
  let cursor: string | undefined
  while (true) {
    const params = ORCHESTRATION_WORKER_LIST_METHOD.params!.parse({
      run: runId,
      includeRemote: true,
      paginate: true,
      ...(cursor ? { cursor } : {})
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this module keeps its own narrow view of the RPC method's page shape, decoupled from worker-list-method.ts's internal fleet projection type.
    const listed = (await ORCHESTRATION_WORKER_LIST_METHOD.handler(params, {
      runtime
    })) as OrchestrationWorkerListPage
    active.push(
      ...listed.workers.filter(
        (worker) => worker.runId === runId && ACTIVE_DISPATCH_STATUSES[worker.dispatchStatus]
      )
    )
    if (!listed.page.hasMore) {
      return active
    }
    const nextCursor = listed.page.nextCursor
    if (!nextCursor || nextCursor === cursor) {
      throw new OrchestrationError(
        'operation_unknown',
        'Orchestration worker-list pagination did not advance its stable snapshot cursor.'
      )
    }
    cursor = nextCursor
  }
}

export async function stopWatcherWorker(
  runtime: QuirkyRuntimeService,
  enrollment: WatcherEnrollment,
  run: RunRow,
  dispatchId: string,
  assertCoordinatorSeat: () => void
): Promise<WatcherCommandResult> {
  const db = runtime.getOrchestrationDb()
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || dispatch.run_id !== run.id) {
    return commandRefused(
      'worker-unverifiable',
      `Dispatch ${dispatchId} could not be verified in watcher Run ${run.id}`
    )
  }
  const workerBefore = db.getWorkerDispatch(dispatchId)
  const federated = db.getFederatedDispatch(dispatchId)
  const hasExactProcessIdentity = federated
    ? Boolean(federated.remote_runtime_epoch && federated.remote_terminal_handle)
    : Boolean(dispatch.process_incarnation)
  if (!workerBefore || !hasExactProcessIdentity) {
    return commandRefused(
      'worker-unverifiable',
      `Dispatch ${dispatchId} has no exact supervised process identity`
    )
  }
  if (!WORKER_STOP_METHOD) {
    return commandRefused('invalid-command', 'Orchestration worker-stop is unavailable')
  }

  const requestId = `heimdall-stop-worker-${randomUUID()}`
  const params = WORKER_STOP_METHOD.params!.parse({ dispatch: dispatchId })
  const request: RpcRequest = {
    id: requestId,
    authToken: '',
    method: 'orchestration.workerStop',
    params,
    orchestrationRequestId: requestId,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrchestrationMutationExecutor.run is intentionally typed Promise<unknown>; the invoked handler's actual receipt shape is this call's only source of truth.
    const receipt = (await getOrchestrationMutationExecutor(runtime).run(
      request,
      params,
      (mutation) => {
        assertCoordinatorSeat()
        return WORKER_STOP_METHOD.handler(params, {
          runtime,
          orchestrationMutation: mutation?.identity
        })
      },
      coordinatorIdentityFingerprint(enrollment.coordinatorIdentity)
    )) as WorkerStopReceipt
    return commandResultFromWorkerStop(receipt)
  } catch (error) {
    if (isCoordinatorSeatLost(error)) {
      throw error
    }
    if (isOrchestrationError(error, 'operation_unknown')) {
      return { status: 'indeterminate', detail: error.message }
    }
    const workerAfter = db.getWorkerDispatch(dispatchId)
    if (
      workerAfter &&
      (workerAfter.state !== workerBefore.state ||
        workerAfter.state === 'stopping' ||
        workerAfter.state === 'stop_unknown')
    ) {
      return {
        status: 'indeterminate',
        detail: `Worker stop may have taken effect: ${errorDetail(error)}`
      }
    }
    return isOrchestrationError(error, 'dispatch_inactive')
      ? commandRefused('invalid-state', error.message)
      : commandRefused('worker-unverifiable', errorDetail(error))
  }
}

export async function releaseWatcherWorker(
  runtime: QuirkyRuntimeService,
  enrollment: WatcherEnrollment,
  run: RunRow,
  dispatchId: string,
  assertCoordinatorSeat: () => void
): Promise<WorkerReleaseReceipt> {
  const dispatch = runtime.getOrchestrationDb().getDispatchContextById(dispatchId)
  if (!dispatch || dispatch.run_id !== run.id) {
    throw new OrchestrationError(
      'dispatch_run_mismatch',
      `Dispatch ${dispatchId} could not be verified in watcher Run ${run.id}`
    )
  }
  if (!WORKER_RELEASE_METHOD) {
    throw new OrchestrationError('operation_unknown', 'Orchestration worker-release is unavailable')
  }

  const requestId = `heimdall-release-worker-${randomUUID()}`
  const params = WorkerDispatchParams.parse({ dispatch: dispatchId })
  const request: RpcRequest = {
    id: requestId,
    authToken: '',
    method: 'orchestration.workerRelease',
    params,
    orchestrationRequestId: requestId,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrchestrationMutationExecutor.run is intentionally typed Promise<unknown>; the invoked handler's actual receipt shape is this call's only source of truth.
  return (await getOrchestrationMutationExecutor(runtime).run(
    request,
    params,
    (mutation) => {
      assertCoordinatorSeat()
      return WORKER_RELEASE_METHOD.handler(params, {
        runtime,
        orchestrationMutation: mutation?.identity
      })
    },
    coordinatorIdentityFingerprint(enrollment.coordinatorIdentity)
  )) as WorkerReleaseReceipt
}

function pendingQuestionsByDispatch(
  db: OrchestrationDb,
  runId: string,
  dispatchIds: readonly string[]
): Map<string, WatcherWorker['question']> {
  if (dispatchIds.length === 0) {
    return new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types every row as unknown; this SELECT's literal column list is the row's only shape source.
  const rows = db.db
    .prepare(
      `SELECT q.message_id, q.dispatch_id, m.body
         FROM question_threads q
         INNER JOIN messages m ON m.id = q.message_id AND m.run_id = q.run_id
        WHERE q.run_id = ? AND q.status = 'pending'
          AND q.dispatch_id IN (SELECT value FROM json_each(?))
        ORDER BY q.created_at DESC, q.rowid DESC`
    )
    .all(runId, JSON.stringify(dispatchIds)) as PendingQuestionRow[]
  const questions = new Map<string, WatcherWorker['question']>()
  for (const row of rows) {
    if (!questions.has(row.dispatch_id)) {
      questions.set(row.dispatch_id, { messageId: row.message_id, body: row.body })
    }
  }
  return questions
}

function parseStoredTimestamp(value: string): number {
  const exposed = exposeUtcTimestamp(value) ?? value
  const parsed = Date.parse(exposed)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid orchestration timestamp: ${value}`)
  }
  return parsed
}

function latestConfirmedContactAtMs(
  liveness: OrchestrationWorkerListRow['projection']['liveness'],
  observedAtMs: number | null,
  heartbeatAt: string | null
): number | null {
  const heartbeatAtMs = heartbeatAt ? parseStoredTimestamp(heartbeatAt) : null
  const confirmedObservationAtMs =
    liveness.verdict === 'live' ||
    (liveness.verdict === 'unverifiable' && liveness.reason === 'stale_status')
      ? observedAtMs
      : null
  if (confirmedObservationAtMs === null) {
    return heartbeatAtMs
  }
  return heartbeatAtMs === null
    ? confirmedObservationAtMs
    : Math.max(confirmedObservationAtMs, heartbeatAtMs)
}

function commandResultFromWorkerStop(receipt: WorkerStopReceipt): WatcherCommandResult {
  if (receipt.state === 'stopped' && !receipt.warning) {
    return { status: 'applied', appliedAtMs: Date.now() }
  }
  if (receipt.state === 'stop_unknown') {
    const detail = receipt.lastError ?? 'The execution host could not confirm the worker stop'
    return receipt.processAction === 'none'
      ? commandRefused('worker-unverifiable', detail)
      : { status: 'indeterminate', detail }
  }
  if (receipt.warning) {
    return commandRefused('worker-unverifiable', receipt.warning)
  }
  if (receipt.state && SETTLED_WORKER_STATES[receipt.state]) {
    return commandRefused('invalid-state', `Worker is already ${receipt.state}`)
  }
  return {
    status: 'indeterminate',
    detail: receipt.lastError ?? `Worker stop returned state ${receipt.state ?? 'unknown'}`
  }
}

function commandRefused(
  reason: Extract<WatcherCommandResult, { status: 'refused' }>['reason'],
  detail: string
): WatcherCommandResult {
  return { status: 'refused', reason, detail }
}

function isOrchestrationError(error: unknown, code: string): error is OrchestrationError {
  return error instanceof OrchestrationError && error.code === code
}

function isCoordinatorSeatLost(error: unknown): boolean {
  return getErrorCode(error) === 'coordinator-seat-lost'
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
