export type LedgerType = 'bug' | 'deferred' | 'test-gap' | 'proposal' | 'decision'
export type LedgerState = 'open' | 'resolved' | 'archived'
export type LedgerTier = 'project' | 'group'
export type LedgerOwner = { tier: LedgerTier; id: string }

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
export type LedgerRemoval = {
  repoIds?: string[]
  groupIds?: string[]
  expectedLedgers?: { ledgerId: string; revision: number }[]
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
  removal?: LedgerRemoval
}

export type LedgerActor = {
  kind: 'human' | 'agent' | 'import' | 'unknown'
  model?: string | null
  providerSessionId?: string | null
  tool?: string
  initiator?: LedgerActor
}

export type LedgerSnapshot = { content: Record<string, unknown>; state: LedgerState; reviewed: boolean }

export type LedgerChange = {
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
  history: LedgerChange[]
  latestContentActor: LedgerActor
}

export type LedgerMetadataChange = {
  revision: number
  at: string
  actor: LedgerActor
  action: 'detached' | 'reattached' | 'attached' | 'settings'
  before: Record<string, unknown>
  after: Record<string, unknown>
  changedFields: string[]
}

export type LedgerSummary = {
  ledgerId: string
  tier: LedgerTier
  owner: LedgerOwner | null
  formerOwner: LedgerOwner | null
  revision: number
  entryCount: number
  nextSequence: number
  staleAfterDays: number
  name: string
  ownerName?: string
  repoId?: string
  ownerPath?: string
  sourceEquivalences?: string[][]
  metadataHistory?: LedgerMetadataChange[]
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

export type LedgerCandidate = {
  entry: LedgerEntry
  stale: boolean
  reason: 'reviewed' | 'unreviewed'
  evidence: LedgerEvidence
}

export type ImportRecord = {
  type: LedgerType
  content: Record<string, unknown>
  sourcePath: string
  sourceBase: LedgerLocation['base']
  legacyId: string
}

export type ImportSkip = { anchor?: string; reason: string; sourcePath?: string }
export type ImportResult = { created: string[]; updated: string[]; alreadyPresent: string[]; skipped: ImportSkip[] }

export type LedgerResponse = {
  schemaVersion: 1
  runtime: { runtimeId: string; profileId: string }
  ledger: LedgerSummary | null
  entry?: LedgerEntry
  entries?: LedgerEntry[]
  ledgers?: LedgerSummary[]
  matches?: LedgerEntry[]
  candidates?: LedgerCandidate[]
  importResult?: ImportResult
  removalPreview?: { ledgerId: string; revision: number; entryCount: number }[]
  owners?: { tier: LedgerTier; id: string; name: string; path?: string; repoId?: string; ledgerId?: string }[]
}
