import type { PluginContext } from '@quirky/protocol'
import type { ApprovalScope, BudgetPolicy, Enrollment, Inspection, JournalEntry, KernelStore, RunnerStatus, TickTrace } from './contracts'

export interface OwnerFence { executionHostId: string; schedulerOwner: string; workspaceKey: string; revision: number }
export interface WatcherTarget { watcherId: string; connectionId?: string | null; pairingRevision?: number | null }
export type CommandRefusal = 'owner-unreachable' | 'unsupported-capability' | 'owner-conflict' | 'stale-revision' | 'watcher-not-found' | 'invalid-state' | 'question-already-answered' | 'worker-unverifiable' | 'coordinator-seat-lost' | 'invalid-command'
export type CommandResult = { kind: 'applied'; appliedAtMs: number } | { kind: 'refused'; reason: CommandRefusal; detail: string } | { kind: 'indeterminate'; detail: string }
export interface WorkerIdentity { dispatchId: string; sessionId?: string; processIncarnation?: string; pid?: number; startTime?: string; terminalHandle?: string }
export interface WatcherWorker { identity: WorkerIdentity; state: 'live' | 'exited' | 'unverifiable'; assignmentActive: boolean; title?: string; lastContactAtMs?: number; question?: { messageId: string; body: string; answered?: boolean }; [key: string]: unknown }
export interface OpenEscalation { escalationId: string; escalationKind: string; status: string; foldCount: number; reason?: string; detail?: string; approvalScope?: ApprovalScope; [key: string]: unknown }
export interface FleetAction { watcherId: string; watcherName: string; attemptId: string; atMs: number; actionKind: string; state: 'attempted' | 'running' | 'settled'; effect?: 'landed' | 'not-landed' | 'indeterminate'; reason?: string; target?: WatcherTarget; ownerLabel?: string }
export type WatcherCommand =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'disarm' }
  | { kind: 'delete' }
  | { kind: 'approve'; escalationId: string; scope: ApprovalScope }
  | { kind: 'adjust-budget'; budget: BudgetPolicy }
  | { kind: 'set-concurrency'; maxConcurrency: number }
  | { kind: 'answer-question'; messageId: string; body: string }
  | { kind: 'answer-escalation'; escalationId: string; body: string }
  | { kind: 'stop-worker'; identity: WorkerIdentity }
export interface CommandRequest { target: WatcherTarget; expectedOwner: OwnerFence; command: WatcherCommand; expectedIncarnation?: string }
export interface FleetRow {
  target: WatcherTarget; ownerFence: OwnerFence; enrollment: Enrollment; status: RunnerStatus
  name: string; workspaceName: string; branch: string | null; phase: string | null
  ownerContact: 'live' | 'unverifiable'; observedAtMs: number; lastSuccessfulTickAtMs: number | null
  budget: Inspection['budget']; runningWorkers: number; maxConcurrency: number | null
  openEscalations: OpenEscalation[]; pendingQuestion: boolean
  ownerLabel?: string
  ownerIncarnation?: string
}
export interface FleetSnapshot { generatedAtMs: number; rows: FleetRow[]; actionHistory: FleetAction[]; buckets: { needsYou: number; lostContact: number; active: number; inactive: number }; activeCount: number; attentionCount: number }
export interface WatcherDetail extends Inspection { target: WatcherTarget; ownerFence: OwnerFence; ownerContact: 'live' | 'unverifiable'; observedAtMs: number; name: string; workers: WatcherWorker[]; openEscalations: OpenEscalation[]; pendingControls: string[]; ownerLabel?: string; ownerIncarnation?: string }
export interface DebugReport { schemaVersion: 2; generatedAtMs: number; enrollment: Enrollment; status: RunnerStatus | null; budget: Inspection['budget']; openInterval: JournalEntry | null; ledger: JournalEntry[]; traces: TickTrace[]; pendingControls: string[]; malformed: string | null; workers: WatcherWorker[]; runner: RunnerStatus | null; pointers: { database: string; workspace: string; leaseHolder: string | null } }
export interface FleetService {
  fleet(): Promise<FleetSnapshot>
  detail(target: WatcherTarget): Promise<WatcherDetail | null>
  debugReport(target: WatcherTarget): Promise<DebugReport | null>
  command(request: CommandRequest, expectedIncarnation?: string): Promise<CommandResult>
  localFleet(): Promise<FleetSnapshot>
  localDetail(target: WatcherTarget): Promise<WatcherDetail | null>
  localDebugReport(target: WatcherTarget): Promise<DebugReport | null>
  publish(watcherId?: string): Promise<void>
  dispose(): void
}
/** Kernel-owned barrier: fence new actions BEFORE waiting for the current tick; release in finally. */
export interface KernelControlHost {
  readonly context: PluginContext
  readonly store: KernelStore
  inspect(watcherId: string): Promise<Inspection | null> | Inspection | null
  withControl<T>(watcherId: string, drain: boolean, operation: () => Promise<T>): Promise<T>
  changed(watcherId: string): void
  reconcile(watcherId: string): Promise<void> | void
  remove(watcherId: string): Promise<void> | void
  workers(enrollment: Enrollment): Promise<WatcherWorker[]>
  answerQuestion(enrollment: Enrollment, messageId: string, body: string): Promise<CommandResult>
  answerEscalation(enrollment: Enrollment, escalationId: string, body: string): Promise<CommandResult>
  stopWorker(enrollment: Enrollment, identity: WorkerIdentity): Promise<CommandResult>
  updateConcurrency?(enrollment: Enrollment, cap: number): Promise<CommandResult>
  now?(): number
}
export interface ControlPlane { command(request: CommandRequest): Promise<CommandResult>; pending(watcherId: string): string[] }
