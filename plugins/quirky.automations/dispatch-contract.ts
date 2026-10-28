import type { PluginContext } from '@quirky/protocol'
import type { AutomationDefinition, AutomationRun, AutomationRunStatus, AutomationStore } from './types'

/** Persisted local registry identity. Remote registration incarnations are not inferred locally. */
export type AutomationOwner = {
  kind: 'local'
  repoId: string
  repoPath: string
  workspaceId: string | null
  workspacePath: string | null
  workspaceInstanceId: string | null
}

export type AutomationTarget = {
  repoId: string
  repoPath: string
  cwd: string
  workspaceId: string | null
  workspaceDisplayName: string | null
  owner: AutomationOwner
}
export type AutomationTargetResolution =
  | { available: true; target: AutomationTarget }
  | { available: false; status: 'skipped_unavailable' | 'skipped_needs_interactive_auth'; error: string }

export type AutomationTargetResolver = {
  /** Capture registry identity on create or an explicit target selector move. Never trust client paths. */
  capture(definition: AutomationDefinition): Promise<AutomationDefinition>
  /** Resolve without recapturing an existing owner. Missing/changed/remote targets fail closed. */
  resolve(definition: AutomationDefinition): Promise<AutomationTargetResolution>
  /** Undefined is allowed for local callers; a supplied stale/malformed owner conflicts. */
  assertExpectedOwner(definition: AutomationDefinition, expectedOwner: unknown): void
}
export type AutomationDispatchContext = Pick<PluginContext, 'call' | 'subscribe' | 'error' | 'log'>
export type AutomationDispatchHooks = {
  store: AutomationStore
  targets: AutomationTargetResolver
  clock: () => number
  inLane<T>(automationId: string, work: () => T | Promise<T>): Promise<T>
  /** Called after each committed dispatcher run mutation. */
  changed(automationId: string, runId: string): void
}
export type AutomationDispatcher = {
  /** Claims only pending runs; duplicate/nonpending calls return the current row. */
  dispatch(runId: string): Promise<AutomationRun | null>
  /** Reconcile durable journal evidence and strand ambiguous pre-launch work without replay. */
  start(): Promise<void>
  dispose(): void
}
export type AutomationServiceOptions = {
  targets?: AutomationTargetResolver
  createDispatcher?: (hooks: AutomationDispatchHooks) => AutomationDispatcher
}
export type AutomationRunDispatchState = {
  messageCursor: number
  reused: boolean
  observedWorking: boolean
  observationStartedAt: number
  /** SDK streaming costs are cumulative; null means a reused turn's prior total was not proven. */
  claudeCostBaseline?: number | null
}
export const AUTOMATION_FINAL_STATUSES: readonly AutomationRunStatus[] = [
  'completed', 'skipped_precheck', 'skipped_missed', 'skipped_unavailable',
  'skipped_needs_interactive_auth', 'dispatch_failed'
]
