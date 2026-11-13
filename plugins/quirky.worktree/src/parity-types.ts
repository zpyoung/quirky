/** Arbitrary URLs are references, not trusted provider data or launch commands. */
export type WorktreeReference = { id: string; url: string; label: string; createdAt: number }
export type ExternalVisibility = 'show' | 'hide' | 'inherit'
export type WorktreeStatusDefinition = { id: string; label: string; color: string; icon?: string }
export type WorktreeProjectIdentity = {
  displayName: string | null
  icon: string | null
  color: string | null
  trackerProject: string | null
}

/** Unknown remote/liveness evidence blocks destructive cleanup rather than proving inactivity. */
export type WorktreeCleanupContext = {
  archivedAt: number | null
  volatile: boolean | null
  remoteConnected: boolean | null
}
export type ReferenceItem = { id: string; host: string; project: string; sigil: '#' | '!'; number: number }
export type ReferenceSearchQuery =
  | { kind: 'url'; url: string; item: string | null }
  | { kind: 'key'; key: string }
export type ReferenceSearchLink = {
  source: 'reference' | 'linkedPR' | 'linkedIssue'
  referenceId: string | null
  url: string
  label: string
  item: string | null
}
export type ReferenceSessionLiveness = 'live' | 'unverifiable' | 'exited'
export type ReferenceSearchSession = {
  id: string
  name: string | null
  title: string
  agent: string
  kind: string
  status: string
  liveness: ReferenceSessionLiveness
  linked: boolean
  lastActivityAt: number
}
export type ReferenceSearchMatch = {
  worktree: {
    id: string
    repoId: string
    name: string
    path: string | null
    kind: string
    archivedAt: number | null
    lastActivityAt: number
    state: 'present' | 'stale'
    staleReason: 'folder-missing' | 'folder-replaced' | 'project-unregistered' | null
  }
  links: ReferenceSearchLink[]
  linkTotal: number
  sessions: ReferenceSearchSession[] | null
  sessionTotal: number | null
}
export type ReferenceSearchEvidence = {
  sessions: 'listed' | 'unavailable'
  sessionsReason: string | null
  processes: 'listed' | 'unavailable'
  processesReason: string | null
  skippedSessions: number
}
export type ReferenceSearchResult = {
  query: ReferenceSearchQuery
  items: ReferenceItem[]
  ambiguous: boolean
  matches: ReferenceSearchMatch[]
  total: number
  truncated: boolean
  archivedOmitted: number
  stale: number
  evidence: ReferenceSearchEvidence
}
