import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { RpcErrorCode, type PluginCaller, type PluginContext, type PluginStore, type QuirkyEvent } from '@quirky/protocol'
import { HISTORY_AGENTS } from './agents'
import { VaultActions } from './actions'
import { callVaultHost, decodePublicId, discoverVaultHosts, hostedLocal, localOutcome, outcome, qualifyPublicId, redactReason, selectHost } from './hosts'
import type { VaultHost } from './hosts'
import type {
  HostOutcome,
  HostedSession,
  ListRequest,
  ListResult,
  PublicListRequest,
  PublicListResult,
  SearchHit,
  SearchRequest,
  SearchResponse,
  SearchResults,
  SearchStatus,
  SearchTipState,
  VaultMessage,
  VaultSession,
  ViewState,
  WorkerEvent
} from './types'
import { VaultViewState } from './view-state'
import { WorkerRequestError, type VaultWorkerClient } from './worker-client'

function assertOwnerHostCaller(context: PluginContext, caller: PluginCaller, hosts: VaultHost[]): void {
  if (caller.role === 'mobile' && hosts.some((host) => host.owner !== undefined)) {
    throw context.error('conflict', 'registered owner Vault access is unavailable to mobile callers')
  }
}

const SEARCH_SETTING = 'setting:quirky.vault/search-enabled'
const SEARCH_DATABASE = 'session-search.sqlite'
const SEARCH_TIP_ID = 'agent-session-search'
const SEARCH_TIP_STATE = `searchTip:${SEARCH_TIP_ID}`
const MAX_PATHS = 64
const MAX_QUERY = 512
const DEFAULT_LIMIT = 20
const DEFAULT_SEARCH_STATUS: SearchStatus = {
  enabled: false,
  phase: 'closed',
  filesIndexed: 0,
  filesDue: 0,
  filesFailed: 0,
  messagesIndexed: 0,
  degradedRoots: [],
  lastReconcileAt: null,
  lastSweepCompletedAt: null,
  generation: 0,
  supportedAgents: [...HISTORY_AGENTS],
  sessionsByAgent: {}
}

type PublicSearchStatus = { status: SearchStatus; hosts: HostOutcome[] }
type PublicSearchResponse = SearchResponse & { hosts?: HostOutcome[] }
type SearchHost = { id: string; label: string; local: boolean; contribution?: VaultHost }
type ScopeResolution = { localPaths?: string[]; remoteWithin?: { worktree?: string; repo?: string }; remoteScopePaths?: string[]; localError?: string }
type ScopeIdentity = { cwd?: string; worktreeId?: string; repoId?: string }
type AggregateHostState = { cursor: string | null; hasMore: boolean; generation: number }
type AggregateCursor = {
  requestKey: string
  hostIds: string[]
  hosts: Record<string, AggregateHostState>
  buffered: SearchHit[]
  truncated: SearchResults['truncated']
  repairedTerms?: Record<string, string>
}

type RecordValue = Record<string, unknown>

/** Daemon-facing vault API. Local parsing/search is delegated only to the owned Worker. */
export class VaultService {
  readonly actions: VaultActions
  readonly methods: Record<string, (params: Record<string, unknown>, caller: PluginCaller) => unknown>
  private readonly view: VaultViewState
  private readonly unsubscribe: () => void
  private readonly activeLists = new Set<string>()
  private policyQueue: Promise<unknown> = Promise.resolve()
  private appliedPolicy: string | undefined

  constructor(
    private readonly context: PluginContext,
    private readonly store: PluginStore,
    private readonly worker: VaultWorkerClient
  ) {
    this.view = new VaultViewState(store)
    this.actions = new VaultActions(context, context.dataDir, worker)
    this.unsubscribe = context.subscribe((event) => this.onEvent(event))
    this.methods = {
      list: (params, caller) => this.list(params, caller),
      cancelList: (params) => this.cancelList(params),
      get: (params, caller) => this.actions.get(params, caller),
      firstPrompt: (params, caller) => this.actions.firstPrompt(params, caller),
      subagents: (params, caller) => this.actions.subagents(params, caller),
      search: (params, caller) => this.search(params, caller),
      searchStatus: (params, caller) => this.searchStatus(params, caller),
      getSearchTip: () => this.getSearchTip(),
      setSearchEnabled: (params, caller) => this.setSearchEnabled(params, caller),
      clearSearchIndex: () => this.clearSearchIndex(),
      getView: (_params, caller) => this.getView(caller),
      setView: (params, caller) => this.setView(params, caller),
      resetView: (_params, caller) => this.resetView(caller),
      prepareResume: (params) => this.actions.prepareResume(params),
      resume: (params, caller) => this.actions.resume(params, caller),
      ownerResume: (params, caller) => this.actions.ownerResume(params, caller),
      deleteSession: (params) => this.actions.deleteSession(params),
      openSource: (params) => this.actions.openSource(params),
      openWorkingDirectory: (params) => this.actions.openWorkingDirectory(params),
      jump: (params) => this.actions.jump(params),
      handoff: (params, caller) => this.actions.handoff(params, caller)
    }
  }

  async close(): Promise<void> {
    this.unsubscribe()
    await this.policyQueue.catch(() => undefined)
    await this.worker.close()
  }

  getView = async (caller: PluginCaller): Promise<ViewState> => this.view.get(await this.defaultScope(caller))

  setView = async (params: Record<string, unknown>, caller: PluginCaller): Promise<ViewState> => {
    let view: ViewState
    try {
      view = this.view.set(params, await this.defaultScope(caller))
    } catch (error) {
      throw this.context.error('invalid-params', messageOf(error))
    }
    this.context.emit('viewChanged', { view })
    return view
  }

  resetView = async (caller: PluginCaller): Promise<ViewState> => {
    const view = this.view.reset(await this.defaultScope(caller))
    this.context.emit('viewChanged', { view })
    return view
  }

  list = async (params: Record<string, unknown>, caller: PluginCaller): Promise<PublicListResult> => {
    const request = this.parseListRequest(params)
    const view = this.view.get(await this.defaultScope(caller))
    const hostSelector = request.host ?? view.host
    const registry = hostSelector === 'local' ? { hosts: [], issues: [] } : await discoverVaultHosts(this.context)
    const selection = selectHost(hostSelector, registry.hosts)
    assertOwnerHostCaller(this.context, caller, selection.hosts)
    if (selection.unavailable) {
      return {
        sessions: [],
        issues: [],
        hosts: [...registry.issues, selection.unavailable],
        scannedFiles: 0,
        scannedAt: Date.now(),
        hasMore: false,
        total: 0
      }
    }
    const scope = await this.resolveScope(request, view, caller, selection.local)
    if (scope.localError && (selection.hosts.length === 0 || scope.remoteWithin === undefined)) {
      return {
        sessions: [],
        issues: [{ hostId: 'local', kind: 'error', reason: scope.localError }],
        hosts: [
          ...registry.issues,
          ...(selection.local ? [localOutcome('unavailable', 0, null, scope.localError)] : []),
          ...selection.hosts.map((host) => outcome(host.id, host.label, 'unavailable', scope.localError!, 0, null))
        ],
        scannedFiles: 0,
        scannedAt: Date.now(),
        hasMore: false,
        total: 0
      }
    }
    const listRequest = this.listArgs(request, view, scope.localPaths)
    const localResults: HostedSession[] = []
    const issues: PublicListResult['issues'] = []
    const hosts: HostOutcome[] = [...registry.issues]
    let scannedFiles = 0
    let scannedAt = Date.now()
    let total = 0
    let hasMore = false

    if (selection.local && scope.localError) {
      hosts.push(localOutcome('unavailable', 0, null, scope.localError))
      issues.push({ hostId: 'local', kind: 'error', reason: scope.localError })
    } else if (selection.local) {
      const result = await this.localList(listRequest)
      localResults.push(...result.sessions.map(hostedLocal))
      issues.push(...result.issues.map((issue) => ({ ...issue, hostId: 'local' })))
      scannedFiles += result.scannedFiles
      scannedAt = Math.max(scannedAt, result.scannedAt)
      total += result.total
      hasMore ||= result.hasMore
      hosts.push(localOutcome('ok', result.scannedFiles, result.scannedAt))
    }

    for (const host of selection.hosts) {
      try {
        const result = await this.remoteList(host, this.remoteListRequest(request, view, scope))
        localResults.push(...result.sessions)
        issues.push(...result.issues)
        scannedFiles += result.scannedFiles
        scannedAt = Math.max(scannedAt, result.scannedAt)
        total += result.total
        hasMore ||= result.hasMore
        hosts.push(outcome(host.id, host.label, 'ok', undefined, result.scannedFiles, result.scannedAt))
      } catch (error) {
        hosts.push(outcome(host.id, host.label, 'error', messageOf(error), 0, null))
      }
    }

    const sessions = this.sortSessions(localResults, request.sort ?? view.browseSort)
    return { sessions, issues, hosts, scannedFiles, scannedAt, hasMore, total }
  }

  cancelList = async (params: Record<string, unknown>): Promise<{ cancelled: boolean }> => {
    if (typeof params.requestToken !== 'string' || params.requestToken === '') {
      throw this.context.error('invalid-params', 'requestToken is required')
    }
    if (!this.activeLists.has(params.requestToken)) return { cancelled: false }
    try {
      return await this.workerRequest<{ cancelled: boolean }>('cancelList', { requestToken: params.requestToken })
    } catch {
      return { cancelled: false }
    }
  }

  searchStatus = async (params: Record<string, unknown>, caller: PluginCaller): Promise<PublicSearchStatus> => {
    const selector = typeof params.host === 'string' ? params.host : 'local'
    const registry = selector === 'local' ? { hosts: [], issues: [] } : await discoverVaultHosts(this.context)
    const selection = selectHost(selector, registry.hosts)
    assertOwnerHostCaller(this.context, caller, selection.hosts)
    const hosts: HostOutcome[] = [...registry.issues]
    let status = DEFAULT_SEARCH_STATUS

    if (selection.local) {
      try {
        status = await this.localStatus()
        hosts.push(localOutcome('ok', status.filesIndexed, status.lastReconcileAt))
      } catch (error) {
        hosts.push(localOutcome('error', 0, null, messageOf(error)))
      }
    }
    if (selection.unavailable) hosts.push(selection.unavailable)
    for (const host of selection.hosts) {
      try {
        const remote = await callVaultHost(this.context, host, 'searchStatus')
        const remoteStatus = this.remoteStatus(remote)
        if (!selection.local && selection.hosts.length === 1) status = remoteStatus
        hosts.push(outcome(host.id, host.label, 'ok', undefined, remoteStatus.filesIndexed, remoteStatus.lastReconcileAt))
      } catch (error) {
        hosts.push(outcome(host.id, host.label, 'error', messageOf(error), 0, null))
      }
    }
    return { status, hosts }
  }
  getSearchTip = async (): Promise<SearchTipState> => this.enqueuePolicy(async () => this.readSearchTip())

  setSearchEnabled = async (params: Record<string, unknown>, caller: PluginCaller): Promise<PublicSearchStatus> => {
    if (typeof params.enabled !== 'boolean') throw this.context.error('invalid-params', 'enabled must be a boolean')
    const historyDays = this.parseHistoryDays(params.historyDays)
    const selector = typeof params.host === 'string' ? params.host : 'local'
    const registry = selector === 'local' ? { hosts: [], issues: [] } : await discoverVaultHosts(this.context)
    const selection = selectHost(selector, registry.hosts)
    assertOwnerHostCaller(this.context, caller, selection.hosts)
    const hosts: HostOutcome[] = [...registry.issues]

    let status = selection.local ? await this.changeLocalPolicy(params.enabled, historyDays) : DEFAULT_SEARCH_STATUS
    if (selection.local) {
      hosts.push(localOutcome('ok', status.filesIndexed, status.lastReconcileAt))
      if (selection.hosts.length === 0 && !selection.unavailable) return { status, hosts }
    }
    if (selection.unavailable) hosts.push(selection.unavailable)
    for (const host of selection.hosts) {
      try {
        const remote = await callVaultHost(this.context, host, 'setSearchEnabled', {
          enabled: params.enabled,
          ...(historyDays === undefined ? {} : { historyDays })
        })
        const remoteStatus = this.remoteStatus(remote)
        if (!selection.local && selection.hosts.length === 1) status = remoteStatus
        hosts.push(outcome(host.id, host.label, 'ok', undefined, remoteStatus.filesIndexed, remoteStatus.lastReconcileAt))
      } catch (error) {
        hosts.push(outcome(host.id, host.label, 'error', messageOf(error), 0, null))
      }
    }
    return { status, hosts }
  }

  clearSearchIndex = async (): Promise<{ cleared: boolean; status: SearchStatus; hosts: HostOutcome[]; reason?: string }> => {
    return this.enqueuePolicy(async () => {
      try {
        if (this.searchEnabled()) await this.context.call('setting.set', { id: SEARCH_SETTING, value: false })
        await this.applySearchPolicy({ enabled: false, historyDays: this.historyDays() })
        const database = `${this.context.dataDir}/${SEARCH_DATABASE}`
        if (this.worker.started || existsSync(database)) await this.workerRequest('clearSearchIndex', {})
        this.appliedPolicy = undefined
        return { cleared: true, status: await this.readLocalStatus(), hosts: [localOutcome('ok')] }
      } catch (error) {
        return { cleared: false, status: await this.safeLocalStatus(), hosts: [localOutcome('error', 0, null, messageOf(error))], reason: messageOf(error) }
      }
    })
  }
  search = async (params: Record<string, unknown>, caller: PluginCaller): Promise<PublicSearchResponse> => {
    const request = this.parseSearchRequest(params)
    const view = this.view.get(await this.defaultScope(caller))
    const selector = request.host ?? view.host
    const registry = selector === 'local' ? { hosts: [], issues: [] } : await discoverVaultHosts(this.context)
    const selection = selectHost(selector, registry.hosts)
    assertOwnerHostCaller(this.context, caller, selection.hosts)
    if (selection.unavailable) {
      return { kind: 'unavailable', reason: 'no-service', hosts: [...registry.issues, selection.unavailable] }
    }
    const scope = await this.resolveScope(request, view, caller, selection.local)
    if (scope.localError && (!selection.local || selection.hosts.length === 0 || scope.remoteWithin === undefined)) {
      return {
        kind: 'unavailable',
        reason: 'scope-unknown',
        hosts: [
          ...registry.issues,
          ...(selection.local ? [localOutcome('unavailable', 0, null, scope.localError)] : []),
          ...selection.hosts.map((host) => outcome(host.id, host.label, 'unavailable', scope.localError!, 0, null))
        ]
      }
    }
    const localRequest = this.localSearchRequest(request, view, scope.localError ? [] : scope.localPaths)
    const remoteRequest = this.remoteSearchRequest(request, view, scope.remoteWithin)
    if (selector === 'all' && selection.hosts.length > 0) {
      return this.aggregateSearch(request, localRequest, remoteRequest, registry.issues, selection.hosts, scope.localError)
    }
    if (!selection.local) {
      const host = selection.hosts[0]!
      const response = await this.searchRemote(host, remoteRequest)
      return this.publicSearchResponse(response.response, host, [...registry.issues, response.outcome])
    }
    const response = await this.localSearch(localRequest)
    const local = localOutcome(response.kind === 'results' ? 'ok' : 'unavailable', 0, null, response.kind === 'unavailable' ? response.reason : undefined)
    return this.publicLocalSearchResponse(response, [...registry.issues, local])
  }

  private parseListRequest(params: Record<string, unknown>): PublicListRequest {
    if (params.agents !== undefined && (!Array.isArray(params.agents) || !params.agents.every((agent) => typeof agent === 'string'))) {
      throw this.context.error('invalid-params', 'agents must be a list of agent IDs')
    }
    if (params.scopePaths !== undefined) {
      if (!Array.isArray(params.scopePaths) || params.scopePaths.length > MAX_PATHS || !params.scopePaths.every((path) => typeof path === 'string')) {
        throw this.context.error('invalid-params', `scopePaths must contain at most ${MAX_PATHS} paths`)
      }
    }
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > 5000)) {
      throw this.context.error('invalid-params', 'limit must be an integer from 1 to 5000')
    }
    if (params.unlimited !== undefined && typeof params.unlimited !== 'boolean') throw this.context.error('invalid-params', 'unlimited must be a boolean')
    if (params.force !== undefined && typeof params.force !== 'boolean') throw this.context.error('invalid-params', 'force must be a boolean')
    if (params.requestToken !== undefined && (typeof params.requestToken !== 'string' || params.requestToken.length > 256)) {
      throw this.context.error('invalid-params', 'requestToken must be at most 256 characters')
    }
    if (params.sort !== undefined && params.sort !== 'updated' && params.sort !== 'created') {
      throw this.context.error('invalid-params', 'sort must be updated or created')
    }
    if (params.hideEmpty !== undefined && typeof params.hideEmpty !== 'boolean') {
      throw this.context.error('invalid-params', 'hideEmpty must be a boolean')
    }
    if (params.host !== undefined && typeof params.host !== 'string') throw this.context.error('invalid-params', 'host must be a string')
    if (params.within !== undefined && !this.validWithin(params.within)) {
      throw this.context.error('invalid-params', 'within must contain one worktree or repo selector')
    }
    return params as unknown as PublicListRequest
  }

  private parseSearchRequest(params: Record<string, unknown>): SearchRequest {
    if (typeof params.query !== 'string') throw this.context.error('invalid-params', 'query is required')
    if (params.query.length > MAX_QUERY) throw this.context.error('invalid-params', `query must be at most ${MAX_QUERY} characters`)
    if (params.scope !== undefined && params.scope !== 'conversation' && params.scope !== 'all') {
      throw this.context.error('invalid-params', 'scope must be conversation or all')
    }
    if (params.freshness !== undefined && params.freshness !== 'indexed' && params.freshness !== 'wait-until-current') {
      throw this.context.error('invalid-params', 'freshness must be indexed or wait-until-current')
    }
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > 100)) {
      throw this.context.error('invalid-params', 'limit must be an integer from 1 to 100')
    }
    if (params.filters !== undefined && !this.validFilters(params.filters)) {
      throw this.context.error('invalid-params', 'filters are malformed')
    }
    if (params.within !== undefined && !this.validWithin(params.within)) {
      throw this.context.error('invalid-params', 'within must contain one worktree or repo selector')
    }
    if (params.host !== undefined && typeof params.host !== 'string') throw this.context.error('invalid-params', 'host must be a string')
    if (params.debug !== undefined && typeof params.debug !== 'boolean') throw this.context.error('invalid-params', 'debug must be a boolean')
    return params as unknown as SearchRequest
  }

  private validFilters(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const filters = value as RecordValue
    if (filters.agents !== undefined && (!Array.isArray(filters.agents) || !filters.agents.every((agent) => typeof agent === 'string'))) return false
    if (filters.scopePaths !== undefined && (
      !Array.isArray(filters.scopePaths) ||
      filters.scopePaths.length > MAX_PATHS ||
      !filters.scopePaths.every((path) => typeof path === 'string')
    )) return false
    if (filters.since !== undefined && (typeof filters.since !== 'string' || !hasOffset(filters.since))) return false
    if (filters.sort !== undefined && filters.sort !== 'relevance' && filters.sort !== 'newest') return false
    return true
  }

  private validWithin(value: unknown): value is { worktree?: string; repo?: string } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const within = value as RecordValue
    const hasWorktree = within.worktree !== undefined
    const hasRepo = within.repo !== undefined
    return hasWorktree !== hasRepo &&
      (within.worktree === undefined || (typeof within.worktree === 'string' && within.worktree !== '')) &&
      (within.repo === undefined || (typeof within.repo === 'string' && within.repo !== ''))
  }

  private listArgs(request: PublicListRequest, view: ViewState, scopePaths?: string[]): ListRequest {
    const disabled = new Set(view.disabledAgents)
    const enabledAgents = HISTORY_AGENTS.filter((agent) => !disabled.has(agent))
    const agents = request.agents ?? (enabledAgents.length === HISTORY_AGENTS.length ? undefined : enabledAgents)
    const unlimited = request.unlimited ?? (request.limit === undefined && view.sessionLimit === null)
    return {
      ...(agents === undefined ? {} : { agents }),
      ...(scopePaths === undefined ? {} : { scopePaths }),
      ...(request.limit === undefined ? (unlimited ? {} : { limit: view.sessionLimit ?? DEFAULT_LIMIT }) : { limit: request.limit }),
      unlimited,
      ...(request.force === undefined ? {} : { force: request.force }),
      ...(request.requestToken === undefined ? {} : { requestToken: request.requestToken }),
      sort: request.sort ?? view.browseSort,
      hideEmpty: request.hideEmpty ?? view.hideEmptySessions
    }
  }

  private localSearchRequest(request: SearchRequest, view: ViewState, scopePaths?: string[]): SearchRequest {
    const disabled = new Set(view.disabledAgents)
    const enabledAgents = HISTORY_AGENTS.filter((agent) => !disabled.has(agent))
    const filters = { ...(request.filters ?? {}) }
    if (filters.agents === undefined && enabledAgents.length !== HISTORY_AGENTS.length) filters.agents = enabledAgents
    if (filters.sort === undefined) filters.sort = view.searchSort
    const local = { ...request, host: 'local', filters }
    if (scopePaths !== undefined) {
      filters.scopePaths = scopePaths
      // The worker accepts resolved paths, not the public opaque scope selector.
      delete local.within
    }
    return local
  }

  private remoteSearchRequest(request: SearchRequest, view: ViewState, remoteWithin?: { worktree?: string; repo?: string }): SearchRequest {
    const local = this.localSearchRequest(request, view)
    const filters = { ...(local.filters ?? {}) }
    if (request.within === undefined && remoteWithin !== undefined) {
      return { ...local, within: remoteWithin, filters }
    }
    return { ...local, filters }
  }
  private async localList(request: ListRequest): Promise<ListResult> {
    if (request.scopePaths?.length === 0 || request.agents?.length === 0) {
      return { sessions: [], issues: [], scannedFiles: 0, scannedAt: Date.now(), hasMore: false, total: 0 }
    }
    const requestToken = request.requestToken ?? crypto.randomUUID()
    this.activeLists.add(requestToken)
    try {
      return await this.workerRequest<ListResult>('list', {
        request: { ...request, requestToken }
      })
    } finally {
      this.activeLists.delete(requestToken)
    }
  }

  private async resolveScope(
    request: PublicListRequest | SearchRequest,
    view: ViewState,
    caller: PluginCaller,
    resolveLocal = true
  ): Promise<ScopeResolution> {
    const listPaths = 'scopePaths' in request ? request.scopePaths : undefined
    const searchPaths = 'filters' in request ? request.filters?.scopePaths : undefined
    const scopePaths = listPaths ?? searchPaths
    if (request.within !== undefined && scopePaths !== undefined) {
      throw this.context.error('invalid-params', 'within and scopePaths cannot be combined')
    }
    if (scopePaths !== undefined) {
      if (scopePaths.length > MAX_PATHS) throw this.context.error('invalid-params', `at most ${MAX_PATHS} scope paths`)
      return { localPaths: [...scopePaths], remoteScopePaths: [...scopePaths] }
    }
    if (request.within !== undefined) {
      if (!resolveLocal) return { remoteWithin: request.within }
      return (await this.resolveWithin(request.within, caller)) ?? {
        localError: 'requested scope cannot be resolved',
        remoteWithin: request.within
      }
    }
    if (view.scope === 'all') return {}
    const identity = await this.scopeIdentity(caller)
    if (!resolveLocal) {
      const remoteWithin = await this.remoteScopeForView(view.scope, identity)
      return remoteWithin ? { remoteWithin } : { localError: 'requested scope has no caller context' }
    }
    if (view.scope === 'workspace') {
      const workspace = await this.currentWorktree(identity)
      if (workspace) return { localPaths: [workspace.path], remoteWithin: { worktree: workspace.id } }
      return { localError: 'requested workspace cannot be resolved', remoteWithin: await this.remoteScopeForView(view.scope, identity) }
    }
    const repo = await this.currentRepo(identity)
    if (!repo) return { localError: 'requested project cannot be resolved', remoteWithin: await this.remoteScopeForView(view.scope, identity) }
    const paths = await this.repoPaths(repo)
    if (paths.length === 0 || paths.length > MAX_PATHS) {
      return { localError: 'requested project scope is unavailable', remoteWithin: { repo: repo.id } }
    }
    return { localPaths: paths, remoteWithin: { repo: repo.id } }
  }

  private async remoteScopeForView(
    scope: ViewState['scope'],
    identity: ScopeIdentity
  ): Promise<{ worktree?: string; repo?: string } | undefined> {
    if (scope === 'all') return undefined
    if (scope === 'workspace') {
      if (identity.worktreeId !== undefined) return { worktree: identity.worktreeId }
      return identity.cwd === undefined ? undefined : { worktree: `path:${identity.cwd}` }
    }
    if (identity.worktreeId !== undefined) {
      const worktree = await this.currentWorktree(identity)
      return worktree ? { repo: worktree.repoId } : { worktree: identity.worktreeId }
    }
    if (identity.repoId !== undefined) return { repo: identity.repoId }
    if (identity.cwd !== undefined) return { repo: `path:${identity.cwd}` }
    return undefined
  }

  private async defaultScope(caller: PluginCaller): Promise<ViewState['scope']> {
    if (caller.role === 'plugin') return 'all'
    const identity = await this.scopeIdentity(caller)
    if (await this.currentWorktree(identity)) return 'workspace'
    if (await this.currentRepo(identity)) return 'project'
    if (identity.repoId !== undefined) return 'project'
    return identity.worktreeId === undefined ? 'all' : 'workspace'
  }

  private async scopeIdentity(caller: PluginCaller): Promise<ScopeIdentity> {
    if (caller.role === 'plugin') return {}
    const identity: ScopeIdentity = {
      ...(caller.cwd === undefined ? {} : { cwd: caller.cwd }),
      ...(caller.worktreeId === undefined ? {} : { worktreeId: caller.worktreeId })
    }
    if (caller.role !== 'ui') return identity
    const state = await this.context.call('ui.state', {}) as {
      layout?: { view?: { input?: unknown } | null }
    }
    const input = state.layout?.view?.input
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return identity
    const viewInput = input as RecordValue
    const worktreeId = viewInput.worktree
    if (typeof worktreeId === 'string' && worktreeId !== '') return { ...identity, worktreeId }
    const repoId = viewInput.repo
    return typeof repoId === 'string' && repoId !== '' ? { repoId } : identity
  }

  private async currentWorktree(identity: ScopeIdentity): Promise<{ id: string; path: string; repoId: string } | null> {
    if (identity.cwd === undefined && identity.worktreeId === undefined) return null
    try {
      const value = (await this.context.call('quirky.worktree/resolve', {
        selector: 'current',
        ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
        ...(identity.worktreeId === undefined ? {} : { worktreeId: identity.worktreeId })
      })) as { id: string; path: string; repoId: string }
      return typeof value.id === 'string' && typeof value.path === 'string' && typeof value.repoId === 'string' ? value : null
    } catch (error) {
      if (errorCode(error) === RpcErrorCode.NotFound) return null
      throw error
    }
  }

  private async currentRepo(identity: ScopeIdentity): Promise<{ id: string; name: string; path: string } | null> {
    if (identity.worktreeId !== undefined) {
      const worktree = await this.currentWorktree(identity)
      return worktree ? this.repoBySelector(worktree.repoId) : null
    }
    if (identity.repoId !== undefined) return this.repoBySelector(identity.repoId)
    if (identity.cwd === undefined) return null
    const worktree = await this.currentWorktree(identity)
    if (worktree) return this.repoBySelector(worktree.repoId)
    const repos = await this.repoList()
    return repos
      .filter((repo) => pathContains(repo.path, identity.cwd!))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  }



  private async resolveWithin(
    within: { worktree?: string; repo?: string },
    caller: PluginCaller
  ): Promise<ScopeResolution | null> {
    if (within.worktree !== undefined) {
      try {
        const worktree = await this.resolveWorktree(within.worktree, caller)
        return { localPaths: [worktree.path], remoteWithin: { worktree: worktree.id } }
      } catch (error) {
        if (errorCode(error) === RpcErrorCode.NotFound) return null
        throw error
      }
    }
    if (within.repo !== undefined) {
      const repo = await this.repoBySelector(within.repo)
      if (!repo) return null
      const paths = await this.repoPaths(repo)
      if (paths.length === 0 || paths.length > MAX_PATHS) return null
      return { localPaths: paths, remoteWithin: { repo: repo.id } }
    }
    return null
  }

  private async resolveWorktree(selector: string, caller: PluginCaller): Promise<{ id: string; path: string; repoId: string }> {
    const identity = await this.scopeIdentity(caller)
    const worktree = (await this.context.call('quirky.worktree/resolve', { selector, ...identity })) as {
      id: string
      path: string
      repoId: string
    }
    if (typeof worktree.id !== 'string' || typeof worktree.path !== 'string' || typeof worktree.repoId !== 'string') {
      throw this.context.error('conflict', 'worktree resolver returned an invalid workspace')
    }
    return worktree
  }

  private async repoList(): Promise<{ id: string; name: string; path: string }[]> {
    const raw = await this.context.call('quirky.repo/list', {})
    if (!Array.isArray(raw)) throw this.context.error('conflict', 'repository list returned an invalid response')
    return raw.flatMap((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
      const repo = value as RecordValue
      if (typeof repo.id !== 'string' || typeof repo.name !== 'string' || typeof repo.path !== 'string') return []
      return [{ id: repo.id, name: repo.name, path: repo.path }]
    })
  }

  private async repoBySelector(selector: string): Promise<{ id: string; name: string; path: string } | null> {
    const repos = await this.repoList()
    const prefix = selector.startsWith('id:') ? 'id' : selector.startsWith('name:') ? 'name' : selector.startsWith('path:') ? 'path' : null
    const value = prefix === null ? selector : selector.slice(prefix.length + 1)
    const matches = repos.filter((repo) =>
      prefix === 'id' ? repo.id === value :
      prefix === 'name' ? repo.name === value :
      prefix === 'path' ? repo.path === value :
      repo.id === value || repo.name === value || repo.path === value
    )
    return matches.length === 1 ? matches[0]! : null
  }

  private async repoPaths(repo: { id: string; path: string }): Promise<string[]> {
    const raw = await this.context.call('quirky.worktree/list', { repo: repo.id })
    if (!Array.isArray(raw)) throw this.context.error('conflict', 'worktree list returned an invalid response')
    const paths = raw.flatMap((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
      const worktree = value as RecordValue
      return typeof worktree.path === 'string' ? [worktree.path] : []
    })
    if (paths.length === 0) paths.push(repo.path)
    return [...new Set(paths)]
  }
  private remoteListRequest(request: PublicListRequest, view: ViewState, scope: ScopeResolution): PublicListRequest {
    const paths = request.scopePaths ?? scope.remoteScopePaths
    const list = this.listArgs(request, view, paths)
    const within = scope.remoteWithin ?? request.within
    return {
      ...list,
      host: 'local',
      ...(within === undefined ? {} : { within })
    }
  }

  private async remoteList(host: VaultHost, request: PublicListRequest): Promise<{
    sessions: HostedSession[]
    issues: PublicListResult['issues']
    scannedFiles: number
    scannedAt: number
    total: number
    hasMore: boolean
  }> {
    const raw = await callVaultHost(this.context, host, 'list', request as unknown as Record<string, unknown>)
    const parsed = this.parseRemoteList(raw, host)
    if (!parsed) throw new Error('host list response does not match the vault list contract')
    return parsed
  }

  private async localStatus(): Promise<SearchStatus> {
    if (this.searchEnabled()) await this.enqueuePolicy(() => this.applyCurrentPolicy())
    return this.readLocalStatus()
  }

  private async readLocalStatus(): Promise<SearchStatus> {
    if (!this.worker.started) return { ...DEFAULT_SEARCH_STATUS, enabled: this.searchEnabled() }
    const status = await this.workerRequest<SearchStatus>('searchStatus', {})
    return { ...status, supportedAgents: [...HISTORY_AGENTS] }
  }

  private async safeLocalStatus(): Promise<SearchStatus> {
    try {
      return await this.readLocalStatus()
    } catch {
      return { ...DEFAULT_SEARCH_STATUS, enabled: this.searchEnabled(), phase: this.searchEnabled() ? 'degraded' : 'closed' }
    }
  }

  private searchEnabled(): boolean {
    return this.context.getSetting('search-enabled') === true
  }

  private historyDays(): number | null {
    const stored = this.store.get<{ value: string }>('SELECT value FROM vault_state WHERE name = ?', 'historyDays')
    if (!stored) return null
    try {
      const value: unknown = JSON.parse(stored.value)
      return validHistoryDays(value) ? value : null
    } catch {
      return null
    }
  }

  private parseHistoryDays(value: unknown): number | null | undefined {
    if (value === undefined) return undefined
    if (!validHistoryDays(value)) throw this.context.error('invalid-params', 'historyDays must be null or an integer from 1 to 3650')
    return value
  }

  private readSearchTip(): SearchTipState {
    const stored = this.store.get<{ value: string }>('SELECT value FROM vault_state WHERE name = ?', SEARCH_TIP_STATE)
    if (stored) {
      try {
        if (JSON.parse(stored.value) === true) return { id: SEARCH_TIP_ID, seen: true }
      } catch {
        // An invalid canonical value is equivalent to an unseen tip.
      }
    }
    return { id: SEARCH_TIP_ID, seen: false }
  }

  private markSearchTipSeen(): void {
    if (this.readSearchTip().seen) return
    this.store.run(
      'INSERT INTO vault_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
      SEARCH_TIP_STATE,
      JSON.stringify(true)
    )
    const state: SearchTipState = { id: SEARCH_TIP_ID, seen: true }
    this.context.emit('searchTipChanged', state)
  }

  private saveHistoryDays(value: number | null): void {
    this.store.run(
      'INSERT INTO vault_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
      'historyDays',
      JSON.stringify(value)
    )
  }

  private async changeLocalPolicy(enabled: boolean, suppliedHistoryDays: number | null | undefined): Promise<SearchStatus> {
    return this.enqueuePolicy(async () => {
      const previousEnabled = this.searchEnabled()
      const previousHistoryDays = this.historyDays()
      const historyDays = suppliedHistoryDays === undefined ? previousHistoryDays : suppliedHistoryDays
      if (suppliedHistoryDays !== undefined) this.saveHistoryDays(suppliedHistoryDays)
      if (previousEnabled !== enabled) {
        await this.context.call('setting.set', { id: SEARCH_SETTING, value: enabled })
      }
      let status: SearchStatus
      try {
        await this.applySearchPolicy({ enabled, historyDays })
        status = await this.readLocalStatus()
        if (enabled && status.enabled) this.markSearchTipSeen()
      } catch (error) {
        let retentionFailure = ''
        if (enabled) {
          // Turning search off must not depend on a writable ancillary plugin store.
          await this.context.call('setting.set', { id: SEARCH_SETTING, value: false }).catch(() => undefined)
          await this.applySearchPolicy({ enabled: false, historyDays: previousHistoryDays }).catch(() => undefined)
          try {
            this.saveHistoryDays(previousHistoryDays)
          } catch (rollbackError) {
            retentionFailure = `; could not restore history retention: ${messageOf(rollbackError)}`
          }
        }
        throw this.context.error('conflict', `could not ${enabled ? 'enable' : 'disable'} transcript search: ${messageOf(error)}${retentionFailure}`)
      }
      return status
    })
  }

  private async applyCurrentPolicy(): Promise<void> {
    await this.applySearchPolicy({ enabled: this.searchEnabled(), historyDays: this.historyDays() })
  }

  private async applySearchPolicy(policy: { enabled: boolean; historyDays: number | null }): Promise<void> {
    const key = JSON.stringify(policy)
    if (this.appliedPolicy === key && this.worker.started) return
    this.worker.setKeepAlive(policy.enabled)
    if (!policy.enabled && !this.worker.started) {
      this.appliedPolicy = key
      return
    }
    await this.workerRequest('applySearch', { policy })
    this.appliedPolicy = key
  }

  private enqueuePolicy<T>(work: () => Promise<T>): Promise<T> {
    const run = this.policyQueue.then(work, work)
    this.policyQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private onEvent(event: QuirkyEvent): void {
    if (event.type !== 'setting.changed' || event.id !== SEARCH_SETTING || typeof event.value !== 'boolean') return
    const enabled = event.value
    void this.enqueuePolicy(async () => {
      const historyDays = this.historyDays()
      try {
        await this.applySearchPolicy({ enabled, historyDays })
      } catch (error) {
        if (enabled) {
          await this.context.call('setting.set', { id: SEARCH_SETTING, value: false }).catch(() => undefined)
          await this.applySearchPolicy({ enabled: false, historyDays }).catch(() => undefined)
          this.context.notify({ title: 'Could not enable transcript search', body: messageOf(error), toast: true, desktop: false })
        }
      }
    })
  }

  private workerRequest<T>(op: string, args: Record<string, unknown>): Promise<T> {
    return this.worker.request<T>(op, { dataDir: this.context.dataDir, ...args }).catch((error: unknown) => {
      this.appliedPolicy = undefined
      if (error instanceof WorkerRequestError) {
        const kind = error.kind === 'invalid-params' || error.kind === 'not-found' || error.kind === 'conflict'
          ? error.kind
          : 'conflict'
        throw this.context.error(kind, error.message)
      }
      throw error
    })
  }
  private parseRemoteList(value: unknown, host: VaultHost): {
    sessions: HostedSession[]
    issues: PublicListResult['issues']
    scannedFiles: number
    scannedAt: number
    total: number
    hasMore: boolean
  } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const result = value as RecordValue
    if (
      !Array.isArray(result.sessions) ||
      !Array.isArray(result.issues) ||
      typeof result.scannedFiles !== 'number' ||
      typeof result.scannedAt !== 'number' ||
      typeof result.total !== 'number' ||
      typeof result.hasMore !== 'boolean'
    ) return null
    const sessions: HostedSession[] = []
    for (const item of result.sessions) {
      const session = this.remoteSession(item, host)
      if (!session) return null
      sessions.push(session)
    }
    const issues: PublicListResult['issues'] = []
    for (const item of result.issues) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
      const issue = item as RecordValue
      if (
        typeof issue.reason !== 'string' ||
        (issue.kind !== 'error' && issue.kind !== 'notice') ||
        (issue.agent !== undefined && typeof issue.agent !== 'string')
      ) return null
      issues.push({
        hostId: host.id,
        kind: issue.kind,
        reason: redactRemoteText(issue.reason),
        ...(typeof issue.agent === 'string' ? { agent: issue.agent } : {})
      })
    }
    return {
      sessions,
      issues,
      scannedFiles: result.scannedFiles,
      scannedAt: result.scannedAt,
      total: result.total,
      hasMore: result.hasMore
    }
  }

  private remoteSession(value: unknown, host: VaultHost): HostedSession | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const row = value as RecordValue
    const source = typeof row.source === 'object' && row.source !== null && !Array.isArray(row.source)
      ? row.source as RecordValue
      : undefined
    const sourceId = typeof row.sourceId === 'string' ? row.sourceId : row.id
    if (host.owner) {
      const ownerLocalId = typeof row.id === 'string' ? decodePublicId(row.id) : null
      if (row.hostId !== 'local' || !ownerLocalId || ownerLocalId.hostId !== 'local' || ownerLocalId.sourceId !== sourceId) return null
    }
    const presence = source?.presence ?? row.presence
    if (
      typeof sourceId !== 'string' ||
      typeof row.agent !== 'string' ||
      typeof row.sessionId !== 'string' ||
      typeof row.title !== 'string' ||
      (row.cwd !== null && typeof row.cwd !== 'string') ||
      (row.branch !== null && typeof row.branch !== 'string') ||
      (row.model !== null && typeof row.model !== 'string') ||
      typeof row.createdAt !== 'number' ||
      typeof row.updatedAt !== 'number' ||
      typeof row.modifiedAt !== 'number' ||
      typeof row.messageCount !== 'number' ||
      (row.totalTokens !== null && typeof row.totalTokens !== 'number') ||
      typeof row.queuedMessageCount !== 'number' ||
      typeof row.subagentTranscriptCount !== 'number' ||
      !Array.isArray(row.previewMessages) ||
      (presence !== 'present' && presence !== 'missing' && presence !== 'unverifiable')
    ) return null
    const previewMessages: VaultMessage[] = []
    for (const message of row.previewMessages) {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
      const item = message as RecordValue
      if (
        (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'tool' && item.role !== 'system') ||
        typeof item.text !== 'string' ||
        (item.timestamp !== null && typeof item.timestamp !== 'number')
      ) return null
      previewMessages.push({ role: item.role, text: item.text, timestamp: item.timestamp })
    }
    return {
      id: qualifyPublicId(host.id, sourceId),
      sourceId,
      hostId: host.id,
      agent: row.agent,
      sessionId: row.sessionId,
      title: row.title,
      cwd: row.cwd,
      branch: row.branch,
      model: row.model,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      modifiedAt: row.modifiedAt,
      messageCount: row.messageCount,
      totalTokens: row.totalTokens,
      previewMessages,
      queuedMessageCount: row.queuedMessageCount,
      subagentTranscriptCount: row.subagentTranscriptCount,
      ...(typeof row.firstUserPrompt === 'string' ? { firstUserPrompt: row.firstUserPrompt } : {}),
      ...(typeof row.lastUserPrompt === 'string' ? { lastUserPrompt: row.lastUserPrompt } : {}),
      ...(typeof row.subagent === 'boolean' ? { subagent: row.subagent } : {}),
      presence,
      source: { presence }
    }
  }

  private remoteStatus(value: unknown): SearchStatus {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('host search status is not an object')
    const envelope = value as RecordValue
    const raw = envelope.status ?? value
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('host search status is malformed')
    const status = raw as RecordValue
    if (
      typeof status.enabled !== 'boolean' ||
      (status.phase !== 'closed' && status.phase !== 'idle' && status.phase !== 'indexing' && status.phase !== 'current' && status.phase !== 'degraded') ||
      typeof status.filesIndexed !== 'number' ||
      typeof status.filesDue !== 'number' ||
      typeof status.filesFailed !== 'number' ||
      typeof status.messagesIndexed !== 'number' ||
      !Array.isArray(status.degradedRoots) ||
      typeof status.lastReconcileAt !== 'number' && status.lastReconcileAt !== null ||
      typeof status.lastSweepCompletedAt !== 'number' && status.lastSweepCompletedAt !== null ||
      typeof status.generation !== 'number' ||
      !Array.isArray(status.supportedAgents) ||
      !status.supportedAgents.every((agent) => typeof agent === 'string') ||
      typeof status.sessionsByAgent !== 'object' ||
      status.sessionsByAgent === null ||
      Array.isArray(status.sessionsByAgent) ||
      !Object.values(status.sessionsByAgent).every((count) => typeof count === 'number')
    ) throw new Error('host search status is malformed')
    return {
      enabled: status.enabled,
      phase: status.phase,
      filesIndexed: status.filesIndexed,
      filesDue: status.filesDue,
      filesFailed: status.filesFailed,
      messagesIndexed: status.messagesIndexed,
      degradedRoots: status.degradedRoots.map((root) => {
        if (typeof root !== 'object' || root === null || Array.isArray(root)) return { reason: 'invalid host root status' }
        const item = root as RecordValue
        return { reason: typeof item.reason === 'string' ? redactRemoteText(item.reason) : 'invalid host root status' }
      }),
      lastReconcileAt: status.lastReconcileAt,
      lastSweepCompletedAt: status.lastSweepCompletedAt,
      generation: status.generation,
      supportedAgents: status.supportedAgents as string[],
      sessionsByAgent: status.sessionsByAgent as Record<string, number>
    }
  }

  private sortSessions(sessions: HostedSession[], sort: 'updated' | 'created'): HostedSession[] {
    return [...sessions].sort((a, b) => {
      const left = sort === 'created' ? a.createdAt : a.updatedAt
      const right = sort === 'created' ? b.createdAt : b.updatedAt
      return right - left || a.id.localeCompare(b.id)
    })
  }

  private async searchRemote(host: VaultHost, request: SearchRequest): Promise<{ response: SearchResponse; outcome: HostOutcome }> {
    try {
      const raw = await callVaultHost(this.context, host, 'search', request as unknown as Record<string, unknown>)
      const response = this.parseRemoteSearch(raw, host)
      if (!response) throw new Error('host search response does not match the vault search contract')
      const kind = response.kind === 'unavailable' ? 'unavailable' : 'ok'
      const reason = response.kind === 'unavailable' ? response.reason : undefined
      return { response, outcome: outcome(host.id, host.label, kind, reason, 0, null) }
    } catch (error) {
      return {
        response: { kind: 'unavailable', reason: 'no-service' },
        outcome: outcome(host.id, host.label, 'error', messageOf(error), 0, null)
      }
    }
  }

  private parseRemoteSearch(value: unknown, host: VaultHost): SearchResponse | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const response = value as RecordValue
    if (response.kind === 'stale-cursor' || response.kind === 'malformed-cursor') return { kind: response.kind }
    if (response.kind === 'unavailable') {
      if (
        response.reason !== 'disabled' &&
        response.reason !== 'not-ready' &&
        response.reason !== 'no-service' &&
        response.reason !== 'scope-unknown' &&
        response.reason !== 'unsupported-agent'
      ) return null
      return { kind: 'unavailable', reason: response.reason }
    }
    if (response.kind !== 'results' || !Array.isArray(response.hits) || typeof response.generation !== 'number') return null
    if (
      typeof response.page !== 'object' ||
      response.page === null ||
      typeof response.truncated !== 'object' ||
      response.truncated === null ||
      typeof response.durationMs !== 'number'
    ) return null
    const page = response.page as RecordValue
    const truncated = response.truncated as RecordValue
    if ((page.cursor !== null && typeof page.cursor !== 'string') || typeof page.hasMore !== 'boolean') return null
    if (
      typeof truncated.candidates !== 'boolean' ||
      typeof truncated.snippets !== 'boolean' ||
      typeof truncated.query !== 'boolean' ||
      typeof truncated.freshness !== 'boolean'
    ) return null
    const hits: SearchHit[] = []
    for (const value of response.hits) {
      const hit = this.parseRemoteHit(value, host)
      if (!hit) return null
      hits.push(hit)
    }
    const repairedTerms = response.repairedTerms
    if (
      repairedTerms !== undefined &&
      (typeof repairedTerms !== 'object' || repairedTerms === null || Array.isArray(repairedTerms) ||
        !Object.values(repairedTerms).every((term) => typeof term === 'string'))
    ) return null
    return {
      kind: 'results',
      hits,
      page: { cursor: page.cursor as string | null, hasMore: page.hasMore },
      generation: response.generation,
      truncated: {
        candidates: truncated.candidates,
        snippets: truncated.snippets,
        query: truncated.query,
        freshness: truncated.freshness
      },
      durationMs: response.durationMs,
      ...(repairedTerms === undefined ? {} : { repairedTerms: repairedTerms as Record<string, string> })
    }
  }

  private parseRemoteHit(value: unknown, host: VaultHost): SearchHit | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const hit = value as RecordValue
    const source = typeof hit.source === 'object' && hit.source !== null && !Array.isArray(hit.source)
      ? hit.source as RecordValue
      : undefined
    const evidence = hit.evidence
    if (
      typeof hit.id !== 'string' ||
      typeof hit.agent !== 'string' ||
      typeof hit.sessionId !== 'string' ||
      typeof hit.title !== 'string' ||
      (hit.cwd !== null && typeof hit.cwd !== 'string') ||
      (hit.branch !== null && typeof hit.branch !== 'string') ||
      typeof hit.updatedAt !== 'number' ||
      typeof hit.messageCount !== 'number' ||
      typeof hit.score !== 'number' ||
      typeof hit.duplicateCount !== 'number' ||
      !source ||
      (source.presence !== 'present' && source.presence !== 'missing' && source.presence !== 'unverifiable')
    ) return null
    if (host.owner) {
      const sourceId = typeof hit.sourceId === 'string' ? hit.sourceId : null
      const ownerLocalId = decodePublicId(hit.id)
      if (
        hit.hostId !== 'local' ||
        sourceId === null ||
        !ownerLocalId ||
        ownerLocalId.hostId !== 'local' ||
        ownerLocalId.sourceId !== sourceId
      ) return null
    }
    if (evidence !== null) {
      if (typeof evidence !== 'object' || Array.isArray(evidence)) return null
      const item = evidence as RecordValue
      if (
        typeof item.snippet !== 'string' ||
        (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'tool' && item.role !== 'system') ||
        (item.timestamp !== null && typeof item.timestamp !== 'number')
      ) return null
    }
    return {
      id: hit.id,
      ...(typeof hit.sourceId === 'string' ? { sourceId: hit.sourceId } : {}),
      agent: hit.agent,
      sessionId: hit.sessionId,
      title: hit.title,
      cwd: hit.cwd,
      branch: hit.branch,
      updatedAt: hit.updatedAt,
      messageCount: hit.messageCount,
      score: hit.score,
      duplicateCount: hit.duplicateCount,
      source: { presence: source.presence },
      evidence: evidence as SearchHit['evidence']
  }
  }

  private publicSearchResponse(response: SearchResponse, host: VaultHost, hostOutcomes: HostOutcome[]): PublicSearchResponse {
    if (response.kind !== 'results') return { ...response, hosts: hostOutcomes }
    const hits = response.hits.map((hit) => ({
      ...hit,
      id: qualifyPublicId(host.id, hit.sourceId ?? hit.id),
      sourceId: hit.sourceId ?? hit.id,
      hostId: host.id,
      source: { presence: hit.source.presence }
    }))
    return { ...response, hits, hosts: hostOutcomes }
  }
  private publicLocalSearchResponse(response: SearchResponse, hostOutcomes: HostOutcome[]): PublicSearchResponse {
    if (response.kind !== 'results') return { ...response, hosts: hostOutcomes }
    const hits = response.hits.map((hit) => ({
      ...hit,
      id: qualifyPublicId('local', hit.sourceId ?? hit.id),
      sourceId: hit.sourceId ?? hit.id,
      hostId: 'local'
    }))
    return { ...response, hits, hosts: hostOutcomes }
  }

  private async aggregateSearch(
    request: SearchRequest,
    localRequest: SearchRequest,
    remoteRequest: SearchRequest,
    registryIssues: HostOutcome[],
    hosts: VaultHost[],
    localUnavailableReason?: string
  ): Promise<PublicSearchResponse> {
    const startedAt = Date.now()
    const targets: SearchHost[] = [
      { id: 'local', label: 'Local Mac', local: true },
      ...hosts.map((host) => ({ id: host.id, label: host.label, local: false, contribution: host }))
    ]
    const hostIds = targets.map((host) => host.id)
    const requestKey = this.searchRequestKey(request)
    const limit = request.limit ?? DEFAULT_LIMIT
    let state: AggregateCursor = {
      requestKey,
      hostIds,
      hosts: Object.fromEntries(hostIds.map((id) => [id, { cursor: null, hasMore: id !== 'local' || localUnavailableReason === undefined, generation: 0 }])),
      buffered: [],
      truncated: { candidates: false, snippets: false, query: false, freshness: false }
    }
    if (request.cursor !== undefined) {
      const decoded = this.decodeAggregateCursor(request.cursor)
      if (!decoded) return { kind: 'malformed-cursor', hosts: registryIssues }
      if (decoded.requestKey !== requestKey) return { kind: 'malformed-cursor', hosts: registryIssues }
      if (decoded.hostIds.length !== hostIds.length || decoded.hostIds.some((id, index) => id !== hostIds[index])) {
        return { kind: 'stale-cursor', hosts: registryIssues }
      }
      state = decoded
    }

    const candidates = [...state.buffered]
    const hostOutcomes = [...registryIssues]
    if (localUnavailableReason) hostOutcomes.push(localOutcome('unavailable', 0, null, localUnavailableReason))
    const repairedTerms = { ...(state.repairedTerms ?? {}) }
    const truncated = { ...state.truncated }
    const pendingHosts = state.buffered.length >= limit ? [] : targets.filter((host) => state.hosts[host.id]?.hasMore)
    let successfulHosts = state.buffered.length > 0 ? 1 : 0
    const unavailableReasons: string[] = []

    for (const target of pendingHosts) {
      const current = state.hosts[target.id]!
      const baseRequest = target.local ? localRequest : remoteRequest
      const hostRequest: SearchRequest = { ...baseRequest, limit }
      delete hostRequest.cursor
      if (typeof current.cursor === 'string') hostRequest.cursor = current.cursor
      let response: SearchResponse
      let hostOutcome: HostOutcome
      if (target.local) {
        response = await this.localSearch(hostRequest)
        hostOutcome = localOutcome(response.kind === 'results' ? 'ok' : 'unavailable', 0, null, response.kind === 'unavailable' ? response.reason : undefined)
        const wrapped = this.publicLocalSearchResponse(response, [])
        if (wrapped.kind === 'results') response = wrapped
      } else {
        const remote = await this.searchRemote(target.contribution!, hostRequest)
        response = remote.response
        hostOutcome = remote.outcome
        if (response.kind === 'results') {
          const wrapped = this.publicSearchResponse(response, target.contribution!, [])
          if (wrapped.kind === 'results') response = wrapped
        }
      }
      hostOutcomes.push(hostOutcome)
      if (response.kind === 'stale-cursor') return { kind: 'stale-cursor', hosts: hostOutcomes }
      if (response.kind === 'malformed-cursor') return { kind: 'malformed-cursor', hosts: hostOutcomes }
      if (response.kind === 'unavailable') {
        current.hasMore = false
        unavailableReasons.push(response.reason)
        continue
      }
      successfulHosts++
      candidates.push(...response.hits)
      current.cursor = response.page.cursor
      current.hasMore = response.page.hasMore
      current.generation = response.generation
      truncated.candidates ||= response.truncated.candidates
      truncated.snippets ||= response.truncated.snippets
      truncated.query ||= response.truncated.query
      truncated.freshness ||= response.truncated.freshness
      if (response.repairedTerms) Object.assign(repairedTerms, response.repairedTerms)
    }

    if (successfulHosts === 0) {
      return { kind: 'unavailable', reason: this.unavailableReason(unavailableReasons), hosts: hostOutcomes }
    }
    const sort = localRequest.filters?.sort ?? 'relevance'
    candidates.sort((a, b) => sort === 'newest'
      ? b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
      : b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const hits = candidates.slice(0, limit)
    const buffered = candidates.slice(limit)
    const hasMore = buffered.length > 0 || hostIds.some((id) => state.hosts[id]?.hasMore === true)
    const cursor = hasMore
      ? this.encodeAggregateCursor({ ...state, buffered, truncated, repairedTerms })
      : null
    const generation = this.aggregateGeneration(hostIds, state.hosts)
    return {
      kind: 'results',
      hits,
      page: { cursor, hasMore },
      generation,
      truncated,
      durationMs: Date.now() - startedAt,
      ...(Object.keys(repairedTerms).length === 0 ? {} : { repairedTerms }),
      hosts: hostOutcomes
    }
  }
  private async localSearch(request: SearchRequest): Promise<SearchResponse> {
    if (!this.searchEnabled()) return { kind: 'unavailable', reason: 'disabled' }
    try {
      await this.enqueuePolicy(() => this.applyCurrentPolicy())
      if (request.filters?.agents?.length === 0 || request.filters?.scopePaths?.length === 0) {
        const status = await this.readLocalStatus()
        return {
          kind: 'results',
          hits: [],
          page: { cursor: null, hasMore: false },
          generation: status.generation,
          truncated: { candidates: false, snippets: false, query: false, freshness: false },
          durationMs: 0
        }
      }
      return await this.workerRequest<SearchResponse>('search', { request })
    } catch {
      return { kind: 'unavailable', reason: 'no-service' }
    }
  }

  private searchRequestKey(request: SearchRequest): string {
    const filters = request.filters ?? {}
    const stable = JSON.stringify({
      query: request.query,
      scope: request.scope ?? 'all',
      freshness: request.freshness ?? 'indexed',
      limit: request.limit ?? DEFAULT_LIMIT,
      filters: {
        agents: filters.agents ?? null,
        scopePaths: filters.scopePaths ?? null,
        since: filters.since ?? null,
        sort: filters.sort ?? 'relevance'
      },
      within: request.within ?? null,
      debug: request.debug ?? false
    })
    return createHash('sha256').update(stable).digest('hex')
  }

  private encodeAggregateCursor(cursor: AggregateCursor): string {
    return `vault1s.${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`
  }

  private decodeAggregateCursor(cursor: string): AggregateCursor | null {
    if (!cursor.startsWith('vault1s.')) return null
    try {
      const raw: unknown = JSON.parse(Buffer.from(cursor.slice(7), 'base64url').toString('utf8'))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
      const value = raw as RecordValue
      if (
        typeof value.requestKey !== 'string' ||
        !Array.isArray(value.hostIds) ||
        !value.hostIds.every((id) => typeof id === 'string') ||
        typeof value.hosts !== 'object' ||
        value.hosts === null ||
        Array.isArray(value.hosts) ||
        !Array.isArray(value.buffered) ||
        typeof value.truncated !== 'object' ||
        value.truncated === null ||
        Array.isArray(value.truncated)
      ) return null
      const hosts: Record<string, AggregateHostState> = {}
      const hostState = value.hosts as RecordValue
      for (const id of value.hostIds as string[]) {
        const state = hostState[id]
        if (typeof state !== 'object' || state === null || Array.isArray(state)) return null
        const entry = state as RecordValue
        if (
          (entry.cursor !== null && typeof entry.cursor !== 'string') ||
          typeof entry.hasMore !== 'boolean' ||
          typeof entry.generation !== 'number'
        ) return null
        hosts[id] = { cursor: entry.cursor as string | null, hasMore: entry.hasMore, generation: entry.generation }
      }
      const buffered: SearchHit[] = []
      for (const hit of value.buffered) {
        if (!this.validSearchHit(hit)) return null
        buffered.push(hit)
      }
      const truncated = value.truncated as RecordValue
      if (
        typeof truncated.candidates !== 'boolean' ||
        typeof truncated.snippets !== 'boolean' ||
        typeof truncated.query !== 'boolean' ||
        typeof truncated.freshness !== 'boolean'
      ) return null
      const repairedTerms = value.repairedTerms
      if (
        repairedTerms !== undefined &&
        (typeof repairedTerms !== 'object' || repairedTerms === null || Array.isArray(repairedTerms) ||
          !Object.values(repairedTerms).every((term) => typeof term === 'string'))
      ) return null
      return {
        requestKey: value.requestKey,
        hostIds: value.hostIds as string[],
        hosts,
        buffered,
        truncated: {
          candidates: truncated.candidates,
          snippets: truncated.snippets,
          query: truncated.query,
          freshness: truncated.freshness
        },
        ...(repairedTerms === undefined ? {} : { repairedTerms: repairedTerms as Record<string, string> })
      }
    } catch {
      return null
    }
  }

  private validSearchHit(value: unknown): value is SearchHit {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const hit = value as RecordValue
    if (
      typeof hit.id !== 'string' ||
      typeof hit.agent !== 'string' ||
      typeof hit.sessionId !== 'string' ||
      typeof hit.title !== 'string' ||
      (hit.cwd !== null && typeof hit.cwd !== 'string') ||
      (hit.branch !== null && typeof hit.branch !== 'string') ||
      typeof hit.updatedAt !== 'number' ||
      typeof hit.messageCount !== 'number' ||
      typeof hit.score !== 'number' ||
      typeof hit.duplicateCount !== 'number' ||
      typeof hit.source !== 'object' ||
      hit.source === null ||
      Array.isArray(hit.source)
    ) return false
    const source = hit.source as RecordValue
    return (
      source.presence === 'present' || source.presence === 'missing' || source.presence === 'unverifiable'
    )
  }

  private aggregateGeneration(hostIds: string[], hosts: Record<string, AggregateHostState>): number {
    const value = JSON.stringify(hostIds.map((id) => [id, hosts[id]?.generation ?? 0]))
    return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16)
  }

  private unavailableReason(reasons: string[]): Extract<SearchResponse, { kind: 'unavailable' }>['reason'] {
    if (reasons.includes('scope-unknown')) return 'scope-unknown'
    if (reasons.includes('unsupported-agent')) return 'unsupported-agent'
    if (reasons.includes('not-ready')) return 'not-ready'
    if (reasons.length > 0 && reasons.every((reason) => reason === 'disabled')) return 'disabled'
    return 'no-service'
  }
}

function validHistoryDays(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650)
}

function hasOffset(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
}

function pathContains(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
}

function redactRemoteText(value: string): string {
  return redactReason(value)
}

function errorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'number') return undefined
  return error.code
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
