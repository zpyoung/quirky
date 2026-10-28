import type { PluginCaller, PluginContext, StructuredMessage } from '@quirky/protocol'

export type LoopAgent = 'claude' | 'codex'
export type LoopState = 'running' | 'needs-you' | 'paused' | 'completed' | 'stopped'
export type PauseReason = 'user' | 'cap-iterations' | 'cap-time' | 'cap-cost' | 'no-progress' | 'protected-path' | 'agent-blocked' | 'agent-decide' | 'crashed' | 'usage-limit' | 'interrupted-by-restart' | 'unverifiable' | 'ask-before-next' | 'queue-exhausted'
export type LoopPreset = 'until-done' | 'interval' | 'queue'
export type QueueItem = { id: string; position: number; body: string; state: 'pending' | 'in-flight' | 'done' }
export type QueueOperation =
  | { kind: 'add'; body: string; position?: number }
  | { kind: 'edit'; id: string; body: string }
  | { kind: 'move'; id: string; position: number }
  | { kind: 'remove'; id: string }
export type LoopConfig = {
  promptSource: { kind: 'repeat'; body: string } | { kind: 'queue'; repeatQueue: boolean }
  pacing: { kind: 'on-idle' } | { kind: 'interval'; minutes: number; anchor: 'from-end' | 'wall-clock' }
  sessionPolicy: 'fresh' | 'continue'
  done: {
    check?: { command: string; timeoutSeconds: number; runWhen: 'every-iteration' | 'on-claim' }
    evaluator?: { condition: string }
  }
  caps: { maxIterations?: number; maxActiveMinutes?: number; maxCostUsd?: number }
  noProgress: boolean
  protectedPaths?: string[]
  checkpointCommits: boolean
  askBeforeNext: boolean
  resumeAtLimitReset: boolean
}
export type LoopConfigPatch = Partial<LoopConfig>
export type LoopCreateInput = {
  worktree?: string
  worktreeId?: string
  name?: string
  agent: LoopAgent
  preset?: LoopPreset
  queueItems?: { body: string }[]
  config: LoopConfig
  model?: string
  options?: Record<string, string | boolean>
}
export type CheckResult = {
  ran: boolean
  pass: boolean
  exitCode: number | null
  timedOut: boolean
  aborted?: boolean
  stdoutTail: string
  stderrTail: string
  durationMs: number
  error?: string
}
export type EvaluatorResult = { verdict: 'met' | 'not-met'; reason: string }
export type LoopMarkers = { done: boolean; blocked?: string; decide?: string }
export type TreeDiff = { added: number; removed: number; files: string[] }
export type UsageLimit = { provider: string; resetsAt: number | null }
export type IterationEvidence = {
  check: CheckResult | null
  evaluator: EvaluatorResult | null
  markers: LoopMarkers
  diff: TreeDiff | null
  treeBefore: string | null
  treeAfter: string | null
  protectedPathHits: string[]
  checkpointCommit: string | null
  costUsd: number | null
  usageLimit: UsageLimit | null
  outputTail: string
  error?: string
}
export type IterationEnd = 'settled' | 'crashed' | 'interrupted' | 'stopped' | 'unverifiable'
export type IterationDetail = IterationEvidence & {
  loopId: string
  n: number
  attempt: number
  sessionId: string | null
  promptSent: string
  startedAt: number
  endedAt: number | null
  endReason: IterationEnd | null
  doneConfig: LoopConfig['done']
  queueItemId?: string | null
  pacingConfig?: LoopConfig['pacing']
}
export type LoopSnapshot = {
  id: string
  name: string
  slug: string
  worktreeId: string
  cwd: string
  workspaceKind: 'git' | 'folder'
  agent: LoopAgent
  preset: LoopPreset
  config: LoopConfig
  model?: string
  options?: Record<string, string | boolean>
  state: LoopState
  pauseReason: PauseReason | null
  pauseDetail: string | null
  sessionId: string | null
  iterationsCompleted: number
  activeMs: number
  costUsd: number | null
  phase: 'waiting' | 'sending' | 'relaunching' | 'working' | 'checking' | 'evaluating' | null
  nextIterationAt: number | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
  notesPath: string
  warnings: string[]
  recentIterations: IterationDetail[]
  queueItems: QueueItem[]
  skippedTicks: number
}
export type LoopSummary = {
  id: string
  worktreeId: string
  state: 'running' | 'needs-you' | 'paused'
  pauseReason: PauseReason | null
  iterationsCompleted: number
  maxIterations: number | null
  updatedAt: number
}

export type DecisionInput = {
  loop: LoopSnapshot
  latest: IterationDetail | null
  history: IterationDetail[]
  stopRequested?: boolean
  pauseRequested?: boolean
  unverifiable?: boolean
  userIdle?: boolean
  agentIdle?: boolean
  now: number
}
export type LoopDecision =
  | { kind: 'complete' }
  | { kind: 'stop' }
  | { kind: 'pause'; reason: PauseReason; detail?: string }
  | { kind: 'wait'; reason: string; until?: number }
  | { kind: 'retry-crashed' }
  | { kind: 'start-iteration'; freshSession: boolean }
export type GatherInput = {
  loop: LoopSnapshot
  n: number
  attempt: number
  treeBefore: string | null
  messages: StructuredMessage[]
  signal?: AbortSignal
  onPhase?: (phase: 'checking' | 'evaluating') => void
  /** Session-cumulative USD before the turn; null when unavailable. */
  costBefore?: number | null
}
export type LoopTiming = { pollMs?: number; userIdleMs?: number; noBusyEdgeMs?: number; resetGraceMs?: number; now?: () => number }

/** Integration owner provides handlers; service owner implements this surface. */
export interface LoopServiceContract {
  start(): Promise<void>
  create(input: LoopCreateInput, caller?: PluginCaller): Promise<LoopSnapshot>
  list(params?: { worktreeId?: string; worktree?: string }): Promise<LoopSnapshot[]>
  summaries(): Promise<LoopSummary[]>
  get(loopId: string): LoopSnapshot
  iterations(loopId: string, limit?: number): IterationDetail[]
  pause(loopId: string): Promise<LoopSnapshot>
  resume(loopId: string, addIterations?: number): Promise<LoopSnapshot>
  stop(loopId: string, now?: boolean): Promise<LoopSnapshot>
  steer(loopId: string, text: string): Promise<LoopSnapshot>
  edit(loopId: string, patch: LoopConfigPatch & { name?: string }): Promise<LoopSnapshot>
  queue(loopId: string, op: QueueOperation): Promise<LoopSnapshot>
  shutdown(): Promise<void>
}

/** Evidence owner exports class EvidenceEngine(context: PluginContext) with this surface. */
export interface EvidenceEngineContract {
  snapshot(cwd: string): Promise<string | null>
  validate(agent: LoopAgent, config: LoopConfig, cwd: string): Promise<void>
  gather(input: GatherInput): Promise<IterationEvidence>
  cancel(loopId: string): Promise<void>
  shutdown(): Promise<void>
}
export type LoopContext = PluginContext

export type PacingInput = {
  pacing: LoopConfig['pacing']
  createdAt: number
  iterationStartedAt: number | null
  iterationEndedAt: number | null
}
export type PacingSchedule = { nextIterationAt: number | null; skippedTicks: number }
