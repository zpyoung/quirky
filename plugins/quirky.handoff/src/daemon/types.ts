import type { GitDiff, GitStatus, OwnerHostIdentity, OwnerSessionHostRef, OwnerSessionWorkspaceRef } from '@quirky/protocol'
import type { SecretHit, Template, Warning } from '../core'
import type { ProbeResult } from './probe'

export type Relationship = 'continues' | 'reviews' | 'branches-from'

export type ArchivedSource = {
  agent: string
  providerSessionId?: string
  transcriptPath?: string
  title?: string
  worktree?: string
  cwd?: string
  prompt?: string
  lastMessage?: string
  owner?: OwnerSessionHostRef
  vaultId?: string
}

/** A live terminal session by id, or an archived source with optional owner-local Vault identity. */
export type SourceRef = { session: string } | { archived: ArchivedSource }

export type Target = { worktree: string } | { remote: OwnerSessionWorkspaceRef } | { create: { name: string; base?: string } }

export type Include = { repoState: boolean; diffBodies: boolean; openEditorTabs: boolean }

export type Controls = {
  target?: Target
  agent?: string
  relationship: Relationship
  context: 'focused' | 'full'
  include: Include
  templateId: string | null
  note: string
}

/** What a closed dialog leaves behind: its controls and, when the preview was edited, the edited text. */
export type Draft = {
  controls: Controls
  preview: { text: string; stale: string[] } | null
}

export type SourceInfo = {
  key: string
  session: string | null
  agent: string
  title: string | null
  cwd: string | null
  worktreeId: string | null
  providerSessionId: string | null
  transcriptPath: string | null
  prompt: string | null
  lastMessage: string | null
  live: boolean
  /** The source's agent reports a turn in progress. */
  busy: boolean
}

export type Candidate = {
  id: string
  name: string
  path: string
  kind: 'git' | 'folder'
  branch: string | null
  remote?: OwnerSessionWorkspaceRef
  hostName?: string
  connected?: boolean
}

export type Prefs = {
  lastAgent: string | null
  includeToggles: Include
  lastTemplateId: string | null
}

export type Catalog = { templates: Template[]; custom: boolean }

export type TemplateOp = {
  op: 'add' | 'update' | 'remove' | 'reset'
  template?: { id?: string; name: string; body: string }
  id?: string
}

export type RepoStateResult = { status: GitStatus; diffs?: GitDiff[] }

export type Preview = {
  brief: string
  notice: string
  characters: number
  tokens: number
  warnings: Warning[]
  secrets: SecretHit[]
  probe: ProbeResult
  repoState: 'ok' | 'failed' | 'off' | 'none'
  busy: boolean
  live: boolean
  contextAvailable: boolean
}

/** How a brief's delivery ended; `resent` means the automatic retry landed. */
export type Outcome = 'delivered' | 'resent' | 'retry-failed' | 'unobservable'

export type LineageEnd = {
  session: string | null
  agent: string | null
  providerSessionId: string | null
  transcriptPath: string | null
  worktreeId: string | null
  title: string | null
  /** The authenticated execution host; absent on historical local records. */
  executionHost?: OwnerHostIdentity
  /** Producer filesystem instance, when the end names a workspace. */
  instanceId?: string | null
}

/** One handoff: the session it continued from, the session it started and how they relate. */
export type LineageRecord = {
  id: string
  createdAt: number
  relationship: Relationship
  parent: LineageEnd
  child: LineageEnd & { tab: string | null }
}
