import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { MobileConnectionState } from '../../contracts'
import type { PanelBridge, PanelProps } from '../contracts'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  applyNotificationBatch,
  createNotificationFeedState,
  errorMessage,
  isActivityRecord,
  mergeUsageStates,
  notificationCheckpoint,
  parseMobileNotificationPreferences,
  parseNotificationBatch,
  parseNotificationCheckpoint,
  resumeVaultSource,
  projectAccountState,
  selectProviderAccount,
  type AccountPanelSnapshot,
  type AccountRowView,
  type MobileNotification,
  type MobileNotificationPreferences,
  type NotificationFeedState,
  type Provider,
  type ResumedSession,
  type UsageWindowView
} from './model'

type LivePanelBridge = PanelBridge & {
  readonly state: MobileConnectionState
  onState(handler: (state: MobileConnectionState) => void): () => void
}

const panel: CSSProperties = { boxSizing: 'border-box', width: '100%', maxWidth: 760, margin: '0 auto', padding: 16, color: '#e5e7eb', font: '14px/1.45 system-ui, sans-serif' }
const card: CSSProperties = { boxSizing: 'border-box', border: '1px solid #374151', borderRadius: 12, padding: 14, background: '#111827', marginTop: 12 }
const button: CSSProperties = { minHeight: 40, padding: '8px 12px', border: '1px solid #4b5563', borderRadius: 8, color: 'inherit', background: '#1f2937', font: 'inherit', cursor: 'pointer' }
const muted: CSSProperties = { color: '#9ca3af', fontSize: 13 }
const errorStyle: CSSProperties = { ...muted, color: '#fca5a5', marginTop: 8 }
const header: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const sectionTitle: CSSProperties = { margin: 0, fontSize: 17 }
type NotificationClientState = {
  ready: boolean
  preferences: MobileNotificationPreferences
  feed: NotificationFeedState
  connection: MobileConnectionState | null
  connected: boolean
  pollError: string | null
  storageError: string | null
}

type NotificationClientStore = {
  snapshot: NotificationClientState
  listeners: Set<() => void>
  getSnapshot: () => NotificationClientState
  subscribe: (listener: () => void) => () => void
}

const notificationClientStores = new Map<string, NotificationClientStore>()
const activeNotificationManagers = new Set<string>()
let foregroundAudioContext: AudioContext | null = null

function notificationClientStore(hostId: string): NotificationClientStore {
  const existing = notificationClientStores.get(hostId)
  if (existing) return existing
  const store: NotificationClientStore = {
    snapshot: {
      ready: false,
      preferences: DEFAULT_NOTIFICATION_PREFERENCES,
      feed: createNotificationFeedState(),
      connection: null,
      connected: false,
      pollError: null,
      storageError: null
    },
    listeners: new Set(),
    getSnapshot: () => store.snapshot,
    subscribe: (listener) => {
      store.listeners.add(listener)
      return () => { store.listeners.delete(listener) }
    }
  }
  notificationClientStores.set(hostId, store)
  return store
}

function updateNotificationClient(hostId: string, patch: Partial<NotificationClientState>): void {
  const store = notificationClientStore(hostId)
  store.snapshot = { ...store.snapshot, ...patch }
  for (const listener of [...store.listeners]) listener()
}

function useNotificationClient(hostId: string): NotificationClientState {
  const store = notificationClientStore(hostId)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function ActivityPanel({ bridge, route }: PanelProps) {
  const hostKey = bridge.init.host.id
  if (route.kind === 'accounts') return <AccountsPanel key={hostKey} bridge={bridge} />
  if (route.kind === 'agent-history') return <HistoryPanel key={`${hostKey}:${route.worktreeId}`} bridge={bridge} worktreeId={route.worktreeId} />
  if (route.kind === 'notifications') return <NotificationsPanel key={`${hostKey}:${route.worktreeId ?? ''}`} bridge={bridge} worktreeId={route.worktreeId} />
  return null
}

function AccountsPanel({ bridge }: { bridge: PanelBridge }) {
  const live = bridge as LivePanelBridge
  const [connection, setConnection] = useState<MobileConnectionState>(live.state)
  const connectionRef = useRef<MobileConnectionState>(live.state)
  connectionRef.current = connection
  const [snapshot, setSnapshot] = useState<AccountPanelSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [hostStale, setHostStale] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null)
  const requestGeneration = useRef(0)
  const inactiveUsage = useRef<Partial<Record<Provider, unknown>>>({})


  const load = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (connectionRef.current.phase !== 'connected') {
      setHostStale(true)
      setAccountError(connectionHint(connectionRef.current))
      setLoading(false)
      return
    }
    setLoading(true)
    const [accountResult, usageResult] = await Promise.allSettled([
      bridge.call('quirky.accounts/list', {}),
      bridge.call('quirky.accounts/usage', {})
    ])
    if (generation !== requestGeneration.current) return
    if (accountResult.status === 'rejected') {
      setHostStale(true)
      setAccountError(`Account records could not be refreshed: ${errorMessage(accountResult.reason)}`)
      setLoading(false)
      return
    }
    const usageValues = [
      ...(usageResult.status === 'fulfilled' ? [usageResult.value] : []),
      ...Object.values(inactiveUsage.current)
    ]
    const usage = mergeUsageStates(usageValues)
    const next = projectAccountState(accountResult.value, usage)
    if (!next) {
      setHostStale(true)
      setAccountError('The host returned incomplete account metadata. Refresh to try again.')
    } else {
      setSnapshot(next)
      setHostStale(false)
      setAccountError(null)
    }
    setUsageError(usageResult.status === 'rejected' ? `Provider usage could not be read: ${errorMessage(usageResult.reason)}` : null)
    setLoading(false)
  }, [bridge])

  useEffect(() => {
    const unsubscribeEvents = bridge.onEvent(({ event }) => {
      if (event === 'quirky.accounts/changed') {
        inactiveUsage.current = {}
        void load()
      } else if (event === 'quirky.accounts/usageChanged') void load()
    })
    const unsubscribeState = live.onState((next) => {
      connectionRef.current = next
      setConnection(next)
      if (next.phase === 'connected') void load()
      else {
        requestGeneration.current++
        setHostStale(true)
        setAccountError(connectionHint(next))
        setLoading(false)
      }
    })
    if (live.state.phase === 'connected') void load()
    else {
      setHostStale(true)
      setAccountError(connectionHint(live.state))
      setLoading(false)
    }
    return () => {
      requestGeneration.current++
      unsubscribeEvents()
      unsubscribeState()
    }
  }, [bridge, live, load])

  const refreshUsage = async (provider: Provider) => {
    if (busyProvider !== null || connectionRef.current.phase !== 'connected') return
    setBusyProvider(provider)
    setUsageError(null)
    try {
      await bridge.call('quirky.accounts/refresh', { provider, force: true })
      inactiveUsage.current[provider] = await bridge.call('quirky.accounts/inactiveUsage', { provider })
      await load()
    } catch (error) {
      setHostStale(true)
      setAccountError(`${providerLabel(provider)} usage could not be refreshed: ${errorMessage(error)}`)
    } finally {
      setBusyProvider(null)
    }
  }

  const select = async (provider: Provider, accountId: string | null) => {
    if (!snapshot || hostStale || busyProvider !== null || connectionRef.current.phase !== 'connected') return
    setBusyProvider(provider)
    setAccountError(null)
    const result = await selectProviderAccount((method, params) => bridge.call(method, params), snapshot, provider, accountId)
    if (result.error) {
      setHostStale(true)
      setAccountError(`Could not select ${providerLabel(provider)} account: ${result.error}`)
    } else {
      setSnapshot(result.snapshot)
      setHostStale(false)
      await load()
    }
    setBusyProvider(null)
  }

  return <main style={panel} aria-labelledby=\"activity-accounts-title\">
    <header style={header}>
      <div>
        <h1 id=\"activity-accounts-title\" style={{ ...sectionTitle, fontSize: 21 }}>Accounts</h1>
        <p style={muted}>Provider accounts on {bridge.init.host.name}. Credentials stay on the desktop host.</p>
      </div>
      <button type=\"button\" style={button} onClick={() => void load()} disabled={loading || connection.phase !== 'connected'}>Refresh</button>
    </header>
    {connection.phase !== 'connected' ? <p role=\"status\" style={errorStyle}>{connectionHint(connection)}</p> : null}
    {hostStale ? <p role=\"status\" style={errorStyle}>Host account data is stale. Changes are disabled until the host reconnects and account data refreshes.</p> : null}
    {accountError ? <p role=\"alert\" style={errorStyle}>{accountError}</p> : null}
    {usageError ? <p role=\"status\" style={muted}>{usageError}</p> : null}
    {loading && !snapshot ? <p role=\"status\" style={muted}>Loading account records and usage…</p> : null}
    {snapshot ? (['claude', 'codex'] as const).map((provider) => {
      const rows = snapshot.rows.filter((row) => row.provider === provider)
      return <section key={provider} style={card} aria-labelledby={`accounts-${provider}`}>
        <header style={header}>
          <h2 id={`accounts-${provider}`} style={sectionTitle}>{providerLabel(provider)}</h2>
          <button type=\"button\" style={button} onClick={() => void refreshUsage(provider)} disabled={loading || busyProvider !== null || connection.phase !== 'connected'}>
            {busyProvider === provider ? 'Refreshing…' : 'Refresh usage'}
          </button>
        </header>
        {rows.filter((row) => row.isSystemDefault).map((row) => <AccountRow key={`${provider}:system`} row={row} stale={hostStale} busy={busyProvider !== null} onSelect={select} />)}
        {rows.filter((row) => !row.isSystemDefault).length === 0 ? <p style={muted}>No configured accounts.</p> : null}
        {rows.filter((row) => !row.isSystemDefault).map((row) => <AccountRow key={row.id ?? `${provider}:system`} row={row} stale={hostStale} busy={busyProvider !== null} onSelect={select} />)}
      </section>
    }) : null}
    <p style={{ ...muted, marginTop: 16 }}>Add accounts or reauthenticate in desktop Settings. Mobile does not create or transfer credentials.</p>
  </main>
}


function AccountRow({ row, stale, busy, onSelect }: {
  row: AccountRowView
  stale: boolean
  busy: boolean
  onSelect(provider: Provider, accountId: string | null): void
}) {
  const identity = [row.email, row.organization, row.isSystemDefault ? `${row.authKind} · ${row.hasAuth ? 'configured' : 'not configured'}` : null].filter(Boolean).join(' · ')
  return <article style={{ borderTop: '1px solid #374151', paddingTop: 12, marginTop: 12 }}>
    <div style={header}>
      <div style={{ minWidth: 0 }}>
        <strong>{row.label}</strong>
        {identity ? <div style={muted}>{identity}</div> : null}
        {row.needsSignIn ? <div style={errorStyle}>Sign in again from desktop Settings to use this account.</div> : null}
      </div>
      <button
        type="button"
        style={button}
        aria-label={row.active ? `Active ${row.label}` : `Select ${row.label}`}
        aria-pressed={row.active}
        disabled={row.active || stale || busy || row.needsSignIn}
        onClick={() => onSelect(row.provider, row.id)}
      >{row.active ? 'Active' : row.needsSignIn ? 'Needs sign-in' : 'Select'}</button>
    </div>
    <div style={{ ...muted, display: 'grid', gridTemplateColumns: '1fr', gap: 3, marginTop: 8 }}>
      <span>5-hour: {usageWindowLabel(row.fiveHour)}</span>
      <span>7-day: {usageWindowLabel(row.sevenDay)}</span>
    </div>
  </article>
}

function usageWindowLabel(window: UsageWindowView | null): string {
  if (!window) return 'Unknown'
  const reset = window.resetDescription || (window.resetsAt === null ? 'reset unknown' : `resets ${new Date(window.resetsAt).toLocaleString()}`)
  return `${Math.round(window.usedPercent)}% used · ${reset}`
}

function providerLabel(provider: string): string {
  if (provider === 'claude') return 'Claude'
  if (provider === 'codex') return 'Codex'
  return provider
}

type RepoRow = { id: string; name: string; path: string }
type HistoryScope = 'workspace' | 'project' | 'all'
type HistoryEntry = {
  id: string
  hostId: string
  agent: string
  sessionId: string
  title: string
  cwd: string | null
  branch: string | null
  updatedAt: number
  evidenceAt: number | null
  messageCount: number
  presence: 'present' | 'missing' | 'unverifiable'
  preview: string | null
  resumable: boolean
}
type WorktreeScope = { name: string | null; repoId: string | null; loading: boolean; error: string | null }

function HistoryPanel({ bridge, worktreeId }: { bridge: PanelBridge; worktreeId: string }) {
  const live = bridge as LivePanelBridge
  const [connection, setConnection] = useState<MobileConnectionState>(live.state)
  const connectionRef = useRef<MobileConnectionState>(live.state)
  connectionRef.current = connection

  const [scope, setScope] = useState<HistoryScope>('workspace')
  const [query, setQuery] = useState('')
  const [scopeInfo, setScopeInfo] = useState<WorktreeScope>({ name: null, repoId: null, loading: true, error: null })
  const [repos, setRepos] = useState<RepoRow[]>([])
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [listHasMore, setListHasMore] = useState(false)
  const [busySession, setBusySession] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const requestGeneration = useRef(0)
  useEffect(() => {
    const unsubscribe = live.onState((next) => {
      connectionRef.current = next
      setConnection(next)
      if (next.phase !== 'connected') {
        requestGeneration.current++
        setBusy(false)
        setError(connectionHint(next))
      }
    })
    return unsubscribe
  }, [live])


  useEffect(() => {
    let current = true
    if (connection.phase !== 'connected') {
      setScopeInfo({ name: null, repoId: null, loading: false, error: connectionHint(connection) })
      return
    }

    setScopeInfo({ name: null, repoId: null, loading: true, error: null })
    const results = Promise.allSettled([
      bridge.call('quirky.worktree/resolve', { selector: `id:${worktreeId}` }),
      bridge.call('quirky.repo/list', {})
    ])
    void results.then(([worktree, repositoryList]) => {
      if (!current) return
      if (worktree.status === 'fulfilled' && isActivityRecord(worktree.value)) {
        setScopeInfo({
          name: typeof worktree.value.name === 'string' ? worktree.value.name : null,
          repoId: typeof worktree.value.repoId === 'string' ? worktree.value.repoId : null,
          loading: false,
          error: null
        })
      } else {
        const reason = worktree.status === 'rejected' ? errorMessage(worktree.reason) : 'The selected workspace is unavailable.'
        setScopeInfo({ name: null, repoId: null, loading: false, error: reason })
      }
      if (repositoryList.status === 'fulfilled' && Array.isArray(repositoryList.value)) {
        setRepos(repositoryList.value.flatMap((value) => isActivityRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.path === 'string'
          ? [{ id: value.id, name: value.name, path: value.path }]
          : []))
      }
    })
    return () => { current = false }
  }, [bridge, connection.phase, worktreeId])


  const within = useMemo((): Record<string, string> | null => {
    if (scope === 'workspace') return { worktree: worktreeId }
    if (scope === 'project') return scopeInfo.repoId ? { repo: scopeInfo.repoId } : null
    return null
  }, [scope, scopeInfo.repoId, worktreeId])

  const runHistory = useCallback(async (force: boolean, append: boolean, requestedCursor: string | null = null) => {
    const generation = ++requestGeneration.current
    if (connectionRef.current.phase !== 'connected') {
      setError(connectionHint(connectionRef.current))
      setBusy(false)
      return
    }

    if (scopeInfo.loading) return
    if (scope === 'project' && !scopeInfo.repoId) {
      setEntries([])
      setError('Project scope is unavailable. Switch to Workspace or All.')
      setBusy(false)
      return
    }
    if (scope === 'workspace' && !worktreeId) {
      setEntries([])
      setError('Workspace scope is unavailable. Switch to Project or All.')
      setBusy(false)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    const searchText = query.trim()
    try {
      if (searchText) {
        const params: Record<string, unknown> = {
          host: 'local',
          query: searchText,
          scope: 'all',
          freshness: force ? 'wait-until-current' : 'indexed',
          limit: 50,
          filters: { sort: 'newest' },
          ...(within ? { within } : {}),
          ...(append && requestedCursor ? { cursor: requestedCursor } : {})
        }
        const response = await bridge.call('quirky.vault/search', params)
        if (generation !== requestGeneration.current) return
        if (!isActivityRecord(response)) throw new Error('The host returned an invalid history search response.')
        if (response.kind !== 'results') {
          setEntries([])
          setCursor(null)
          setHasMore(false)
          setListHasMore(false)
          setError(searchFailure(response))
          return
        }
        const next = Array.isArray(response.hits) ? response.hits.flatMap((value) => parseSearchEntry(value)) : []
        setEntries((previous) => append ? appendUnique(previous, next) : next)
        const page = isActivityRecord(response.page) ? response.page : null
        setCursor(page && typeof page.cursor === 'string' ? page.cursor : null)
        setHasMore(page?.hasMore === true)
        setListHasMore(false)
      } else {
        const params: Record<string, unknown> = { host: 'local', limit: 100, sort: 'updated', force, ...(within ? { within } : {}) }
        const response = await bridge.call('quirky.vault/list', params)
        if (generation !== requestGeneration.current) return
        if (!isActivityRecord(response) || !Array.isArray(response.sessions)) throw new Error('The host returned an invalid history list.')
        const next = response.sessions.flatMap((value) => parseListEntry(value))
        setEntries(next)
        setCursor(null)
        setHasMore(false)
        setListHasMore(response.hasMore === true)
        if (Array.isArray(response.issues) && response.issues.length > 0) setNotice('Some history sources could not be read. Refresh for current results or switch scope.')
      }
    } catch (caught) {
      if (generation === requestGeneration.current) setError(errorMessage(caught))
    } finally {
      if (generation === requestGeneration.current) setBusy(false)
    }
  }, [bridge, connection.phase, query, scope, scopeInfo.loading, scopeInfo.repoId, within, worktreeId])


  useEffect(() => {
    const timer = setTimeout(() => void runHistory(false, false), query.trim() ? 250 : 0)
    return () => {
      clearTimeout(timer)
      requestGeneration.current++
    }
  }, [runHistory, query])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const resume = async (entry: HistoryEntry) => {
    if (!entry.resumable || busySession !== null || connectionRef.current.phase !== 'connected') return

    setBusySession(entry.id)
    setError(null)
    setNotice(null)
    try {
      const result: ResumedSession = await resumeVaultSource(
        (method, params) => bridge.call(method, params),
        (destination) => bridge.navigate(destination),
        entry.id
      )
      setNotice(`Opened ${result.title || entry.title || result.id}.`)
    } catch (caught) {
      setError(`Could not resume ${entry.title || entry.sessionId}: ${errorMessage(caught)}`)
    } finally {
      setBusySession(null)
    }
  }

  const groupLabel = (entry: HistoryEntry): string => {
    if (scope === 'workspace') return scopeInfo.name || 'Workspace'
    if (scope === 'project') return repos.find((repo) => repo.id === scopeInfo.repoId)?.name ?? 'Project'
    return repoLabelForPath(entry.cwd, repos)
  }
  const groups = useMemo(() => {
    const result = new Map<string, HistoryEntry[]>()
    for (const entry of entries) {
      const label = groupLabel(entry)
      const group = result.get(label) ?? []
      group.push(entry)
      result.set(label, group)
    }
    return [...result.entries()]
  }, [entries, repos, scope, scopeInfo.name, scopeInfo.repoId])

  return <main style={panel} aria-labelledby="activity-history-title">
    <header style={header}>
      <div>
        <h1 id="activity-history-title" style={{ ...sectionTitle, fontSize: 21 }}>Agent history</h1>
        <p style={muted}>Sessions indexed on {bridge.init.host.name}. Resume opens the actual host session.</p>
      </div>
      <button type="button" style={button} disabled={busy || connection.phase !== 'connected'} onClick={() => void runHistory(true, false)}>Refresh</button>
    </header>
    {connection.phase !== 'connected' ? <p role="status" style={errorStyle}>{connectionHint(connection)} The displayed history is stale; resume is disabled.</p> : null}
    <div role="group" aria-label="History scope" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
      {(['workspace', 'project', 'all'] as const).map((value) => <button
        key={value}
        type="button"
        style={{ ...button, borderColor: scope === value ? '#60a5fa' : '#4b5563', background: scope === value ? '#1e3a5f' : '#1f2937' }}
        aria-pressed={scope === value}
        disabled={value === 'project' && !scopeInfo.repoId}
        onClick={() => { setScope(value); setEntries([]); setError(null); setNotice(null) }}
      >{value === 'workspace' ? 'Workspace' : value === 'project' ? 'Project' : 'All'}</button>)}
    </div>
    {scopeInfo.loading ? <p role="status" style={muted}>Resolving workspace and project…</p> : null}
    {scopeInfo.error ? <p style={muted}>The selected workspace could not be resolved. Workspace results may be unavailable; Project requires an available repository.</p> : null}
    <label htmlFor="activity-history-query" style={{ display: 'block', marginTop: 8, fontWeight: 600 }}>Search sessions</label>
    <input
      id="activity-history-query"
      type="search"
      value={query}
      onChange={(event) => { setQuery(event.currentTarget.value); setEntries([]); setError(null); setNotice(null) }}
      placeholder="Search titles and messages; try repo: or path:"
      style={{ boxSizing: 'border-box', width: '100%', minHeight: 44, marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #4b5563', color: 'inherit', background: '#111827', font: 'inherit' }}
    />
    {busy ? <p role="status" style={muted}>{query.trim() ? 'Searching indexed conversations…' : 'Loading sessions…'}</p> : null}
    {error ? <p role="alert" style={errorStyle}>{error}</p> : null}
    {notice ? <p role="status" style={muted}>{notice}</p> : null}
    {!busy && !error && entries.length === 0 ? <p style={muted}>{query.trim() ? 'No matching sessions. Search requires the host’s enabled vault index.' : 'No agent history in this scope.'}</p> : null}
    {groups.map(([label, group]) => <section key={label} style={card} aria-label={`${label} sessions`}>
      <h2 style={sectionTitle}>{label}</h2>
      {group.map((entry) => <HistoryRow key={`${entry.hostId}:${entry.id}`} entry={entry} now={now} busy={busySession === entry.id} disabled={busySession !== null || connection.phase !== 'connected'} onResume={() => void resume(entry)} />)}
    </section>)}
    {query.trim() && hasMore && cursor ? <button type="button" style={{ ...button, width: '100%', marginTop: 12 }} disabled={busy} onClick={() => void runHistory(false, true, cursor)}>Load more results</button> : null}
    {!query.trim() && listHasMore ? <p style={muted}>More sessions are available. Narrow the scope or search to find older history.</p> : null}
  </main>
}

function HistoryRow({ entry, now, busy, disabled, onResume }: { entry: HistoryEntry; now: number; busy: boolean; disabled: boolean; onResume(): void }) {
  const ageTimestamp = entry.evidenceAt ?? entry.updatedAt
  return <article style={{ borderTop: '1px solid #374151', paddingTop: 12, marginTop: 12 }}>
    <div style={header}>
      <div style={{ minWidth: 0 }}>
        <strong>{entry.title || entry.sessionId}</strong>
        <div style={muted}>{agentLabel(entry.agent)} · {entry.messageCount} messages · {ageLabel(ageTimestamp, now)}</div>
        {entry.branch ? <div style={muted}>Branch: {entry.branch}</div> : null}
      </div>
      <button type="button" style={button} disabled={!entry.resumable || disabled} onClick={onResume} aria-label={`Resume ${entry.title || entry.sessionId}`}>
        {busy ? 'Starting…' : entry.resumable ? 'Resume' : 'Unavailable'}
      </button>
    </div>
    {entry.preview ? <p style={{ ...muted, marginBottom: 0, overflowWrap: 'anywhere', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>{entry.preview}</p> : null}
    {entry.presence !== 'present' ? <p style={muted}>Transcript {entry.presence === 'missing' ? 'is missing' : 'availability could not be verified'}.</p> : null}
  </article>
}

function parseListEntry(value: unknown): HistoryEntry[] {
  if (!isActivityRecord(value) || typeof value.id !== 'string' || typeof value.sessionId !== 'string') return []
  const source = isActivityRecord(value.source) ? value.source : null
  const presence = source?.presence ?? value.presence
  const normalizedPresence = presence === 'present' || presence === 'missing' ? presence : 'unverifiable'
  const previewMessages = Array.isArray(value.previewMessages) ? value.previewMessages : []
  const preview = previewMessages.slice().reverse().find((message) => isActivityRecord(message) && typeof message.text === 'string')
  const messageCount = typeof value.messageCount === 'number' && Number.isFinite(value.messageCount) ? value.messageCount : 0
  const queued = typeof value.queuedMessageCount === 'number' && value.queuedMessageCount > 0
  const subagents = typeof value.subagentTranscriptCount === 'number' && value.subagentTranscriptCount > 0
  const hasConversation = previewMessages.some((message) => isActivityRecord(message) && (message.role === 'user' || message.role === 'assistant'))
  return [{
    id: value.id,
    hostId: typeof value.hostId === 'string' ? value.hostId : 'local',
    agent: typeof value.agent === 'string' ? value.agent : 'unknown',
    sessionId: value.sessionId,
    title: typeof value.title === 'string' ? value.title : value.sessionId,
    cwd: typeof value.cwd === 'string' ? value.cwd : null,
    branch: typeof value.branch === 'string' ? value.branch : null,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    evidenceAt: null,
    messageCount,
    presence: normalizedPresence,
    preview: preview && isActivityRecord(preview) ? preview.text as string : typeof value.lastUserPrompt === 'string' ? value.lastUserPrompt : null,
    resumable: (typeof value.hostId !== 'string' || value.hostId === 'local') && normalizedPresence === 'present' && (messageCount > 0 || queued || subagents || hasConversation)
  }]
}

function parseSearchEntry(value: unknown): HistoryEntry[] {
  if (!isActivityRecord(value) || typeof value.id !== 'string' || typeof value.sessionId !== 'string') return []
  const source = isActivityRecord(value.source) ? value.source : null
  const evidence = isActivityRecord(value.evidence) ? value.evidence : null
  const presence = source?.presence
  const normalizedPresence = presence === 'present' || presence === 'missing' ? presence : 'unverifiable'
  const messageCount = typeof value.messageCount === 'number' && Number.isFinite(value.messageCount) ? value.messageCount : 0
  return [{
    id: value.id,
    hostId: typeof value.hostId === 'string' ? value.hostId : 'local',
    agent: typeof value.agent === 'string' ? value.agent : 'unknown',
    sessionId: value.sessionId,
    title: typeof value.title === 'string' ? value.title : value.sessionId,
    cwd: typeof value.cwd === 'string' ? value.cwd : null,
    branch: typeof value.branch === 'string' ? value.branch : null,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    evidenceAt: typeof evidence?.timestamp === 'number' && Number.isFinite(evidence.timestamp) ? evidence.timestamp : null,
    messageCount,
    presence: normalizedPresence,
    preview: typeof evidence?.snippet === 'string' ? evidence.snippet : null,
    resumable: (typeof value.hostId !== 'string' || value.hostId === 'local') && normalizedPresence === 'present' && messageCount > 0
  }]
}

function appendUnique(previous: HistoryEntry[], incoming: HistoryEntry[]): HistoryEntry[] {
  const ids = new Set(previous.map((entry) => entry.id))
  return [...previous, ...incoming.filter((entry) => !ids.has(entry.id))]
}

function searchFailure(response: Record<string, unknown>): string {
  if (response.kind === 'stale-cursor') return 'The history index changed while searching. Refresh and try again.'
  if (response.kind === 'malformed-cursor') return 'This search page is no longer valid. Refresh to start again.'
  if (response.kind === 'unavailable') {
    if (response.reason === 'disabled') return 'Vault search is disabled on this host. Enable it in desktop Settings.'
    if (response.reason === 'not-ready') return 'The vault index is not ready yet. Refresh in a moment.'
    if (response.reason === 'unsupported-agent') return 'The host cannot search this provider’s history.'
    if (response.reason === 'scope-unknown') return 'This scope is unavailable. Switch to All or refresh the workspace.'
  }
  return 'The host could not search agent history.'
}

function repoLabelForPath(path: string | null, repos: RepoRow[]): string {
  if (!path) return 'No project'
  const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '') || '/'
  const cwd = normalize(path)
  const repo = repos.filter((item) => cwd === normalize(item.path) || cwd.startsWith(`${normalize(item.path)}/`)).sort((left, right) => right.path.length - left.path.length)[0]
  return repo?.name ?? cwd.split('/').filter(Boolean).at(-1) ?? cwd
}

function agentLabel(agent: string): string {
  return agent.length === 0 ? 'Unknown provider' : agent[0]!.toUpperCase() + agent.slice(1)
}

function ageLabel(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Age unknown'
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString()
}


function NotificationsPanel({ bridge, worktreeId }: { bridge: PanelBridge; worktreeId?: string }) {
  const hostId = bridge.init.host.id
  const client = useNotificationClient(hostId)
  const live = bridge as LivePanelBridge
  const [connection, setConnection] = useState<MobileConnectionState>(live.state)
  const [preferenceBusy, setPreferenceBusy] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const focusedWorktree = worktreeId || bridge.init.host.lastWorktree || null
  const audioSupported = foregroundSoundSupported()

  useEffect(() => live.onState(setConnection), [live])

  const savePreferences = async (next: MobileNotificationPreferences): Promise<boolean> => {
    if (preferenceBusy || !client.ready) return false
    setPreferenceBusy(true)
    try {
      await bridge.storage.set(`mobile.activity.notifications.v1:${hostId}:preferences`, JSON.stringify(next))
      updateNotificationClient(hostId, { preferences: next, storageError: null })
      return true
    } catch (caught) {
      updateNotificationClient(hostId, { storageError: `Device notification preferences could not be saved: ${errorMessage(caught)}` })
      return false
    } finally {
      setPreferenceBusy(false)
    }
  }

  const updatePreference = async (change: Partial<MobileNotificationPreferences>): Promise<boolean> =>
    savePreferences({ ...client.preferences, ...change })

  const changeSound = async (enabled: boolean) => {
    if (enabled) {
      try {
        await activateForegroundSound()
      } catch (caught) {
        setTestMessage(`Foreground sound is unavailable: ${errorMessage(caught)}`)
        return
      }
    }
    const saved = await updatePreference({ soundWhileOpen: enabled })
    if (!saved && enabled && foregroundAudioContext && foregroundAudioContext.state !== 'closed') {
      await foregroundAudioContext.suspend().catch(() => undefined)
    } else if (saved && !enabled && foregroundAudioContext && foregroundAudioContext.state !== 'closed') {
      await foregroundAudioContext.suspend().catch(() => undefined)
    }
  }

  const sendTest = async () => {
    if (testBusy || !client.preferences.enabled || connection.phase !== 'connected') return
    setTestBusy(true)
    setTestMessage(null)
    try {
      const result = await bridge.call('quirky.mobile/notificationTest', {})
      if (!isActivityRecord(result) || result.sent !== true) throw new Error('The host did not confirm the test event.')
      setTestMessage('Test event sent to this device. It appears in the in-app alert list while the page is open.')
    } catch (caught) {
      setTestMessage(`Test event could not be sent: ${errorMessage(caught)}. It was not retried.`)
    } finally {
      setTestBusy(false)
    }
  }

  return <main style={panel} aria-labelledby=\"activity-notifications-title\">
    <header style={header}>
      <div>
        <h1 id=\"activity-notifications-title\" style={{ ...sectionTitle, fontSize: 21 }}>Notifications</h1>
        <p style={muted}>Live alerts from {bridge.init.host.name} on this device. No background push is enabled.</p>
      </div>
    </header>
    {connection.phase !== 'connected' ? <p role=\"status\" style={errorStyle}>{connectionHint(connection)} Alerts are paused and the current list may be stale.</p> : null}
    <section style={card} aria-label=\"Device notification settings\">
      {!client.ready ? <p role=\"status\" style={muted}>Loading this device’s notification settings…</p> : null}
      <PreferenceToggle
        label=\"Enable live alerts on this device\"
        checked={client.preferences.enabled}
        disabled={!client.ready || preferenceBusy}
        onChange={(checked) => void updatePreference({ enabled: checked })}
      />
      <p style={muted}>Alerts are received only while the paired host is reachable and the app page is open.</p>
      <PreferenceToggle
        label=\"Only when the desktop is away\"
        checked={client.preferences.onlyWhenDesktopAway}
        disabled={!client.ready || preferenceBusy}
        onChange={(checked) => void updatePreference({ onlyWhenDesktopAway: checked })}
      />
      <PreferenceToggle
        label=\"Suppress alerts for the focused workspace\"
        checked={client.preferences.suppressFocusedWorkspace}
        disabled={!focusedWorktree || !client.ready || preferenceBusy}
        onChange={(checked) => void updatePreference({ suppressFocusedWorkspace: checked })}
      />
      {!focusedWorktree ? <p style={muted}>Workspace suppression is unavailable outside a selected or last-viewed workspace.</p> : null}
      <PreferenceToggle
        label=\"Play a sound while this page is open\"
        checked={audioSupported && client.preferences.soundWhileOpen}
        disabled={!audioSupported || !client.ready || preferenceBusy}
        onChange={(checked) => void changeSound(checked)}
      />
      {!audioSupported ? <p style={muted}>Foreground sound is unavailable in this browser; no sound control is enabled.</p> : null}
      {audioSupported ? <p style={muted}>The short tone needs a user gesture for this app session and never plays in the background.</p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button type=\"button\" style={button} disabled={!client.preferences.enabled || connection.phase !== 'connected' || testBusy} onClick={() => void sendTest()}>
          {testBusy ? 'Sending test…' : 'Send test event'}
        </button>
        <span role=\"status\" style={{ ...muted, alignSelf: 'center' }}>
          {!client.ready ? 'Loading' : !client.preferences.enabled ? 'Disabled on this device' : connection.phase !== 'connected' ? connectionHint(connection) : client.pollError ? `Reconnecting: ${client.pollError}` : client.connected ? 'Connected · live while open' : 'Waiting for the first host response…'}
        </span>
      </div>
      {testMessage ? <p role=\"status\" style={testMessage.startsWith('Test event could not') || testMessage.startsWith('Foreground sound') ? errorStyle : muted}>{testMessage}</p> : null}
      {client.storageError ? <p role=\"alert\" style={errorStyle}>{client.storageError}</p> : null}
      {client.preferences.enabled && !client.feed.presenceAvailable ? <p role=\"status\" style={muted}>Desktop presence is unavailable. Unknown presence is treated as away, so the away-only filter cannot be guaranteed.</p> : null}
      {(client.feed.reset || client.feed.truncated) ? <p role=\"status\" style={muted}>The host’s bounded replay history reset or was truncated. Some older alerts may be unavailable.</p> : null}
    </section>
    <p style={muted}>{client.feed.notifications.length === 0 ? 'No alerts have been received on this device yet.' : `${client.feed.notifications.length} recent alerts are listed in the in-app notification tray across routes.`}</p>
  </main>
}
export function DirectNotifications({ bridge, viewedWorktree }: { bridge: PanelBridge; viewedWorktree?: string }) {
  const live = bridge as LivePanelBridge
  const hostId = bridge.init.host.id
  const storageKey = `mobile.activity.notifications.v1:${hostId}`
  const preferencesKey = `${storageKey}:preferences`
  const checkpointKey = `${storageKey}:checkpoint`
  const client = useNotificationClient(hostId)
  const [connection, setConnection] = useState<MobileConnectionState>(live.state)
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  const preferencesRef = useRef(client.preferences)
  preferencesRef.current = client.preferences
  const feedRef = useRef(client.feed)
  feedRef.current = client.feed
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const focusedWorktree = viewedWorktree || bridge.init.host.lastWorktree || null

  useEffect(() => {
    const updateConnection = (next: MobileConnectionState) => {
      connectionRef.current = next
      setConnection(next)
      updateNotificationClient(hostId, {
        connection: next,
        ...(next.phase === 'connected' ? { pollError: null } : { connected: false, pollError: connectionHint(next) })
      })
    }
    updateConnection(live.state)
    return live.onState(updateConnection)
  }, [bridge, hostId, live])

  useEffect(() => {
    let active = true
    updateNotificationClient(hostId, { ready: false, connection: connectionRef.current, connected: false, pollError: null, storageError: null })
    void Promise.allSettled([bridge.storage.get(preferencesKey), bridge.storage.get(checkpointKey)]).then(([savedPreferences, savedCheckpoint]) => {
      if (!active) return
      const storedPreferences = savedPreferences.status === 'fulfilled'
        ? parseMobileNotificationPreferences(savedPreferences.value)
        : DEFAULT_NOTIFICATION_PREFERENCES
      const preferences = storedPreferences.soundWhileOpen
        ? { ...storedPreferences, soundWhileOpen: false }
        : storedPreferences
      const feed = savedCheckpoint.status === 'fulfilled'
        ? parseNotificationCheckpoint(savedCheckpoint.value) ?? createNotificationFeedState()
        : createNotificationFeedState()
      updateNotificationClient(hostId, {
        ready: true,
        preferences,
        feed,
        connection: connectionRef.current,
        storageError: savedPreferences.status === 'rejected' || savedCheckpoint.status === 'rejected'
          ? 'This device could not restore its notification settings or replay cursor.'
          : null
      })
    })
    return () => { active = false }
  }, [bridge, checkpointKey, hostId, preferencesKey])

  useEffect(() => {
    if (!client.ready || !client.preferences.enabled || connection.phase !== 'connected') {
      updateNotificationClient(hostId, { connected: false })
      return
    }
    if (activeNotificationManagers.has(hostId)) {
      updateNotificationClient(hostId, { pollError: 'Another notification manager is already active for this host.' })
      return
    }
    activeNotificationManagers.add(hostId)
    const subscriptionId = globalThis.crypto.randomUUID()
    let active = true
    let failures = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let cancelRetry: (() => void) | null = null
    updateNotificationClient(hostId, { connected: false, pollError: null })

    const run = async () => {
      while (active) {
        const currentPreferences = preferencesRef.current
        if (!currentPreferences.enabled || connectionRef.current.phase !== 'connected') break
        const cursor = feedRef.current
        const params: Record<string, unknown> = {
          subscriptionId,
          waitMs: 20_000,
          ...(cursor.epoch === null ? {} : { after: cursor.cursor, epoch: cursor.epoch }),
          onlyWhenDesktopAway: currentPreferences.onlyWhenDesktopAway,
          ...(currentPreferences.suppressFocusedWorkspace && focusedWorktree ? { suppressWorktree: focusedWorktree } : {})
        }
        try {
          const value = await bridge.call('quirky.mobile/notificationPoll', params, { timeoutMs: 30_000 })
          if (!active || !preferencesRef.current.enabled || connectionRef.current.phase !== 'connected') break
          const batch = parseNotificationBatch(value)
          if (!batch) throw new Error('The host returned an invalid notification replay response.')
          const next = applyNotificationBatch(feedRef.current, batch)
          feedRef.current = next
          updateNotificationClient(hostId, { feed: next, connected: true, pollError: null })
          failures = 0
          try {
            await bridge.storage.set(checkpointKey, notificationCheckpoint(next))
            if (active) updateNotificationClient(hostId, { storageError: null })
          } catch {
            if (active) updateNotificationClient(hostId, { storageError: 'Notification history could not be saved on this device; reconnects may replay recent alerts.' })
          }
          if (!active) break
          if (next.arrivals.length > 0 && preferencesRef.current.soundWhileOpen) playForegroundTone(foregroundAudioContext)
        } catch (caught) {
          if (!active) break
          failures++
          updateNotificationClient(hostId, { connected: false, pollError: errorMessage(caught) })
          const retry = Promise.withResolvers<void>()
          cancelRetry = retry.resolve
          retryTimer = setTimeout(retry.resolve, Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)))
          await retry.promise
          retryTimer = null
          cancelRetry = null
        }
      }
    }
    void run()
    return () => {
      active = false
      activeNotificationManagers.delete(hostId)
      if (retryTimer !== null) clearTimeout(retryTimer)
      cancelRetry?.()
      void bridge.call('quirky.mobile/notificationCancel', { subscriptionId }).catch(() => undefined)
    }
  }, [bridge, checkpointKey, client.preferences, client.ready, connection.phase, focusedWorktree, hostId])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => () => {
    const context = foregroundAudioContext
    foregroundAudioContext = null
    if (context && context.state !== 'closed') void context.close()
  }, [])

  const openNotification = async (notification: MobileNotification) => {
    setNavigationError(null)
    try {
      if (notification.worktreeId) {
        await bridge.navigate({
          kind: 'session',
          worktreeId: notification.worktreeId,
          ...(notification.sessionId ? { sessionId: notification.sessionId } : {})
        })
        return
      }
      if (!notification.sessionId) throw new Error('This alert has no workspace or session destination.')
      const session = await bridge.call('quirky.session/get', { session: notification.sessionId })
      if (!isActivityRecord(session) || typeof session.id !== 'string' || typeof session.worktreeId !== 'string') {
        throw new Error('The host could not resolve this alert to an active session.')
      }
      await bridge.navigate({ kind: 'session', worktreeId: session.worktreeId, sessionId: session.id })
    } catch (caught) {
      setNavigationError(`Could not open this alert: ${errorMessage(caught)}`)
    }
  }

  if (!client.ready || (!client.preferences.enabled && client.feed.notifications.length === 0)) return null
  const status = !client.preferences.enabled
    ? 'Disabled on this device'
    : connection.phase !== 'connected'
      ? connectionHint(connection)
      : client.pollError
        ? `Reconnecting: ${client.pollError}`
        : client.connected
          ? 'Live while this page is open'
          : 'Connecting to host…'
  return <aside
    aria-label=\"In-app notifications\"
    style={{
      ...card,
      position: 'fixed',
      left: '50%',
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
      transform: 'translateX(-50%)',
      width: 'min(520px, calc(100vw - 24px))',
      maxHeight: '34vh',
      overflowY: 'auto',
      zIndex: 100,
      boxShadow: '0 8px 28px rgba(0,0,0,.35)',
      margin: 0
    }}
  >
    <div aria-live=\"polite\" role=\"status\" style={muted}>{status}</div>
    {client.preferences.enabled && !client.feed.presenceAvailable ? <p style={muted}>Desktop presence is unavailable; unknown presence is not suppressed.</p> : null}
    {(client.feed.reset || client.feed.truncated) ? <p style={muted}>Some older alerts were unavailable in the bounded replay history.</p> : null}
    {navigationError ? <p role=\"alert\" style={errorStyle}>{navigationError}</p> : null}
    {client.storageError ? <p role=\"status\" style={muted}>{client.storageError}</p> : null}
    {client.feed.arrivals[0] ? <div aria-live=\"polite\" style={{ borderTop: '1px solid #374151', paddingTop: 8, marginTop: 8 }}>
      <strong>New alert: {client.feed.arrivals[0].title}</strong>
      <p style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>{client.feed.arrivals[0].body}</p>
      <button type=\"button\" style={button} disabled={!client.feed.arrivals[0].worktreeId && !client.feed.arrivals[0].sessionId} onClick={() => void openNotification(client.feed.arrivals[0]!)}>Open workspace or session</button>
    </div> : null}
    {client.feed.notifications.length > 0 ? <details>
      <summary>Recent alerts ({client.feed.notifications.length})</summary>
      <div aria-label=\"Recent host alerts\" style={{ maxHeight: '24vh', overflowY: 'auto' }}>
        {client.feed.notifications.map((notification) => <NotificationRow
          key={`${client.feed.epoch}:${notification.id}`}
          notification={notification}
          now={now}
          onOpen={() => void openNotification(notification)}
        />)}
      </div>
    </details> : <p style={muted}>Live alerts are enabled. No alerts have arrived on this device.</p>}
  </aside>
}


function PreferenceToggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange(checked: boolean): void }) {
  return <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 42, cursor: disabled ? 'default' : 'pointer' }}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    <span>{label}</span>
  </label>
}

function NotificationRow({ notification, now, onOpen }: { notification: MobileNotification; now: number; onOpen?: () => void }) {
  return <article style={{ borderTop: '1px solid #374151', paddingTop: 12, marginTop: 12 }}>
    <strong>{notification.title}</strong>
    <div style={muted}>{ageLabel(notification.at, now)}{notification.desktopAway === null ? ' · desktop presence unknown' : notification.desktopAway ? ' · desktop away' : ' · desktop active'}</div>
    <p style={{ marginBottom: 0, overflowWrap: 'anywhere' }}>{notification.body}</p>
    {onOpen ? <button type=\"button\" style={{ ...button, marginTop: 8 }} disabled={!notification.worktreeId && !notification.sessionId} onClick={onOpen}>Open workspace or session</button> : null}
  </article>
}
function foregroundSoundSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.AudioContext === 'function'
}

async function activateForegroundSound(): Promise<void> {
  if (!foregroundSoundSupported()) throw new Error('This browser does not provide foreground audio.')
  foregroundAudioContext ??= new window.AudioContext()
  await foregroundAudioContext.resume()
  if (foregroundAudioContext.state !== 'running') throw new Error('The browser did not allow foreground audio.')
  playForegroundTone(foregroundAudioContext)
}


function playForegroundTone(context: AudioContext | null): void {
  if (!context || context.state === 'closed') return
  void context.resume().then(() => {
    if (context.state === 'closed') return
    const startedAt = context.currentTime
    const oscillator = context.createOscillator()
    const volume = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(740, startedAt)
    volume.gain.setValueAtTime(0.0001, startedAt)
    volume.gain.exponentialRampToValueAtTime(0.08, startedAt + 0.015)
    volume.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.16)
    oscillator.connect(volume)
    volume.connect(context.destination)
    oscillator.onended = () => { oscillator.disconnect(); volume.disconnect() }
    oscillator.start(startedAt)
    oscillator.stop(startedAt + 0.17)
  }).catch(() => undefined)
}
function connectionHint(connection: MobileConnectionState): string {
  const detail = connection.message ? ` ${connection.message}` : ''
  return `The paired host is ${connection.phase.replaceAll('-', ' ')}.${detail}`
}
