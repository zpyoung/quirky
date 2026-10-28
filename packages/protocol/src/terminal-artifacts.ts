/** A capability minted only from a path found in authoritative local terminal output. */
export type TerminalArtifact = {
  source: 'terminalArtifact'
  artifactId: string
  grant: string
  expiresAt: number
  worktree: string
  session: string
  name: string
  path: string
}

export type TerminalArtifactRequest = {
  action: 'list' | 'preview' | 'refresh' | 'save'
  worktree: string
  session: string
  artifactId?: string
  grant?: string
  expectedRevision?: string
  content?: string
}

export type TerminalArtifactRefusal = {
  kind: 'refused'
  reason: 'grant-expired' | 'grant-invalid' | 'source-unavailable' | 'file-changed' | 'unsupported' | 'too-large' | 'read-only'
  guidance: string
}

export type TerminalArtifactPreview = {
  kind: 'preview'
  artifact: TerminalArtifact
  format: 'text' | 'markdown' | 'image' | 'binary'
  content: string
  /** Base64 only for a safe, bounded raster image; absent for text and other binary files. */
  image?: { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
  bytes: number
  truncated: boolean
  writable: boolean
  revision: string
}

export type TerminalArtifactResult =
  | { kind: 'listed'; artifacts: TerminalArtifact[]; limited: boolean }
  | TerminalArtifactPreview
  | { kind: 'refreshed'; artifact: TerminalArtifact }
  | { kind: 'saved'; artifact: TerminalArtifact; revision: string }
  | TerminalArtifactRefusal

/** Sized below the phone's per-string request ceiling. Larger previews remain read-only. */
export const TERMINAL_ARTIFACT_TEXT_BYTES = 48 * 1024
