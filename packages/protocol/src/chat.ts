/** Shared chat types: the typed items a runner journals and the capability and queue shapes around them. */

/** Lifecycle of one tool call; a call that never settles is rendered as stopped when its turn stops. */
export type CallState = 'running' | 'done' | 'failed' | 'stopped'

/**
 * One typed entry in an agent chat transcript, set on `StructuredMessage.item` by every runner.
 * A call that starts and finishes appends two items with the same `callId`; the UI keeps the last.
 * A normalizer that cannot classify an event returns `{ kind: 'status' }` instead of throwing.
 */
export type ChatItem =
  | { kind: 'user'; text: string; images?: string[]; queuedId?: string }
  | { kind: 'prose'; text: string; streaming?: boolean }
  | { kind: 'activity'; callId: string; tool: string; summary: string; state: CallState; detail?: string }
  | { kind: 'file-change'; callId: string; path: string; added?: number; removed?: number; state: CallState }
  | {
      kind: 'tests'
      callId: string
      command: string
      passed?: number
      failed?: number
      skipped?: number
      state: CallState
      tail?: string
    }
  | { kind: 'steps'; callId: string; steps: { text: string; state: 'pending' | 'active' | 'done' }[] }
  | { kind: 'ask'; askId: string; variant: 'approval' | 'question' }
  | { kind: 'view'; viewId: string }
  | { kind: 'view-error'; title: string; errors: string[]; source: string }
  | { kind: 'changes'; worktree: string; fromTree: string; toTree: string; files: number }
  | { kind: 'turn-end'; state: 'done' | 'stopped' | 'failed'; durationMs?: number }
  | { kind: 'error'; reason: 'exited' | 'spawn' | 'protocol'; stderrTail: string[]; resumable: boolean }
  | { kind: 'status'; text: string }
  | {
      kind: 'plan'
      version: number
      status: PlanStatus
      text: string
      filePath?: string
      askId?: string
      empty?: boolean
      unchanged?: boolean
      approvedMode?: 'auto' | 'acceptEdits' | 'default'
      reason?: 'feedback' | 'stopped' | 'mode-switch' | 'restarted'
    }
  | { kind: 'mode'; mode: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'; autoAvailable?: boolean }

/** Lifecycle of one plan version shown in the transcript. */
export type PlanStatus = 'waiting' | 'revised' | 'approved' | 'not-answered'

/** A plan version a runner journaled; `version` is 1-based per session. */
export type PlanItem = Extract<ChatItem, { kind: 'plan' }>

/** A permission-mode change marker in the transcript. */
export type ModeItem = Extract<ChatItem, { kind: 'mode' }>

/** Name of a permission mode a session can be in. */
export type PermissionModeName = ModeItem['mode']

/** Whether an agent supports a feature; `reason` is the hover text shown when it does not. */
export type Capability = { ok: true } | { ok: false; reason: string }

/**
 * The permission modes an agent's harness offers. `modes[0]` is the mode a chat uses when nothing else
 * picks one; `labels` names a mode for people where its id reads badly; `dangerous` lists the modes
 * that let the agent act without asking, which the composer marks while one is active.
 */
export type PermissionModes = { ok: true; modes: string[]; labels?: Record<string, string>; dangerous?: string[] } | { ok: false; reason: string }

/** The static feature set of one agent runner, which the composer uses to enable or disable controls. */
export type AgentCapabilities = {
  agent: 'claude' | 'codex' | 'pi' | 'omp'
  steer: Capability
  model: Capability
  planMode: Capability
  permissionModes: PermissionModes
  images: Capability
  effort: Capability
  approveForSession: Capability
  resume: Capability
  fork: Capability
}

/** Token counts for one scope of a chat's usage; `total` is the sum of the other four. */
export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }

/** One prompt-cache lifetime (5 minutes or 1 hour) and the moment its countdown last restarted. */
export type CacheTier = { ttlMs: 300000 | 3600000; anchorAt: number }

/** The prompt-cache tiers a chat currently holds, so the header can show when each expires. */
export type CacheState = { tiers: CacheTier[] }

/** A chat session's running usage as the header shows it. */
export type UsageSummary = { sessionId: string; own: UsageTotals; turns: number; cache: CacheState | null; updatedAt: number }

/**
 * The answer to a usage query: this chat's own totals, the whole forked-from conversation's, the
 * conversation's completed turn count (0 when none), and its cache state; null where unknown.
 */
export type UsageResult = { own: UsageTotals | null; conversation: UsageTotals | null; turns: number; cache: CacheState | null }

/** What a runner reports to the usage tracker: token counts, a turn boundary, and cache-write/read activity for one call. */
export type UsageReport = {
  tokens?: Omit<UsageTotals, 'total'>
  turnEnded?: boolean
  cache?: { callStartedAt: number; wrote5m: number; wrote1h: number; read: number }
}

/**
 * What an agent command is: the user's or project's own `command` or `skill`, a `plugin` entry, an
 * MCP server's prompt (`mcp`), or one of the harness's `builtin` commands.
 */
export type AgentCommandKind = 'command' | 'skill' | 'plugin' | 'mcp' | 'builtin'

/**
 * A slash command, skill or plugin entry a session's agent offers. `name` is what follows the `/`
 * when typed. `startOnly` marks an entry the harness runs only when it opens the message, so it is
 * not offered mid-message.
 */
export type AgentCommand = {
  name: string
  kind: AgentCommandKind
  description?: string
  argumentHint?: string
  startOnly?: boolean
}

/** A message waiting in a session's queue; `images` are absolute paths and `at` is an ISO timestamp. */
export type QueuedMessage = { id: string; text: string; images?: string[]; at: string }
