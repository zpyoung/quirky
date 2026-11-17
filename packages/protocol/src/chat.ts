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
}

/** A slash command or skill a session's agent offers; `name` has no leading slash. */
export type AgentCommand = { name: string; kind: 'command' | 'skill'; description?: string }

/** A message waiting in a session's queue; `images` are absolute paths and `at` is an ISO timestamp. */
export type QueuedMessage = { id: string; text: string; images?: string[]; at: string }
