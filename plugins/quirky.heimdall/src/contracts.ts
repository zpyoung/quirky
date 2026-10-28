import type { PluginContext, PluginStore, Schema } from '@quirky/protocol'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type CapabilityMode = 'off' | 'gated' | 'on'
export interface BudgetPolicy { wallClockActiveMs: number | null; turns: number | null }
export interface BudgetUsage { activeMs: number; turns: number; exhausted: 'budget-wall-clock' | 'budget-turns' | null }
export type PacingTier = 'rapid' | 'active' | 'idle' | 'stopped'
export type ParkReason = 'budget' | 'stop-predicate' | 'worker-question' | 'worker-escalation' | 'coordinator-seat-lost' | 'configuration-error'
export interface Snapshot<W = Json> { freshness: 'live' | 'cached'; contentIdentity: string; observedAtMs: number; world: W }
export interface KernelAction {
  kind: string; capability: string; visibility: 'external' | 'local'
  contentIdentity: string; evidenceKey: string; recovery?: 'replay-safe'
  expectedState?: { target: string; before: Json }; approvalRequired?: boolean
  [key: string]: unknown
}
export interface ApprovalScope { actionKind: string; contentIdentity: string; evidenceKey: string; preparedCommitSha?: string }
export type GateVerdict = { verdict: 'allow' } | { verdict: 'hold' | 'escalate'; reason: string; detail?: string }
export interface Deviation { kind: string; detail?: string }
export type Decision<A extends KernelAction = KernelAction> =
  | { action: A; considered?: string[] }
  | { action: null; reason: string; detail?: string; considered?: string[]; deviation?: Deviation }
export interface WorkerRequest { spec: string; worktree: string; agent?: string; mode?: 'terminal' | 'structured'; taskTitle?: string; [key: string]: unknown }
export type DispatchResult =
  | { kind: 'dispatched'; dispatchId: string; terminalHandle?: string }
  | { kind: 'refused'; reason: string; detail?: string }
  | { kind: 'indeterminate'; requestId: string; detail?: string }
export type ExecuteResult = { effect: 'landed' | 'not-landed' | 'indeterminate'; reason?: string; expectedAfter?: Json; failureClass?: string }
export interface ExecuteContext {
  enrollment: Enrollment; attemptId: string; fingerprint: string; signal: AbortSignal
  dispatchWorker(request: WorkerRequest): Promise<DispatchResult>
}
export type StopResult = { kind: 'terminal'; state: string; reason: string } | { kind: 'park'; reason: ParkReason; detail: string } | null
export interface EnrollmentInput { kind: string; kindPayload: Json; capabilities?: Record<string, CapabilityMode>; budget?: BudgetPolicy }
export interface AuthorizedEnrollment {
  workspaceKey: string; workspacePath: string; executionHostId: string; schedulerOwner: string
  repoId?: string | null; worktreeId?: string | null; kindPayload: Json; undo?: Json
}
export interface Enrollment extends AuthorizedEnrollment {
  watcherId: string; kind: string; enabled: boolean; paused: boolean; commandRevision: number
  capabilities: Record<string, CapabilityMode>; budget: BudgetPolicy
  coordinator: { handle: string; paneKey: string }; orchestrationRunId: string | null
  createdAtMs: number; terminalAtMs: number | null; parkReason: ParkReason | null
  haltReason: string | null; malformed?: string
}
export type EnrollmentResult =
  | { kind: 'enrolled' | 're-armed'; enrollment: Enrollment }
  | { kind: 'refused'; reason: 'duplicate-workspace' | 'owner-not-executable' | 'unknown-kind' | 'invalid-payload'; detail: string }
export interface JournalEntry {
  seq: number; eventId: string; watcherId: string; atMs: number
  class: 'fact' | 'observation'; origin: 'owner' | 'client'; kind: string; resolved: boolean
  [key: string]: unknown
}
export type JournalAppend = Omit<JournalEntry, 'seq' | 'eventId' | 'watcherId' | 'atMs'> & {
  kind: string; class: 'fact' | 'observation'; origin: 'owner' | 'client'; resolved: boolean
  eventId?: string; atMs?: number
}
export interface Attempt extends JournalEntry {
  kind: 'attempt'; attemptId: string; fingerprint: string; action: KernelAction
  state: 'attempted' | 'running' | 'settled'; effect?: ExecuteResult['effect']; reason?: string
  workerRequest?: WorkerRequest; requestId?: string; dispatchId?: string; generation?: string
}
export interface TickTrace {
  seq: number; watcherId: string; startedAtMs: number; durationMs: number; exitPath: string; pinned: boolean
  fullResyncDue: boolean; snapshotReadCount: number; contentIdentity?: string; snapshot?: Json
  decision?: Decision; declined: string[]; gate?: GateVerdict; budget?: BudgetUsage
  pacing?: { tier: PacingTier; delayMs: number | null }; error?: string; runner?: RunnerStatus
}
export interface RunnerStatus {
  state: 'watching' | 'acting' | 'held' | 'escalated' | 'parked' | 'terminal' | 'disabled' | 'unreachable' | 'malformed'
  reason?: string; detail?: string; nextPulseAtMs: number | null; consecutiveErrors: number; consecutiveGateHolds: number
}
export interface TerminalSummary { watcherId: string; kind: string; state: string; reason: string; atMs: number; budget: BudgetUsage }
export interface WatcherKind<W = Json, A extends KernelAction = KernelAction> {
  id: string; displayName: string; enrollmentPayloadSchema: Schema
  authorizeEnrollment(input: EnrollmentInput): Promise<AuthorizedEnrollment>
  validateEnrollment?(candidate: AuthorizedEnrollment, existing: Enrollment | null): Promise<void> | void
  undoAuthorization?(authorization: AuthorizedEnrollment): Promise<void>
  describeEnrollment?(enrollment: Enrollment): string
  read(enrollment: Enrollment, options: { fresh: boolean }): Promise<Snapshot<W>>
  describeSnapshot?(snapshot: Snapshot<W>): Json
  decide(snapshot: Snapshot<W>, journal: JournalEntry[], enrollment: Enrollment): Decision<A> | Promise<Decision<A>>
  preflight?(action: A, snapshot: Snapshot<W>, journal: JournalEntry[], enrollment: Enrollment): Promise<GateVerdict>
  execute(action: A, context: ExecuteContext): Promise<ExecuteResult>
  resolveOutcome?(attempt: Attempt, snapshot: Snapshot<W>, journal: JournalEntry[], enrollment: Enrollment): Promise<ExecuteResult | null>
  pace?(snapshot: Snapshot<W>, journal: JournalEntry[]): PacingTier | Promise<PacingTier>
  stop?(snapshot: Snapshot<W>, journal: JournalEntry[], enrollment: Enrollment): StopResult | Promise<StopResult>
  reconcile?(enrollment: Enrollment, snapshot: Snapshot<W>, journal: JournalEntry[]): Promise<boolean>
  concurrency?: { parallelActions?: boolean; drainOnBudget?: boolean }
}
/** Serializable public kind registration. All hook references belong to the authenticated declaring plugin. */
export interface KindRegistration {
  id: string; displayName: string; enrollmentPayloadSchema: Schema
  hooks: { authorize: string; read: string; decide: string; execute: string; validate?: string; undo?: string; describeSnapshot?: string; resolveOutcome?: string; preflight?: string; pace?: string; stop?: string; reconcile?: string }
  concurrency?: WatcherKind['concurrency']; pluginId?: string
}
export interface KindRegistry {
  get(id: string): WatcherKind | undefined
  register(kind: WatcherKind): void
  registerDescriptor(descriptor: KindRegistration, pluginId: string): void
  descriptors(): KindRegistration[]
}
export interface KernelStore {
  readonly readOnly: boolean
  list(): Enrollment[]; get(id: string): Enrollment | null; live(workspaceKey: string): Enrollment | null
  save(enrollment: Enrollment): void
  transaction<T>(work: () => T): T
  journal(id: string): JournalEntry[]
  append(id: string, entry: JournalAppend): JournalEntry
  traces(id: string): TickTrace[]; trace(id: string, trace: TickTrace): void
  nextTraceSeq(id: string): number
  retain(id: string): void
  terminal(enrollment: Enrollment, summary: TerminalSummary): void
  summary(id: string): TerminalSummary | null
  registrations(): KindRegistration[]; saveRegistration(registration: KindRegistration): void
  /** Atomically removes only this watcher's state/history; never stops or releases workers. */
  remove?(id: string): void
  close(): void
}
export interface EnrollmentService {
  enroll(input: EnrollmentInput): Promise<EnrollmentResult>
}
export interface WorkerMessage { id: string; type: 'worker_done' | 'question' | 'escalation' | string; dispatchId?: string; body: string; resolved?: boolean; outcome?: 'succeeded' | 'failed'; raw?: Json }
export interface OrchestrationPort {
  dispatch(enrollment: Enrollment, attempt: Attempt, request: WorkerRequest): Promise<DispatchResult>
  recover(enrollment: Enrollment, attempt: Attempt): Promise<DispatchResult | null>
  mailbox(enrollment: Enrollment): Promise<WorkerMessage[]>
  acknowledge(enrollment: Enrollment, messages: WorkerMessage[]): Promise<void>
  release(enrollment: Enrollment, dispatchId: string): Promise<void>
  dispose(): void
}
export interface Runner {
  readonly watcherId: string
  status(): RunnerStatus
  pulse(): Promise<void>
  schedule(delayMs: number): void
  suspend(): void; resume(): void
  /** Fences new actions before optionally draining the current tick; serializes control mutations. */
  withControl?<T>(operation: () => Promise<T>, drain: boolean): Promise<T>
  shutdown(deadlineMs?: number): Promise<void>
}
export interface KernelOptions {
  context: PluginContext; store: KernelStore; registry: KindRegistry; orchestration: OrchestrationPort
  now?: () => number; schedulerOwner?: string; executionHostId?: string
  onChanged?: (watcherId: string) => void
}
export interface RunnerOptions extends KernelOptions { enrollment: Enrollment }
export interface Inspection {
  readOnly: boolean; enrollment: Enrollment; status: RunnerStatus | null
  journal: JournalEntry[]; traces: TickTrace[]; summary: TerminalSummary | null; budget: BudgetUsage
}
export type StoreFactory = (context: PluginContext) => KernelStore
export type PluginStoreHandle = PluginStore
