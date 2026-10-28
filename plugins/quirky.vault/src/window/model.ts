import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { HISTORY_AGENTS } from '../agents'
import type {
  HostOutcome,
  HostedSession,
  Presence,
  PublicListResult,
  SearchHit,
  SearchRequest,
  SearchResponse,
  SearchStatus,
  SearchTipState,
  ViewState
} from '../types'

export const HISTORY_PANEL_ID = 'panel:quirky.vault/history'
export const SETTINGS_SECTION_ID = 'settings-section:quirky.vault/search'
export const SETTINGS_VIEW_ID = 'view:quirky.vault/search-settings'
export const VAULT_RESUME_COMMAND = 'command:quirky.vault/resume'

export const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude', codebuddy: 'CodeBuddy', qoder: 'Qoder', codex: 'Codex', hermes: 'Hermes',
  pi: 'Pi', omp: 'OMP', 'prime-agent': 'Prime Agent', cursor: 'Cursor', gemini: 'Gemini',
  antigravity: 'Antigravity', rovo: 'Rovo Dev', copilot: 'GitHub Copilot', opencode: 'OpenCode',
  opencode2: 'OpenCode 2', zcode: 'ZCode', grok: 'Grok', openclaw: 'OpenClaw', devin: 'Devin',
  droid: 'Droid', cline: 'Cline', kimi: 'Kimi', muse: 'Muse', jcode: 'Jcode', kiro: 'Kiro'
}

export type VaultScope = { worktree: string | null; repo: string | null; worktreeName: string | null; repoName: string | null; loading: boolean }
export type VaultListState = { result: PublicListResult | null; loading: boolean; error: string | null }
export type VaultSearchState = { response: SearchResponse | null; loading: boolean; error: string | null }
export type VaultSnapshot = {
  view: ViewState
  viewReady: boolean
  scope: VaultScope
  list: VaultListState
  search: VaultSearchState
  searchStatus: SearchStatus | null
  searchTip: SearchTipState | null
  scanProgress: { phase: 'discovering' | 'reading' | 'complete'; scannedFiles: number; parsedFiles: number; current?: string } | null
  hostOutcomes: HostOutcome[]
  repoRows: { id: string; name: string; path: string }[]
  actionError: string | null
}

export type VaultViewReport = {
  host: string
  scope: ViewState['scope']
  query: string
  selectedId: string | null
  expandedIds: string[]
  focusedSearch: boolean
  group: ViewState['group']
  disabledAgents: string[]
  browseSort: ViewState['browseSort']
  searchSort: ViewState['searchSort']
  hideEmptySessions: boolean
  sessionLimit: ViewState['sessionLimit']
  adjustmentCount: number
  visibleIds: string[]
  listedCount: number
  total: number
  loading: boolean
  searchEnabled: boolean
  hostIssues: number
  sourceIssues: number
  status: string | null
  searchError: string | null
}

export type VaultRow = {
  id: string
  sourceId?: string
  hostId: string
  agent: string
  sessionId: string
  title: string
  cwd: string | null
  branch: string | null
  model: string | null
  createdAt: number | null
  updatedAt: number
  modifiedAt?: number
  messageCount: number
  totalTokens?: number | null
  previewMessages?: HostedSession['previewMessages']
  firstUserPrompt?: string
  lastUserPrompt?: string
  queuedMessageCount?: number
  subagentTranscriptCount?: number
  presence: Presence
  filePath?: string
  evidence?: SearchHit['evidence']
  duplicateCount?: number
  score?: number
}
type PublicSearchHit = SearchHit & { sourceId: string; hostId: string }

export const DEFAULT_VIEW: ViewState = {
  disabledAgents: [],
  browseSort: 'updated',
  searchSort: 'relevance',
  group: 'project',
  hideEmptySessions: false,
  sessionLimit: 250,
  host: 'local',
  scope: 'all',
  query: '',
  selectedId: null,
  expandedIds: [],
  focusedSearch: false
}

const emptySnapshot = (): VaultSnapshot => ({
  view: DEFAULT_VIEW,
  viewReady: false,
  scope: { worktree: null, repo: null, worktreeName: null, repoName: null, loading: true },
  list: { result: null, loading: false, error: null },
  search: { response: null, loading: false, error: null },
  searchStatus: null,
  searchTip: null,
  scanProgress: null,
  hostOutcomes: [],
  repoRows: [],
  actionError: null
})

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {})

function viewOf(value: unknown): ViewState | null {
  const candidate = asRecord(value) as unknown as Partial<ViewState>
  return typeof candidate.host === 'string' && typeof candidate.query === 'string' && Array.isArray(candidate.disabledAgents)
    ? candidate as ViewState
    : null
}

function searchStatusFrom(value: unknown): SearchStatus | null {
  const envelope = asRecord(value)
  const status = asRecord(envelope.status)
  if (!Array.isArray(envelope.hosts) || typeof status.enabled !== 'boolean' || !['closed', 'idle', 'indexing', 'current', 'degraded'].includes(String(status.phase))) return null
  return status as unknown as SearchStatus
}
function localSearchStatusFrom(value: unknown): SearchStatus | null {
  const status = asRecord(value)
  if (typeof status.enabled !== 'boolean' || !['closed', 'idle', 'indexing', 'current', 'degraded'].includes(String(status.phase))) return null
  return status as unknown as SearchStatus
}

function searchTipFrom(value: unknown): SearchTipState | null {
  const candidate = asRecord(value)
  return candidate.id === 'agent-session-search' && typeof candidate.seen === 'boolean'
    ? { id: 'agent-session-search', seen: candidate.seen }
    : null
}


function outcomeRows(value: unknown): HostOutcome[] {
  const outcomes = asRecord(value).hosts
  return Array.isArray(outcomes) ? outcomes.filter((row): row is HostOutcome => typeof asRecord(row).hostId === 'string') : []
}

function mergeHostOutcomes(current: HostOutcome[], incoming: HostOutcome[], replace = false): HostOutcome[] {
  const merged = new Map<string, HostOutcome>()
  if (!replace) for (const outcome of current) merged.set(outcome.hostId, outcome)
  for (const outcome of incoming) merged.set(outcome.hostId, outcome)
  return [...merged.values()]
}

function worktreeFrom(layout: UiLayout): string | null {
  const input = asRecord(layout.view?.input)
  const worktree = input.worktree
  return typeof worktree === 'string' && worktree.trim() !== '' ? worktree : null
}

function repoFrom(layout: UiLayout): string | null {
  const input = asRecord(layout.view?.input)
  const repo = input.repo
  return typeof repo === 'string' && repo.trim() !== '' ? repo : null
}


export class VaultWindowModel {
  private snapshot = emptySnapshot()
  private readonly listeners = new Set<() => void>()
  private unsubs: (() => void)[] = []
  private started = false
  private stopped = false
  private scopeGeneration = 0
  private listGeneration = 0
  private listToken: string | null = null
  private searchGeneration = 0
  private searchTipGeneration = 0
  private readonly instance = Math.random().toString(36).slice(2)
  private scanStartedAt: number | null = null

  constructor(readonly context: UiPluginContext) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): VaultSnapshot => this.snapshot

  private update(patch: Partial<VaultSnapshot>): void {
    if (this.stopped) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubs.push(
      this.context.subscribe((event) => {
        if (event.type === 'quirky.vault/viewChanged') {
          const view = viewOf((event as { data?: unknown }).data)
          if (view) this.update({ view, viewReady: true })
        } else if (event.type === 'quirky.vault/scanProgress') {
          const progress = asRecord((event as { data?: unknown }).data)
          if (progress.phase === 'discovering' || progress.phase === 'reading' || progress.phase === 'complete') {
            if (this.scanStartedAt === null) this.scanStartedAt = Date.now()
            this.update({ scanProgress: progress as VaultSnapshot['scanProgress'] })
          }
        } else if (event.type === 'quirky.vault/searchStatus') {
          const data = (event as { data?: unknown }).data
          const status = searchStatusFrom(data)
          if (status) {
            this.update({ searchStatus: status })
            const hosts = outcomeRows(data)
            if (hosts.length) this.update({ hostOutcomes: mergeHostOutcomes(this.snapshot.hostOutcomes, hosts) })
          } else if (this.snapshot.view.host === 'local') {
            const localStatus = localSearchStatusFrom(data)
            if (localStatus) this.update({ searchStatus: localStatus })
          }
        } else if (event.type === 'quirky.vault/searchTipChanged') {
          const searchTip = searchTipFrom((event as { data?: unknown }).data)
          if (searchTip) {
            this.searchTipGeneration += 1
            this.update({ searchTip })
          }
        }
      }),
      this.context.onLayout((layout) => void this.resolveScope(layout))
    )
    void this.initialize()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const unsubscribe of this.unsubs.splice(0)) unsubscribe()
    this.listeners.clear()
    if (this.listToken) void this.context.call('quirky.vault/cancelList', { requestToken: this.listToken }).catch(() => {})
  }

  private async initialize(): Promise<void> {
    await this.retryView()
  }

  async retryView(): Promise<void> {
    void this.refreshSearchTip()
    this.update({ list: { result: null, loading: true, error: null } })
    try {
      const view = viewOf(await this.context.call('quirky.vault/getView', {}))
      if (!view) throw new Error('The vault returned an invalid view state.')
      this.update({ view, viewReady: true, list: { result: null, loading: false, error: null } })
      if (this.stopped) return
      const layout = this.context.getLayout()
      await Promise.all([this.resolveScope(layout), this.refreshSearchStatus(view.host), this.loadRepositories()])
      if (this.stopped) return
      void this.discoverHosts()
    } catch (error) {
      this.update({ viewReady: false, list: { result: null, loading: false, error: errorMessage(error) } })
    }
  }

  async setView(patch: Partial<ViewState>): Promise<ViewState> {
    try {
      const value = viewOf(await this.context.call('quirky.vault/setView', patch as Record<string, unknown>))
      if (!value) throw new Error('The vault returned an invalid view state.')
      this.update({ view: value, viewReady: true, actionError: null })
      return value
    } catch (error) {
      this.update({ actionError: errorMessage(error) })
      throw error
    }
  }

  async resetView(): Promise<void> {
    try {
      const value = viewOf(await this.context.call('quirky.vault/resetView', {}))
      if (!value) throw new Error('The vault returned an invalid view state.')
      this.update({ view: value, viewReady: true, actionError: null })
    } catch (error) {
      this.update({ actionError: errorMessage(error) })
      throw error
    }
  }

  setActionError(error: unknown): void {
    this.update({ actionError: errorMessage(error) })
  }


  clearSearchResults(): void {
    this.searchGeneration += 1
    if (this.snapshot.search.response !== null || this.snapshot.search.loading || this.snapshot.search.error !== null) {
      this.update({ search: { response: null, loading: false, error: null } })
    }
  }


  private async resolveScope(layout: UiLayout): Promise<void> {
    const generation = ++this.scopeGeneration
    const worktreeSelector = worktreeFrom(layout)
    if (worktreeSelector === null) {
      const repoSelector = repoFrom(layout)
      if (repoSelector === null) {
        this.update({ scope: { worktree: null, repo: null, worktreeName: null, repoName: null, loading: false } })
        return
      }
      this.update({ scope: { worktree: null, repo: null, worktreeName: null, repoName: null, loading: true } })
      if (!this.snapshot.repoRows.some((repo) => repo.id === repoSelector)) await this.loadRepositories()
      if (generation !== this.scopeGeneration || this.stopped) return
      const repo = this.snapshot.repoRows.find((entry) => entry.id === repoSelector)
      this.update({
        scope: {
          worktree: null,
          repo: repo?.id ?? null,
          worktreeName: null,
          repoName: repo?.name ?? null,
          loading: false
        }
      })
      return
    }
    this.update({ scope: { ...this.snapshot.scope, loading: true } })
    try {
      const resolved = asRecord(await this.context.call('quirky.worktree/resolve', { selector: worktreeSelector }))
      if (generation !== this.scopeGeneration || this.stopped) return
      const id = typeof resolved.id === 'string' ? resolved.id : null
      const repo = typeof resolved.repoId === 'string' ? resolved.repoId : null
      const worktreeName = typeof resolved.name === 'string' ? resolved.name : worktreeSelector
      const repos = this.snapshot.repoRows
      const repoName = repo ? repos.find((entry) => entry.id === repo)?.name ?? null : null
      this.update({ scope: { worktree: id, repo, worktreeName, repoName, loading: false } })
    } catch {
      if (generation !== this.scopeGeneration || this.stopped) return
      this.update({ scope: { worktree: null, repo: null, worktreeName: null, repoName: null, loading: false } })
    }
  }

  private async loadRepositories(): Promise<void> {
    try {
      const rows = await this.context.call('quirky.repo/list', {}) as unknown
      if (!Array.isArray(rows)) return
      const repoRows = rows.flatMap((value) => {
        const row = asRecord(value)
        return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.path === 'string' ? [{ id: row.id, name: row.name, path: row.path }] : []
      })
      this.update({ repoRows })
      if (this.snapshot.scope.repo) {
        const repoName = repoRows.find((repo) => repo.id === this.snapshot.scope.repo)?.name ?? null
        this.update({ scope: { ...this.snapshot.scope, repoName } })
      }
    } catch {
      // Project labels can fall back to their source path; scanning remains available.
    }
  }

  private async discoverHosts(): Promise<void> {
    try {
      const result = await this.context.call('quirky.vault/list', { host: 'all', limit: 1 })
      const hosts = outcomeRows(result)
      if (hosts.length) this.update({ hostOutcomes: mergeHostOutcomes(this.snapshot.hostOutcomes, hosts, true) })
    } catch {
      // Host enumeration must not replace the selected host's actual browse result.
    }
  }

  private async refreshSearchTip(): Promise<void> {
    const generation = ++this.searchTipGeneration
    try {
      const searchTip = searchTipFrom(await this.context.call('quirky.vault/getSearchTip', {}))
      if (this.stopped || generation !== this.searchTipGeneration) return
      if (this.snapshot.searchTip?.seen && searchTip?.seen !== true) return
      this.update({ searchTip })
    } catch {
      if (this.stopped || generation !== this.searchTipGeneration || this.snapshot.searchTip?.seen) return
      this.update({ searchTip: null })
    }
  }
  async refreshSearchStatus(host = this.snapshot.view.host): Promise<SearchStatus | null> {
    try {
      const response = await this.context.call('quirky.vault/searchStatus', { host })
      const status = searchStatusFrom(response)
      if (status) {
        this.update({ searchStatus: status, search: { ...this.snapshot.search, error: null } })
        const hosts = outcomeRows(response)
        if (hosts.length) this.update({ hostOutcomes: mergeHostOutcomes(this.snapshot.hostOutcomes, hosts, host === 'all') })
        return status
      }
      this.update({ search: { ...this.snapshot.search, error: 'Search status is unavailable.' } })
      return null
    } catch (error) {
      this.update({ search: { ...this.snapshot.search, error: errorMessage(error) } })
      return null
    }
  }

  async setSearchEnabled(enabled: boolean, host = this.snapshot.view.host): Promise<void> {
    const response = await this.context.call('quirky.vault/setSearchEnabled', { enabled, host })
    const status = searchStatusFrom(response)
    if (!status || status.enabled !== enabled) throw new Error(`Could not confirm that search was ${enabled ? 'enabled' : 'disabled'}.`)
    this.update({ searchStatus: status, actionError: null })
    const hosts = outcomeRows(response)
    if (hosts.length) this.update({ hostOutcomes: mergeHostOutcomes(this.snapshot.hostOutcomes, hosts, host === 'all') })
  }




  private within(): { worktree?: string; repo?: string } | null {
    const scope = this.snapshot.view.scope
    if (scope === 'all') return {}
    if (scope === 'workspace') return this.snapshot.scope.worktree ? { worktree: this.snapshot.scope.worktree } : null
    return this.snapshot.scope.repo ? { repo: this.snapshot.scope.repo } : null
  }

  scopeUnavailableReason(): string | null {
    if (this.snapshot.scope.loading) return 'Resolving the current workspace and project.'
    if (this.snapshot.view.scope === 'workspace' && !this.snapshot.scope.worktree) return 'This workspace is unavailable. Switch to Project or All explicitly.'
    if (this.snapshot.view.scope === 'project' && !this.snapshot.scope.repo) return 'This project is unavailable. Switch to All explicitly.'
    return null
  }

  selectedAgents(): string[] {
    return HISTORY_AGENTS.filter((agent) => !this.snapshot.view.disabledAgents.includes(agent))
  }

  private nextToken(kind: string): string {
    return `${this.instance}-${kind}-${++this.listGeneration}`
  }

  async refreshList(force = false): Promise<void> {
    const view = this.snapshot.view
    const agents = this.selectedAgents()
    if (agents.length === 0) {
      this.update({ list: { result: null, loading: false, error: null } })
      return
    }
    const reason = this.scopeUnavailableReason()
    if (reason) {
      this.update({ list: { result: null, loading: false, error: reason } })
      return
    }
    const previousToken = this.listToken
    const token = this.nextToken('scan')
    this.listToken = token
    if (previousToken) void this.context.call('quirky.vault/cancelList', { requestToken: previousToken }).catch(() => {})
    this.scanStartedAt = Date.now()
    this.update({ list: { result: null, loading: true, error: null }, scanProgress: { phase: 'discovering', scannedFiles: 0, parsedFiles: 0 } })
    try {
      const within = this.within()
      const result = await this.context.call('quirky.vault/list', {
        host: view.host,
        ...(within && Object.keys(within).length ? { within } : {}),
        agents,
        ...(view.sessionLimit === null ? { unlimited: true } : { limit: view.sessionLimit }),
        force,
        requestToken: token,
        sort: view.browseSort,
        hideEmpty: view.hideEmptySessions
      }) as PublicListResult
      if (this.stopped || this.listToken !== token) return
      this.update({
        list: { result, loading: false, error: null },
        hostOutcomes: result.hosts?.length ? mergeHostOutcomes(this.snapshot.hostOutcomes, result.hosts, view.host === 'all') : this.snapshot.hostOutcomes,
        scanProgress: { phase: 'complete', scannedFiles: result.scannedFiles, parsedFiles: result.sessions.length }
      })
      this.context.setPanelBadge(HISTORY_PANEL_ID, result.issues.length ? result.issues.length : null, result.issues.length ? `${result.issues.length} history sources need attention` : undefined)
    } catch (error) {
      if (this.stopped || this.listToken !== token) return
      this.update({ list: { ...this.snapshot.list, loading: false, error: errorMessage(error) } })
      this.context.setPanelBadge(HISTORY_PANEL_ID, null)
    }
  }

  async runSearch(options: { cursor?: string; append?: boolean; freshness?: SearchRequest['freshness'] } = {}): Promise<void> {
    const view = this.snapshot.view
    const agents = this.selectedAgents()
    if (!this.snapshot.searchStatus?.enabled || view.query.trim() === '' || agents.length === 0) {
      this.update({ search: { response: null, loading: false, error: null } })
      return
    }
    const reason = this.scopeUnavailableReason()
    if (reason) {
      this.update({ search: { response: { kind: 'unavailable', reason: 'scope-unknown' }, loading: false, error: reason } })
      return
    }
    const generation = ++this.searchGeneration
    const within = this.within()
    const request: SearchRequest = {
      query: view.query,
      host: view.host,
      limit: 20,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.freshness ? { freshness: options.freshness } : {}),
      filters: { agents, sort: view.searchSort },
      ...(within && Object.keys(within).length ? { within } : {})
    }
    this.update({
      search: options.cursor
        ? { ...this.snapshot.search, loading: true, error: null }
        : { response: null, loading: true, error: null }
    })
    try {
      const response = await this.context.call('quirky.vault/search', request as unknown as Record<string, unknown>) as SearchResponse
      if (this.stopped || generation !== this.searchGeneration) return
      if (response.kind === 'stale-cursor' && options.cursor) {
        await this.runSearch({ freshness: options.freshness })
        return
      }
      if (options.append && response.kind === 'results' && this.snapshot.search.response?.kind === 'results') {
        const prior = this.snapshot.search.response
        const ids = new Set(prior.hits.map((hit) => hit.id))
        this.update({ search: { response: { ...response, hits: [...prior.hits, ...response.hits.filter((hit) => !ids.has(hit.id))] }, loading: false, error: null } })
      } else {
        this.update({ search: { response, loading: false, error: null } })
      }
      if (response.kind === 'results' && response.hosts?.length) this.update({ hostOutcomes: mergeHostOutcomes(this.snapshot.hostOutcomes, response.hosts, view.host === 'all') })
    } catch (error) {
      if (this.stopped || generation !== this.searchGeneration) return
      this.update({ search: { ...this.snapshot.search, loading: false, error: errorMessage(error) } })
    }
  }

  async loadMoreSearch(): Promise<void> {
    const response = this.snapshot.search.response
    if (!response || response.kind !== 'results' || !response.page.cursor || this.snapshot.search.loading) return
    await this.runSearch({ cursor: response.page.cursor, append: true })
  }


  ageText(now: number): string {
    const scannedAt = this.snapshot.list.result?.scannedAt
    if (!scannedAt) return 'Not scanned yet'
    const minutes = Math.max(0, Math.floor((now - scannedAt) / 60_000))
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  scanElapsed(now: number): string | null {
    if (!this.snapshot.list.loading || this.scanStartedAt === null) return null
    return `${Math.max(1, Math.floor((now - this.scanStartedAt) / 1000))}s`
  }

  repoLabelForPath(path: string | null): string {
    if (!path) return 'No project'
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    const cwd = normalize(path)
    const repo = this.snapshot.repoRows
      .filter((row) => cwd === normalize(row.path) || cwd.startsWith(`${normalize(row.path)}/`))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (repo) return repo.name
    return cwd.split('/').filter(Boolean).at(-1) ?? cwd
  }

  rows(): VaultRow[] {
    const state = this.snapshot
    const search = state.search.response
    const searching = state.searchStatus?.enabled === true && state.view.query.trim() !== ''
    if (searching && search?.kind === 'results') {
      const hits = search.hits as PublicSearchHit[]
      return hits.map((hit) => ({
        id: hit.id,
        sourceId: hit.sourceId,
        hostId: hit.hostId,
        agent: hit.agent,
        sessionId: hit.sessionId,
        title: hit.title,
        cwd: hit.cwd,
        branch: hit.branch,
        model: null,
        createdAt: null,
        updatedAt: hit.updatedAt,
        messageCount: hit.messageCount,
        presence: hit.source.presence,
        filePath: hit.source.filePath,
        evidence: hit.evidence,
        duplicateCount: hit.duplicateCount,
        score: hit.score
      }))
    }
    const titleFallback = searching && state.view.host !== 'all' && search?.kind === 'unavailable' && (search.reason === 'disabled' || search.reason === 'no-service')
    if (searching && !titleFallback) return []
    const sessions = state.list.result?.sessions ?? []
    const query = state.view.query.trim().toLocaleLowerCase()
    return sessions
      .filter((session) => query === '' || session.title.toLocaleLowerCase().includes(query))
      .map((session) => ({
        id: session.id,
        sourceId: session.sourceId,
        hostId: session.hostId,
        agent: session.agent,
        sessionId: session.sessionId,
        title: session.title,
        cwd: session.cwd,
        branch: session.branch,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        modifiedAt: session.modifiedAt,
        messageCount: session.messageCount,
        totalTokens: session.totalTokens,
        previewMessages: session.previewMessages,
        firstUserPrompt: session.firstUserPrompt,
        lastUserPrompt: session.lastUserPrompt,
        queuedMessageCount: session.queuedMessageCount,
        subagentTranscriptCount: session.subagentTranscriptCount,
        presence: session.source.presence,
        filePath: session.source.filePath,
      }))
  }
}

export function isResumable(row: VaultRow): boolean {
  return row.presence === 'present' && row.hostId === 'local' && (row.messageCount > 0 || (row.queuedMessageCount ?? 0) > 0 || (row.subagentTranscriptCount ?? 0) > 0 || row.previewMessages?.some((message) => message.role === 'user' || message.role === 'assistant') === true)
}

