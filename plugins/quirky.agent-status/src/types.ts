/** The four states an agent row can be in; see docs/quirk/specs/2026-10-26-m1-agent-status/logic.md. */
export type AgentState = 'working' | 'waiting' | 'blocked' | 'done'

/** How a lead's turn ended. */
export type Outcome = 'success' | 'cancellation' | 'failure'

/** What the window draws for a row: its state adjusted by outcome, freshness and source. */
export type AgentDisplayState =
  | 'working'
  | 'monitoring'
  | 'waiting'
  | 'permission'
  | 'blocked'
  | 'failed'
  | 'interrupted'
  | 'done'
  | 'unverifiable'
  | 'idle'
  | 'unconfirmed'

/** Where a row's latest evidence came from. */
export type EvidenceSource = 'hook' | 'replay' | 'title' | 'program-status' | 'inference'

export type ChildKind = 'agent' | 'shell' | 'cron'

export type Child = { id: string; kind: ChildKind; state: 'working' | 'waiting' | 'done' }

export type ProviderSession = { id: string; transcriptPath: string | null }

/** The program's own OSC 7501 report riding on a row; it never decides the row's state. */
export type ProgramStatusFacet = { state: string; kind?: string; progress?: number; msg?: string; app?: string }

/** One session's agent status, as stored by quirky.agent-status. */
export type AgentRow = {
  sessionId: string
  /** The hook source that owns the row, e.g. `claude`, `qwen-code`. */
  agent: string
  /** The folded state: the lead's state combined with its children's. */
  state: AgentState
  workingMode?: 'monitoring'
  outcome?: Outcome
  interrupted?: boolean
  sessionBoundary?: boolean
  prompt: string
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  /** JSON of the question an agent asked, when it asked one. */
  question?: string
  model?: string
  /** Readable one-line detail; never a JSON object. */
  detail: string
  lead: {
    providerSession: string | null
    agentPid: number | null
    agentStart: string | null
    ended: boolean
    /** The lead's own state before the fold. */
    state: AgentState
    stateStartedAt: number
  }
  children: Child[]
  heldPermission?: { toolUseId: string | null; toolName: string; input: string; childId: string | null }
  /** The lead state saved while a child asks a human, restored when that child moves on. */
  stashedState?: AgentState
  stateStartedAt: number
  evidenceAt: number
  turnStartedAt: number | null
  /** Evidence time of the last hook or spool replay; OSC 7501 precedence reads it. */
  lastHookAt: number | null
  source: EvidenceSource
  restoredUnconfirmed?: boolean
  programStatus?: ProgramStatusFacet
}

/** The row summary carried on `Session.agentStatus` and returned by `list`. */
export type AgentStatusSummary = {
  state: AgentState
  display: AgentDisplayState
  label: string
  detail: string
  progress: number | null
  stateStartedAt: number
  evidenceAt: number
  restoredUnconfirmed: boolean
}

export type ChildOp =
  | { op: 'start'; id: string; kind: ChildKind }
  | { op: 'stop'; id: string }
  | { op: 'state'; id: string; state: Child['state'] }

/** A background-work inventory a payload reported in full (Claude `background_tasks`, Grok tasks). */
export type Inventory = { tasks: { id: string; kind: ChildKind; running: boolean }[]; complete: boolean }

/**
 * What one hook event means, as a normalizer reports it. `state: null` with `newTurn: false`
 * and no other fields means the event says nothing about status.
 */
export type Normalized = {
  eventName: string
  state: AgentState | null
  newTurn: boolean
  sessionBoundary?: boolean
  outcome?: Outcome
  interrupted?: boolean
  fields: {
    prompt?: string
    toolName?: string
    toolInput?: string
    toolUseId?: string
    lastAssistantMessage?: string
    question?: string
    model?: string
  }
  childOps?: ChildOp[]
  inventory?: Inventory
  /** True when session crons are active (Claude `session_crons` non-empty); false when cleared. */
  cronsActive?: boolean
  providerSession?: ProviderSession
  /** The child the event came from, when it came from a subagent. */
  agentId?: string
  /** The event proves the agent process ended (Claude SessionEnd rule). */
  endsProcess?: boolean
  /** A SessionStart that moves the lead to a new provider session (`clear`, `resume`). */
  movesLead?: boolean
  /** The event is a permission request (for the Claude permission hold). */
  permissionRequest?: boolean
  cacheReset?: boolean
}

/** Per-session memory a normalizer may keep between events (last prompt, per-thread state). */
export type NormalizerCache = Map<string, unknown>

/** A source's normalizer: the event's meaning, or null when the event carries no status. */
export type Normalizer = (payload: Record<string, unknown>, eventName: string, cache: NormalizerCache) => Normalized | null

export type InstallStatus = 'installed' | 'not-installed' | 'agent_disabled' | 'cli_not_found' | 'hooks_disabled' | 'error'

/** The environment an installer reads: the user's home plus agent-specific home variables. */
export type InstallEnv = { home: string; env: Record<string, string | undefined>; quirkyHome: string }

/** One agent's hook installer; see tech.md "Installer contract". */
export type Installer = {
  agent: string
  source: string
  files(target: InstallEnv): string[]
  install(target: InstallEnv): { changed: string[]; note?: string; message?: string }
  remove(target: InstallEnv): { changed: string[]; message?: string }
  status(target: InstallEnv): 'installed' | 'not-installed' | { error: string }
}

/** Thrown by an installer that can't read a config file; the file is left untouched. */
export class InstallError extends Error {}
