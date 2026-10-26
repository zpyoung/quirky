/** Domain types shared by the daemon, the PTY host, the UI, the CLI and the desktop shell. */

export type Repo = {
  id: string
  name: string
  /** Absolute path of the repository's main working tree (`git rev-parse --show-toplevel`). */
  path: string
  addedAt: number
}

export type Worktree = {
  /** Stable for a given path: `wt_` + the first 12 hex chars of sha1(absolute path). */
  id: string
  repoId: string
  path: string
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null
  head: string
  isMain: boolean
  /** Display name: the branch, else the directory name. */
  name: string
}

/** `shell` or a catalog agent ID; the daemon checks the ID against the agent catalog at launch. */
export type AgentKind = string

/** What a terminal session was launched with, replayed by resume. */
export type SessionLaunch = { command: string; args: string; env: Record<string, string> }

/** The agent CLI's own session, which resume passes back to it. */
export type SessionProviderSession = { id: string; transcriptPath: string | null }

/** How a launch's first prompt reached the agent; null when it had none. */
export type PromptDeliveryState = 'command-line' | 'pending' | 'pasted' | 'unconfirmed' | 'not-delivered'

/**
 * Terminal sessions report `running`/`exited` from the process alone; agents with hooks also
 * report `working` (a turn is in progress), `waiting` (needs the user) and `done` (turn finished).
 */
export type SessionStatus = 'starting' | 'running' | 'working' | 'waiting' | 'done' | 'exited'

export type SessionKind = 'terminal' | 'structured'

export type Session = {
  id: string
  kind: SessionKind
  agent: AgentKind
  worktreeId: string
  cwd: string
  title: string
  status: SessionStatus
  createdAt: number
  lastActivityAt: number
  exitCode: number | null
  /** Null for shell sessions and sessions recorded before launches were kept. */
  launch?: SessionLaunch | null
  providerSession?: SessionProviderSession | null
  promptDelivery?: PromptDeliveryState | null
  /** The session this one was resumed or forked from. */
  resumedFrom?: string | null
}

export type GitFileStatus = {
  path: string
  /** Porcelain v1 X (index) and Y (worktree) status letters; ' ' means unmodified. */
  index: string
  worktree: string
  untracked: boolean
  /** Source path of a rename or copy. */
  origPath?: string
}

export type GitStatus = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
}

/**
 * Both sides of a file diff. For `staged: true`, original is HEAD and modified is the index;
 * otherwise original is the index and modified is the working tree. Missing sides are ''.
 */
export type GitDiff = {
  path: string
  staged: boolean
  original: string
  modified: string
  binary: boolean
}

export type AskOption = { value: string; label: string; description?: string }

export type AskQuestion =
  | { id: string; type: 'select'; question: string; header?: string; options: AskOption[] }
  | { id: string; type: 'multiselect'; question: string; header?: string; options: AskOption[] }
  | { id: string; type: 'text'; question: string; header?: string; multiline?: boolean }
  | { id: string; type: 'confirm'; question: string; header?: string }

export type AskSpec = { title?: string; questions: AskQuestion[] }

export type AskAnswer =
  | { value: string; label?: string; source: 'option' | 'other' | 'input' }
  | { values: string[]; labels: string[]; source: 'options' }
  | { value: boolean; source: 'input' }

export type AskStatus = 'pending' | 'answered' | 'partial' | 'declined' | 'timed_out'

export type AskEnvelope = {
  status: AskStatus
  askId: string
  answers: Record<string, AskAnswer>
  skipped: string[]
}

export type Ask = {
  id: string
  spec: AskSpec
  sessionId: string | null
  worktreeId: string | null
  createdAt: number
  envelope: AskEnvelope
}

export type StructuredRole = 'user' | 'assistant' | 'tool' | 'system' | 'result'

export type StructuredMessage = {
  sessionId: string
  seq: number
  role: StructuredRole
  text: string
  /** The agent's raw event, for views that want more than text. */
  data?: unknown
  at: number
}
