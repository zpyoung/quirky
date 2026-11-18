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
  | { kind: 'mode'; mode: 'default' | 'acceptEdits' | 'auto' | 'plan'; autoAvailable?: boolean }

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

/** The static feature set of one agent runner, which the composer uses to enable or disable controls. */
export type AgentCapabilities = {
  agent: 'claude' | 'codex' | 'pi' | 'omp'
  steer: Capability
  model: Capability
  planMode: Capability
  permissionModes: { ok: true; modes: string[] } | { ok: false; reason: string }
  images: Capability
  effort: Capability
  approveForSession: Capability
  resume: Capability
}

/** A slash command or skill a session's agent offers; `name` has no leading slash. */
export type AgentCommand = { name: string; kind: 'command' | 'skill'; description?: string }

/** A message waiting in a session's queue; `images` are absolute paths and `at` is an ISO timestamp. */
export type QueuedMessage = { id: string; text: string; images?: string[]; at: string }
