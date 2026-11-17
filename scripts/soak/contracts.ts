export type SoakLimits = {
  maxChildren: number
  maxGrowth: number
  maxZombies: number
  maxEventsPer5s: number
  maxStallMs: number
  maxUnanswered: number
  maxWindowRequestsPerMinute: number | null
}
export type PanelKey = 'changes' | 'checks' | 'explorer' | 'tasks' | 'session-info' | 'feedback'
export type PanelRequestRecord = { at: number; index: number; panel: PanelKey }
export type GitProbeRecord = { at: number; ms: number; ownLagMs: number; timedOut: boolean; failed: boolean; worktree: string }
export type DayInputs = { enabled: boolean; windows: { index: number; worktree: string }[]; worktrees: string[] }
export type SwitchRecord = {
  at: number; seq: number; index: number; from: string; requested: string; settled: string
  proof: { at: number; method: string; worktree: string } | null
  ok: boolean; followMs: number | null; error: string | null
}
export type PhaseRecord = {
  at: number; seq: number; phase: number; ok: boolean; applyMs: number
  missing: { index: number; panel: PanelKey }[]; error: string | null
}
export type TaskInteractionRecord = {
  kind: 'task'; at: number; seq: number; index: number; method: string
  ok: boolean; proof: { at: number; method: string } | null; error: string | null
}

export const FAULT_KINDS = ['leak', 'zombies', 'storm', 'block', 'slow-git', 'feedback', 'flood'] as const
export type FaultKind = (typeof FAULT_KINDS)[number]
export type FaultCheck = 'children' | 'zombies' | 'events' | 'stalls' | 'calls' | 'refreshes' | 'requests'
export const FAULT_CHECK: Record<FaultKind, FaultCheck> = {
  leak: 'children',
  zombies: 'zombies',
  storm: 'events',
  block: 'stalls',
  'slow-git': 'calls',
  feedback: 'refreshes',
  flood: 'requests',
}
export const FAULT_MIN_MINUTES = 0.25
export const DEFAULT_WINDOWS = 3
export const MAX_WINDOWS = 7
export const WINDOW_SILENCE_SECONDS = 30

/** `pids` is leaked children, zombie holders, or slow-git process groups; empty otherwise. */
export type FaultDetail = {
  pids: number[]
  refreshes: number
  blockedMs: number | null
  worktrees?: [string, string]
  flood?: { index: number; worktree: string; requests: number }
}
export type FaultRecord = { kind: FaultKind; check: FaultCheck; at: number; detail: FaultDetail }

export type RefreshExample = {
  id: string
  startedAt: string
  phase: 'setup' | 'run' | 'unknown'
  elapsedMs: number
  loopLagMs: number
  maxProbeOwnLagMs: number | null
  outcome: 'ok' | 'error' | 'timeout' | 'pending'
}
export type RefreshSummary = {
  slow: number
  completed: number
  failed: number
  pending: number
  invalid: number
  examples: RefreshExample[]
}

export const DEFAULT_LIMITS: SoakLimits = {
  maxChildren: 60,
  maxGrowth: 5,
  maxZombies: 0,
  maxEventsPer5s: 30,
  maxStallMs: 1000,
  maxUnanswered: 0,
  maxWindowRequestsPerMinute: 2500,
}
export const QUALIFYING_MINUTES = 30
export const QUALIFYING_WINDOWS = 2

export type SoakConfig = { minutes: number; out: string; limits: SoakLimits; windows: number; fault?: FaultKind; slowGitMs?: number }
export type ProcessRow = { pid: number; ppid: number; state: string; rssKb: number; started: string; command: string }
/** Excludes the daemon and PTY host themselves from owned processes. */
export type Sample = { at: number; owned: ProcessRow[]; daemonRssKb: number | null }
export type EventRecord = { at: number; type: string }
export const MAX_PANEL_REFRESHES_PER5S = 8
export type PanelRefreshRecord = {
  at: number
  index: number
  worktree: string
  method: string
}
export type WindowRequestObservation = {
  at: number
  index: number
  worktree: string
  method: string
  params: unknown
}
export type ProbeRecord = { at: number; ms: number; ownLagMs: number; timedOut: boolean }
export type WorkerBeat = { worktree: string; lastBeatAgeSeconds: number | null }

export type WindowBeat = {
  worktree: string
  open: boolean
  shown: boolean
  lastRequestAgeSeconds: number | null
}
export type WindowRecord = WindowBeat & {
  index: number
  connId: number
  requests: number
  sockets: number
  pageErrors: number
  pageErrorExamples: string[]
}

export type SoakReport = {
  version: 1
  commit: string
  startedAt: string
  durationSeconds: number
  config: { minutes: number; windows: number; worktrees: number; workers: number; limits: SoakLimits; slowGitMs: number | null }
  verdict: 'pass' | 'fail'
  qualifies: boolean
  disqualified: string[]
  checks: {
    children: {
      ok: boolean; peak: number; peakAt: number; peakCommands: { command: string; count: number }[]
      medianFirst: number | null; medianLast: number | null; growth: number | null
      spawned: number; spawnedPerMinute: number
    }
    zombies: { ok: boolean; peak: number; persistent: number; examples: { pid: number; ppid: number; command: string; seconds: number }[] }
    events: { ok: boolean; total: number; peakPer5s: number; peakType: string | null; peakAt: number | null; byType: { type: string; total: number; peakPer5s: number }[] }
    refreshes: {
      ok: boolean
      total: number
      limitPer5s: 8
      peakPer5s: number
      peakAt: number | null
      peakWindow: number | null
      peakWorktree: string | null
      missingWindows: string[]
      byWindow: { index: number; worktree: string; total: number; peakPer5s: number }[]
      byPanel: { index: number; panel: PanelKey; total: number; peakPer5s: number }[]
    }
    requests: {
      ok: boolean
      limitPerMinute: number | null
      peakPerMinute: number
      peakAt: number | null
      peakWindow: number | null
      peakWorktree: string | null
      byWindow: { index: number; worktree: string; total: number; peakPerMinute: number; peakAt: number | null }[]
    }
    stalls: {
      ok: boolean
      probes: number
      stalls: number
      hostBusy: number
      p50Ms: number
      p95Ms: number
      maxMs: number
      worst: { at: number; ms: number }[]
      daemonExited: boolean
      git: {
        probes: number; stalls: number; failed: number; hostBusy: number
        p50Ms: number; p95Ms: number; maxMs: number
        worst: { at: number; ms: number; worktree: string }[]
        byWorktree: { worktree: string; probes: number; maxMs: number }[]
      }
    }
    day: {
      ok: boolean; enabled: boolean; expectedSwitches: number; expectedPhases: number
      expectedTaskInteractions: number; switches: number; phases: number; taskInteractions: number
      missing: string[]; duplicates: string[]; unscheduled: string[]
      wrongTarget: string[]; failed: string[]; slowestFollowMs: number | null
      counts: { missing: number; duplicates: number; unscheduled: number; wrongTarget: number; failed: number }
    }
    calls: { ok: boolean; unanswered: number; byMethod: { method: string; count: number }[]; gitTimeouts: number; refreshes: RefreshSummary }
    workers: { ok: boolean; expected: number; alive: number; stale: string[] }
    windows: { ok: boolean; expected: number; alive: number; lost: string[] }
  }
  panelRefreshes: PanelRefreshRecord[]
  windows: WindowRecord[]
  windowRequests: { method: string; total: number }[]
  windowRequestSeconds: number[][]
  panelRequests: PanelRequestRecord[]
  gitProbes: GitProbeRecord[]
  day: DayInputs | null
  switches: SwitchRecord[]
  taskInteractions: TaskInteractionRecord[]
  phases: PhaseRecord[]
  fault: FaultRecord | null
  daemon: { pid: number; rssKbFirst: number | null; rssKbMax: number | null; rssKbLast: number | null }
  skippedSamples: number
  skippedBeats: number
  files: { samples: string; daemonLog: string }
}
