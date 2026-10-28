/** Caller-relative workspace provenance. Null means the producer has no trustworthy evidence. */
export type WorkspaceOriginView = {
  worktreeId: string
  automation: boolean | null
  otherClient: boolean | null
}

/** Durable workspace sleep state; partial failures retain every recovery record. */
export type WorkspaceSleepState = {
  worktreeId: string
  state: 'awake' | 'sleeping' | 'asleep' | 'waking' | 'partial'
  updatedAt: number
  sessions: Array<{
    sessionId: string
    state: 'pending' | 'stopped' | 'restored'
    error: string | null
  }>
}

/** Nonterminal phone tabs use the actual public UI tab identity, never a terminal session alias. */
export type MobileWorkspaceTab = {
  tabId: string
  worktreeId: string
  kind: 'markdown' | 'browser'
  title: string
  dirty: boolean
}

/** A bounded text projection; no absolute path, resource capability, environment or credentials. */
export type MobileMarkdownDocument = {
  tabId: string
  worktreeId: string
  title: string
  relativePath: string
  text: string
  revision: number
  dirty: boolean
  readOnly: boolean
}

/** Latest-only JPEG Watch frame; data is base64 capped at 512 KiB before the page bridge. */
export type MobileBrowserFrame = {
  tabId: string
  worktreeId: string
  watchId: string
  sequence: number
  width: number
  height: number
  mimeType: 'image/jpeg'
  data: string
}
