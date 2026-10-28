import type { PluginContext } from '@quirky/protocol'
import type { Enrollment, ExecuteContext, ExecuteResult, Json, KernelAction, KernelStore, OwnerConfig, Snapshot } from '../contracts'

export const OWNER_IDLE_GRACE_MS = 120_000
export const OWNER_STALL_THRESHOLD_MS = 900_000
export const OWNER_RECHECK_MS = 15_000
export const OWNER_BRIEF_MAX_STATE_BYTES = 32 * 1024
export const MAX_OWNER_REPORT_BYTES = 64 * 1024

export type { OwnerConfig } from '../contracts'
export const OWNER_DEVIATION_KINDS = [
  'report-rejected', 'node-failed', 'retry-exhausted', 'worker-question', 'worker-escalation',
  'worker-unverifiable', 'worker-exited', 'check-failed', 'review-blocked', 'landing-failed',
  'plan-failed', 'gate-held', 'stall',
] as const
export type OwnerDeviationKind = typeof OWNER_DEVIATION_KINDS[number]
export interface OwnerDeviation {
  kind: OwnerDeviationKind; naturalKey: string; detail: string
  dispatchId?: string; messageId?: string; trigger?: 'idle' | 'silent'
}
export type OwnerIntervention =
  | { kind: 'continue' }
  | { kind: 'ask-human'; question: string }
  | { kind: 'abandon'; reason: string }
  | { kind: 'answer-worker'; dispatchId: string; messageId: string; body: string }
  | { kind: 'stop-worker'; dispatchId: string }
  | { kind: 'message-worker'; dispatchId: string; body: string }
  | { kind: 'kind-action'; action: Json }
export interface OwnerEnrollment extends Enrollment {
  owner?: OwnerConfig | null
  ownerInterventionCapability?: 'off' | 'gated' | 'on'
}
export interface WorkerActivity {
  dispatchId: string
  contact: 'live' | 'unverifiable' | 'exited' | 'missing' | 'identity-changed'
  observedAtMs: number
  /** True only for positively attested current prompt-wait evidence. */
  waitingAtPrompt: boolean
  idleSinceMs?: number
  lastProgressAtMs: number
  lastMessage?: string
}
export interface WorkerScan {
  deviations: OwnerDeviation[]
  observations: { key: string; dispatchId: string; idleSinceMs: number; detail: string }[]
  questions: { key: string; dispatchId: string; messageId: string; body: string }[]
  nextCheckAtMs: number | null
}
export interface OwnerApplyResult {
  kind: 'applied' | 'held' | 'indeterminate' | 'refused'
  reason?: string
  action?: KernelAction
  outcome?: ExecuteResult
}
export interface OwnerRuntimeHost {
  context: PluginContext; store: KernelStore; reportDirectory: string; now: () => number
  /** Automatic turns recheck the runner's current control/lifecycle fence immediately before dispatch. */
  canDispatch?(watcherId: string): boolean
  /** Parent owns ordinary write-ahead execution and BOTH native and owner capability gates. */
  apply(enrollment: OwnerEnrollment, intervention: OwnerIntervention, deviation: OwnerDeviation, snapshot: Snapshot): Promise<OwnerApplyResult>
  /** Serialized under the runner; persists disabled+park reason+exact escalation. */
  park(enrollment: OwnerEnrollment, escalationId: string, detail: string): void
  wake(watcherId: string): void
}
export interface OwnerPending {
  reportKey: string; reportPath: string; deviation: OwnerDeviation; escalationId: string
  issuedAtMs: number; lastWakeAtMs: number; wakeCount: number; contentIdentity: string
  phase: 'deferred' | 'issuing' | 'waiting' | 'ready' | 'indeterminate' | 'parked'
  intervention?: OwnerIntervention
}
export interface OwnerState {
  sessionId: string | null; pending: OwnerPending | null
  /** A restart must resume a previously persisted session before sending. */
  instanceId?: string
}
export interface OwnerStepResult { handled: boolean; nextCheckAtMs?: number; reason?: string }
export interface OwnerController {
  step(enrollment: OwnerEnrollment, snapshot: Snapshot, deviations: OwnerDeviation[]): Promise<OwnerStepResult>
  ready(watcherId: string, reportKey: string): Promise<{ kind: 'accepted' | 'refused'; reason?: string }>
  answer(watcherId: string, escalationId: string, body: string): Promise<OwnerStepResult>
  inspect(watcherId: string): OwnerState
  /** Releases one watcher's owner connection and issued reports without touching worker sessions. */
  release(watcherId: string): Promise<void>
  shutdown(): Promise<void>
}

/** Runner insertion port; proposals always use the ordinary native gate/write-ahead executor. */
export interface OwnerKernelPort {
  step(enrollment: Enrollment, snapshot: Snapshot, deviation?: OwnerDeviation, canDispatch?: () => boolean): Promise<OwnerStepResult & { action?: KernelAction }>
  execute(action: KernelAction, context: ExecuteContext): Promise<ExecuteResult>
  onTerminal?(watcherId: string): Promise<void>
  shutdown(): Promise<void>
}
