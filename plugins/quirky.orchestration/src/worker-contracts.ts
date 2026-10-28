import type { PluginContext, PluginStore, Session, StoreMigration } from '@quirky/protocol'
import type {
  DeclaredCallerAliases, DispatchId, DispatchRow, JsonValue, MutationRequest,
  MutationResult, RunId, RunRow, RuntimeCallerEvidence, TaskCreateParams, TaskId,
  TaskRow, UtcTimestamp, WorkerRow,
} from './contracts'
import type { SessionIdentity } from './runtime-contracts'
import type { DurableMutationOptions, OrchestrationWorkerCore, WorkerLifecyclePort } from './worker-integration'

/** A service principal is constructed only after kernel plugin-caller and owned-Run checks. */
export interface ServiceCoordinatorEvidence {
  kind: 'service'
  pluginId: string
  runId: RunId
  authority: 'kernel_plugin'
}
export type CoordinatorEvidence = RuntimeCallerEvidence | ServiceCoordinatorEvidence

export type WorkerMode = 'terminal' | 'structured'
export type TurnStart = 'observed' | 'permission' | 'unsupported' | 'unobserved'
export type TerminalState = 'active' | 'reclaimable' | 'retained' | 'release_pending' | 'release_unknown' | 'released'
export type OwnershipState = 'owned' | 'transferred' | 'user_owned' | 'external' | 'released'
export type ReleaseState = 'not_requested' | 'retained' | 'requested' | 'releasing' | 'released' | 'unknown'
export type WorkerEffect = { kind: 'worktree' | 'terminal' | 'setup' | 'dispatch_input'; action: string; role: 'agent' | 'setup' | 'configured_tab' | 'recovery_shell'; id: string }
export interface WorkerModeDecision { mode: WorkerMode; preferred: WorkerMode; reason: string; detail: string }
export interface WorkerSetup {
  requested: string; effective: string; source: string; hookFound: boolean
  startupPolicy: string; state: string
}
export interface WorkerStartParams extends MutationRequest, DeclaredCallerAliases {
  runId?: RunId; taskId?: TaskId; spec?: string; worktree: string
  agent?: string; terminal?: string; mode?: WorkerMode
  taskTitle?: string; dependencyTaskIds?: readonly TaskId[]; parentTaskId?: TaskId
  model?: string; effort?: string; name?: string; repo?: string; baseBranch?: string
  displayName?: string; comment?: string; setup?: 'run' | 'skip' | 'inherit'
  retryOfDispatchId?: DispatchId; timeoutMs?: number
}
export interface WorkerControlParams extends MutationRequest, DeclaredCallerAliases {
  dispatchId: DispatchId
  runId?: RunId
  expectedIdentity?: { sessionId: string; processIncarnation: string }
}
export interface WorkerShowParams { dispatchId: DispatchId }
export interface WorkerReadParams {
  dispatchId: DispatchId; source?: 'auto' | 'transcript' | 'terminal'; cursor?: string; limit?: number
}
export interface WorkerListParams {
  runId?: RunId; terminalState?: TerminalState; includeRemote?: boolean; cursor?: string; limit?: number
}
export interface WorkerUserInputParams { session: string; expectedIncarnation: string }
export interface WorkerStartReceipt {
  runId: RunId; taskId: TaskId; dispatchId: DispatchId
  state: 'ready' | 'failed' | 'outcome_unknown'; stage: string; workerOutcome?: string
  turnStart: TurnStart; setup: WorkerSetup
  launch: { requested: { agent: string | null; model: string | null; effort: string | null }; effective: { agent: string | null; model: string | null; effort: string | null } }
  mode: WorkerModeDecision; timeoutMs: number; effects: readonly WorkerEffect[]
  residualResources: readonly JsonValue[]; failedStage?: string; lastError?: string
  recovery?: string; nextCommands?: readonly string[][]; warning?: string; prompt?: string
}
export interface WorkerRecord extends WorkerRow {
  runtimeEpoch: string; processIncarnation: string | null; mode: WorkerMode
  /** Kernel identity epoch; null until real session authority attaches. Never the supervisor epoch above. */
  processRuntimeEpoch: string | null
  startOptions: WorkerStartParams; receipt: WorkerStartReceipt | null
}
export interface TerminalResource {
  id: string; originDispatchId: DispatchId; ownerDispatchId: DispatchId
  priorOwnerDispatchIds: readonly DispatchId[]; worktreeId: string; sessionId: string
  processIncarnation: string; ownershipState: OwnershipState; releaseState: ReleaseState
  retainedReason: string | null; releaseRequestedAt: UtcTimestamp | null
  releaseCompletedAt: UtcTimestamp | null; releaseError: string | null
  recoveryAttemptCount: number; lastRecoveryAt: UtcTimestamp | null
  archiveSource: string | null; archiveStatus: 'captured' | 'empty' | 'unavailable' | null
}
export interface WorkerArchive {
  dispatchId: DispatchId; resourceId: string; kind: 'transcript_pin' | 'terminal_tail' | 'structured_journal'
  content: string; sourceIdentity: string; status: 'captured' | 'empty' | 'unavailable'
  createdAt: UtcTimestamp
}
export interface WorkerObservation {
  status: 'live' | 'unverifiable' | 'exited' | 'missing' | 'unattached' | 'identity_changed'
  exactWorker: boolean; reason: string | null; identity: SessionIdentity | null
  session: Session | null
  agentWait?: { waiting: boolean; source: string; reason: string | null }
}
export interface WorkerControlResult {
  dispatchId: DispatchId; state: string; alreadySettled?: boolean
  processAction: 'closed_agent_terminal' | 'none' | 'unknown'
  lastError?: string; warning?: string; archive?: { source: string; status: string }
}
export type WorkerLiveness = { status: 'live' | 'exited' | 'unverifiable'; reason: string | null }
export interface WorkerProjection {
  id: DispatchId; role: 'worker'; parent: { taskId: TaskId } | null
  provider: { id: string; model: string | null } | null
  host: { kind: 'local'; id: string }; workspace: { id: string; kind: string } | null
  stage: { worker: string | null; dispatch: string; detail: string; activity: 'working' | 'blocked' | 'waiting' | 'done' | 'unknown' }
  outcome: 'in_progress' | 'succeeded' | 'failed' | 'outcome_unknown' | 'finished_unverified'
  liveness: WorkerLiveness
  evidence: { durable: boolean; liveStatus: 'fresh' | 'stale' | 'unavailable' | 'redacted_restore'; lastObservedAt: string | null }
  resource: TerminalResource | null
  nextAction: { kind: 'inspect' | 'release' | 'recover' | 'none'; argv: readonly string[] }
  attention: { categories: readonly string[]; requiresAction: boolean }
}
export interface WorkerFleetRow {
  dispatchId: DispatchId; taskId: TaskId; runId: RunId; workerState: string | null
  dispatchStatus: string; agentTerminalHandle: string | null; terminalState: TerminalState
  resource: TerminalResource | null; projection: WorkerProjection
}
export interface WorkerShowResult {
  dispatch: DispatchRow; worker: WorkerRecord | null; projection: WorkerProjection
  terminal: Session | null; observation: WorkerObservation; terminalResource: TerminalResource | null
}
export interface WorkerListResult {
  workers: readonly WorkerFleetRow[]; scope: { runId: RunId | null; source: 'flag' | 'bound' | 'all' }
  page: { nextCursor: string | null; snapshotId: string; total: number }
  partialHostErrors: readonly { host: string; reason: string }[]
}
export type OutputFallbackReason = 'provider_unsupported' | 'session_not_reported' | 'transcript_empty' | 'transcript_missing' | 'transcript_unreadable' | 'transcript_parse_failed' | 'remote_capability_unavailable'
export interface WorkerReadResult {
  dispatchId: DispatchId; sessionId: string | null; source: 'transcript' | 'terminal' | 'structured'
  archived: boolean; sourceExact: boolean; fallbackReason: OutputFallbackReason | null
  content: string; messages?: readonly JsonValue[]; contentComplete: boolean
  clipping: { clipped: boolean; maxBytes: number }; nextCursor: string | null
  terminalLiveness: WorkerObservation['status']; agentLiveness: WorkerLiveness
  warnings: readonly string[]; sourceIdentity: string
}

/** Adapter to core's concrete task/receipt/staged-authority APIs, never another store. */
export interface WorkerCore extends OrchestrationWorkerCore {
  requireCoordinator(caller: CoordinatorEvidence, runId?: RunId): RunRow
  createTask(input: Omit<TaskCreateParams, keyof MutationRequest>, caller: CoordinatorEvidence): TaskRow
  reserveWorkerDispatch(input: { taskId: TaskId; runId: RunId; retryOfDispatchId?: DispatchId }, caller: CoordinatorEvidence): DispatchRow
  attachWorkerAuthority(dispatchId: DispatchId, identity: SessionIdentity, caller: CoordinatorEvidence): DispatchRow
  mutateWorker<T extends object>(method: string, params: MutationRequest & object, caller: CoordinatorEvidence, operation: (store: PluginStore) => T, options?: DurableMutationOptions<T>): Promise<MutationResult<T>>
  emitWorkerStatus(dispatchId: DispatchId, subject: string, body: string, high: boolean): void
  closeWorkerQuestions(dispatchId: DispatchId, at: UtcTimestamp): void
  listDispatches(): DispatchRow[]
  boundRunId(caller: RuntimeCallerEvidence): RunId | null
  attentionFor(dispatchId: DispatchId): { guidance: boolean; input: boolean; approval: boolean; rootCompletion: boolean }
}

/** All repository methods are synchronous and participate in core.store.transaction. */
export interface WorkerRepository {
  readonly store: PluginStore
  get(dispatchId: DispatchId): WorkerRecord | null
  insert(record: WorkerRecord): void
  update(dispatchId: DispatchId, patch: Partial<WorkerRecord>, expectedState?: WorkerRow['state']): WorkerRecord
  list(): WorkerRecord[]
  resource(dispatchId: DispatchId): TerminalResource | null
  resourceBySession(sessionId: string): TerminalResource | null
  putResource(resource: TerminalResource): void
  archive(dispatchId: DispatchId): WorkerArchive | null
  putArchive(archive: WorkerArchive): void
  deleteArchive(dispatchId: DispatchId): void
  addObservation(dispatchId: DispatchId, facet: string, payload: JsonValue): void
  reconcile(runtimeEpoch: string): void
}
export interface WorkerPlacement {
  worktreeId: string; session: Session; identity: SessionIdentity; created: boolean
  effects: readonly WorkerEffect[]; setup: WorkerSetup
}
export interface WorkerRuntime {
  readonly context: PluginContext; readonly epoch: string
  validate(params: WorkerStartParams, caller: CoordinatorEvidence): Promise<{ worktreeId: string | null; decision: WorkerModeDecision }>
  place(params: WorkerStartParams, task: TaskRow, dispatch: DispatchRow, caller: CoordinatorEvidence, onCustody: (placement: WorkerPlacement) => void): Promise<WorkerPlacement>
  waitReady(placement: WorkerPlacement, deadline: number, reused: boolean): Promise<void>
  submit(placement: WorkerPlacement, text: string, operationId: string, deadline: number): Promise<TurnStart>
  observe(record: WorkerRecord | null, dispatch: DispatchRow): Promise<WorkerObservation>
  close(resource: TerminalResource): Promise<{ closed: boolean; reason?: string }>
  dispose(): void
}
export interface WorkerOutput {
  read(params: WorkerReadParams): Promise<WorkerReadResult>
  capture(dispatchId: DispatchId): Promise<WorkerArchive>
}
export interface WorkerLifecycle extends WorkerLifecyclePort {
  stop(params: WorkerControlParams, caller: CoordinatorEvidence): Promise<MutationResult<WorkerControlResult>>
  abandon(params: WorkerControlParams, caller: CoordinatorEvidence): Promise<MutationResult<WorkerControlResult>>
  release(params: WorkerControlParams, caller: CoordinatorEvidence): Promise<MutationResult<WorkerControlResult>>
  retain(params: WorkerControlParams, caller: CoordinatorEvidence): Promise<MutationResult<WorkerControlResult>>
  userInput(params: WorkerUserInputParams): { takenOver: boolean }
  recoverReleases(): Promise<void>
  onExit(sessionId: string, incarnation: string | null, reason: string, exitCode: number | null): void
  dispose(): void
}
export interface WorkerStarter {
  start(params: WorkerStartParams, caller: CoordinatorEvidence): Promise<MutationResult<WorkerStartReceipt>>
  dispose(): void
}
export interface WorkerFleet {
  show(params: WorkerShowParams): Promise<WorkerShowResult>
  list(params: WorkerListParams, caller: RuntimeCallerEvidence | null): Promise<WorkerListResult>
  dispose(): void
}
export type WorkerStoreFactory = (store: PluginStore) => WorkerRepository
export type WorkerMigrations = readonly StoreMigration[]
