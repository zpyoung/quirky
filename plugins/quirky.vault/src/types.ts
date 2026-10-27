// Shared JSON contracts for the vault worker, daemon and window. No runtime imports.
export type VaultRole = 'user' | 'assistant' | 'tool' | 'system'
export type Presence = 'present' | 'missing' | 'unverifiable'
export type VaultMessage = { role: VaultRole; text: string; timestamp: number | null }
export type VaultSession = {
  id: string
  agent: string
  sessionId: string
  title: string
  cwd: string | null
  branch: string | null
  model: string | null
  filePath: string
  codexHome: string | null
  createdAt: number
  updatedAt: number
  modifiedAt: number
  messageCount: number
  totalTokens: number | null
  previewMessages: VaultMessage[]
  firstUserPrompt?: string
  lastUserPrompt?: string
  queuedMessageCount: number
  subagentTranscriptCount: number
  subagent?: boolean
  presence: Presence
}
export type ScanIssue = { root?: string; filePath?: string; reason: string; kind: 'error' | 'notice'; agent?: string }
export type ScanProgress = { phase: 'discovering' | 'reading' | 'complete'; scannedFiles: number; parsedFiles: number; current?: string }
export type SourceRoot = { agent: string; path: string; presence: Presence; reason?: string }
export type SourceCandidate = {
  agent: string
  filePath: string
  root: string
  signature: string
  mtimeMs: number
  size: number
  codexHome: string | null
  sessionId?: string
  sidecars?: string[]
  metadata?: Record<string, unknown>
}
export type Discovery = { candidates: SourceCandidate[]; roots: SourceRoot[]; issues: ScanIssue[] }
export type ListRequest = {
  agents?: string[]
  scopePaths?: string[]
  limit?: number
  unlimited?: boolean
  force?: boolean
  requestToken?: string
  sort?: 'updated' | 'created'
  hideEmpty?: boolean
}
export type ListResult = { sessions: VaultSession[]; issues: ScanIssue[]; scannedFiles: number; scannedAt: number; hasMore: boolean; total: number }
export type ScannerOptions = {
  sourceHome: string
  dataDir: string
  env: Record<string, string | undefined>
  progress?: (value: ScanProgress) => void
}
export type DeleteTarget = { path: string; kind: 'file' | 'directory' }
export type VaultScanner = {
  discover(signal?: AbortSignal): Promise<Discovery>
  parse(candidate: SourceCandidate, onMessage?: (message: VaultMessage) => void, signal?: AbortSignal): Promise<VaultSession | null>
  list(request: ListRequest, signal?: AbortSignal): Promise<ListResult>
  get(id: string): Promise<VaultSession | null>
  firstPrompt(id: string): Promise<string | null>
  subagents(id: string): Promise<VaultSession[]>
  deleteTargets(id: string): Promise<DeleteTarget[]>
  invalidate(id: string): void
  close(): void | Promise<void>
}
export type Within = { worktree?: string; repo?: string }
export type PublicListRequest = ListRequest & { host?: string; within?: Within }
export type HostOutcome = { hostId: string; label: string; kind: 'ok' | 'unavailable' | 'error'; reason?: string; scannedFiles: number; scannedAt: number | null }
export type HostedSession = Omit<VaultSession, 'id' | 'filePath' | 'codexHome'> & {
  id: string
  sourceId: string
  hostId: string
  source: { presence: Presence; filePath?: string; codexHome?: string }
}
export type PublicListResult = {
  sessions: HostedSession[]
  issues: (ScanIssue & { hostId: string })[]
  hosts: HostOutcome[]
  scannedFiles: number
  scannedAt: number
  hasMore: boolean
  total: number
}
export type SearchFilters = { agents?: string[]; scopePaths?: string[]; since?: string; sort?: 'relevance' | 'newest' }
export type SearchRequest = {
  query: string
  scope?: 'conversation' | 'all'
  freshness?: 'indexed' | 'wait-until-current'
  limit?: number
  cursor?: string
  filters?: SearchFilters
  within?: Within
  debug?: boolean
  host?: string
}
export type SearchHit = {
  id: string
  sourceId?: string
  hostId?: string
  agent: string
  sessionId: string
  title: string
  cwd: string | null
  branch: string | null
  updatedAt: number
  messageCount: number
  score: number
  duplicateCount: number
  source: { presence: Presence; filePath?: string; codexHome?: string }
  evidence: { snippet: string; role: VaultRole; timestamp: number | null } | null
  resumeCommand?: string
}
export type SearchResults = {
  kind: 'results'
  hits: SearchHit[]
  page: { cursor: string | null; hasMore: boolean }
  generation: number
  truncated: { candidates: boolean; snippets: boolean; query: boolean; freshness: boolean }
  durationMs: number
  repairedTerms?: Record<string, string>
  hosts?: HostOutcome[]
  debug?: Record<string, unknown>
}
export type SearchResponse = SearchResults | { kind: 'stale-cursor'; hosts?: HostOutcome[] } | { kind: 'malformed-cursor'; hosts?: HostOutcome[] } | {
  kind: 'unavailable'
  reason: 'disabled' | 'not-ready' | 'no-service' | 'scope-unknown' | 'unsupported-agent'
  hosts?: HostOutcome[]
}
export type SearchStatus = {
  enabled: boolean
  phase: 'closed' | 'idle' | 'indexing' | 'current' | 'degraded'
  filesIndexed: number
  filesDue: number
  filesFailed: number
  messagesIndexed: number
  degradedRoots: { root?: string; reason: string }[]
  lastReconcileAt: number | null
  lastSweepCompletedAt: number | null
  generation: number
  supportedAgents: string[]
  sessionsByAgent: Record<string, number>
}
export type SearchPolicy = { enabled: boolean; historyDays: number | null }
export type SearchOptions = { dataDir: string; scanner: VaultScanner; progress?: (status: SearchStatus) => void }
export type VaultSearch = {
  apply(policy: SearchPolicy): Promise<void>
  search(request: SearchRequest): Promise<SearchResponse>
  status(): SearchStatus
  reconcile(options?: { full?: boolean; signal?: AbortSignal }): Promise<void>
  clear(): Promise<void>
  remove(id: string): void | Promise<void>
  close(): void | Promise<void>
}
export type ViewState = {
  disabledAgents: string[]
  browseSort: 'updated' | 'created'
  searchSort: 'relevance' | 'newest'
  group: 'project' | 'folder' | 'agent'
  hideEmptySessions: boolean
  sessionLimit: 250 | 500 | 1000 | null
  host: string
  scope: 'workspace' | 'project' | 'all'
  query: string
  selectedId: string | null
  expandedIds: string[]
  focusedSearch: boolean
}
export type WorkerRequest = { id: number; op: string; args: Record<string, unknown> }
export type WorkerResponse = { id: number; result?: unknown; error?: { kind: string; message: string } }
export type WorkerEvent = { event: 'scanProgress' | 'searchStatus'; data: ScanProgress | SearchStatus }
