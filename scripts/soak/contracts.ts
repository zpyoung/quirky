export type SoakLimits = {
  maxChildren: number
  maxGrowth: number
  maxZombies: number
  maxEventsPer5s: number
  maxStallMs: number
}

export const FAULT_KINDS = ['leak', 'zombies', 'storm', 'block'] as const
export type FaultKind = (typeof FAULT_KINDS)[number]
export type FaultCheck = 'children' | 'zombies' | 'events' | 'stalls'
export const FAULT_CHECK: Record<FaultKind, FaultCheck> = {
  leak: 'children',
  zombies: 'zombies',
  storm: 'events',
  block: 'stalls',
}
export const FAULT_MIN_MINUTES = 0.25

/** `pids` is the leaked children for a leak, the holders for zombies, and empty otherwise. */
export type FaultDetail = { pids: number[]; refreshes: number; blockedMs: number | null }
export type FaultRecord = { kind: FaultKind; check: FaultCheck; at: number; detail: FaultDetail }

export const DEFAULT_LIMITS: SoakLimits = { maxChildren: 60, maxGrowth: 5, maxZombies: 0, maxEventsPer5s: 30, maxStallMs: 1000 }
export const QUALIFYING_MINUTES = 30
export const QUALIFYING_WINDOWS = 2

export type SoakConfig = { minutes: number; out: string; limits: SoakLimits; fault?: FaultKind }
export type ProcessRow = { pid: number; ppid: number; state: string; rssKb: number; started: string; command: string }
/** Excludes the daemon and PTY host themselves from owned processes. */
export type Sample = { at: number; owned: ProcessRow[]; daemonRssKb: number | null }
export type EventRecord = { at: number; type: string }
export type ProbeRecord = { at: number; ms: number; ownLagMs: number; timedOut: boolean }
export type WorkerBeat = { worktree: string; lastBeatAgeSeconds: number | null }

export type SoakReport = {
  version: 1
  commit: string
  startedAt: string
  durationSeconds: number
  config: { minutes: number; windows: number; worktrees: number; workers: number; limits: SoakLimits }
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
    stalls: { ok: boolean; probes: number; stalls: number; hostBusy: number; p50Ms: number; p95Ms: number; maxMs: number; worst: { at: number; ms: number }[]; daemonExited: boolean }
    workers: { ok: boolean; expected: number; alive: number; stale: string[] }
  }
  fault: FaultRecord | null
  daemon: { pid: number; rssKbFirst: number | null; rssKbMax: number | null; rssKbLast: number | null }
  skippedSamples: number
  files: { samples: string; daemonLog: string }
}
