import type { PluginContext, PluginStore } from '@quirky/protocol'
import type {
  DispatchAdmissionInput, DispatchId, DispatchRow, DispatchStatus, JsonValue, LifecycleCorePort,
  MutationCheckpoint, MutationRequest, MutationResult, MutatingOrchestrationMethod,
  ResetMode, RunId, RunRow, RuntimeCallerEvidence, TaskCreateParams, TaskId, TaskRow, UtcTimestamp,
  WorkerOutcome, WorkerRow, WorkerState, WorkerTransitionInput,
} from './contracts'
import type { SessionIdentity } from './runtime-contracts'

/** Registered by the supervised-worker extension in the same orchestration plugin.
 * Every hook runs synchronously inside the core's enclosing store transaction.
 * Throwing rejects and rolls back the entire lifecycle/mail/receipt mutation.
 */
export interface WorkerLifecyclePort {
  hasLiveForTask(store: PluginStore, taskId: TaskId): boolean
  stateForDispatch(store: PluginStore, dispatchId: DispatchId): WorkerState | null
  workerForDispatch(store: PluginStore, dispatchId: DispatchId): WorkerRow | null
  settleDispatch(store: PluginStore, dispatchId: DispatchId, status: DispatchStatus, at: UtcTimestamp): void
  transitionWorker(store: PluginStore, input: WorkerTransitionInput): WorkerRow
  reset(store: PluginStore, mode: ResetMode, at: UtcTimestamp): void
  acceptReport(store: PluginStore, input: {
    dispatchId: DispatchId
    outcome: WorkerOutcome
    caller: RuntimeCallerEvidence
    at: UtcTimestamp
  }): WorkerRow | null
  recordHeartbeat(store: PluginStore, input: {
    dispatchId: DispatchId
    caller: RuntimeCallerEvidence
    at: UtcTimestamp
  }): void
}

/** Acceptance runs in the ledger's transaction; asynchronous effects begin after commit. */
export interface DurableMutationOptions<T extends object> {
  /** Side-effect-free preflight, after receipt replay/mismatch lookup and before acceptance. */
  beforeAccept?: () => void | Promise<void>
  acceptedCheckpoint?: (accepted: T) => MutationCheckpoint
  afterCommit?: (accepted: T) => T | Promise<T>
}

/** Shared core service implemented by OrchestrationCore in core.ts.
 * Worker starts createTask/reserveWorkerDispatch + worker/custody rows in mutate's
 * synchronous operation; acceptedCheckpoint persists with them before launch effects.
 * A supervised dispatch is permanently marked dispatches.supervised=1; if its worker
 * port is unavailable, core fails closed rather than treating it as context-only.
 * Async process/provider work occurs only after transaction commit.
 */
export interface OrchestrationWorkerCore extends LifecycleCorePort {
  readonly context: PluginContext
  readonly store: PluginStore
  registerWorkerPort(port: WorkerLifecyclePort): void
  requireCoordinator(caller: RuntimeCallerEvidence, runId?: RunId): RunRow
  getRun(runId: RunId): RunRow
  getTask(taskId: TaskId): TaskRow
  getDispatch(dispatchId: DispatchId): DispatchRow
  createDispatch(input: DispatchAdmissionInput & { supervised?: boolean }, caller: RuntimeCallerEvidence, identity: SessionIdentity): DispatchRow
  createTask(input: Omit<TaskCreateParams, keyof MutationRequest>, caller: RuntimeCallerEvidence): TaskRow
  reserveWorkerDispatch(input: Omit<DispatchAdmissionInput, 'assigneeSessionId'>, caller: RuntimeCallerEvidence): DispatchRow
  attachDispatchAuthority(dispatchId: DispatchId, identity: SessionIdentity, caller: RuntimeCallerEvidence): DispatchRow
  emitWorkerStatus(dispatchId: DispatchId, subject: string, body: string, high: boolean, type?: 'status' | 'escalation', payload?: JsonValue): void
  closeWorkerQuestions(dispatchId: DispatchId, at: UtcTimestamp): void
  mutate<T extends object>(
    method: MutatingOrchestrationMethod,
    params: MutationRequest,
    caller: RuntimeCallerEvidence,
    operation: (store: PluginStore) => T,
    options?: DurableMutationOptions<T>,
  ): Promise<MutationResult<T>>
}

/** Schema ownership: core exports v1 migrations from src/store.ts for runs/tasks/
 * dispatches/messages/deliveries/question_threads/gates/mutation_receipts/
 * pointer_operations. Worker-owned migrations append after v1 in the single
 * context.openStore call (worker_dispatches/custody/observations/etc.). No second
 * database or independent task/report/heartbeat settlement implementation.
 * Worker code owns src/workers/**, worker-contracts.ts, worker acceptance tests.
 * Core owns core.ts/store.ts/identity.ts/messaging.ts/pointers.ts/main.ts/cli.ts
 * until the worker integration step extends main/manifest/CLI after core merge.
 */
