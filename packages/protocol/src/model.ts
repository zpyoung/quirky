/** Domain types shared by the daemon, the PTY host, the UI, the CLI and the desktop shell. */

import type { ExitCause } from './pty'

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

/** A GitHub repository identity established by the hosting plugin. */
export type GitHubRepositoryIdentity = { host: string; owner: string; repo: string }

/** Durable linked work, independent of the workspace's editable note and branch. */
export type GitHubWorktreeLink = {
  provider: 'github'
  kind: 'issue' | 'pullRequest'
  number: number
  title: string
  url: string
  repository: GitHubRepositoryIdentity
}

/** Fresh, authenticated source information for a GitHub-created worktree. */
export type GitHubWorktreeSource = {
  item: GitHubWorktreeLink
  head: {
    repository: GitHubRepositoryIdentity
    refName: string
    oid: string
    sshUrl: string
    httpsUrl: string
    maintainerCanModify: boolean
  } | null
  base: { repository: GitHubRepositoryIdentity; refName: string; oid: string } | null
}

/** The selected PR's actual push destination, not its synthetic read-only pull ref. */
export type WorktreePushTarget = {
  remoteName: string
  branchName: string
  maintainerCanModify: boolean
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
  linkedPR?: GitHubWorktreeLink | null
  linkedIssue?: GitHubWorktreeLink | null
  pushTarget?: WorktreePushTarget | null
  /** Display-only membership in a project group; distinct from folder identity and repo ownership. */
  projectGroupId: string | null
  /** Greatest session lifecycle/activity timestamp observed for this workspace; zero when unknown. */
  lastActivityAt: number
  /** Filesystem-instance identity, distinct from the path-derived worktree ID. */
  instanceId: string
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
  /** Parent project group, or null for a root group. */
  parentId: string | null
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
  /** Local command template for a linked GitHub issue. */
  issueCommand?: string
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
  /** Linked-issue command with the same shared-content trust boundary as setup. */
  issueCommand?: HookScript | null
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
  issueCommand?: {
    ran: 'terminal' | 'daemon' | 'none' | 'skipped'
    sessionId?: string
    exitCode?: number | null
    timedOut?: boolean
  }
}

/** What a workspace remove returns: what was deleted and what was deliberately left behind. */
export type WorktreeRemoveResult = {
  ok: true
  removed: string[]
  keptBranch?: { name: string; head: string }
  sessionErrors?: string[]
}

/** `shell` or a catalog agent ID; the daemon checks the ID against the agent catalog at launch. */
export type AgentKind = string

/** What a terminal session was launched with, replayed by resume. */
export type SessionLaunch = { command: string; args: string; env: Record<string, string> }

/** Where a launch setting came from: a pick, or extra arguments that set the same flag. */
export type LaunchSettingSource = 'explicit' | 'extra-args'

/**
 * What a launch applied, kept with the session so history doesn't change when settings do.
 * `options` holds the model under the key `model`; a value is absent when extra arguments set it.
 */
export type LaunchSettings = {
  agent: string
  options: Record<string, { value?: string | boolean; source: LaunchSettingSource }>
  args?: { value: string; source: 'explicit' | 'inherited' }
  /** "Claude · Opus · Effort: high", computed at launch. */
  summary: string
}

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

/** What the agent-status plugin shows for a session; the order is not urgency (see the worktree priority). */
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

/** The agent-status plugin's per-session summary: a coarse `state` for rollups and a `display` for the glyph. */
export type AgentStatusSummary = {
  state: 'working' | 'waiting' | 'blocked' | 'done'
  display: AgentDisplayState
  label: string
  detail: string
  /** A percentage from 0 to 100, or null when the program reports none. */
  progress: number | null
  stateStartedAt: number
  evidenceAt: number
  /** True when the row was loaded from a previous run and nothing has confirmed it since. */
  restoredUnconfirmed: boolean
}

/** Why a session is marked unread: an agent finished, a terminal bell rang, or a program posted a notification. */
export type SessionUnread = 'agent' | 'bell' | 'notification'

/** A chip a plugin attaches to a session's tab; clicking it runs `command` with `args` when `command` is set. */
export type SessionBadge = {
  label: string
  tooltip?: string
  command?: string
  args?: unknown
}

export type Session = {
  id: string
  kind: SessionKind
  agent: AgentKind
  worktreeId: string
  cwd: string
  title: string
  /** Background work is not auto-adopted into terminal tabs; an explicit session view can still show it. */
  background?: boolean
  status: SessionStatus
  createdAt: number
  lastActivityAt: number
  exitCode: number | null
  /** The signal that ended the process, when one did; null while it is alive. */
  exitSignal: string | null
  /** Why the session ended; null while it is alive and for records from before causes were kept. */
  exitCause: ExitCause | null
  /** True when the PTY host still holds the session's history, so `restore` can start a shell in it. */
  restorable: boolean
  /** Null for shell sessions and sessions recorded before launches were kept. */
  launch?: SessionLaunch | null
  providerSession?: SessionProviderSession | null
  promptDelivery?: PromptDeliveryState | null
  /** Null for a launch with no picks and no arguments, and for sessions recorded before launch settings. */
  launchSettings?: LaunchSettings | null
  /** The session this one was resumed or forked from. */
  resumedFrom?: string | null
  /** Null or absent until the agent-status plugin has evidence; the coarse `status` then stands alone. */
  agentStatus?: AgentStatusSummary | null
  /** Lowercase, unique among sessions that have not exited; scripts can pass it wherever a session ID is taken. */
  name?: string | null
  /** Why the session is marked unread; null or absent when it is not. */
  unread?: SessionUnread | null
  /** Chips on the session's tab, keyed `<plugin id>/<key>`; absent when there are none. */
  badges?: Record<string, SessionBadge>
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

/** Which Source Control section a row belongs to; `unstaged` is the "Changes" section. */
export type GitArea = 'conflicts' | 'staged' | 'unstaged' | 'untracked'

export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'

export type GitConflictKind =
  | 'both_modified'
  | 'both_added'
  | 'both_deleted'
  | 'added_by_us'
  | 'added_by_them'
  | 'deleted_by_us'
  | 'deleted_by_them'

/** The merge, rebase or cherry-pick in progress in a worktree, read from its git directory. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'none'

/** An operation that holds a worktree's lock while it runs; at most one per worktree. */
export type GitBusyOp = 'push' | 'force-push' | 'pull' | 'fast-forward' | 'fetch' | 'sync' | 'rebase' | 'continue' | 'abort'

/** One row of the Source Control panel. A path both staged and changed has two entries. */
export type GitStatusEntry = {
  path: string
  /** Source path of a rename or copy. */
  oldPath?: string
  area: GitArea
  status: GitChangeStatus
  /** Set only in the conflicts area; `resolved_locally` means opened in Quirky and no longer unmerged in git. */
  conflict?: { kind: GitConflictKind; state: 'unresolved' | 'resolved_locally' }
  /** Line counts; absent when unknown (binary, capped status, too large). */
  added?: number
  removed?: number
  binary?: boolean
  submodule?: { commitChanged: boolean; trackedChanges: boolean; untrackedChanges: boolean }
}

export type GitUpstreamStatus = {
  hasUpstream: boolean
  /** Short name such as `origin/zoe/feat`. */
  name: string | null
  /** The commit the remote-tracking ref points at, as last fetched. */
  sha: string | null
  ahead: number
  behind: number
  /** Whether every commit behind is patch-equivalent to one ahead; null when not computed (not diverged, or capped). */
  behindPatchEquivalent: boolean | null
}

export type GitStatus = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** v1's porcelain-v1 view of the same snapshot; kept unchanged for existing readers. */
  files: GitFileStatus[]
  head: string | null
  detached: boolean
  unborn: boolean
  entries: GitStatusEntry[]
  operation: GitOperation
  /** True when the status stopped at its entry limit; line counts and the upstream probe are then skipped. */
  capped: boolean
  upstreamStatus: GitUpstreamStatus
  busy: GitBusyOp | null
}

/** The v1 subset of `GitStatus`: what porcelain v1 gives. */
export type GitStatusSummary = Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'files'>

/** The v1 subset of `GitDiff`: the two sides and whether either is binary. */
export type GitDiffPair = Pick<GitDiff, 'path' | 'staged' | 'original' | 'modified' | 'binary'>

/** A file changed between two commits (branch compare, a commit's files). */
export type GitChange = {
  path: string
  oldPath?: string
  status: GitChangeStatus
  /** Null for binary files. */
  added: number | null
  removed: number | null
  binary: boolean
}

/** Committed changes on the branch since its merge base with the base ref. Not-ready statuses carry `message`. */
export type GitCompare = {
  status: 'ready' | 'invalid-base' | 'unborn-head' | 'no-merge-base'
  base: string | null
  baseSource: 'worktree' | 'project' | 'detected' | 'upstream' | 'param' | null
  message: string | null
  baseOid: string | null
  headOid: string | null
  mergeBase: string | null
  ahead: number
  behind: number
  entries: GitChange[]
  added: number
  removed: number
}

export type GitCommit = {
  oid: string
  parents: string[]
  author: string
  email: string
  /** Milliseconds since the epoch. */
  authoredAt: number
  committedAt: number
  subject: string
  body: string
  /** Shortened decorations, e.g. `HEAD -> zoe/feat`, `origin/main`, `tag: v1`. */
  refs: string[]
}

export type GitHistory = { commits: GitCommit[]; hasMore: boolean }

export type GitDiffSource = 'unstaged' | 'staged' | 'branch' | 'commit'

/**
 * Both sides of a file diff. For `staged: true`, original is HEAD and modified is the index;
 * otherwise original is the index and modified is the working tree. Missing sides are ''.
 * `kind: 'image'` sides hold base64 with `binary` true; a `tooLarge` text diff has empty bodies.
 */
export type GitDiff = {
  path: string
  staged: boolean
  original: string
  modified: string
  binary: boolean
  source: GitDiffSource
  oldPath?: string
  kind: 'text' | 'binary' | 'image'
  mime?: string
  /** sha-256 hex of the working file's bytes for unstaged diffs; null when the file is missing. */
  modifiedHash?: string | null
  modifiedDeleted?: boolean
  tooLarge?: { originalLines: number; modifiedLines: number; characters: number; reason: 'lines' | 'characters' }
}

export type AskPreview = { format: 'markdown' | 'html'; content: string }

export type AskOption = { value: string; label: string; description?: string; preview?: AskPreview }

type AskQuestionCommon = { id: string; question: string; header?: string; required?: boolean }

export type AskQuestion =
  | (AskQuestionCommon & { type: 'select'; options: AskOption[]; default?: string })
  | (AskQuestionCommon & { type: 'multiselect'; options: AskOption[]; default?: string[] })
  | (AskQuestionCommon & { type: 'text'; multiline?: boolean; pattern?: string; format?: 'email' | 'url'; default?: string })
  | (AskQuestionCommon & { type: 'number'; integer?: boolean; min?: number; max?: number; default?: number })
  /** `default` is a calendar date, `YYYY-MM-DD`. */
  | (AskQuestionCommon & { type: 'date'; default?: string })
  | (AskQuestionCommon & { type: 'confirm'; default?: boolean })

export type AskSpec = { title?: string; questions: AskQuestion[] }

/** One question's answer; `source: 'default'` only ever comes from a deadline. */
export type AskAnswer =
  | { value: string; label?: string; note?: string; source: 'option' | 'other' | 'input' | 'default' }
  | { values: string[]; labels: string[]; other?: string; source: 'options' | 'default' }
  | { value: number; source: 'input' | 'default' }
  | { value: boolean; source: 'input' | 'default' }

export type AskStatus = 'pending' | 'answered' | 'partial' | 'declined' | 'timed_out'

export type AskEnvelope = {
  status: AskStatus
  askId: string
  answers: Record<string, AskAnswer>
  skipped: string[]
  /** One line per answered question, `<header or question>: <value>`; empty while pending and when declined. */
  summary: string
}

/** What `quirky ask` prints when a `--chunk-ms` chunk ends before the ask does. */
export type AskPendingEnvelope = { status: 'pending'; askId: string; instruction: string }

/** One question's work in progress, as the window saves it. */
export type AskPartialQuestionDraft = { selected?: string[]; other?: string; note?: string; draft?: string; confirm?: boolean }

/** Drafts by question ID. */
export type AskPartial = Record<string, AskPartialQuestionDraft>

export type Ask = {
  id: string
  spec: AskSpec
  sessionId: string | null
  worktreeId: string | null
  createdAt: number
  envelope: AskEnvelope
  /** The store-wide change counter's value at this ask's latest change. */
  seq: number
  /** Pending behind an earlier pending ask of the same session. */
  queued: boolean
  partial: AskPartial
  /** Epoch ms after which the ask times out, or null for no deadline. */
  expiresAt: number | null
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
