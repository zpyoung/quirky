import type { AgentDisplayState, SessionStatus } from '@quirky/protocol'
import type { DispatchStatus, TaskStatus, WorkerRow } from './contracts'
import type { TerminalState } from './worker-contracts'

/** Optional row cap for the local summary. Omitted values default to 100. */
export interface SummaryParams {
  limit?: number
}

/** Public session lifecycle joined to an optional matching dashboard display. */
export interface SummarySession {
  id: string
  agent: string
  kind: 'terminal' | 'structured'
  status: SessionStatus
  display: AgentDisplayState | null
  live: boolean
}

/** Minimal dispatch attempt projection; custody fields retain worker-list meaning. */
export interface SummaryDispatch {
  id: string
  runId: string
  task: { id: string; title: string; status: TaskStatus }
  status: DispatchStatus
  creatorSessionId: string | null
  assigneeSessionId: string | null
  workerSessionId: string | null
  currentAssignment: boolean
  workerState: WorkerRow['state'] | null
  terminalState: TerminalState
}

/** A single enumerated worktree with its current session and orchestration associations. */
export interface SummaryRow {
  worktree: { id: string; name: string; path: string; repoId: string }
  sessions: SummarySession[]
  runIds: string[]
  dispatches: SummaryDispatch[]
}

/** Bounded, local-only observation; unavailable entries identify incomplete optional reads. */
export interface SummaryResult {
  scope: 'local'
  rows: SummaryRow[]
  total: number
  limit: number
  truncated: boolean
  unavailable: string[]
}
