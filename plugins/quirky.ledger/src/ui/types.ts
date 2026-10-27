
export type LedgerType = 'bug' | 'deferred' | 'test-gap' | 'proposal' | 'decision'
export type LedgerState = 'open' | 'resolved' | 'archived'
export type LedgerOwner = { tier: 'project' | 'group'; id: string }
export type LedgerTarget = {
  workspaceId?: string
  owner?: LedgerOwner
  ledgerId?: string
  group?: boolean
  groupSelector?: string
}
export type LedgerLocation = {
  path: string
  line?: number
  base: { kind: 'project' | 'workspace'; id: string; host?: string }
  external?: boolean
  host?: string
}
export type LedgerFilters = {
  type?: LedgerType
  state?: LedgerState
  reviewed?: boolean
  stale?: boolean
  workspaceId?: string
  branch?: string
  search?: string
  sort?: 'activity' | 'sequence' | 'title'
}
export type LedgerSelection = { id: string; revision: number }
export type LedgerActor = {
  kind: string
  model?: string | null
  providerSessionId?: string | null
  tool?: string | null
  initiator?: LedgerActor
}
export type LedgerSnapshot = { content: Record<string, unknown>; state: LedgerState; reviewed: boolean }
export type LedgerHistory = {
  revision: number
  at: string
  actor: LedgerActor
  before: LedgerSnapshot
  after: LedgerSnapshot
  changedFields: string[]
}
export type LedgerOrigin = {
  workspaceId?: string
  owner?: LedgerOwner
  branch?: string
  host?: string
  revision?: string
  observedAt?: string
}
export type LedgerEntry = {
  id: string
  type: LedgerType
  sequence: number
  revision: number
  content: Record<string, unknown>
  state: LedgerState
  reviewed: boolean
  origin: LedgerOrigin
  createdAt: string
  updatedAt: string
  history: LedgerHistory[]
  latestContentActor?: LedgerActor | null
}
export type LedgerSummary = {
  ledgerId: string
  tier: 'project' | 'group'
  owner: LedgerOwner | null
  formerOwner?: LedgerOwner | null
  revision: number
  entryCount: number
  nextSequence: number
  staleAfterDays: number
  name: string
  ownerName?: string
  repoId?: string
  ownerPath?: string
}
export type LedgerEvidence = {
  available: boolean
  workspaceId?: string
  observedRevision?: string
  observedAt?: string
  baselineRevision?: string
  fileExists?: boolean
  note?: string
}
export type LedgerCandidate = { entry: LedgerEntry; stale: boolean; reason: 'reviewed' | 'unreviewed'; evidence?: LedgerEvidence }
export type LedgerOwnerOption = { tier: 'project' | 'group'; id: string; name: string; path?: string; repoId?: string; ledgerId?: string }
export type LedgerResponse = {
  schemaVersion: 1
  runtime: { runtimeId: string; profileId: string }
  ledger: LedgerSummary | null
  entry?: LedgerEntry
  entries?: LedgerEntry[]
  ledgers?: LedgerSummary[]
  owners?: LedgerOwnerOption[]
  matches?: LedgerEntry[]
  candidates?: LedgerCandidate[]
  removalPreview?: { ledgerId: string; revision: number; entryCount: number }[]
}
export type LedgerOperation =
  | 'file'
  | 'list'
  | 'show'
  | 'edit'
  | 'state'
  | 'review'
  | 'revert'
  | 'import'
  | 'catalog'
  | 'approve'
  | 'bulk-state'
  | 'delete-entries'
  | 'delete-ledger'
  | 'attach'
  | 'settings'
  | 'removal-preview'
export type LedgerRequest = {
  operation: LedgerOperation
  target?: LedgerTarget
  type?: LedgerType
  content?: Record<string, unknown>
  id?: string
  ifRevision?: number
  toRevision?: number
  state?: LedgerState
  filters?: LedgerFilters
  selections?: LedgerSelection[]
  ifLedgerRevision?: number
  attachTo?: LedgerOwner
  confirmed?: boolean
  staleAfterDays?: number
  removal?: { repoIds?: string[]; groupIds?: string[]; expectedLedgers?: { ledgerId: string; revision: number }[] }
}
export type LedgerControl = {
  action: 'scope' | 'filters' | 'sort' | 'selection' | 'detail' | 'new' | 'edit' | 'triage' | 'settings'
  target?: LedgerTarget
  id?: string
  scope?: 'worktree' | 'project' | 'group'
  filters?: LedgerFilters
  sort?: 'activity' | 'sequence' | 'title'
  selections?: LedgerSelection[]
}

