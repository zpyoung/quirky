import type { GitDiff, GitStatus } from '@quirky/protocol'

export type Template = { id: string; name: string; body: string }

export type WarningCode =
  | 'no-transcript-context'
  | 'diff-truncated'
  | 'no-context'
  | 'repo-state-failed'
  | 'transcript-unreachable'
  | 'transcript-unverifiable'
  | 'full-unavailable'
  | 'no-live-pane'
  | 'secrets'

export type Warning = { code: WarningCode; message: string }

export type SecretRule =
  | 'aws-access-key-id'
  | 'github-token'
  | 'stripe-key'
  | 'slack-token'
  | 'private-key-header'
  | 'env-assignment'

/** A likely secret at `[start, end)` of the scanned text; `excerpt` is safe to show. */
export type SecretHit = { rule: SecretRule; start: number; end: number; excerpt: string }

export type SourceFacts = {
  agent: string
  sessionId: string | null
  name: string | null
  cwd: string | null
  prompt: string | null
  lastMessage: string | null
}

export type ComposeInput = {
  source: SourceFacts
  /** Set only when the transcript is usable on the target; it then wins over `capture`. */
  transcriptPath: string | null
  /** The bounded terminal capture, already cleaned by `boundCapture`. */
  capture: string | null
  context: 'focused' | 'full'
  /** Null when repo state is off, unavailable or failed. */
  repoState: { status: GitStatus; diffs?: GitDiff[] } | null
  editorTabs: string[] | null
  template: Template | null
  note: string
}

export type TemplateVars = {
  gitStatus?: string | null
  changedPaths?: string | null
  openEditorTabs?: string | null
}
