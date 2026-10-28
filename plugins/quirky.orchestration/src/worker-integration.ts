import type { PluginContext, PluginStore } from '@quirky/protocol'
import type {
  CoordinatorAuthority, DispatchAdmissionInput, DispatchId, DispatchRow, DispatchStatus, HeartbeatResult, JsonValue, LifecycleCorePort,
  MutationCheckpoint, MutationRequest, MutationResult, MutatingOrchestrationMethod,
  ResetMode, RunId, RunRow, RuntimeCallerEvidence, TaskCreateParams, TaskId, TaskRow, UtcTimestamp,
  FederatedWorkerExitAcceptance, FederatedWorkerExitInput, WorkerDoneReportInput, WorkerExitResult, WorkerHeartbeatInput,
  WorkerOutcome, WorkerReportAuthority, WorkerReportResult, HeartbeatResult,
  WorkerRow, WorkerState, WorkerTransitionInput,
} from './contracts'
import type { SessionIdentity } from './runtime-contracts'
import type { FederationReportAuthority } from './federation/contracts'

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
    caller: WorkerReportAuthority
    at: UtcTimestamp
  }): WorkerRow | null
  recordHeartbeat(store: PluginStore, input: {
    dispatchId: DispatchId
    caller: WorkerReportAuthority
    at: UtcTimestamp
  }): void

  acceptFederatedExit(
    store: PluginStore,
    input: FederatedWorkerExitInput,
    authority: FederationReportAuthority,
  ): FederatedWorkerExitAcceptance
}

export type { WorkerReportAuthority } from './contracts'

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
  readonly nestedWorkerMaxDepth: number
  registerWorkerPort(port: WorkerLifecyclePort): void
  registerFederationAuthorityValidator(validator: (authority: FederationReportAuthority) => void): void
  requireCoordinator(caller: CoordinatorAuthority, runId?: RunId): RunRow
  getRun(runId: RunId): RunRow
  getTask(taskId: TaskId): TaskRow
  getDispatch(dispatchId: DispatchId): DispatchRow
  listDispatches(runId?: RunId): DispatchRow[]
  boundRunId(caller: RuntimeCallerEvidence): RunId | null
  attentionFor(dispatchId: DispatchId): { guidance: boolean; input: boolean; approval: boolean; rootCompletion: boolean }
  createDispatch(input: DispatchAdmissionInput & { supervised?: boolean }, caller: RuntimeCallerEvidence, identity: SessionIdentity): DispatchRow
  /** Internal lifecycle fence; only exact supervised stops may block a live Task. */
  blockTaskForWorkerStop(input: { taskId: TaskId; dispatchId: DispatchId; at: UtcTimestamp }): TaskRow
  createTask(input: Omit<TaskCreateParams, keyof MutationRequest>, caller: CoordinatorAuthority): TaskRow
  reserveWorkerDispatch(input: Omit<DispatchAdmissionInput, 'assigneeSessionId'>, caller: CoordinatorAuthority): DispatchRow
  attachWorkerAuthority(dispatchId: DispatchId, identity: SessionIdentity, caller: CoordinatorAuthority): DispatchRow
  emitWorkerStatus(dispatchId: DispatchId, subject: string, body: string, high: boolean, type?: 'status' | 'escalation', payload?: JsonValue): void
  closeWorkerQuestions(dispatchId: DispatchId, at: UtcTimestamp): void
  preflightFederatedWorkerDone(input: WorkerDoneReportInput, authority: FederationReportAuthority): WorkerReportResult | null
  reportFederatedWorkerDone(input: WorkerDoneReportInput, authority: FederationReportAuthority): WorkerReportResult
  recordFederatedHeartbeat(input: WorkerHeartbeatInput, authority: FederationReportAuthority): HeartbeatResult
  reportFederatedWorkerExit(input: FederatedWorkerExitInput, authority: FederationReportAuthority): WorkerExitResult
  mutateWorker<T extends object>(
    method: string,
    params: MutationRequest & Record<string, unknown>,
    caller: CoordinatorAuthority,
    operation: (store: PluginStore) => T,
    options?: DurableMutationOptions<T>,
  ): Promise<MutationResult<T>>
  mutate<T extends object>(
    method: MutatingOrchestrationMethod,
    params: MutationRequest & Record<string, unknown>,
    caller: CoordinatorAuthority,
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
