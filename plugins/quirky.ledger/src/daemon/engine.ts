import { randomUUID } from 'node:crypto'
import { RpcErrorCode, type PluginCaller, type PluginContext, type PluginStore, type Worktree } from '@quirky/protocol'
import type {
  ImportRecord,
  ImportResult,
  ImportSkip,
  LedgerActor,
  LedgerCandidate,
  LedgerEntry,
  LedgerEvidence,
  LedgerFilters,
  LedgerLocation,
  LedgerMetadataChange,
  LedgerOperation,
  LedgerOwner,
  LedgerRequest,
  LedgerResponse,
  LedgerSelection,
  LedgerSnapshot,
  LedgerState,
  LedgerSummary,
  LedgerTarget,
  LedgerType
} from '../types'
import { fileExistsSafely, isRecord, mergeAndValidateContent, stableStringify, validateContent, editableFieldsOf, locationFieldOf } from './content'
import { readLegacyImports } from './imports'
import { canonicalRepositoryIdentity, liveOwners, ownerFor, readOwnerCatalog, resolveWorkspace, selectWorkspaceOwner, validateTargetSelectors, workspaceFor, type LiveOwner, type OwnerCatalog, type WorkspaceContext } from './owners'
import { openStore, parseJson, stringify, validateStore, type AnchorRow, type EntryRow, type HistoryRow, type LedgerRow } from './store'

const OPERATIONS: readonly LedgerOperation[] = [
  'file', 'list', 'show', 'edit', 'state', 'review', 'revert', 'import', 'catalog', 'approve', 'bulk-state', 'delete-entries', 'delete-ledger', 'attach', 'settings', 'removal-preview'
]
const DESTRUCTIVE = new Set<LedgerOperation>(['bulk-state', 'delete-entries', 'delete-ledger', 'attach'])
const MAX_SELECTIONS = 10_000
const DAY = 24 * 60 * 60 * 1000
const SNAPSHOT_EMPTY: LedgerSnapshot = { content: {}, state: 'open', reviewed: false }

type Resolved = { catalog: OwnerCatalog; workspace?: WorkspaceContext; owner?: LiveOwner; ledger: LedgerRow | null }
type Result = { response: LedgerResponse; changed?: boolean }
type Fail = (domain: string, message: string, data?: Record<string, unknown>) => never


const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isNotFound = (error: unknown): boolean => errorCode(error) === RpcErrorCode.NotFound
const isMethodNotFound = (error: unknown): boolean => errorCode(error) === RpcErrorCode.MethodNotFound

function isoNow(): string {
  return new Date().toISOString()
}

function asOwner(row: LedgerRow): LedgerOwner | null {
  return row.owner_id === null ? null : { tier: row.tier, id: row.owner_id }
}

function asFormerOwner(row: LedgerRow): LedgerOwner | null {
  return row.former_id === null || row.former_tier === null ? null : { tier: row.former_tier, id: row.former_id }
}

function snapshotOf(entry: Pick<EntryRow, 'content' | 'state' | 'reviewed'>): LedgerSnapshot {
  return {
    content: parseJson<Record<string, unknown>>(entry.content, 'entry content'),
    state: entry.state as LedgerState,
    reviewed: entry.reviewed === 1
  }
}

function unknownActor(): LedgerActor {
  return { kind: 'unknown' }
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLocaleLowerCase() : ''
}

function isTrueUnknown(actor: LedgerActor): boolean {
  return actor.kind === 'unknown' || (actor.kind === 'import' && actor.initiator?.kind === 'unknown')
}

function words(title: unknown): Set<string> {
  if (typeof title !== 'string') return new Set()
  return new Set((title.normalize('NFKD').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common += 1
  return common / (left.size + right.size - common)
}


function expectedRevision(value: unknown, label: string, fail: Fail, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail('invalid-request', `${label} must be a ${allowZero ? 'nonnegative' : 'positive'} safe integer`)
  return value
}

export class LedgerEngine {
  readonly runtimeId = randomUUID()
  readonly profileId: string
  private readonly context: PluginContext
  private readonly store: PluginStore | null
  private readonly storeFailure: string | null
  private catalog: OwnerCatalog | null = null
  private generation = 0
  private reconciledGeneration = -1
  private unavailable = false
  private reconciliation: Promise<void> | null = null

  constructor(context: PluginContext) {
    this.context = context
    let store: PluginStore | null = null
    let failure: string | null = null
    let profileId = 'unavailable'
    try {
      store = openStore(context)
      validateStore(store)
      let stored = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'profile-id')?.value
      if (!stored) {
        stored = randomUUID()
        store.run('INSERT INTO meta (key, value) VALUES (?, ?)', 'profile-id', stored)
      }
      if (!/^[0-9a-f-]{36}$/i.test(stored)) throw new Error('invalid plugin profile identifier')
      profileId = stored
    } catch (error) {
      failure = errorMessage(error)
      context.log(`ledger store is unavailable: ${failure}`)
    }
    this.store = store
    this.storeFailure = failure
    this.profileId = profileId
  }

  async start(): Promise<void> {
    this.context.subscribe((event) => {
      if (event.type !== 'quirky.repo/changed' && event.type !== 'quirky.worktree/changed') return
      this.generation += 1
      this.unavailable = true
      const task = this.performReconciliation(this.generation)
      this.reconciliation = task
      void task.catch((error) => this.context.log(`ledger owner reconciliation failed: ${errorMessage(error)}`))
    })
    if (this.store && !this.storeFailure) {
      try {
        await this.ensureCatalog()
      } catch (error) {
        this.context.log(`ledger owner catalog is unavailable: ${errorMessage(error)}`)
      }
    }
  }

  request(request: LedgerRequest, caller: PluginCaller): Promise<LedgerResponse> {
    return this.execute(request, caller).then(({ response, changed }) => {
      if (changed) this.context.emit('changed', { ...(response.ledger ? { ledgerId: response.ledger.ledgerId } : {}) })
      return response
    })
  }

  async describe(request: LedgerRequest, caller: PluginCaller): Promise<string | null> {
    this.ensureHealthy()
    if (!OPERATIONS.includes(request.operation)) this.fail('invalid-request', 'unknown ledger operation')
    if (!DESTRUCTIVE.has(request.operation)) return null
    await this.ensureCatalog()
    const resolved = await this.resolveTarget(request, caller)
    if (!resolved.ledger) this.fail('not-found', 'ledger not found')
    const ledger = resolved.ledger
    if (request.operation === 'delete-ledger') {
      const expected = expectedRevision(request.ifLedgerRevision, 'ifLedgerRevision', this.fail.bind(this), true)
      if (expected !== ledger.revision) this.fail('conflict', 'Ledger revision is stale', { currentRevision: ledger.revision })
      const count = this.countEntries(ledger.ledger_id)
      return `Permanently delete ledger ${ledger.ledger_id} at revision ${ledger.revision}, including ${count} entries and all history.`
    }
    if (request.operation === 'attach') {
      const expected = expectedRevision(request.ifLedgerRevision, 'ifLedgerRevision', this.fail.bind(this), true)
      if (expected !== ledger.revision) this.fail('conflict', 'Ledger revision is stale', { currentRevision: ledger.revision })
      if (ledger.owner_id !== null) this.fail('attachment-refused', 'only a detached ledger can be attached')
      const attachTo = this.validateAttachTo(request.attachTo, ledger, resolved.catalog)
      if (this.store!.get('SELECT 1 FROM ledgers WHERE tier = ? AND owner_id = ?', attachTo.tier, attachTo.id)) this.fail('attachment-refused', 'target owner already has a ledger')
      const former = asFormerOwner(ledger)
      if (!former) this.fail('attachment-refused', 'detached ledger has no former owner metadata')
      if (ledger.tier === 'project' && former.id !== attachTo.id) {
        const equivalences = this.addEquivalence(parseJson<string[][]>(ledger.source_equivalences, 'source equivalences'), former.id, attachTo.id)
        if (this.hasCanonicalAnchorCollision(ledger.ledger_id, equivalences)) this.fail('attachment-refused', 'attachment would collapse import anchors')
      }
      return `Attach detached ${ledger.tier} ledger ${ledger.ledger_id} at revision ${ledger.revision} to ${attachTo.tier} ${attachTo.id}.`
    }
    const selections = this.validateSelections(request.selections)
    const expectedRows = this.checkSelectionsCurrent(selections, ledger.ledger_id)
    if (request.operation === 'bulk-state') {
      this.validateState(request.state)
      return `Set ledger ${ledger.ledger_id} to ${request.state} for ${expectedRows.map((entry) => `${entry.id} r${entry.revision} “${String(parseJson<Record<string, unknown>>(entry.content, 'entry content').title ?? '')}”`).join('; ')}.`
    }
    return `Delete from ledger ${ledger.ledger_id}: ${expectedRows.map((entry) => `${entry.id} r${entry.revision} “${String(parseJson<Record<string, unknown>>(entry.content, 'entry content').title ?? '')}”`).join('; ')}.`
  }

  private fail(domain: string, message: string, data: Record<string, unknown> = {}): never {
    const kind = domain === 'not-found' || domain.endsWith('-missing') || domain === 'owner-missing'
      ? 'not-found'
      : domain === 'conflict' || domain === 'group-ambiguous' || domain === 'owner-ambiguous' || domain === 'attachment-refused' || domain === 'catalog-unavailable'
        ? 'conflict'
        : 'invalid-params'
    const error = this.context.error(kind, message)
    Object.assign(error, { data: { ...data, kind: domain } })
    throw error
  }

  private ensureHealthy(): asserts this is this & { store: PluginStore } {
    if (!this.store || this.storeFailure) this.fail('incompatible-store', `Ledger service is unavailable: ${this.storeFailure ?? 'store unavailable'}`)
  }

  private async ensureCatalog(): Promise<OwnerCatalog> {
    this.ensureHealthy()
    for (;;) {
      if (this.reconciliation) {
        try {
          await this.reconciliation
        } catch {
          // The latched error is reported below; a later event/request can retry reconciliation.
        }
      }
      if (this.reconciledGeneration !== this.generation || this.unavailable || !this.catalog) {
        const task = this.performReconciliation(this.generation)
        this.reconciliation = task
        try {
          await task
        } catch {
          this.unavailable = true
        }
      }
      if (this.reconciledGeneration === this.generation && !this.unavailable && this.catalog) return this.catalog
      if (!this.reconciliation) this.fail('catalog-unavailable', 'Owner catalog could not be reconciled')
      if (this.reconciliation) {
        try {
          await this.reconciliation
        } catch {
          this.fail('catalog-unavailable', 'Owner catalog could not be reconciled')
        }
      }
    }
  }

  private async performReconciliation(generation: number): Promise<void> {
    this.ensureHealthy()
    this.unavailable = true
    let catalog: OwnerCatalog
    try {
      catalog = await readOwnerCatalog(this.context)
    } catch (error) {
      this.unavailable = true
      throw error
    }
    const identities = new Map<string, string>()
    const projectRepos = catalog.repos.filter((repo) => repo.kind === 'git')
    for (const repo of projectRepos) {
      const saved = this.store.get<{ identity_key: string }>('SELECT identity_key FROM repo_identities WHERE repo_id = ?', repo.id)?.identity_key
      if (saved) identities.set(repo.id, saved)
      else {
        const attached = this.store.get<LedgerRow>('SELECT * FROM ledgers WHERE tier = ? AND owner_id = ?', 'project', repo.id)
        identities.set(repo.id, attached?.identity_key ?? await canonicalRepositoryIdentity(repo))
      }
    }
    if (generation !== this.generation) return
    const changed = this.store.transaction(() => {
      let any = false
      const now = isoNow()
      for (const repo of projectRepos) {
        const identity = identities.get(repo.id)!
        const existing = this.store.get<{ repo_id: string }>('SELECT repo_id FROM repo_identities WHERE repo_id = ?', repo.id)
        if (existing) this.store.run('UPDATE repo_identities SET identity_key = ? WHERE repo_id = ?', identity, repo.id)
        else this.store.run('INSERT INTO repo_identities (repo_id, identity_key) VALUES (?, ?)', repo.id, identity)
      }
      const groups = new Set(catalog.groups.map((group) => group.id))
      const repos = new Set(projectRepos.map((repo) => repo.id))
      for (const row of this.store.all<LedgerRow>('SELECT * FROM ledgers WHERE owner_id IS NOT NULL')) {
        const live = row.tier === 'project' ? repos.has(row.owner_id!) : groups.has(row.owner_id!)
        if (!live) {
          const before = { owner: asOwner(row), formerOwner: asFormerOwner(row), name: row.name }
          const after = { owner: null, formerOwner: { tier: row.tier, id: row.owner_id }, name: row.name }
          this.updateMetadata(row, 'detached', before, after, unknownActor(), { owner_id: null, former_tier: row.tier, former_id: row.owner_id }, now)
          any = true
        } else {
          const currentOwner = { tier: row.tier, id: row.owner_id! } as LedgerOwner
          const current = ownerFor(catalog, currentOwner)
          if (current) this.store.run('UPDATE ledgers SET name = ?, owner_path = ?, repo_id = ? WHERE ledger_id = ?', current.name, current.path ?? null, current.repoId ?? null, row.ledger_id)
        }
      }
      const liveIdentityCounts = new Map<string, number>()
      for (const key of identities.values()) liveIdentityCounts.set(key, (liveIdentityCounts.get(key) ?? 0) + 1)
      for (const repo of projectRepos) {
        const identity = identities.get(repo.id)!
        if (liveIdentityCounts.get(identity) !== 1) continue
        if (this.store.get('SELECT 1 FROM ledgers WHERE tier = ? AND owner_id = ?', 'project', repo.id)) continue
        const candidates = this.store.all<LedgerRow>('SELECT * FROM ledgers WHERE tier = ? AND owner_id IS NULL AND identity_key = ?', 'project', identity)
        if (candidates.length !== 1) continue
        const candidate = candidates[0]!
        const owner = { tier: 'project', id: repo.id }
        const before = { owner: null, formerOwner: asFormerOwner(candidate), name: candidate.name }
        const after = { owner, formerOwner: asFormerOwner(candidate), name: repo.displayName || repo.name }
        this.updateMetadata(candidate, 'reattached', before, after, unknownActor(), { owner_id: repo.id, name: repo.displayName || repo.name, owner_path: repo.path, repo_id: repo.id }, now)
        any = true
      }
      return any
    })
    if (generation !== this.generation) return
    this.catalog = catalog
    this.reconciledGeneration = generation
    this.unavailable = false
    if (changed) this.context.emit('changed', {})
  }

  private updateMetadata(
    row: LedgerRow,
    action: LedgerMetadataChange['action'],
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    actor: LedgerActor,
    columns: Partial<Pick<LedgerRow, 'owner_id' | 'former_tier' | 'former_id' | 'name' | 'owner_path' | 'repo_id' | 'identity_key' | 'stale_after_days' | 'source_equivalences'>>,
    at = isoNow()
  ): void {
    const revision = row.revision + 1
    const changedFields = Object.keys(after).filter((field) => stableStringify(before[field]) !== stableStringify(after[field])).sort()
    const history = parseJson<LedgerMetadataChange[]>(row.metadata_history, `metadata history for ${row.ledger_id}`)
    history.push({ revision, at, actor, action, before, after, changedFields })
    const fields: [keyof typeof columns, unknown][] = Object.entries(columns) as [keyof typeof columns, unknown][]
    const assignments = [...fields.map(([key]) => `${String(key)} = ?`), 'revision = ?', 'metadata_history = ?', 'updated_at = ?'].join(', ')
    this.store!.run(`UPDATE ledgers SET ${assignments} WHERE ledger_id = ?`, ...fields.map(([, value]) => value as string | number | null), revision, stringify(history), at, row.ledger_id)
  }

  private actor(caller: PluginCaller): LedgerActor {
    if (caller.role === 'ui' || caller.role === 'desktop') return { kind: 'human', ...(caller.name ? { tool: caller.name } : {}) }
    return { kind: 'unknown', tool: caller.role === 'plugin' ? caller.pluginId : caller.name ?? caller.role }
  }

  private response(row: LedgerRow | null, catalog: OwnerCatalog, details = false): LedgerResponse {
    return {
      schemaVersion: 1,
      runtime: { runtimeId: this.runtimeId, profileId: this.profileId },
      ledger: row ? this.summary(row, catalog, details) : null
    }
  }

  private summary(row: LedgerRow, catalog: OwnerCatalog, details = false): LedgerSummary {
    const owner = asOwner(row)
    const live = owner ? ownerFor(catalog, owner) : null
    const summary: LedgerSummary = {
      ledgerId: row.ledger_id,
      tier: row.tier,
      owner,
      formerOwner: asFormerOwner(row),
      revision: row.revision,
      entryCount: this.countEntries(row.ledger_id),
      nextSequence: row.next_sequence,
      staleAfterDays: row.stale_after_days,
      name: live?.name ?? row.name
    }
    if (live) {
      summary.ownerName = live.name
      if (live.repoId) summary.repoId = live.repoId
      if (live.path) summary.ownerPath = live.path
    } else {
      if (row.repo_id) summary.repoId = row.repo_id
      if (row.owner_path) summary.ownerPath = row.owner_path
    }
    if (details) {
      summary.sourceEquivalences = parseJson<string[][]>(row.source_equivalences, `source equivalences for ${row.ledger_id}`)
      summary.metadataHistory = parseJson<LedgerMetadataChange[]>(row.metadata_history, `metadata history for ${row.ledger_id}`)
    }
    return summary
  }

  private countEntries(ledgerId: string): number {
    return this.store!.get<{ count: number }>('SELECT COUNT(*) AS count FROM entries WHERE ledger_id = ?', ledgerId)?.count ?? 0
  }

  private entry(row: EntryRow): LedgerEntry {
    const historyRows = this.store!.all<HistoryRow>('SELECT * FROM history WHERE ledger_id = ? AND entry_id = ? ORDER BY revision', row.ledger_id, row.id)
    return {
      id: row.id,
      type: row.type as LedgerType,
      sequence: row.sequence,
      revision: row.revision,
      content: parseJson<Record<string, unknown>>(row.content, `entry content ${row.ledger_id}/${row.id}`),
      state: row.state as LedgerState,
      reviewed: row.reviewed === 1,
      origin: parseJson<LedgerEntry['origin']>(row.origin, `entry origin ${row.ledger_id}/${row.id}`),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestContentActor: parseJson<LedgerActor>(row.latest_content_actor, `entry actor ${row.ledger_id}/${row.id}`),
      history: historyRows.map((item) => ({
        revision: item.revision,
        at: item.at,
        actor: parseJson<LedgerActor>(item.actor, `history actor ${row.ledger_id}/${row.id}`),
        before: parseJson<LedgerSnapshot>(item.before, `history before ${row.ledger_id}/${row.id}`),
        after: parseJson<LedgerSnapshot>(item.after, `history after ${row.ledger_id}/${row.id}`),
        changedFields: parseJson<string[]>(item.changed_fields, `history fields ${row.ledger_id}/${row.id}`)
      }))
    }
  }

  private async resolveTarget(request: LedgerRequest, caller: PluginCaller): Promise<Resolved> {
    const catalog = await this.ensureCatalog()
    const target: LedgerTarget = request.target ?? {}
    validateTargetSelectors(target, this.fail.bind(this))
    if (target.ledgerId !== undefined) {
      const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', target.ledgerId)
      if (!ledger) this.fail('not-found', `ledger ${target.ledgerId} not found`)
      return { catalog, ledger }
    }
    if (target.owner) {
      const owner = ownerFor(catalog, target.owner)
      if (!owner) this.fail('owner-missing', `owner ${target.owner.id} is not live`)
      const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE tier = ? AND owner_id = ?', owner.owner.tier, owner.owner.id)
      return { catalog, owner, ledger }
    }
    const needsWorkspace = target.workspaceId !== undefined || target.group === true || target.groupSelector !== undefined || (!target.owner && !target.ledgerId)
    if (!needsWorkspace) return { catalog, ledger: null }
    let resolvedWorkspace: Worktree
    try {
      resolvedWorkspace = await resolveWorkspace(this.context, target.workspaceId, caller)
    } catch (error) {
      if (isMethodNotFound(error)) this.fail('catalog-unavailable', 'Workspace selector is unavailable')
      if (isNotFound(error)) this.fail('workspace-missing', errorMessage(error))
      this.fail('invalid-target', `workspace could not be resolved: ${errorMessage(error)}`)
    }
    const workspace = workspaceFor(catalog, resolvedWorkspace.id)
    if (!workspace) this.fail('workspace-missing', `workspace ${resolvedWorkspace.id} is not live`)
    const owner = selectWorkspaceOwner(target, workspace, catalog, this.fail.bind(this)) ?? undefined
    const ledger = owner ? this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE tier = ? AND owner_id = ?', owner.owner.tier, owner.owner.id) : null
    return { catalog, workspace, ...(owner ? { owner } : {}), ledger }
  }

  private async execute(request: LedgerRequest, caller: PluginCaller): Promise<Result> {
    this.ensureHealthy()
    if (!isRecord(request) || !OPERATIONS.includes(request.operation)) this.fail('invalid-request', 'operation must be a supported ledger operation')
    if (request.confirmed !== undefined && typeof request.confirmed !== 'boolean') this.fail('invalid-request', 'confirmed must be a boolean')
    if (request.operation === 'catalog') {
      await this.ensureCatalog()
      return this.catalogResponse()
    }
    if (request.operation === 'removal-preview') return this.removalPreview(request)
    const resolved = await this.resolveTarget(request, caller)
    switch (request.operation) {
      case 'file': return this.file(request, caller, resolved)
      case 'list': return this.list(request, resolved)
      case 'show': return this.show(request, resolved)
      case 'edit': return this.edit(request, caller, resolved)
      case 'state': return this.state(request, caller, resolved)
      case 'review': return this.review(request, resolved)
      case 'revert': return this.revert(request, caller, resolved)
      case 'import': return this.import(request, caller, resolved)
      case 'approve': return this.approve(request, caller, resolved)
      case 'bulk-state': return this.bulkState(request, caller, resolved)
      case 'delete-entries': return this.deleteEntries(request, resolved)
      case 'delete-ledger': return this.deleteLedger(request, resolved)
      case 'attach': return this.attach(request, caller, resolved)
      case 'settings': return this.settings(request, caller, resolved)
      default: this.fail('invalid-request', 'unsupported ledger operation')
    }
  }

  private catalogResponse(): Result {
    const catalog = this.catalog
    if (!catalog || this.reconciledGeneration !== this.generation || this.unavailable) this.fail('catalog-unavailable', 'Owner catalog could not be reconciled')
    const ledgers = this.store!.all<LedgerRow>('SELECT * FROM ledgers ORDER BY name COLLATE NOCASE, ledger_id')
    const owners = liveOwners(catalog).map((owner) => {
      const ledger = this.store!.get<{ ledger_id: string }>('SELECT ledger_id FROM ledgers WHERE tier = ? AND owner_id = ?', owner.owner.tier, owner.owner.id)
      return { tier: owner.owner.tier, id: owner.owner.id, name: owner.name, ...(owner.path ? { path: owner.path } : {}), ...(owner.repoId ? { repoId: owner.repoId } : {}), ...(ledger ? { ledgerId: ledger.ledger_id } : {}) }
    })
    return { response: { ...this.response(null, catalog), ledgers: ledgers.map((row) => this.summary(row, catalog)), owners } }
  }

  private async file(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    if (!resolved.owner) this.fail('owner-missing', 'filing requires a live project or group owner')
    if (!request.type || !['bug', 'deferred', 'test-gap', 'proposal', 'decision'].includes(request.type)) this.fail('invalid-enum', `Invalid ledger type: ${String(request.type)}`, { field: 'type' })
    if (!isRecord(request.content)) this.fail('invalid-request', 'content must be an object')
    const locationField = locationFieldOf(request.type)
    const content = mergeAndValidateContent(request.type, undefined, request.content, {
      catalog: resolved.catalog,
      ...(resolved.workspace ? { workspace: resolved.workspace } : {}),
      normalizeFields: new Set(locationField ? [locationField] : []),
      fail: this.fail.bind(this)
    })
    const actor = this.actor(caller)
    const origin = this.origin(resolved.workspace, resolved.owner.owner)
    const now = isoNow()
    const newLedgerId = randomUUID()
    const ledgerId = this.store!.transaction(() => {
      let ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE tier = ? AND owner_id = ?', resolved.owner!.owner.tier, resolved.owner!.owner.id)
      if (!ledger) {
        const identity = resolved.owner!.owner.tier === 'project'
          ? this.store!.get<{ identity_key: string }>('SELECT identity_key FROM repo_identities WHERE repo_id = ?', resolved.owner!.owner.id)?.identity_key ?? null
          : null
        this.store!.run(
          'INSERT INTO ledgers (ledger_id, tier, owner_id, former_tier, former_id, name, owner_path, repo_id, identity_key, revision, next_sequence, stale_after_days, source_equivalences, metadata_history, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, 1, 90, ?, ?, ?, ?)',
          newLedgerId,
          resolved.owner!.owner.tier,
          resolved.owner!.owner.id,
          resolved.owner!.name,
          resolved.owner!.path ?? null,
          resolved.owner!.repoId ?? null,
          identity,
          '[]',
          '[]',
          now,
          now
        )
        ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', newLedgerId)!
      }
      const sequence = ledger.next_sequence
      const id = `${request.type}-${sequence}`
      const after: LedgerSnapshot = { content, state: 'open', reviewed: false }
      this.store!.run(
        'INSERT INTO entries (ledger_id, id, type, sequence, revision, content, state, reviewed, origin, created_at, updated_at, latest_content_actor) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?, ?)',
        ledger.ledger_id,
        id,
        request.type!,
        sequence,
        stringify(content),
        'open',
        stringify(origin),
        now,
        now,
        stringify(actor)
      )
      this.store!.run(
        'INSERT INTO history (ledger_id, entry_id, revision, at, actor, before, after, changed_fields) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
        ledger.ledger_id,
        id,
        now,
        stringify(actor),
        stringify(SNAPSHOT_EMPTY),
        stringify(after),
        stringify(Object.keys(content).sort())
      )
      this.store!.run('UPDATE ledgers SET revision = revision + 1, next_sequence = next_sequence + 1, updated_at = ? WHERE ledger_id = ?', now, ledger.ledger_id)
      return ledger.ledger_id
    })
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', ledgerId)!
    const entryRow = this.store!.get<EntryRow>('SELECT * FROM entries WHERE ledger_id = ? AND id = ?', ledgerId, `${request.type}-${ledger.next_sequence - 1}`)!
    const matches = this.nearMatches(entryRow, ledger)
    return { response: { ...this.response(ledger, resolved.catalog, true), entry: this.entry(entryRow), matches }, changed: true }
  }

  private origin(workspace: WorkspaceContext | undefined, owner: LedgerOwner): LedgerEntry['origin'] {
    const observedAt = isoNow()
    if (!workspace) return { owner, observedAt }
    return {
      workspaceId: workspace.workspace.id,
      owner,
      ...(workspace.workspace.branch ? { branch: workspace.workspace.branch } : {}),
      host: 'local',
      ...(workspace.workspace.head ? { revision: workspace.workspace.head } : {}),
      observedAt
    }
  }

  private list(request: LedgerRequest, resolved: Resolved): Result {
    this.validateFilters(request.filters)
    if (!resolved.ledger) return { response: { ...this.response(null, resolved.catalog), entries: [] } }
    const ledger = resolved.ledger
    const all = this.store!.all<EntryRow>('SELECT * FROM entries WHERE ledger_id = ?', ledger.ledger_id)
    const filters = request.filters ?? {}
    const selected = all.filter((row) => {
      const entry = this.entry(row)
      const stale = this.isStale(row.updated_at, ledger.stale_after_days)
      return (filters.type === undefined || entry.type === filters.type)
        && (filters.state === undefined || entry.state === filters.state)
        && (filters.reviewed === undefined || entry.reviewed === filters.reviewed)
        && (filters.stale === undefined || stale === filters.stale)
        && (filters.workspaceId === undefined || entry.origin.workspaceId === filters.workspaceId)
        && (filters.branch === undefined || entry.origin.branch === filters.branch)
        && (filters.search === undefined || lower(entry.id).includes(lower(filters.search)) || lower(entry.content.title).includes(lower(filters.search)))
    })
    const sort = filters.sort ?? 'activity'
    selected.sort((a, b) => sort === 'sequence'
      ? a.sequence - b.sequence
      : sort === 'title'
        ? String(this.entry(a).content.title ?? '').localeCompare(String(this.entry(b).content.title ?? '')) || a.sequence - b.sequence
        : b.updated_at.localeCompare(a.updated_at) || b.sequence - a.sequence)
    return { response: { ...this.response(ledger, resolved.catalog), entries: selected.map((row) => this.entry(row)) } }
  }

  private show(request: LedgerRequest, resolved: Resolved): Result {
    if (!request.id?.trim()) this.fail('invalid-request', 'show requires an entry id')
    if (!resolved.ledger) this.fail('not-found', `entry ${request.id} not found`)
    const row = this.store!.get<EntryRow>('SELECT * FROM entries WHERE ledger_id = ? AND id = ?', resolved.ledger.ledger_id, request.id)
    if (!row) this.fail('not-found', `entry ${request.id} not found`)
    return { response: { ...this.response(resolved.ledger, resolved.catalog, true), entry: this.entry(row) } }
  }

  private validateRevision(request: LedgerRequest): number {
    return expectedRevision(request.ifRevision, 'ifRevision', this.fail.bind(this))
  }


  private async edit(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    const ifRevision = this.validateRevision(request)
    if (!request.id?.trim()) this.fail('invalid-request', 'edit requires an entry id')
    if (!isRecord(request.content) || Object.keys(request.content).length === 0) this.fail('invalid-request', 'Edit requires at least one content field')
    if (!resolved.ledger) this.fail('not-found', `entry ${request.id} not found`)
    const changed = this.store!.transaction(() => {
      const current = this.requireEntry(resolved.ledger!.ledger_id, request.id!)
      this.checkEntryRevision(current, ifRevision)
      if (request.type !== undefined && request.type !== current.type) this.fail('invalid-request', 'entry type is immutable')
      const previous = parseJson<Record<string, unknown>>(current.content, 'entry content')
      const locationField = locationFieldOf(current.type as LedgerType)
      const locationChanged = locationField !== undefined && Object.hasOwn(request.content!, locationField) && stableStringify(request.content![locationField]) !== stableStringify(previous[locationField])
      const normalizedFields = new Set(locationChanged && locationField ? [locationField] : [])
      if (normalizedFields.size && !resolved.workspace && typeof request.content![locationField!] === 'string') this.fail('invalid-target', 'a workspace target is required for raw location scope')
      const content = mergeAndValidateContent(current.type as LedgerType, previous, request.content!, {
        catalog: resolved.catalog,
        ...(resolved.workspace ? { workspace: resolved.workspace } : {}),
        normalizeFields: normalizedFields,
        fail: this.fail.bind(this)
      })
      if (stableStringify(content) === stableStringify(previous)) return false
      this.commitEntryChange(current, { content, state: current.state as LedgerState, reviewed: this.isUi(caller) }, this.actor(caller), true)
      return true
    })
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger.ledger_id)!
    const entry = this.requireEntry(ledger.ledger_id, request.id)
    return { response: { ...this.response(ledger, resolved.catalog, true), entry: this.entry(entry) }, changed }
  }

  private async state(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    const ifRevision = this.validateRevision(request)
    if (!request.id?.trim()) this.fail('invalid-request', 'state requires an entry id')
    this.validateState(request.state)
    if (!resolved.ledger) this.fail('not-found', `entry ${request.id} not found`)
    const changed = this.store!.transaction(() => {
      const current = this.requireEntry(resolved.ledger!.ledger_id, request.id!)
      this.checkEntryRevision(current, ifRevision)
      if (current.state === request.state) return false
      const content = parseJson<Record<string, unknown>>(current.content, 'entry content')
      this.commitEntryChange(current, { content, state: request.state!, reviewed: this.isUi(caller) }, this.actor(caller), true)
      return true
    })
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger.ledger_id)!
    const entry = this.requireEntry(ledger.ledger_id, request.id)
    return { response: { ...this.response(ledger, resolved.catalog, true), entry: this.entry(entry) }, changed }
  }

  private async revert(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    const ifRevision = this.validateRevision(request)
    const toRevision = expectedRevision(request.toRevision, 'toRevision', this.fail.bind(this))
    if (!request.id?.trim()) this.fail('invalid-request', 'revert requires an entry id')
    if (!resolved.ledger) this.fail('not-found', `entry ${request.id} not found`)
    const changed = this.store!.transaction(() => {
      const current = this.requireEntry(resolved.ledger!.ledger_id, request.id!)
      this.checkEntryRevision(current, ifRevision)
      const history = this.store!.get<HistoryRow>('SELECT * FROM history WHERE ledger_id = ? AND entry_id = ? AND revision = ?', resolved.ledger!.ledger_id, request.id, toRevision)
      if (!history) this.fail('not-found', `revision ${toRevision} not found for ${request.id}`)
      const target = parseJson<LedgerSnapshot>(history.after, 'history snapshot')
      const currentContent = parseJson<Record<string, unknown>>(current.content, 'entry content')
      const targetContent = target.content
      const content = { ...currentContent }
      for (const field of editableFieldsOf(current.type as LedgerType)) {
        if (Object.hasOwn(targetContent, field)) content[field] = targetContent[field]
      }
      const validated = validateContent(current.type as LedgerType, content, { catalog: resolved.catalog, fail: this.fail.bind(this) })
      if (stableStringify(validated) === stableStringify(currentContent) && target.state === current.state) return false
      this.commitEntryChange(current, { content: validated, state: target.state, reviewed: this.isUi(caller) }, this.actor(caller), true)
      return true
    })
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger.ledger_id)!
    const entry = this.requireEntry(ledger.ledger_id, request.id)
    return { response: { ...this.response(ledger, resolved.catalog, true), entry: this.entry(entry) }, changed }
  }

  private commitEntryChange(current: EntryRow, next: LedgerSnapshot, actor: LedgerActor, contentActorChanges: boolean): void {
    const before = snapshotOf(current)
    const changedFields: string[] = []
    const allContentKeys = new Set([...Object.keys(before.content), ...Object.keys(next.content)])
    for (const key of allContentKeys) if (stableStringify(before.content[key]) !== stableStringify(next.content[key])) changedFields.push(key)
    if (before.state !== next.state) changedFields.push('state')
    if (before.reviewed !== next.reviewed) changedFields.push('reviewed')
    changedFields.sort()
    const revision = current.revision + 1
    const at = isoNow()
    this.store!.run(
      'UPDATE entries SET content = ?, state = ?, reviewed = ?, revision = ?, updated_at = ?, latest_content_actor = ? WHERE ledger_id = ? AND id = ?',
      stringify(next.content), next.state, next.reviewed ? 1 : 0, revision, at, contentActorChanges ? stringify(actor) : current.latest_content_actor, current.ledger_id, current.id
    )
    this.store!.run('UPDATE ledgers SET revision = revision + 1, updated_at = ? WHERE ledger_id = ?', at, current.ledger_id)
    this.store!.run(
      'INSERT INTO history (ledger_id, entry_id, revision, at, actor, before, after, changed_fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      current.ledger_id, current.id, revision, at, stringify(actor), stringify(before), stringify(next), stringify(changedFields)
    )
  }

  private async review(request: LedgerRequest, resolved: Resolved): Promise<Result> {
    this.validateFilters(request.filters)
    if (!resolved.ledger) return { response: { ...this.response(null, resolved.catalog), candidates: [] } }
    const ledger = resolved.ledger
    const rows = this.filteredRows(request.filters ?? {}, ledger)
    const entries = rows.map((row) => this.entry(row))
    const candidates: LedgerCandidate[] = entries.map((entry) => {
      const stale = this.isStale(entry.updatedAt, ledger.stale_after_days)
      return { entry, stale, reason: entry.reviewed ? 'reviewed' : 'unreviewed', evidence: this.evidence(entry, resolved.catalog, ledger.ledger_id) }
    })
    candidates.sort((a, b) => {
      const band = (item: LedgerCandidate) => (!item.entry.reviewed && item.stale ? 0 : !item.entry.reviewed ? 1 : item.stale ? 2 : 3)
      return band(a) - band(b)
        || Number(!isTrueUnknown(a.entry.latestContentActor)) - Number(!isTrueUnknown(b.entry.latestContentActor))
        || a.entry.updatedAt.localeCompare(b.entry.updatedAt)
        || a.entry.sequence - b.entry.sequence
    })
    return { response: { ...this.response(ledger, resolved.catalog), candidates } }
  }

  private evidence(entry: LedgerEntry, catalog: OwnerCatalog, ledgerId: string): LedgerEvidence {
    const origin = entry.origin
    if (!origin.workspaceId) return { available: false, note: 'No originating workspace is recorded' }
    const workspace = catalog.worktrees.find((item) => item.id === origin.workspaceId)
    if (!workspace) return { available: false, workspaceId: origin.workspaceId, note: 'Originating workspace is unavailable' }
    const evidence: LedgerEvidence = {
      available: true,
      workspaceId: workspace.id,
      observedAt: isoNow(),
      ...(workspace.head ? { observedRevision: workspace.head } : {}),
      ...(origin.revision ? { baselineRevision: origin.revision } : {})
    }
    const locationKey = locationFieldOf(entry.type)
    const location = locationKey ? entry.content[locationKey] : undefined
    if (!isRecord(location) || typeof location.path !== 'string') {
      evidence.note = 'No scoped location is recorded'
      return evidence
    }
    if (location.external === true) {
      evidence.note = 'External locations are not dereferenced during review'
      return evidence
    }
    const repo = catalog.repos.find((item) => item.id === workspace.repoId)
    if (!repo) {
      evidence.note = 'Originating workspace is unavailable'
      return evidence
    }
    const base = location.base
    let root: string | undefined
    if (isRecord(base) && base.kind === 'workspace' && base.id === workspace.id) root = workspace.path
    else if (isRecord(base) && base.kind === 'project' && (base.id === repo.id || this.idsEquivalent(String(base.id), repo.id, 'project', ledgerId))) root = repo.path
    if (!root) {
      evidence.note = 'Recorded location is outside this workspace scope'
      return evidence
    }
    const exists = fileExistsSafely(root, location.path)
    if (exists === null) {
      evidence.note = 'Recorded location is outside this workspace scope'
      return evidence
    }
    evidence.fileExists = exists
    if (!exists) evidence.note = 'Recorded file is absent; file presence alone does not establish resolution'
    else if (evidence.baselineRevision && evidence.observedRevision) evidence.note = 'Baseline and current revisions are recorded; file presence alone does not establish resolution'
    else evidence.note = 'File presence alone does not establish resolution'
    return evidence
  }

  private idsEquivalent(left: string, right: string, tier: string, ledgerId: string): boolean {
    if (left === right || tier !== 'project') return left === right
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', ledgerId)
    if (!ledger) return false
    const groups = parseJson<string[][]>(ledger.source_equivalences, 'source equivalences')
    return groups.some((group) => group.includes(left) && group.includes(right))
  }

  private filteredRows(filters: LedgerFilters, ledger: LedgerRow): EntryRow[] {
    const all = this.store!.all<EntryRow>('SELECT * FROM entries WHERE ledger_id = ?', ledger.ledger_id)
    return all.filter((row) => {
      const content = parseJson<Record<string, unknown>>(row.content, 'entry content')
      const origin = parseJson<LedgerEntry['origin']>(row.origin, 'entry origin')
      const stale = this.isStale(row.updated_at, ledger.stale_after_days)
      return (filters.type === undefined || row.type === filters.type)
        && (filters.state === undefined || row.state === filters.state)
        && (filters.reviewed === undefined || (row.reviewed === 1) === filters.reviewed)
        && (filters.stale === undefined || stale === filters.stale)
        && (filters.workspaceId === undefined || origin.workspaceId === filters.workspaceId)
        && (filters.branch === undefined || origin.branch === filters.branch)
        && (filters.search === undefined || lower(row.id).includes(lower(filters.search)) || lower(content.title).includes(lower(filters.search)))
    })
  }

  private validateFilters(filters: LedgerFilters | undefined): void {
    if (filters === undefined) return
    if (!isRecord(filters)) this.fail('invalid-request', 'filters must be an object')
    if (filters.type !== undefined && !['bug', 'deferred', 'test-gap', 'proposal', 'decision'].includes(filters.type)) this.fail('invalid-enum', 'Invalid filter type')
    if (filters.state !== undefined && !['open', 'resolved', 'archived'].includes(filters.state)) this.fail('invalid-enum', 'Invalid filter state')
    if (filters.reviewed !== undefined && typeof filters.reviewed !== 'boolean') this.fail('invalid-request', 'reviewed filter must be a boolean')
    if (filters.stale !== undefined && typeof filters.stale !== 'boolean') this.fail('invalid-request', 'stale filter must be a boolean')
    for (const key of ['workspaceId', 'branch', 'search'] as const) if (filters[key] !== undefined && typeof filters[key] !== 'string') this.fail('invalid-request', `${key} filter must be a string`)
    if (filters.sort !== undefined && !['activity', 'sequence', 'title'].includes(filters.sort)) this.fail('invalid-enum', 'Invalid sort order')
  }

  private isStale(updatedAt: string, staleAfterDays: number): boolean {
    return Date.now() - Date.parse(updatedAt) > staleAfterDays * DAY
  }

  private validateState(state: unknown): asserts state is LedgerState {
    if (!['open', 'resolved', 'archived'].includes(String(state))) this.fail('invalid-enum', `Invalid state: ${String(state)}`, { field: 'state' })
  }

  private requireEntry(ledgerId: string, id: string): EntryRow {
    const entry = this.store!.get<EntryRow>('SELECT * FROM entries WHERE ledger_id = ? AND id = ?', ledgerId, id)
    if (!entry) this.fail('not-found', `entry ${id} not found`)
    return entry
  }

  private checkEntryRevision(entry: EntryRow, expected: number): void {
    if (entry.revision !== expected) this.fail('conflict', 'Entry revision is stale', { currentRevision: entry.revision })
  }

  private isUi(caller: PluginCaller): boolean {
    return caller.role === 'ui' || caller.role === 'desktop'
  }

  private validateSelections(selections: LedgerSelection[] | undefined): LedgerSelection[] {
    if (!Array.isArray(selections) || selections.length === 0) this.fail('invalid-request', 'selections must contain at least one entry')
    if (selections.length > MAX_SELECTIONS) this.fail('invalid-request', `selections cannot exceed ${MAX_SELECTIONS}`)
    const seen = new Set<string>()
    for (const selection of selections) {
      if (!isRecord(selection) || typeof selection.id !== 'string' || !selection.id.trim()) this.fail('invalid-request', 'each selection needs an entry id')
      expectedRevision(selection.revision, 'selection revision', this.fail.bind(this))
      if (seen.has(selection.id)) this.fail('invalid-request', `duplicate selection ${selection.id}`)
      seen.add(selection.id)
    }
    return selections
  }

  private checkSelectionsCurrent(selections: LedgerSelection[], ledgerId: string): EntryRow[] {
    return selections.map((selection) => {
      const row = this.requireEntry(ledgerId, selection.id)
      if (row.revision !== selection.revision) this.fail('conflict', `Entry ${row.id} revision is stale`, { currentRevision: row.revision, id: row.id })
      return row
    })
  }

  private async approve(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    if (!resolved.ledger) this.fail('not-found', 'ledger not found')
    const selections = this.validateSelections(request.selections)
    const changedCount = this.store!.transaction(() => {
      const rows = this.checkSelectionsCurrent(selections, resolved.ledger!.ledger_id)
      let changed = 0
      for (const row of rows) {
        if (row.reviewed === 1) continue
        const before = snapshotOf(row)
        const after = { ...before, reviewed: true }
        const revision = row.revision + 1
        const at = isoNow()
        const actor = this.actor(caller)
        this.store!.run('UPDATE entries SET reviewed = 1, revision = ?, updated_at = ? WHERE ledger_id = ? AND id = ?', revision, at, row.ledger_id, row.id)
        this.store!.run('UPDATE ledgers SET revision = revision + 1, updated_at = ? WHERE ledger_id = ?', at, row.ledger_id)
        this.store!.run('INSERT INTO history (ledger_id, entry_id, revision, at, actor, before, after, changed_fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row.ledger_id, row.id, revision, at, stringify(actor), stringify(before), stringify(after), stringify(['reviewed']))
        changed += 1
      }
      return changed
    })
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger.ledger_id)!
    const entries = selections.map((selection) => this.entry(this.requireEntry(ledger.ledger_id, selection.id)))
    return { response: { ...this.response(ledger, resolved.catalog, true), entries }, changed: changedCount > 0 }
  }

  private async bulkState(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    this.requireConfirmation(request)
    if (!resolved.ledger) this.fail('not-found', 'ledger not found')
    this.validateState(request.state)
    const selections = this.validateSelections(request.selections)
    const count = this.store!.transaction(() => {
      const rows = this.checkSelectionsCurrent(selections, resolved.ledger!.ledger_id)
      let changed = 0
      for (const row of rows) {
        if (row.state === request.state) continue
        const content = parseJson<Record<string, unknown>>(row.content, 'entry content')
        this.commitEntryChange(row, { content, state: request.state!, reviewed: this.isUi(caller) }, this.actor(caller), true)
        changed += 1
      }
      return changed
    })
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger.ledger_id)!
    const entries = selections.map((selection) => this.entry(this.requireEntry(ledger.ledger_id, selection.id)))
    return { response: { ...this.response(ledger, resolved.catalog, true), entries }, changed: count > 0 }
  }

  private async deleteEntries(request: LedgerRequest, resolved: Resolved): Promise<Result> {
    this.requireConfirmation(request)
    if (!resolved.ledger) this.fail('not-found', 'ledger not found')
    const selections = this.validateSelections(request.selections)
    this.store!.transaction(() => {
      const rows = this.checkSelectionsCurrent(selections, resolved.ledger!.ledger_id)
      const at = isoNow()
      for (const row of rows) {
        this.store!.run('DELETE FROM history WHERE ledger_id = ? AND entry_id = ?', row.ledger_id, row.id)
        this.store!.run('DELETE FROM entries WHERE ledger_id = ? AND id = ?', row.ledger_id, row.id)
        this.store!.run('UPDATE anchors SET deleted = 1, baseline = NULL WHERE ledger_id = ? AND entry_id = ?', row.ledger_id, row.id)
        this.store!.run('UPDATE ledgers SET revision = revision + 1, updated_at = ? WHERE ledger_id = ?', at, row.ledger_id)
      }
    })
    const ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger.ledger_id)!
    return { response: { ...this.response(ledger, resolved.catalog, true), entries: [] }, changed: selections.length > 0 }
  }

  private async deleteLedger(request: LedgerRequest, resolved: Resolved): Promise<Result> {
    this.requireConfirmation(request)
    if (!resolved.ledger) this.fail('not-found', 'ledger not found')
    const expected = expectedRevision(request.ifLedgerRevision, 'ifLedgerRevision', this.fail.bind(this), true)
    const summary = this.summary(resolved.ledger, resolved.catalog, true)
    this.store!.transaction(() => {
      const current = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger!.ledger_id)
      if (!current) this.fail('not-found', 'ledger not found')
      if (current.revision !== expected) this.fail('conflict', 'Ledger revision is stale', { currentRevision: current.revision })
      this.store!.run('DELETE FROM history WHERE ledger_id = ?', current.ledger_id)
      this.store!.run('DELETE FROM entries WHERE ledger_id = ?', current.ledger_id)
      this.store!.run('DELETE FROM anchors WHERE ledger_id = ?', current.ledger_id)
      this.store!.run('DELETE FROM ledgers WHERE ledger_id = ?', current.ledger_id)
    })
    return { response: { ...this.response(null, resolved.catalog), ledger: summary }, changed: true }
  }

  private async settings(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    if (!resolved.ledger) return { response: this.response(null, resolved.catalog, true) }
    if (request.staleAfterDays === undefined) return { response: this.response(resolved.ledger, resolved.catalog, true) }
    if (!Number.isSafeInteger(request.staleAfterDays) || request.staleAfterDays < 0 || request.staleAfterDays > 3650) this.fail('invalid-request', 'staleAfterDays must be an integer from 0 to 3650')
    const expected = expectedRevision(request.ifLedgerRevision, 'ifLedgerRevision', this.fail.bind(this), true)
    const changed = this.store!.transaction(() => {
      const current = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger!.ledger_id)
      if (!current) this.fail('not-found', 'ledger not found')
      if (current.revision !== expected) this.fail('conflict', 'Ledger revision is stale', { currentRevision: current.revision })
      if (current.stale_after_days === request.staleAfterDays) return false
      const afterDays = request.staleAfterDays!
      this.updateMetadata(current, 'settings', { staleAfterDays: current.stale_after_days }, { staleAfterDays: afterDays }, this.actor(caller), { stale_after_days: afterDays })
      return true
    })
    const updated = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger.ledger_id)!
    return { response: this.response(updated, resolved.catalog, true), changed }
  }

  private async attach(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    this.requireConfirmation(request)
    if (!request.target?.ledgerId || !resolved.ledger) this.fail('invalid-target', 'attach requires target.ledgerId')
    const expected = expectedRevision(request.ifLedgerRevision, 'ifLedgerRevision', this.fail.bind(this), true)
    const attachTo = this.validateAttachTo(request.attachTo, resolved.ledger, resolved.catalog)
    const updated = this.store!.transaction(() => {
      const current = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', resolved.ledger!.ledger_id)
      if (!current) this.fail('not-found', 'ledger not found')
      if (current.revision !== expected) this.fail('conflict', 'Ledger revision is stale', { currentRevision: current.revision })
      if (current.owner_id !== null) this.fail('attachment-refused', 'only a detached ledger can be attached')
      if (current.tier !== attachTo.tier) this.fail('attachment-refused', 'ledger and owner tiers must match')
      if (this.store!.get('SELECT 1 FROM ledgers WHERE tier = ? AND owner_id = ?', attachTo.tier, attachTo.id)) this.fail('attachment-refused', 'target owner already has a ledger')
      let equivalences = parseJson<string[][]>(current.source_equivalences, 'source equivalences')
      const former = asFormerOwner(current)
      if (!former) this.fail('attachment-refused', 'detached ledger has no former owner metadata')
      if (current.tier === 'project' && former.id !== attachTo.id) {
        equivalences = this.addEquivalence(equivalences, former.id, attachTo.id)
        if (this.hasCanonicalAnchorCollision(current.ledger_id, equivalences)) this.fail('attachment-refused', 'attachment would collapse import anchors')
      }
      const nextIdentity = current.tier === 'project'
        ? this.store!.get<{ identity_key: string }>('SELECT identity_key FROM repo_identities WHERE repo_id = ?', attachTo.id)?.identity_key ?? null
        : null
      if (current.tier === 'project' && !nextIdentity) this.fail('catalog-unavailable', 'project identity mapping is unavailable')
      const before = { owner: null, formerOwner: former, identityKey: current.identity_key, sourceEquivalences: parseJson<string[][]>(current.source_equivalences, 'source equivalences') }
      const after = { owner: { tier: attachTo.tier, id: attachTo.id }, formerOwner: former, identityKey: nextIdentity, sourceEquivalences: equivalences }
      this.updateMetadata(current, 'attached', before, after, this.actor(caller), {
        owner_id: attachTo.id,
        former_tier: former.tier,
        former_id: former.id,
        name: attachTo.name,
        owner_path: attachTo.path ?? null,
        repo_id: attachTo.repoId ?? null,
        ...(current.tier === 'project' ? { identity_key: nextIdentity } : {}),
        source_equivalences: stringify(equivalences)
      })
      return this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', current.ledger_id)!
    })
    return { response: this.response(updated, resolved.catalog, true), changed: true }
  }

  private validateAttachTo(value: LedgerOwner | undefined, ledger: LedgerRow, catalog: OwnerCatalog): LiveOwner {
    if (!value || (value.tier !== 'project' && value.tier !== 'group') || typeof value.id !== 'string' || !value.id.trim()) this.fail('invalid-request', 'attachTo must identify a project or group')
    const owner = ownerFor(catalog, value)
    if (!owner) this.fail('owner-missing', `attachment owner ${value.id} is not live`)
    if (value.tier !== ledger.tier) this.fail('attachment-refused', 'ledger and owner tiers must match')
    return owner
  }

  private addEquivalence(equivalences: string[][], left: string, right: string): string[][] {
    const merged = new Set([left, right])
    const remaining: string[][] = []
    for (const group of equivalences) {
      if (group.includes(left) || group.includes(right)) for (const id of group) merged.add(id)
      else remaining.push(group)
    }
    remaining.push([...merged].sort())
    return remaining
  }

  private hasCanonicalAnchorCollision(ledgerId: string, equivalences: string[][]): boolean {
    const anchors = this.store!.all<AnchorRow>('SELECT * FROM anchors WHERE ledger_id = ?', ledgerId)
    const seen = new Set<string>()
    for (const row of anchors) {
      const parsed = this.parseAnchor(row.anchor)
      if (!parsed) continue
      const canonicalId = this.canonicalProjectId(parsed.base.id, equivalences)
      const canonical = JSON.stringify([parsed.base.kind, canonicalId, parsed.base.host ?? null, parsed.sourcePath, parsed.legacyId])
      if (seen.has(canonical)) return true
      seen.add(canonical)
    }
    return false
  }

  private canonicalProjectId(id: string, equivalences: string[][]): string {
    return equivalences.find((group) => group.includes(id))?.slice().sort()[0] ?? id
  }

  private async import(request: LedgerRequest, caller: PluginCaller, resolved: Resolved): Promise<Result> {
    if (!resolved.workspace || !resolved.owner) this.fail('invalid-target', 'import requires a live workspace target')
    const base: LedgerLocation['base'] = resolved.workspace.repo.kind === 'git'
      ? { kind: 'project', id: resolved.workspace.repo.id }
      : { kind: 'workspace', id: resolved.workspace.workspace.id }
    let parsed: { records: ImportRecord[]; skipped: ImportSkip[] }
    try {
      parsed = await readLegacyImports(resolved.workspace.workspace.path, base)
    } catch (error) {
      parsed = { records: [], skipped: [{ sourcePath: '.', reason: `read-error:${errorMessage(error)}` }] }
    }
    const result: ImportResult = { created: [], updated: [], alreadyPresent: [], skipped: [...parsed.skipped] }
    let ledger = resolved.ledger
    let changed = false
    const initiator = this.actor(caller)
    for (const record of parsed.records) {
      const anchor = JSON.stringify([record.sourceBase.kind, record.sourceBase.id, record.sourceBase.host ?? null, record.sourcePath, record.legacyId])
      try {
        const normalized = mergeAndValidateContent(record.type, undefined, record.content, {
          catalog: resolved.catalog,
          workspace: resolved.workspace,
          externalHost: 'local',
          normalizeFields: new Set(locationFieldOf(record.type) ? [locationFieldOf(record.type)!] : []),
          fail: this.fail.bind(this)
        })
        const outcome = this.store!.transaction(() => {
          let currentLedger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE tier = ? AND owner_id = ?', resolved.owner!.owner.tier, resolved.owner!.owner.id)
          const exact = currentLedger ? this.store!.get<AnchorRow>('SELECT * FROM anchors WHERE ledger_id = ? AND anchor = ?', currentLedger.ledger_id, anchor) : null
          const equivalent = currentLedger ? this.canonicalAnchorMatches(anchor, currentLedger) : []
          if (equivalent.length > 1) return { status: 'skip' as const, reason: 'canonical-anchor-collision' }
          const existing = exact ?? equivalent[0] ?? null
          if (existing?.deleted === 1) return { status: 'skip' as const, reason: 'deleted' }
          const actor: LedgerActor = { kind: 'import', initiator }
          const now = isoNow()
          if (!currentLedger) {
            const identity = resolved.owner!.owner.tier === 'project'
              ? this.store!.get<{ identity_key: string }>('SELECT identity_key FROM repo_identities WHERE repo_id = ?', resolved.owner!.owner.id)?.identity_key ?? null
              : null
            const id = randomUUID()
            this.store!.run('INSERT INTO ledgers (ledger_id, tier, owner_id, former_tier, former_id, name, owner_path, repo_id, identity_key, revision, next_sequence, stale_after_days, source_equivalences, metadata_history, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, 1, 90, ?, ?, ?, ?)', id, resolved.owner!.owner.tier, resolved.owner!.owner.id, resolved.owner!.name, resolved.owner!.path ?? null, resolved.owner!.repoId ?? null, identity, '[]', '[]', now, now)
            currentLedger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', id)!
          }
          if (existing) {
            const sourceBaseline = parseJson<Record<string, unknown>>(existing.baseline ?? '{}', 'import baseline')
            if (stableStringify(sourceBaseline) === stableStringify(normalized)) return { status: 'already' as const, entryId: existing.entry_id }
            const currentEntry = this.requireEntry(currentLedger.ledger_id, existing.entry_id)
            const currentContent = parseJson<Record<string, unknown>>(currentEntry.content, 'entry content')
            if (stableStringify(currentContent) !== stableStringify(sourceBaseline)) return { status: 'skip' as const, reason: 'conflict' }
            const next: LedgerSnapshot = { content: normalized, state: currentEntry.state as LedgerState, reviewed: false }
            this.commitEntryChange(currentEntry, next, actor, true)
            this.store!.run('UPDATE anchors SET baseline = ? WHERE ledger_id = ? AND anchor = ?', stringify(normalized), currentLedger.ledger_id, existing.anchor)
            return { status: 'updated' as const, ledgerId: currentLedger.ledger_id, entryId: existing.entry_id }
          }
          const seq = currentLedger.next_sequence
          const entryId = `${record.type}-${seq}`
          const origin = this.origin(resolved.workspace, resolved.owner!.owner)
          const after: LedgerSnapshot = { content: normalized, state: 'open', reviewed: false }
          this.store!.run('INSERT INTO entries (ledger_id, id, type, sequence, revision, content, state, reviewed, origin, created_at, updated_at, latest_content_actor) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?, ?)', currentLedger.ledger_id, entryId, record.type, seq, stringify(normalized), 'open', stringify(origin), now, now, stringify(actor))
          this.store!.run('INSERT INTO history (ledger_id, entry_id, revision, at, actor, before, after, changed_fields) VALUES (?, ?, 1, ?, ?, ?, ?, ?)', currentLedger.ledger_id, entryId, now, stringify(actor), stringify(SNAPSHOT_EMPTY), stringify(after), stringify(Object.keys(normalized).sort()))
          this.store!.run('UPDATE ledgers SET revision = revision + 1, next_sequence = next_sequence + 1, updated_at = ? WHERE ledger_id = ?', now, currentLedger.ledger_id)
          this.store!.run('INSERT INTO anchors (ledger_id, anchor, entry_id, baseline, source_path, source_base, legacy_id, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)', currentLedger.ledger_id, anchor, entryId, stringify(normalized), record.sourcePath, stringify(record.sourceBase), record.legacyId)
          return { status: 'created' as const, ledgerId: currentLedger.ledger_id, entryId }
        })
        if (outcome.status === 'skip') result.skipped.push({ anchor, sourcePath: record.sourcePath, reason: outcome.reason })
        else if (outcome.status === 'already') result.alreadyPresent.push(outcome.entryId)
        else if (outcome.status === 'created') {
          result.created.push(outcome.entryId)
          ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', outcome.ledgerId)
          changed = true
        } else {
          result.updated.push(outcome.entryId)
          ledger = this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE ledger_id = ?', outcome.ledgerId)
          changed = true
        }
      } catch (error) {
        result.skipped.push({ anchor, sourcePath: record.sourcePath, reason: this.importSkipReason(error) })
      }
    }
    if (!ledger) {
      const current = resolved.owner ? this.store!.get<LedgerRow>('SELECT * FROM ledgers WHERE tier = ? AND owner_id = ?', resolved.owner.owner.tier, resolved.owner.owner.id) : null
      ledger = current
    }
    return { response: { ...this.response(ledger, resolved.catalog, true), importResult: result }, changed }
  }

  private parseAnchor(anchor: string): { base: LedgerLocation['base']; sourcePath: string; legacyId: string } | null {
    try {
      const parsed = JSON.parse(anchor) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 5 || (parsed[0] !== 'project' && parsed[0] !== 'workspace') || typeof parsed[1] !== 'string' || (parsed[2] !== null && typeof parsed[2] !== 'string') || typeof parsed[3] !== 'string' || typeof parsed[4] !== 'string') return null
      return { base: { kind: parsed[0], id: parsed[1], ...(parsed[2] ? { host: parsed[2] } : {}) }, sourcePath: parsed[3], legacyId: parsed[4] }
    } catch {
      return null
    }
  }

  private canonicalAnchorMatches(anchor: string, ledger: LedgerRow): AnchorRow[] {
    const candidate = this.parseAnchor(anchor)
    if (!candidate) return []
    const equivalences = parseJson<string[][]>(ledger.source_equivalences, 'source equivalences')
    const canonical = JSON.stringify([candidate.base.kind, this.canonicalProjectId(candidate.base.id, equivalences), candidate.base.host ?? null, candidate.sourcePath, candidate.legacyId])
    return this.store!.all<AnchorRow>('SELECT * FROM anchors WHERE ledger_id = ?', ledger.ledger_id).filter((row) => {
      const current = this.parseAnchor(row.anchor)
      return current && JSON.stringify([current.base.kind, this.canonicalProjectId(current.base.id, equivalences), current.base.host ?? null, current.sourcePath, current.legacyId]) === canonical
    })
  }

  private importSkipReason(error: unknown): string {
    const data = (error as { data?: { kind?: unknown } } | null)?.data
    if (data?.kind === 'conflict') return 'conflict'
    if (data?.kind === 'invalid-enum' || data?.kind === 'invalid-request') return 'invalid-record'
    if (data?.kind === 'canonical-anchor-collision') return 'canonical-anchor-collision'
    return 'invalid-record'
  }

  private requireConfirmation(request: LedgerRequest): void {
    if (request.confirmed !== true) this.fail('confirmation-required', 'This ledger operation requires a confirmed snapshot')
  }

  private async removalPreview(request: LedgerRequest): Promise<Result> {
    const catalog = await this.ensureCatalog()
    if (request.target !== undefined) this.fail('invalid-target', 'removal-preview does not use a ledger target')
    if (!isRecord(request.removal)) this.fail('invalid-request', 'removal-preview requires a removal object')
    const removal = request.removal
    const repoIds = removal.repoIds ?? []
    const groupIds = removal.groupIds ?? []
    if (!Array.isArray(repoIds) || !Array.isArray(groupIds) || repoIds.length > MAX_SELECTIONS || groupIds.length > MAX_SELECTIONS || [...repoIds, ...groupIds].some((id) => typeof id !== 'string' || !id.trim())) this.fail('invalid-request', 'removal owner ids are invalid')
    if (!repoIds.length && !groupIds.length) this.fail('invalid-request', 'removal-preview needs at least one project or group ID')
    if (new Set(repoIds).size !== repoIds.length || new Set(groupIds).size !== groupIds.length) this.fail('invalid-request', 'removal owner IDs must be unique')
    const rows = this.store!.all<LedgerRow>('SELECT * FROM ledgers WHERE owner_id IS NOT NULL').filter((row) => row.tier === 'project' ? repoIds.includes(row.owner_id!) : groupIds.includes(row.owner_id!))
    const snapshots = rows.map((row) => ({ ledgerId: row.ledger_id, revision: row.revision, entryCount: this.countEntries(row.ledger_id) })).sort((a, b) => a.ledgerId.localeCompare(b.ledgerId))
    if (removal.expectedLedgers !== undefined) {
      if (!Array.isArray(removal.expectedLedgers) || removal.expectedLedgers.length > MAX_SELECTIONS) this.fail('invalid-request', 'expectedLedgers is invalid')
      const expected = new Map<string, number>()
      for (const item of removal.expectedLedgers) {
        if (!isRecord(item) || typeof item.ledgerId !== 'string' || !item.ledgerId.trim()) this.fail('invalid-request', 'expected ledger snapshots need ledgerId and revision')
        if (expected.has(item.ledgerId)) this.fail('invalid-request', `duplicate expected ledger ${item.ledgerId}`)
        expected.set(item.ledgerId, expectedRevision(item.revision, 'ledger revision', this.fail.bind(this), true))
      }
      const current = new Map(snapshots.map((item) => [item.ledgerId, item.revision]))
      const matches = expected.size === current.size && [...current].every(([id, revision]) => expected.get(id) === revision)
      if (!matches) {
        const mismatch = snapshots.find((item) => expected.get(item.ledgerId) !== item.revision)
        this.fail('conflict', 'Ledger removal preview is stale', { current: snapshots, ...(mismatch ? { ledgerId: mismatch.ledgerId, currentRevision: mismatch.revision } : {}) })
      }
    }
    return { response: { ...this.response(null, catalog), removalPreview: snapshots } }
  }


  private nearMatches(created: EntryRow, ledger: LedgerRow): LedgerEntry[] {
    const newContent = parseJson<Record<string, unknown>>(created.content, 'entry content')
    const createdTitle = words(newContent.title)
    const equivalences = parseJson<string[][]>(ledger.source_equivalences, 'source equivalences')
    const rows = this.store!.all<EntryRow>('SELECT * FROM entries WHERE ledger_id = ? AND type = ? AND id <> ?', ledger.ledger_id, created.type, created.id)
    return rows.filter((row) => {
      const content = parseJson<Record<string, unknown>>(row.content, 'entry content')
      const titleMatches = jaccard(createdTitle, words(content.title)) >= 0.6
      const field = locationFieldOf(created.type as LedgerType)
      const left = field ? newContent[field] : undefined
      const right = field ? content[field] : undefined
      const locationMatches = isRecord(left) && isRecord(right)
        && left.path === right.path
        && Boolean(left.external) === Boolean(right.external)
        && (left.external !== true || left.host === right.host)
        && isRecord(left.base) && isRecord(right.base)
        && left.base.kind === right.base.kind
        && this.canonicalProjectId(String(left.base.id), equivalences) === this.canonicalProjectId(String(right.base.id), equivalences)
      return titleMatches || locationMatches
    }).map((row) => this.entry(row))
  }
}
