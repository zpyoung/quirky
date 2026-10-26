/** Domain types shared by the daemon, the PTY host, the UI, the CLI and the desktop shell. */

export type Repo = {
  id: string
  /** The repository folder's basename. */
  name: string
  /** Absolute path of the repository's main working tree (`git rev-parse --show-toplevel`). */
  path: string
  addedAt: number
  /** `folder` for a directory opened without git; its single workspace has no git features. */
  kind: 'git' | 'folder'
  /** User-chosen label shown in place of `name`; null when unset. */
  displayName: string | null
  groupId: string | null
}

/** Where a workspace sits in the user's flow, set by hand or by tooling. */
export type WorktreeStatus = 'todo' | 'in-progress' | 'in-review' | 'done'

/** The surface that created a workspace; `external` for ones found already on disk. */
export type WorktreeCreatedBy = 'window' | 'cli' | 'api' | 'external'

export type Worktree = {
  /** Stable for a given path: `wt_` + the first 12 hex chars of sha1(absolute path). */
  id: string
  repoId: string
  path: string
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null
  head: string
  isMain: boolean
  /** Display name when set, else the branch for the primary checkout and the folder name for the rest. */
  name: string
  kind: 'git' | 'folder'
  /** User-chosen label that `name` reflects when set; null when unset. */
  displayName: string | null
  comment: string
  status: WorktreeStatus
  pinned: boolean
  unread: boolean
  /** The workspace this one was created from, for nesting in the tree; null for top level. */
  parentId: string | null
  createdAt: number
  createdBy: WorktreeCreatedBy
  /** The ref the branch was created from; null when unknown. */
  baseRef: string | null
  /** Whether removing the workspace leaves its branch in place. */
  keepBranch: boolean
  /** True while a removal is in flight, so views can show the row as deleting. */
  removing: boolean
  groupId: string | null
}

/** A named, orderable collection of projects in the tree. */
export type ProjectGroup = {
  id: string
  name: string
  /** Folder the group was scanned from; null for a hand-made group. */
  parentPath: string | null
  collapsed: boolean
  order: number
  createdFrom: 'manual' | 'folder-scan'
  repoIds: string[]
}

/** Per-project preferences that override the global defaults. */
export type ProjectSettings = {
  defaultBase: string | null
  worktreeLocation: string | null
  setupPolicy: 'ask' | 'run-by-default' | 'skip-by-default'
  agentStartup: 'start-immediately' | 'wait-for-setup' | null
  commandSource: 'shared-only' | 'local-only' | 'run-both' | null
  setupScript: string
  archiveScript: string
}

/** One hook script after merging the shared file with the user's local script, with its trust state. */
export type HookScript = {
  text: string
  source: 'shared' | 'local' | 'both'
  badge: string
  shared: { text: string; hash: string; trusted: boolean; changed: boolean } | null
}

/** The setup and archive hooks that apply to a project, resolved from its hooks file and settings. */
export type EffectiveHooks = {
  file: 'quirky.yaml' | 'orca.yaml' | null
  setup: HookScript | null
  archive: HookScript | null
  agentStartup: ProjectSettings['agentStartup']
  sharedDirectories: string[]
  warnings: string[]
}

/** A project with its settings and resolved hooks, for the settings dialog and `repo show`. */
export type RepoDetails = {
  repo: Repo
  settings: ProjectSettings
  hooks: EffectiveHooks
}

/** What a workspace create returns: the new workspace plus anything the caller should surface. */
export type WorktreeCreateResult = {
  worktree: Worktree
  warnings: string[]
  baseFallback?: { requestedRef: string; localRef: string; message: string }
  setup: {
    ran: 'terminal' | 'daemon' | 'none' | 'skipped'
    sessionId?: string
    exitCode?: number | null
    timedOut?: boolean
  }
  agentSessionId?: string
  agentPending?: boolean
}

/** What a workspace remove returns: what was deleted and what was deliberately left behind. */
export type WorktreeRemoveResult = {
  ok: true
  removed: string[]
  keptBranch?: { name: string; head: string }
  sessionErrors?: string[]
}

export type AgentKind = 'shell' | 'claude' | 'codex' | 'opencode' | 'gemini'

export const AGENT_KINDS: readonly AgentKind[] = ['shell', 'claude', 'codex', 'opencode', 'gemini']

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
