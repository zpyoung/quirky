import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode } from 'react'
import type { ProjectGroup, Repo, Session, Worktree, WorktreeCreateResult, WorkspaceOriginView, WorkspaceSleepState } from '@quirky/protocol'
import type { MobilePageBridge, MobileRoute } from '../contracts'
import { PageError, PageModal, errorMessage, statusLabel } from './components'
import { matchesWorkspaceFilters } from './workspace-filters'
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  projectWorkspaceSessions,
  readWorkspaceCache,
  readWorkspacePreferences,
  writeWorkspaceCache,
  writeWorkspacePreferences,
  type WorkspaceCache,
  type WorkspaceFilterKey,
  type WorkspaceGroupBy,
  type WorkspacePreferences,
  type WorkspacePropertyKey,
  type WorkspaceSessionSummary,
  type WorkspaceSortBy
} from './storage'

type Props = {
  bridge: MobilePageBridge
  connected: boolean
  onNavigate(route: MobileRoute | { kind: 'home' }): Promise<void>
  onReport(state: Record<string, unknown>): void
}

type DeleteDialog = { worktree: Worktree; description: string }
type GroupedRows = { key: string; label: string; worktrees: Worktree[] }

const GROUP_OPTIONS: Array<{ value: WorkspaceGroupBy; label: string }> = [
  { value: 'none', label: 'None' }, { value: 'status', label: 'Status' }, { value: 'pr', label: 'PR' }, { value: 'project', label: 'Project' }
]
const SORT_OPTIONS: Array<{ value: WorkspaceSortBy; label: string }> = [
  { value: 'name', label: 'Name' }, { value: 'agentActivity', label: 'Agent Activity' }, { value: 'recent', label: 'Recent' }, { value: 'project', label: 'Project' }, { value: 'manual', label: 'Manual' }
]
const PROPERTY_OPTIONS: Array<{ value: WorkspacePropertyKey; label: string }> = [
  { value: 'status', label: 'Status' }, { value: 'branch', label: 'Branch' }, { value: 'project', label: 'Project' },
  { value: 'kind', label: 'Workspace kind' }, { value: 'path', label: 'Workspace path' }, { value: 'head', label: 'Head commit' },
  { value: 'baseRef', label: 'Base ref' }, { value: 'projectGroup', label: 'Project group' }, { value: 'branchRetention', label: 'Branch retention' },
  { value: 'pushTarget', label: 'Push target' }, { value: 'pullRequest', label: 'PR/MR link' }, { value: 'issue', label: 'Issue' },
  { value: 'comment', label: 'Notes' }, { value: 'creator', label: 'Created by' }, { value: 'activity', label: 'Agent activity' }, { value: 'tabCount', label: 'Session count' }
]
const FILTER_OPTIONS: Array<{ key: WorkspaceFilterKey; label: string; detail: string }> = [
  { key: 'exceptDefaultBranch', label: 'Except default branch', detail: 'Keep the primary worktree visible when other filters would hide it.' },
  { key: 'hideDefaultBranch', label: 'Hide default branch', detail: 'Hide primary worktrees.' },
  { key: 'hideSleeping', label: 'Hide sleeping', detail: 'Hide only workspaces whose sessions are authoritatively asleep. Partial recovery stays visible.' },
  { key: 'hideAutomationCreated', label: 'Hide automation-created', detail: 'Hide only workspaces with recorded automation origin. Unknown origins remain visible.' },
  { key: 'hideCliCreated', label: 'Hide CLI-created', detail: 'Hide workspaces whose source is the Quirky CLI.' },
  { key: 'hideOtherClient', label: 'Hide other-client workspaces', detail: 'Hide workspaces proven to originate from another client. Unknown origins remain visible.' },
  { key: 'hideDetachedHead', label: 'Hide detached HEAD', detail: 'Hide worktrees without a branch name.' }
]

function viewportCells(): { cols: number; rows: number } {
  const width = typeof window === 'undefined' ? 390 : window.innerWidth
  const height = typeof window === 'undefined' ? 844 : window.innerHeight
  return {
    cols: Math.max(20, Math.min(160, Math.floor((width - 28) / 8))),
    rows: Math.max(10, Math.min(80, Math.floor((height - 230) / 18)))
  }
}

function displayName(repo: Repo | undefined, group: ProjectGroup | undefined, worktree: Worktree): string {
  if (repo) return repo.displayName || repo.name
  if (group) return group.name
  if (worktree.repoId.startsWith('group:')) return 'Project group'
  return 'Unknown project'
}

function statusRank(status: string): number {
  switch (status) {
    case 'waiting': return 5
    case 'working': return 4
    case 'running': return 3
    case 'starting': return 2
    case 'done': return 1
    default: return 0
  }
}

function activeFilterCount(filters: WorkspacePreferences['filters']): number {
  return FILTER_OPTIONS.reduce((count, option) => count + (filters[option.key] ? 1 : 0), 0)
}

export function WorkspacesPage({ bridge, connected, onNavigate, onReport }: Props) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [groups, setGroups] = useState<ProjectGroup[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([])
  const [origins, setOrigins] = useState<WorkspaceOriginView[]>([])
  const [sleepStates, setSleepStates] = useState<WorkspaceSleepState[]>([])
  const [sleepDialog, setSleepDialog] = useState<Worktree | null>(null)
  const [sleepBusy, setSleepBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(!connected)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<WorkspacePreferences>({ ...DEFAULT_WORKSPACE_PREFERENCES, filters: { ...DEFAULT_WORKSPACE_PREFERENCES.filters } })
  const [preferencesReady, setPreferencesReady] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createWarnings, setCreateWarnings] = useState<string[]>([])
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [menuWorktreeId, setMenuWorktreeId] = useState<string | null>(null)
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const requestId = useRef(0)
  const loadInFlight = useRef<number | null>(null)
  const serverLoaded = useRef(false)
  const widthDrag = useRef<{ startX: number; width: number } | null>(null)
  const resizeListeners = useRef<{ move(event: globalThis.PointerEvent): void; up(): void } | null>(null)
  const storageGranted = bridge.init.grants.includes('storage')
  const rpcGranted = bridge.init.grants.includes('rpc')
  const pageActiveNow = useCallback(() => connected && bridge.state.phase === 'connected' &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden'), [bridge, connected])
  const canMutateNow = useCallback(() => pageActiveNow() && rpcGranted, [pageActiveNow, rpcGranted])
  const canMutate = canMutateNow()

  useEffect(() => {
    let active = true
    if (!storageGranted) {
      setPreferencesReady(true)
      return () => { active = false }
    }
    void readWorkspacePreferences(bridge).then((saved) => {
      if (!active) return
      setPreferences(saved)
      setPreferencesReady(true)
    })
    void readWorkspaceCache(bridge).then((cache) => {
      if (!active || serverLoaded.current || !cache) return
      setRepos(cache.repos)
      setGroups(cache.groups)
      setWorktrees(cache.worktrees)
      setSessions(cache.sessions)
      setStale(true)
      setLoading(false)
    })
    return () => { active = false }
  }, [bridge, storageGranted])

  useEffect(() => {
    if (!preferencesReady || !storageGranted) return
    void writeWorkspacePreferences(bridge, preferences).catch((cause) => setActionError(`Could not save workspace view options: ${errorMessage(cause)}`))
  }, [bridge, preferences, preferencesReady, storageGranted])

  const load = useCallback(async () => {
    if (!pageActiveNow()) {
      requestId.current += 1
      setStale(true)
      setLoading(false)
      return
    }
    if (loadInFlight.current === requestId.current) return
    const currentRequest = ++requestId.current
    loadInFlight.current = currentRequest
    setLoading(true)
    try {
      const [nextRepos, nextGroups, nextWorktrees, nextSessions, nextOrigins, nextSleepStates] = await Promise.all([
        bridge.call<Repo[]>('quirky.repo/list', {}),
        bridge.call<ProjectGroup[]>('quirky.repo/groupList', {}),
        bridge.call<Worktree[]>('quirky.worktree/list', {}),
        bridge.call<Session[]>('quirky.session/list', {}),
        bridge.call<WorkspaceOriginView[]>('quirky.worktree/origins', {}),
        bridge.call<WorkspaceSleepState[]>('quirky.session/workspaceSleepStates', {})
      ])
      if (currentRequest !== requestId.current || !pageActiveNow()) return
      const cache: WorkspaceCache = {
        repos: nextRepos,
        groups: nextGroups,
        worktrees: nextWorktrees,
        sessions: projectWorkspaceSessions(nextSessions)
      }
      setRepos(nextRepos)
      setGroups(nextGroups)
      setWorktrees(nextWorktrees)
      setSessions(cache.sessions)
      setOrigins(nextOrigins)
      setSleepStates(nextSleepStates)
      setStale(false)
      setError(null)
      serverLoaded.current = true
      if (storageGranted) void writeWorkspaceCache(bridge, cache).catch(() => {})
    } catch (cause) {
      if (currentRequest !== requestId.current || !pageActiveNow()) return
      setError(errorMessage(cause, 'Could not load workspaces.'))
      setStale(true)
    } finally {
      if (loadInFlight.current === currentRequest) loadInFlight.current = null
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [bridge, pageActiveNow, storageGranted])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!connected) {
      setStale(true)
      return
    }
    const timer = window.setInterval(() => void load(), 8000)
    return () => window.clearInterval(timer)
  }, [connected, load])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const updatePreferences = useCallback((update: (current: WorkspacePreferences) => WorkspacePreferences) => {
    setPreferences((current) => update(current))
  }, [])

  const reposById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
  const sessionsByWorktree = useMemo(() => {
    const byWorktree = new Map<string, WorkspaceSessionSummary[]>()
    for (const session of sessions) {
      const list = byWorktree.get(session.worktreeId) ?? []
      list.push(session)
      byWorktree.set(session.worktreeId, list)
    }
    return byWorktree
  }, [sessions])
  const originsByWorktree = useMemo(() => new Map(origins.map((origin) => [origin.worktreeId, origin])), [origins])
  const sleepByWorktree = useMemo(() => new Map(sleepStates.map((state) => [state.worktreeId, state])), [sleepStates])

  const visibleWorktrees = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    const filter = preferences.filters
    const matches = worktrees.filter((worktree) => {
      const repo = reposById.get(worktree.repoId)
      const projectGroup = worktree.projectGroupId ? groupsById.get(worktree.projectGroupId) : undefined
      if (selectedRepoId && worktree.repoId !== selectedRepoId) return false
      if (search && ![worktree.name, worktree.branch ?? '', worktree.path, worktree.id, worktree.comment, repo?.name ?? '', repo?.displayName ?? '', projectGroup?.name ?? ''].some((part) => part.toLocaleLowerCase().includes(search))) return false
      return matchesWorkspaceFilters(worktree, filter, originsByWorktree.get(worktree.id), sleepByWorktree.get(worktree.id)?.state)
    })
    const index = new Map(worktrees.map((worktree, position) => [worktree.id, position]))
    const activity = (worktree: Worktree) => sessionsByWorktree.get(worktree.id) ?? []
    const repoOrder = new Map(repos.map((repo, position) => [repo.id, position]))
    const projectActivity = new Map<string, number>()
    for (const worktree of worktrees) projectActivity.set(worktree.repoId, Math.max(projectActivity.get(worktree.repoId) ?? 0, worktree.lastActivityAt))
    const sorted = [...matches].sort((a, b) => {
      const pinned = Number(preferences.pinnedWorktreeIds.includes(b.id)) - Number(preferences.pinnedWorktreeIds.includes(a.id))
      if (pinned !== 0) return pinned
      switch (preferences.sortBy) {
        case 'name': return a.name.localeCompare(b.name) || (index.get(a.id)! - index.get(b.id)!)
        case 'recent': return b.lastActivityAt - a.lastActivityAt || (index.get(a.id)! - index.get(b.id)!)
        case 'agentActivity': {
          const aActive = activity(a).reduce((score, item) => Math.max(score, statusRank(item.status)), 0)
          const bActive = activity(b).reduce((score, item) => Math.max(score, statusRank(item.status)), 0)
          return bActive - aActive || b.lastActivityAt - a.lastActivityAt || (index.get(a.id)! - index.get(b.id)!)
        }
        case 'project': {
          if (preferences.projectOrder === 'recent') {
            const recent = (projectActivity.get(b.repoId) ?? 0) - (projectActivity.get(a.repoId) ?? 0)
            if (recent !== 0) return recent
          } else {
            const project = (repoOrder.get(a.repoId) ?? Number.MAX_SAFE_INTEGER) - (repoOrder.get(b.repoId) ?? Number.MAX_SAFE_INTEGER)
            if (project !== 0) return project
          }
          return a.name.localeCompare(b.name) || (index.get(a.id)! - index.get(b.id)!)
        }
        case 'manual': return index.get(a.id)! - index.get(b.id)!
      }
    })
    return sorted
  }, [worktrees, reposById, groupsById, sessionsByWorktree, originsByWorktree, sleepByWorktree, repos, selectedRepoId, query, preferences])

  const groupedRows = useMemo((): GroupedRows[] => {
    const labels = new Map<string, string>()
    const buckets = new Map<string, Worktree[]>()
    for (const worktree of visibleWorktrees) {
      let key = ''
      let label = 'Workspaces'
      switch (preferences.groupBy) {
        case 'status':
          key = worktree.status
          label = statusLabel(worktree.status)
          break
        case 'pr':
          key = worktree.linkedPR ? `pr:${worktree.linkedPR.number}` : 'pr:none'
          label = worktree.linkedPR ? `PR #${worktree.linkedPR.number}` : 'No PR'
          break
        case 'project': {
          const projectGroup = worktree.projectGroupId ? groupsById.get(worktree.projectGroupId) : undefined
          label = displayName(reposById.get(worktree.repoId), projectGroup, worktree)
          key = `project:${worktree.repoId}`
          break
        }
        case 'none':
          key = 'all'
          label = 'Workspaces'
          break
      }
      labels.set(key, label)
      const bucket = buckets.get(key) ?? []
      bucket.push(worktree)
      buckets.set(key, bucket)
    }
    return [...buckets.entries()].map(([key, worktreesInGroup]) => ({ key, label: labels.get(key) ?? 'Workspaces', worktrees: worktreesInGroup }))
  }, [visibleWorktrees, preferences.groupBy, groupsById, reposById])

  const collapsed = useCallback((key: string, isWorktree = false) =>
    (isWorktree ? preferences.collapsedWorktrees : preferences.collapsedGroups).includes(key),
  [preferences.collapsedGroups, preferences.collapsedWorktrees])

  const toggleCollapsed = (key: string, isWorktree = false) => updatePreferences((current) => {
    const property = isWorktree ? 'collapsedWorktrees' : 'collapsedGroups'
    const values = current[property]
    return { ...current, [property]: values.includes(key) ? values.filter((value) => value !== key) : [...values, key] }
  })

  const refresh = () => { setActionError(null); void load() }

  const openCreate = () => {
    setCreateError(null)
    setCreateWarnings([])
    setCreateOpen(true)
  }

  const openFloating = async () => {
    if (!canMutateNow() || !bridge.init.grants.includes('terminal')) return
    setActionError(null)
    try {
      const { cols, rows } = viewportCells()
      const session = await bridge.call<Session>('quirky.session/create', { worktree: 'floating', agent: 'shell', cols, rows })
      await onNavigate({ kind: 'session', worktreeId: 'floating', sessionId: session.id })
    } catch (cause) {
      setActionError(errorMessage(cause, 'Could not create a terminal in the floating workspace.'))
    }
  }

  const changeSleep = async (worktree: Worktree, wake: boolean): Promise<boolean> => {
    if (!canMutateNow() || sleepBusy) return false
    setSleepBusy(worktree.id)
    setActionError(null)
    try {
      const state = await bridge.call<WorkspaceSleepState>(wake ? 'quirky.session/wakeWorkspace' : 'quirky.session/sleepWorkspace', { worktree: worktree.id })
      if (!pageActiveNow()) return false
      setSleepStates((current) => [...current.filter((item) => item.worktreeId !== state.worktreeId), state])
      setSleepDialog(null)
      const expected = wake ? 'awake' : 'asleep'
      if (state.state !== expected) {
        const errors = state.sessions.flatMap((session) => session.error ? [`${session.sessionId}: ${session.error}`] : [])
        setActionError(`Workspace recovery is ${state.state}.${errors.length ? ` ${errors.join(' ')}` : ' Use Wake to resume retained sessions.'}`)
        return false
      }
      setNotice(`${worktree.name} ${wake ? 'is awake' : 'is asleep; history and resume records are retained'}.`)
      await load()
      return true
    } catch (cause) {
      setActionError(errorMessage(cause, wake ? 'Could not wake this workspace.' : 'Sleep was refused; recovery records are retained.'))
      await load()
      return false
    } finally {
      setSleepBusy(null)
    }
  }

  const openWorkspace = async (worktree: Worktree) => {
    const state = sleepByWorktree.get(worktree.id)?.state
    if (state === 'asleep' && !(await changeSleep(worktree, true))) return
    await onNavigate({ kind: 'session', worktreeId: worktree.id })
  }

  const requestDelete = async (worktree: Worktree) => {
    if (!canMutateNow() || worktree.isMain || worktree.removing) return
    setMenuWorktreeId(null)
    setDeleteError(null)
    try {
      const description = await bridge.call<string>('quirky.worktree/describeRemove', { worktree: worktree.id })
      if (!pageActiveNow()) return
      setDeleteDialog({ worktree, description })
    } catch (cause) {
      if (pageActiveNow()) setDeleteError(errorMessage(cause, 'Could not prepare workspace deletion.'))
    }
  }

  const confirmDelete = async () => {
    if (!deleteDialog || !canMutateNow() || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const result = await bridge.call<{ ok: true; removed: string[]; sessionErrors?: string[] }>('quirky.worktree/remove', { worktree: deleteDialog.worktree.id, yes: true })
      if (!result.ok || !result.removed.includes(deleteDialog.worktree.id)) throw new Error('The desktop did not confirm workspace removal.')
      requestId.current += 1
      const removed = new Set(result.removed)
      const remainingWorktrees = worktrees.filter((worktree) => !removed.has(worktree.id))
      const remainingSessions = sessions.filter((session) => !removed.has(session.worktreeId))
      setWorktrees(remainingWorktrees)
      setSessions(remainingSessions)
      if (storageGranted) void writeWorkspaceCache(bridge, { repos, groups, worktrees: remainingWorktrees, sessions: remainingSessions }).catch(() => {})
      setDeleteDialog(null)
      setNotice(`Removed ${deleteDialog.worktree.name}.${result.sessionErrors?.length ? ' The desktop reported session cleanup warnings.' : ''}`)
      await load()
    } catch (cause) {
      setDeleteError(errorMessage(cause, 'Workspace deletion was refused.'))
      await load()
    } finally {
      setDeleteBusy(false)
    }
  }

  const togglePin = (worktree: Worktree) => {
    updatePreferences((current) => {
      const pinned = current.pinnedWorktreeIds.includes(worktree.id)
      return {
        ...current,
        pinnedWorktreeIds: pinned
          ? current.pinnedWorktreeIds.filter((id) => id !== worktree.id)
          : [...current.pinnedWorktreeIds, worktree.id]
      }
    })
    setMenuWorktreeId(null)
  }

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    widthDrag.current = { startX: event.clientX, width: preferences.sidebarWidth }
    const move = (next: globalThis.PointerEvent) => {
      if (!widthDrag.current) return
      const delta = next.clientX - widthDrag.current.startX
      updatePreferences((current) => ({ ...current, sidebarWidth: Math.max(220, Math.min(480, Math.round(widthDrag.current!.width + delta))) }))
    }
    const up = () => {
      widthDrag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      resizeListeners.current = null
    }
    resizeListeners.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useEffect(() => () => {
    const listeners = resizeListeners.current
    if (listeners) {
      window.removeEventListener('pointermove', listeners.move)
      window.removeEventListener('pointerup', listeners.up)
      resizeListeners.current = null
    }
    widthDrag.current = null
  }, [])

  useEffect(() => {
    onReport({
      visibleWorktreeIds: visibleWorktrees.slice(0, 256).map((worktree) => worktree.id),
      searchOpen,
      optionsOpen,
      sidebarCollapsed: preferences.sidebarCollapsed,
      detailMode: preferences.cardLayout
    })
  }, [onReport, visibleWorktrees, selectedRepoId, searchOpen, optionsOpen, preferences.sidebarCollapsed, preferences.cardLayout])

  const sidebarStyle = { '--sidebar-width': `${preferences.sidebarWidth}px` } as CSSProperties
  const activeFilters = activeFilterCount(preferences.filters)

  return (
    <div className="qp-page--workspaces">
      <header className="qp-topbar">
        <button className="qp-icon-button" type="button" aria-label="Back to hosts" onClick={() => void onNavigate({ kind: 'home' })}>‹</button>
        <div className="qp-topbar__titles">
          <h1>{bridge.init.host.personalName || bridge.init.host.name}</h1>
          <p>{bridge.init.host.platform || 'Desktop'} · {loading && worktrees.length === 0 ? 'Loading workspaces…' : `${worktrees.length} workspaces`}{stale ? ' · Stale' : ''}</p>
        </div>
        <button className="qp-icon-button" type="button" aria-label={searchOpen ? 'Close search' : 'Search'} aria-expanded={searchOpen} onClick={() => {
          setSearchOpen((open) => !open)
          setQuery('')
        }}>{searchOpen ? '×' : '⌕'}</button>
        <button className="qp-icon-button" type="button" aria-label="Workspace options" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(true)}>
          ⚙{activeFilters > 0 ? <span className="qp-visually-hidden">, {activeFilters} active filters</span> : null}
        </button>
        <button className="qp-button qp-button--primary" type="button" disabled={!canMutate} onClick={openCreate}>New workspace</button>
        <button className="qp-icon-button" type="button" aria-label="Floating Workspace" title="Create a terminal in the real Floating workspace" disabled={!canMutate || !bridge.init.grants.includes('terminal')} onClick={() => void openFloating()}>↗</button>
      </header>
      <div className="qp-content">
        <div className="qp-workspace-layout" data-sidebar-collapsed={preferences.sidebarCollapsed} style={sidebarStyle}>
          <aside className={`qp-sidebar${preferences.sidebarCollapsed ? ' qp-sidebar--collapsed' : ''}`} aria-label="Projects">
            <div className="qp-sidebar__heading">Projects</div>
            <button className="qp-sidebar__project" type="button" aria-pressed={selectedRepoId === null} onClick={() => setSelectedRepoId(null)}>
              <span>All projects</span><span>{worktrees.length}</span>
            </button>
            {repos.map((repo) => (
              <button className="qp-sidebar__project" key={repo.id} type="button" aria-pressed={selectedRepoId === repo.id} onClick={() => setSelectedRepoId(selectedRepoId === repo.id ? null : repo.id)}>
                <span>{repo.displayName || repo.name}</span><span>{worktrees.filter((worktree) => worktree.repoId === repo.id).length}</span>
              </button>
            ))}
            <div className="qp-sidebar__resize" role="separator" aria-orientation="vertical" aria-label="Resize project sidebar" aria-valuemin={220} aria-valuemax={480} aria-valuenow={preferences.sidebarWidth} tabIndex={0} onPointerDown={startResize} onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              const delta = event.key === 'ArrowLeft' ? -16 : 16
              updatePreferences((current) => ({ ...current, sidebarWidth: Math.max(220, Math.min(480, current.sidebarWidth + delta)) }))
            }} style={{ touchAction: 'none' }} />
          </aside>
          <main className="qp-main-list" aria-label="Workspaces">
            <div className="qp-toolbar">
              <button className="qp-button qp-button--quiet qp-sidebar-toggle" type="button" onClick={() => updatePreferences((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))}>
                {preferences.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              </button>
              <span className="qp-toolbar__fill" />
              <button className="qp-button qp-button--quiet" type="button" aria-label="Refresh workspaces" disabled={!pageActiveNow() || loading} onClick={refresh}>{loading ? 'Refreshing…' : 'Refresh'}</button>
            </div>
            {searchOpen && (
              <div className="qp-search-row">
                <input className="qp-search" type="search" placeholder="Search workspaces" aria-label="Search workspaces" value={query} onChange={(event) => setQuery(event.currentTarget.value)} autoFocus />
                {query && <button className="qp-icon-button" type="button" aria-label="Clear search" onClick={() => setQuery('')}>×</button>}
              </div>
            )}
            {actionError && <PageError>{actionError}</PageError>}
            {error && worktrees.length === 0 && <PageError>{error}</PageError>}
            {error && worktrees.length > 0 && <PageError>{error} Cached workspaces remain visible as stale.</PageError>}
            {notice && <div className="qp-error" role="status">{notice}</div>}
            {loading && worktrees.length === 0 ? (
              <div className="qp-empty" role="status"><strong>Loading workspaces…</strong>Reading projects and worktrees from this desktop.</div>
            ) : visibleWorktrees.length === 0 ? (
              <div className="qp-empty">
                <strong>{worktrees.length === 0 ? 'No workspaces yet' : 'No matching workspaces'}</strong>
                {worktrees.length === 0 ? 'Create a workspace from a project, or start a terminal in the Floating workspace.' : 'Change the search or filters to see workspaces again.'}
                {worktrees.length === 0 && <div className="qp-sheet__footer"><button className="qp-button qp-button--primary" type="button" disabled={!canMutate || repos.length === 0} onClick={openCreate}>New workspace</button></div>}
              </div>
            ) : (
              groupedRows.map((group) => {
                const isGroupCollapsed = preferences.groupBy !== 'none' && collapsed(group.key)
                const ids = new Set(group.worktrees.map((worktree) => worktree.id))
                const roots = group.worktrees.filter((worktree) => !worktree.parentId || !visibleWorktrees.some((candidate) => candidate.id === worktree.parentId && ids.has(candidate.id)))
                return (
                  <section className="qp-worktree-group" key={group.key || 'all'}>
                    {preferences.groupBy !== 'none' && (
                      <button className="qp-group-heading" type="button" aria-expanded={!isGroupCollapsed} onClick={() => toggleCollapsed(group.key)}>
                        <span>{isGroupCollapsed ? '▸' : '▾'}</span><span>{group.label}</span><small>{group.worktrees.length}</small>
                      </button>
                    )}
                    {!isGroupCollapsed && <div className="qp-worktree-rows">
                      {roots.map((worktree) => renderWorktreeTree(worktree, 0, group.worktrees, {
                        bridge, canMutate, groupsById, menuWorktreeId, preferences, reposById, sessionsByWorktree, sleepByWorktree, sleepBusy,
                        collapsed, onOpen: (item) => void openWorkspace(item), onToggleCollapse: toggleCollapsed,
                        onToggleMenu: (id) => setMenuWorktreeId(menuWorktreeId === id ? null : id), onPin: togglePin, onDelete: requestDelete,
                        onSleep: (item) => { setMenuWorktreeId(null); setSleepDialog(item) }, onWake: (item) => void changeSleep(item, true)
                      }))}
                    </div>}
                  </section>
                )
              })
            )}
          </main>
        </div>
      </div>

      {optionsOpen && <OptionsSheet bridge={bridge} preferences={preferences} onClose={() => setOptionsOpen(false)} onChange={updatePreferences} />}
      {createOpen && <CreateWorkspaceSheet
        repos={repos} canMutate={canMutate} busy={createBusy} error={createError} warnings={createWarnings}
        onClose={() => { if (!createBusy) setCreateOpen(false) }}
        onSubmit={async (params) => {
          if (!canMutateNow() || createBusy) return
          setCreateBusy(true)
          setCreateError(null)
          setCreateWarnings([])
          try {
            const result = await bridge.call<WorktreeCreateResult>('quirky.worktree/create', params)
            requestId.current += 1
            const createdWorktrees = worktrees.some((worktree) => worktree.id === result.worktree.id)
              ? worktrees.map((worktree) => worktree.id === result.worktree.id ? result.worktree : worktree)
              : [...worktrees, result.worktree]
            setWorktrees(createdWorktrees)
            if (bridge.init.grants.includes('storage')) void writeWorkspaceCache(bridge, { repos, groups, worktrees: createdWorktrees, sessions }).catch(() => {})
            setCreateWarnings(result.warnings)
            setCreateOpen(false)
            setNotice(`Created ${result.worktree.name}.`)
            await load()
            if (result.warnings.length > 0) setNotice(`${result.worktree.name} created. ${result.warnings.join(' ')}`)
          } catch (cause) {
            setCreateError(errorMessage(cause, 'The desktop refused to create this workspace.'))
          } finally {
            setCreateBusy(false)
          }
        }}
      />}
      {sleepDialog && <PageModal title="Sleep workspace" labelledBy="qp-sleep-workspace-title" onClose={() => { if (!sleepBusy) setSleepDialog(null) }} footer={
        <>
          <button className="qp-button" type="button" disabled={sleepBusy !== null} onClick={() => setSleepDialog(null)}>Cancel</button>
          <button className="qp-button qp-button--primary" type="button" disabled={!canMutate || sleepBusy !== null} onClick={() => void changeSleep(sleepDialog, false)}>{sleepBusy ? 'Stopping sessions…' : 'Sleep workspace'}</button>
        </>
      }>
        <p className="qp-dialog-copy">Stop sessions in {sleepDialog.name} while retaining terminal history and supported agent resume identities. Wake resumes the recorded sessions; this does not delete the workspace.</p>
        <p className="qp-dialog-copy">If a session cannot be safely resumed, the desktop refuses before stopping it. Partial recovery remains visible.</p>
        {actionError && <PageError>{actionError}</PageError>}
      </PageModal>}
      {deleteDialog && <PageModal title="Delete workspace" labelledBy="qp-delete-workspace-title" onClose={() => { if (!deleteBusy) setDeleteDialog(null) }} footer={
        <>
          <button className="qp-button" type="button" disabled={deleteBusy} onClick={() => setDeleteDialog(null)}>Cancel</button>
          <button className="qp-button qp-button--danger" type="button" aria-label="Confirm delete workspace" disabled={!canMutate || deleteBusy} onClick={() => void confirmDelete()}>{deleteBusy ? 'Deleting…' : 'Delete workspace'}</button>
        </>
      }>
        <p className="qp-dialog-copy">{deleteDialog.description}</p>
        <p className="qp-dialog-copy">This action is performed by the desktop worktree API. Child workspaces or active sessions can cause the desktop to refuse it.</p>
        {deleteError && <PageError>{deleteError}</PageError>}
      </PageModal>}
    </div>
  )
}

type RenderContext = {
  bridge: MobilePageBridge
  canMutate: boolean
  groupsById: Map<string, ProjectGroup>
  menuWorktreeId: string | null
  preferences: WorkspacePreferences
  reposById: Map<string, Repo>
  sessionsByWorktree: Map<string, WorkspaceSessionSummary[]>
  sleepByWorktree: Map<string, WorkspaceSleepState>
  sleepBusy: string | null
  collapsed(key: string, isWorktree?: boolean): boolean
  onOpen(worktree: Worktree): void
  onToggleCollapse(key: string, isWorktree?: boolean): void
  onToggleMenu(id: string): void
  onPin(worktree: Worktree): void
  onDelete(worktree: Worktree): void
  onSleep(worktree: Worktree): void
  onWake(worktree: Worktree): void
}

function renderWorktreeTree(worktree: Worktree, depth: number, groupRows: Worktree[], context: RenderContext): ReactNode {
  const visibleIds = new Set(groupRows.map((item) => item.id))
  const children = groupRows.filter((item) => item.parentId === worktree.id)
  const isCollapsed = context.collapsed(worktree.id, true)
  const projectGroup = worktree.projectGroupId ? context.groupsById.get(worktree.projectGroupId) : undefined
  const repo = context.reposById.get(worktree.repoId)
  const displayProperties = new Set(context.preferences.properties)
  const isPinnedHere = context.preferences.pinnedWorktreeIds.includes(worktree.id)
  const sessionRows = context.sessionsByWorktree.get(worktree.id) ?? []
  const sleep = context.sleepByWorktree.get(worktree.id)
  const sleeping = sleep !== undefined && sleep.state !== 'awake'
  const sleepPending = context.sleepBusy !== null || sleep?.state === 'sleeping' || sleep?.state === 'waking'
  const activeSession = sessionRows.find((item) => item.status === 'working' || item.status === 'waiting' || item.status === 'running')
  const activityLabel = activeSession ? `${activeSession.agent} · ${statusLabel(activeSession.status)}` : sessionRows.length > 0 ? 'No active agent' : 'No sessions'
  const cardClass = `qp-worktree-card${context.preferences.cardLayout === 'compact' ? ' qp-worktree-card--compact' : ''}${depth > 0 ? ' qp-worktree-card--child' : ''}`
  const externalLink = (url: string) => {
    if (!context.bridge.init.grants.includes('externalLink')) return
    void context.bridge.native.openExternal(url).catch(() => {})
  }
  const linkedPR = worktree.linkedPR
  const linkedIssue = worktree.linkedIssue
  const pushTarget = worktree.pushTarget
  return (
    <div key={worktree.id}>
      <article className={cardClass} style={{ marginLeft: Math.min(depth * 14, 42) }} data-worktree-id={worktree.id}>
        <div className="qp-worktree-card__main">
          {children.length > 0 && <button className="qp-icon-button" type="button" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${worktree.name}`} aria-expanded={!isCollapsed} onClick={() => context.onToggleCollapse(worktree.id, true)}>{isCollapsed ? '▸' : '▾'}</button>}
          <div className="qp-worktree-card__body">
            <div className="qp-worktree-card__name">{worktree.name}{worktree.isMain ? ' · primary' : ''}</div>
            {sleeping && <span className="qp-chip qp-chip--warn">{sleep.state === 'asleep' ? 'Sleeping' : `Recovery: ${sleep.state}`}</span>}
            {displayProperties.has('branch') && <div className="qp-worktree-card__branch">{worktree.branch ?? 'Detached HEAD'}</div>}
            {displayProperties.has('project') && <div className="qp-worktree-card__project">{displayName(repo, projectGroup, worktree)}</div>}
            {displayProperties.has('kind') && <div className="qp-worktree-card__project">{worktree.kind === 'git' ? 'Git worktree' : 'Folder workspace'}</div>}
            {displayProperties.has('path') && <div className="qp-worktree-card__branch" title={worktree.path}>Path · {worktree.path}</div>}
            {displayProperties.has('head') && <div className="qp-worktree-card__branch" title={worktree.head}>HEAD · {worktree.head.slice(0, 12)}</div>}
            {displayProperties.has('baseRef') && worktree.baseRef && <div className="qp-worktree-card__branch">Base · {worktree.baseRef}</div>}
            {displayProperties.has('projectGroup') && worktree.projectGroupId && <div className="qp-worktree-card__project">Project group · {projectGroup?.name || worktree.projectGroupId}</div>}
            {(displayProperties.has('status') || worktree.parentId || children.length > 0 || isPinnedHere || worktree.pinned || worktree.unread) && (
              <div className="qp-chips">
                {displayProperties.has('status') && <span className="qp-chip">{statusLabel(worktree.status)}</span>}
                {worktree.parentId && visibleIds.has(worktree.parentId) && <span className="qp-chip">Child workspace</span>}
                {children.length > 0 && <span className="qp-chip">{children.length} {children.length === 1 ? 'child' : 'children'}</span>}
                {isPinnedHere && <span className="qp-chip qp-chip--accent">Pinned on this phone</span>}
                {worktree.pinned && <span className="qp-chip qp-chip--muted">Pinned on desktop</span>}
                {worktree.unread && <span className="qp-chip qp-chip--warn">Unread</span>}
              </div>
            )}
          </div>
          <div className="qp-worktree-card__actions">
            <button className="qp-icon-button" type="button" aria-label={`Workspace actions for ${worktree.name}`} aria-expanded={context.menuWorktreeId === worktree.id} onClick={() => context.onToggleMenu(worktree.id)}>⋯</button>
          </div>
        </div>
        {context.preferences.cardLayout === 'detailed' && (
          <div className="qp-chips">
            {displayProperties.has('pullRequest') && linkedPR && <button className="qp-chip qp-chip--accent" type="button" disabled={!context.bridge.init.grants.includes('externalLink')} onClick={() => externalLink(linkedPR.url)} title={linkedPR.title}>PR #{linkedPR.number}</button>}
            {displayProperties.has('issue') && linkedIssue && <button className="qp-chip" type="button" disabled={!context.bridge.init.grants.includes('externalLink')} onClick={() => externalLink(linkedIssue.url)} title={linkedIssue.title}>{linkedIssue.kind === 'pullRequest' ? 'PR' : 'Issue'} #{linkedIssue.number}</button>}
            {displayProperties.has('creator') && <span className="qp-chip qp-chip--muted">{worktree.createdBy}</span>}
            {displayProperties.has('activity') && <span className="qp-chip qp-chip--muted">{activityLabel}</span>}
            {displayProperties.has('tabCount') && <span className="qp-chip qp-chip--muted">{sessionRows.length} {sessionRows.length === 1 ? 'session' : 'sessions'}</span>}
            {displayProperties.has('branchRetention') && <span className="qp-chip qp-chip--muted">{worktree.keepBranch ? 'Keep branch after delete' : 'Delete branch with workspace'}</span>}
            {displayProperties.has('pushTarget') && pushTarget && <span className="qp-chip qp-chip--muted">Push · {pushTarget.remoteName}/{pushTarget.branchName}</span>}
            {displayProperties.has('comment') && worktree.comment.trim() && <span className="qp-chip" title={worktree.comment}>{worktree.comment.length > 80 ? `${worktree.comment.slice(0, 77)}…` : worktree.comment}</span>}
            {displayProperties.has('activity') && worktree.lastActivityAt > 0 && <span className="qp-chip qp-chip--muted">Updated {new Date(worktree.lastActivityAt).toLocaleString()}</span>}
          </div>
        )}
        <button className="qp-button qp-worktree-card__open" type="button" disabled={sleepPending || (sleeping && !context.canMutate)} aria-label={`Open ${worktree.name}`} onClick={() => context.onOpen(worktree)}>
          Open workspace · {sessionRows.length} {sessionRows.length === 1 ? 'tab' : 'tabs'}
        </button>
        {context.menuWorktreeId === worktree.id && <div className="qp-worktree-card__menu" role="group" aria-label={`Actions for ${worktree.name}`}>
          <button type="button" disabled={!context.bridge.init.grants.includes('storage')} onClick={() => context.onPin(worktree)}>{isPinnedHere ? 'Unpin on this phone' : 'Pin on this phone'}</button>
          {sleeping
            ? <button type="button" disabled={!context.canMutate || sleepPending} onClick={() => context.onWake(worktree)}>Wake workspace</button>
            : <button type="button" disabled={!context.canMutate || sleepPending || worktree.removing} onClick={() => context.onSleep(worktree)}>Sleep workspace</button>}
          {sleep?.state === 'partial' && <p>Some sessions need recovery. Wake retries retained resume records.</p>}
          <button type="button" disabled={!context.canMutate || worktree.isMain || worktree.removing} title={worktree.isMain ? 'The primary worktree cannot be deleted.' : undefined} onClick={() => context.onDelete(worktree)}>{worktree.removing ? 'Deleting…' : 'Delete workspace'}</button>
        </div>}
      </article>
      {!isCollapsed && children.map((child) => renderWorktreeTree(child, depth + 1, groupRows, context))}
    </div>
  )
}

function OptionsSheet({ bridge, preferences, onClose, onChange }: {
  bridge: MobilePageBridge
  preferences: WorkspacePreferences
  onClose(): void
  onChange(update: (current: WorkspacePreferences) => WorkspacePreferences): void
}) {
  const setFilter = (key: WorkspaceFilterKey, checked: boolean) => onChange((current) => ({ ...current, filters: { ...current.filters, [key]: checked } }))
  const clearFilters = () => onChange((current) => ({
    ...current,
    filters: { ...DEFAULT_WORKSPACE_PREFERENCES.filters }
  }))
  const setProperty = (key: WorkspacePropertyKey, checked: boolean) => onChange((current) => ({
    ...current,
    properties: checked ? [...new Set([...current.properties, key])] : current.properties.filter((value) => value !== key)
  }))
  return (
    <PageModal title="Workspace options" labelledBy="qp-workspace-options-title" onClose={onClose} footer={<button className="qp-button" type="button" onClick={onClose}>Done</button>}>
      <section className="qp-sheet__section">
        <h3>Organization</h3>
        <label className="qp-form-field">Group by<select aria-label="Group by" value={preferences.groupBy} onChange={(event) => onChange((current) => ({ ...current, groupBy: event.currentTarget.value as WorkspaceGroupBy }))}>
          {GROUP_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select></label>
        <label className="qp-form-field">Sort by<select aria-label="Sort by" value={preferences.sortBy} onChange={(event) => onChange((current) => ({ ...current, sortBy: event.currentTarget.value as WorkspaceSortBy }))}>
          {SORT_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select></label>
        <label className="qp-form-field">Project order<select aria-label="Project order" value={preferences.projectOrder} onChange={(event) => onChange((current) => ({ ...current, projectOrder: event.currentTarget.value === 'recent' ? 'recent' : 'manual' }))}>
          <option value="manual">Manual</option><option value="recent">Recent</option>
        </select></label>
      </section>
      <section className="qp-sheet__section">
        <h3>Card layout</h3>
        <div className="qp-option-row">
          {(['detailed', 'compact'] as const).map((layout) => <button className="qp-chip" key={layout} type="button" aria-pressed={preferences.cardLayout === layout} onClick={() => onChange((current) => ({ ...current, cardLayout: layout }))}>{layout === 'detailed' ? 'Detailed' : 'Compact'}</button>)}
        </div>
      </section>
      <section className="qp-sheet__section">
        <h3>Show properties</h3>
        <div className="qp-choice-list">
          {PROPERTY_OPTIONS.map((option) => <label className="qp-choice" key={option.value}>
            <input type="checkbox" checked={preferences.properties.includes(option.value)} onChange={(event) => setProperty(option.value, event.currentTarget.checked)} />
            <span>{option.label}</span>
          </label>)}
        </div>
      </section>
      <section className="qp-sheet__section">
        <h3>Filters</h3>
        {FILTER_OPTIONS.map((option) => (
          <label className="qp-filter-toggle" key={option.key}>
            <input type="checkbox" checked={preferences.filters[option.key]} onChange={(event) => setFilter(option.key, event.currentTarget.checked)} />
            <span>{option.label}<small>{option.detail}</small></span>
          </label>
        ))}
        <button className="qp-button" type="button" onClick={clearFilters}>Clear filters</button>
      </section>
      {bridge.init.grants.includes('storage') ? null : <PageError>Workspace view preferences cannot be persisted because storage access was not granted.</PageError>}
    </PageModal>
  )
}

function CreateWorkspaceSheet({ repos, canMutate, busy, error, warnings, onClose, onSubmit }: {
  repos: Repo[]
  canMutate: boolean
  busy: boolean
  error: string | null
  warnings: string[]
  onClose(): void
  onSubmit(params: Record<string, unknown>): Promise<void>
}) {
  const defaultRepo = repos.find((repo) => repo.kind === 'git') ?? repos[0]
  const [repoId, setRepoId] = useState(defaultRepo?.id ?? '')
  const [name, setName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [base, setBase] = useState('')
  const repo = repos.find((item) => item.id === repoId)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canMutate || busy || !repoId) return
    const params: Record<string, unknown> = { repo: repoId }
    if (name.trim()) params.name = name.trim()
    if (repo?.kind === 'git' && branchName.trim()) params.branchName = branchName.trim()
    if (repo?.kind === 'git' && base.trim()) params.base = base.trim()
    void onSubmit(params)
  }
  return (
    <PageModal title="New workspace" labelledBy="qp-create-workspace-title" onClose={onClose} footer={
      <>
        <button className="qp-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="qp-button qp-button--primary" type="submit" form="qp-create-workspace-form" disabled={!canMutate || busy || repos.length === 0 || !repoId}>{busy ? 'Creating…' : 'Create workspace'}</button>
      </>
    }>
      {repos.length === 0 ? <div className="qp-empty"><strong>No projects are available</strong>Add a repository on the desktop before creating a worktree.</div> : (
        <form id="qp-create-workspace-form" onSubmit={submit}>
          <label className="qp-form-field">Project<select aria-label="Project" value={repoId} onChange={(event) => setRepoId(event.currentTarget.value)}>
            {repos.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.name}{item.kind === 'folder' ? ' · folder' : ''}</option>)}
          </select></label>
          <label className="qp-form-field">Workspace name<input aria-label="Workspace name" value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Optional; Quirky can choose a name" maxLength={80} /></label>
          {repo?.kind === 'git' && <label className="qp-form-field">Branch name<input aria-label="Branch name" value={branchName} onChange={(event) => setBranchName(event.currentTarget.value)} placeholder="Optional new branch" maxLength={200} /></label>}
          {repo?.kind === 'git' && <label className="qp-form-field">Base branch or ref<input aria-label="Base branch or ref" value={base} onChange={(event) => setBase(event.currentTarget.value)} placeholder="Project default" maxLength={200} /></label>}
          <p className="qp-dialog-copy">The desktop creates the workspace using its configured hooks and base-branch policy. No agent or prompt is started by this form.</p>
          {error && <PageError>{error}</PageError>}
          {warnings.map((warning, index) => <PageError key={`${index}:${warning}`}>{warning}</PageError>)}
        </form>
      )}
    </PageModal>
  )
}
