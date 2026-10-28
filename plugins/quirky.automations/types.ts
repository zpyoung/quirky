import type { PluginStore } from '@quirky/protocol'
import type { AutomationOwner, AutomationRunDispatchState } from './dispatch-contract'

export type AutomationRunStatus =
  | 'pending' | 'dispatching' | 'dispatched' | 'completed'
  | 'skipped_precheck' | 'skipped_missed' | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth' | 'dispatch_failed'
export type AutomationTrigger = 'scheduled' | 'manual'
export type AutomationPrecheck = { command: string; timeoutSeconds: number }
export type AutomationLaunchOverrides = { model?: string; optionValues?: Record<string, string | boolean> }
export type AutomationDefinition = {
  id: string
  creationKey?: string
  owner?: AutomationOwner | null
  name: string
  prompt: string
  agentId: 'claude' | 'codex'
  projectId: string
  workspaceMode: 'existing' | 'new_per_run'
  workspaceId: string | null
  baseBranch: string | null
  setupDecision?: 'run' | 'skip'
  reuseSession: boolean
  runContext: Record<string, unknown> | null
  sourceContext: Record<string, unknown> | null
  launchOverrides: AutomationLaunchOverrides | null
  precheck: AutomationPrecheck | null
  timezone: string
  rrule: string
  dtstart: number
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  missedRunPolicy: 'run_once_within_grace'
  missedRunGraceMinutes: number
  createdAt: number
  updatedAt: number
}
export type AutomationRun = {
  id: string
  automationId: string
  title: string
  runNumber: number
  scheduledFor: number
  trigger: AutomationTrigger
  status: AutomationRunStatus
  createdAt: number
  startedAt?: number
  dispatchedAt?: number
  completedAt?: number
  occurrenceCount: number
  lastOccurrenceAt?: number
  runContext: Record<string, unknown> | null
  sourceContext: Record<string, unknown> | null
  workspaceId: string | null
  workspaceDisplayName?: string | null
  sessionKind: 'structured'
  sessionId: string | null
  launchSettings: Record<string, unknown> | null
  dispatchState?: AutomationRunDispatchState | null
  outputSnapshot?: { format: 'plain_text'; content: string; capturedAt: number; truncated: boolean } | null
  precheckResult?: Record<string, unknown> | null
  usage?: Record<string, unknown> | null
  error: string | null
}
export type AutomationRunPatch = Partial<Pick<AutomationRun,
  'status' | 'workspaceId' | 'workspaceDisplayName' | 'sessionId' | 'launchSettings' |
  'outputSnapshot' | 'precheckResult' | 'usage' | 'error' | 'dispatchState'>>
export type AutomationRunsPage = { runs: AutomationRun[]; nextCursor: string | null }
export type AutomationRunInput = {
  trigger: AutomationTrigger
  scheduledFor: number
  status?: AutomationRunStatus
  error?: string | null
  now: number
}

/** All writes are synchronous durable transactions; emit changes only after they return. */
export interface AutomationStore {
  list(): AutomationDefinition[]
  get(id: string): AutomationDefinition | null
  findByCreationKey(key: string): AutomationDefinition | null
  insert(definition: AutomationDefinition): AutomationDefinition
  update(id: string, patch: Partial<AutomationDefinition>): AutomationDefinition
  remove(id: string): boolean
  runs(automationId: string | undefined, limit?: number, cursor?: string): AutomationRunsPage
  getRun(id: string): AutomationRun | null
  createRun(automationId: string, input: AutomationRunInput): AutomationRun
  updateRun(id: string, patch: AutomationRunPatch, now: number): AutomationRun
  claimRun(id: string, now: number): AutomationRun
  foldUnavailable(automationId: string, scheduledFor: number, error: string, now: number): AutomationRun
  prune(): void
}
export type AutomationStoreFactory = (database: PluginStore) => AutomationStore

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
export type ScheduleDescription = {
  kind: SchedulePreset | 'invalid'
  label: string
  hour?: number
  minute?: number
  day?: number
}
export type ScheduleBuildInput = { preset: SchedulePreset; hour?: number; minute?: number; day?: number; cron?: string }
/** Strict input validation differs from legacy runnable cron oversized steps. */
export interface AutomationScheduleContract {
  next(rule: string, dtstart: number, after: number, timezone: string): number
  latest(rule: string, dtstart: number, now: number, timezone: string): number | null
  valid(rule: string, timezone?: string): boolean
  runnable(rule: string, timezone?: string): boolean
  describe(rule: string): ScheduleDescription
  build(input: ScheduleBuildInput): string
}
