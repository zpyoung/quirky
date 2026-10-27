import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { currentRevisionOf, errorData, errorMessage, isConflict, ledgerRequest } from './api'
import { LedgerDetail } from './LedgerDetail'
import { LedgerForm, type LocationBaseOption } from './LedgerForm'
import { LedgerTriage } from './LedgerTriage'
import { LEDGER_CSS } from './styles'
import type {
  LedgerCandidate,
  LedgerControl,
  LedgerEntry,
  LedgerFilters,
  LedgerOwner,
  LedgerOwnerOption,
  LedgerResponse,
  LedgerSelection,
  LedgerState,
  LedgerSummary,
  LedgerTarget,
  LedgerType
} from './types'

export const LEDGER_VIEW_ID = 'view:quirky.ledger/ledger'
export const LEDGER_SETTINGS_VIEW_ID = 'view:quirky.ledger/settings'
export const LEDGER_PANEL_ID = 'panel:quirky.ledger/ledger'
export const LEDGER_SIDEBAR_ID = 'sidebar-section:quirky.ledger/ledger'

export type LedgerUiMode = 'page' | 'panel'
export type ControlHandler = (control: LedgerControl) => Promise<void>

type RepoInfo = { id: string; name?: string; displayName?: string | null; path?: string; kind?: string; groupId?: string | null }
type GroupInfo = { id: string; name: string; repoIds: string[] }
type WorkspaceInfo = { id: string; repoId: string; name?: string; kind?: string; projectGroupId?: string | null }
type Directory = { repos: RepoInfo[]; groups: GroupInfo[]; workspaces: WorkspaceInfo[]; loading: boolean; error: string }
type CandidateSnapshot = { id: string; revision: number; title: string }
type PendingConfirmation =
  | { kind: 'bulk-state'; state: Extract<LedgerState, 'resolved' | 'archived'>; selections: LedgerSelection[]; snapshots: CandidateSnapshot[] }
  | { kind: 'delete-entries'; selections: LedgerSelection[]; snapshots: CandidateSnapshot[] }
  | { kind: 'delete-ledger'; ledgerId: string; revision: number; entryCount: number }
  | { kind: 'attach'; ledgerId: string; revision: number; attachTo: LedgerOwner; ownerName: string }
type SortMode = NonNullable<LedgerFilters['sort']>
type Scope = NonNullable<LedgerControl['scope']>

const TYPE_LABELS: Record<LedgerType, string> = { bug: 'Bug', deferred: 'Deferred', 'test-gap': 'Test gap', proposal: 'Proposal', decision: 'Decision' }
const TYPE_OPTIONS: LedgerType[] = ['bug', 'deferred', 'test-gap', 'proposal', 'decision']
const STATE_OPTIONS: LedgerState[] = ['open', 'resolved', 'archived']
const DEFAULT_FILTERS: LedgerFilters = {}
const MAX_SELECTIONS = 10_000

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function targetFromInput(input: unknown): LedgerTarget | null {
  const target = object(input).target
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return null
  const source = target as Record<string, unknown>
  const result: LedgerTarget = {}
  if (typeof source.workspaceId === 'string') result.workspaceId = source.workspaceId
  if (typeof source.ledgerId === 'string') result.ledgerId = source.ledgerId
  if (typeof source.group === 'boolean') result.group = source.group
  if (typeof source.groupSelector === 'string') result.groupSelector = source.groupSelector
  if (typeof source.owner === 'object' && source.owner !== null) {
    const owner = source.owner as Record<string, unknown>
    if ((owner.tier === 'project' || owner.tier === 'group') && typeof owner.id === 'string') result.owner = { tier: owner.tier, id: owner.id }
  }
  return Object.keys(result).length > 0 ? result : null
}

function activeWorkspace(layout: UiLayout): string | null {
  const input = object(layout.view?.input)
  const value = typeof input.worktree === 'string' ? input.worktree : input.workspaceId
  return typeof value === 'string' && value.length > 0 ? value : null
}


function repoName(repo: RepoInfo | undefined): string {
  if (!repo) return 'Unknown project'
  return repo.displayName || repo.name || repo.id
}

function selectionKey(selection: LedgerSelection): string {
  return `${selection.id}@${selection.revision}`
}

function safeSelections(values: unknown): LedgerSelection[] {
  if (!Array.isArray(values)) return []
  const results: LedgerSelection[] = []
  const seen = new Set<string>()
  for (const item of values) {
    const candidate = object(item)
    if (typeof candidate.id !== 'string' || typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1) continue
    const selection = { id: candidate.id, revision: candidate.revision }
    const key = selectionKey(selection)
    if (!seen.has(key)) results.push(selection)
    seen.add(key)
    if (results.length >= MAX_SELECTIONS) break
  }
  return results
}

function panelErrorText(error: unknown): string {
  const kind = errorData(error).kind
  switch (kind) {
    case 'group-missing': return 'This workspace has no group.'
    case 'workspace-missing': return 'This workspace is not live in this runtime.'
    case 'owner-missing': return 'The owning project or group no longer exists.'
    case 'owner-ambiguous':
    case 'group-ambiguous': return 'Ledger scope could not be resolved to a single project.'
    case 'catalog-unavailable': return 'The owner catalog is unavailable. Ledger could not be loaded.'
    default: return `Ledger could not be loaded. ${errorMessage(error)}`
  }
}

function summaryTitle(summary: LedgerSummary | null, target: LedgerTarget | null, owners: LedgerOwnerOption[]): string {
  if (summary) return summary.owner ? (summary.ownerName || summary.name) : summary.name
  const owner = target?.owner
  return owner ? owners.find((candidate) => candidate.tier === owner.tier && candidate.id === owner.id)?.name ?? owner.id : 'Ledger'
}

function entryTitle(entry: LedgerEntry): string {
  return typeof entry.content.title === 'string' ? entry.content.title : ''
}

function snapshotFor(selection: LedgerSelection, titles: Map<string, string>, entries: LedgerEntry[]): CandidateSnapshot {
  const entry = entries.find((candidate) => candidate.id === selection.id && candidate.revision === selection.revision)
  const title = titles.get(selectionKey(selection)) ?? (entry ? entryTitle(entry) : '')
  return { ...selection, title }
}

function runtimeTip(response: LedgerResponse | null): string {
  if (!response?.runtime) return ''
  return `Ledger plugin store runtime ${response.runtime.runtimeId}; persistent store profile ${response.runtime.profileId}`
}

export function LedgerApp({
  context,
  input,
  report,
  mode = 'page',
  registerControl
}: {
  context: UiPluginContext
  input?: unknown
  report?(state: unknown): void
  mode?: LedgerUiMode
  registerControl?(handler: ControlHandler, mode: LedgerUiMode): () => void
}) {
  const [target, setTarget] = useState<LedgerTarget | null>(() => targetFromInput(input))
  const [panelTargetOverride, setPanelTargetOverride] = useState<LedgerTarget | null>(null)
  const [scope, setScope] = useState<Scope>(mode === 'panel' ? 'worktree' : 'project')
  const [filters, setFilters] = useState<LedgerFilters>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<SortMode>('activity')
  const [response, setResponse] = useState<LedgerResponse | null>(null)
  const [catalog, setCatalog] = useState<LedgerResponse | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [directoryRetry, setDirectoryRetry] = useState(0)
  const [directory, setDirectory] = useState<Directory>({ repos: [], groups: [], workspaces: [], loading: true, error: '' })
  const [workspaceId, setWorkspaceId] = useState(() => mode === 'panel' ? activeWorkspace(context.getLayout()) : null)
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [workspaceRepo, setWorkspaceRepo] = useState<RepoInfo | null>(null)
  const [workspaceGroup, setWorkspaceGroup] = useState<GroupInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshSpinner, setRefreshSpinner] = useState(false)
  const [error, setError] = useState('')
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [selected, setSelected] = useState<LedgerSelection[]>([])
  const [selectionTitles, setSelectionTitles] = useState<Map<string, string>>(new Map())
  const [form, setForm] = useState<{ entry?: LedgerEntry; type?: LedgerType } | null>(null)
  const [detail, setDetail] = useState<LedgerEntry | null>(null)
  const [detailId, setDetailId] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [triageOpen, setTriageOpen] = useState(false)
  const [candidates, setCandidates] = useState<LedgerCandidate[]>([])
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [candidateError, setCandidateError] = useState('')
  const [triageConflict, setTriageConflict] = useState('')
  const [triageSelected, setTriageSelected] = useState<LedgerSelection[]>([])
  const [triageTitles, setTriageTitles] = useState<Map<string, string>>(new Map())
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [attachChoice, setAttachChoice] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const entryGeneration = useRef(0)
  const catalogGeneration = useRef(0)
  const candidateGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const dispatchRef = useRef<ControlHandler>(async () => {})

  useEffect(() => {
    if (mode !== 'panel') return
    setWorkspaceId(activeWorkspace(context.getLayout()))
    return context.onLayout((next) => setWorkspaceId(activeWorkspace(next)))
  }, [context, mode])

  useEffect(() => {
    let live = true
    setDirectory((current) => ({ ...current, loading: true, error: '' }))
    Promise.allSettled([
      context.call('quirky.repo/list', {}),
      context.call('quirky.repo/groupList', {}),
      context.call('quirky.worktree/list', {})
    ]).then((results) => {
      if (!live) return
      const errors: string[] = []
      const values: unknown[][] = results.map((result, index) => {
        if (result.status === 'fulfilled') return Array.isArray(result.value) ? result.value : []
        errors.push(`${['projects', 'groups', 'workspaces'][index]}: ${errorMessage(result.reason)}`)
        return []
      })
      const nextDirectory = { repos: values[0] as RepoInfo[], groups: values[1] as GroupInfo[], workspaces: values[2] as WorkspaceInfo[], loading: false, error: errors.join('; ') }
      setDirectory(nextDirectory)
      const currentWorkspace = nextDirectory.workspaces.find((item) => item.id === workspaceId) ?? null
      const currentRepo = currentWorkspace ? nextDirectory.repos.find((item) => item.id === currentWorkspace.repoId) ?? null : null
      const currentGroup = currentWorkspace ? nextDirectory.groups.find((item) => item.repoIds.includes(currentWorkspace.repoId)) ?? null : null
      setWorkspace(currentWorkspace)
      setWorkspaceRepo(currentRepo)
      setWorkspaceGroup(currentGroup)
    })
    return () => { live = false }
  }, [context, workspaceId, directoryRetry])

  const effectiveTarget = useMemo(() => {
    if (mode === 'page') return target
    if (panelTargetOverride) return panelTargetOverride
    if (!workspaceId) return null
    return scope === 'group' ? { workspaceId, group: true } : { workspaceId }
  }, [mode, target, panelTargetOverride, workspaceId, scope])

  const requestFilters = useMemo(() => {
    const next: LedgerFilters = {}
    if (filters.type) next.type = filters.type
    if (filters.state) next.state = filters.state
    if (filters.reviewed !== undefined) next.reviewed = filters.reviewed
    if (filters.stale !== undefined) next.stale = filters.stale
    if (filters.workspaceId) next.workspaceId = filters.workspaceId
    if (filters.branch) next.branch = filters.branch
    if (mode === 'panel' && !panelTargetOverride && scope === 'worktree' && workspaceId) next.workspaceId = workspaceId
    return next
  }, [filters.type, filters.state, filters.reviewed, filters.stale, filters.workspaceId, filters.branch, mode, panelTargetOverride, scope, workspaceId])

  const loadCatalog = useCallback(async () => {
    const generation = ++catalogGeneration.current
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const next = await ledgerRequest(context, { operation: 'catalog' })
      if (catalogGeneration.current !== generation) return
      setCatalog(next)
      setCatalogError('')
    } catch (reason) {
      if (catalogGeneration.current === generation) setCatalogError(errorMessage(reason))
    } finally {
      if (catalogGeneration.current === generation) setCatalogLoading(false)
    }
  }, [context])

  const loadEntries = useCallback(async (showDelayedSpinner = false) => {
    const generation = ++entryGeneration.current
    setError('')
    if (mode === 'panel' && (!workspaceId || directory.loading)) {
      setEntries([])
      setResponse(null)
      setLoading(Boolean(workspaceId))
      return
    }
    if (!effectiveTarget) {
      setEntries([])
      setResponse(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setRefreshSpinner(false)
    const timer = showDelayedSpinner ? window.setTimeout(() => {
      if (entryGeneration.current === generation) setRefreshSpinner(true)
    }, 200) : undefined
    try {
      const next = await ledgerRequest(context, { operation: 'list', target: effectiveTarget, filters: requestFilters })
      if (entryGeneration.current !== generation) return
      setResponse(next)
      setEntries(next.entries ?? [])
      setError('')
    } catch (reason) {
      if (entryGeneration.current === generation) {
        setResponse(null)
        setEntries([])
        setError(mode === 'panel' ? panelErrorText(reason) : errorMessage(reason))
      }
    } finally {
      window.clearTimeout(timer)
      if (entryGeneration.current === generation) {
        setLoading(false)
        setRefreshSpinner(false)
      }
    }
  }, [context, mode, workspaceId, directory.loading, effectiveTarget, requestFilters])

  useEffect(() => {
    void loadCatalog()
    return () => { catalogGeneration.current++ }
  }, [loadCatalog])

  useEffect(() => {
    void loadEntries()
    return () => { entryGeneration.current++ }
  }, [loadEntries])


  const loadCandidates = useCallback(async () => {
    const generation = ++candidateGeneration.current
    if (!effectiveTarget) {
      setCandidates([])
      setCandidateLoading(false)
      return
    }
    setCandidateLoading(true)
    setCandidateError('')
    setCandidates([])
    try {
      const result = await ledgerRequest(context, { operation: 'review', target: effectiveTarget, filters: requestFilters })
      if (candidateGeneration.current !== generation) return
      setCandidates(result.candidates ?? [])
      setCandidateError('')
    } catch (reason) {
      if (candidateGeneration.current === generation) setCandidateError(errorMessage(reason))
    } finally {
      if (candidateGeneration.current === generation) setCandidateLoading(false)
    }
  }, [context, effectiveTarget, requestFilters])

  useEffect(() => {
    if (triageOpen) void loadCandidates()
    return () => { candidateGeneration.current++ }
  }, [triageOpen, loadCandidates])

  useEffect(() => {
    if (mode !== 'panel' || directory.loading || !workspaceId) return
    const currentWorkspace = directory.workspaces.find((item) => item.id === workspaceId) ?? null
    const currentRepo = currentWorkspace ? directory.repos.find((item) => item.id === currentWorkspace.repoId) ?? null : null
    const currentGroup = currentWorkspace ? directory.groups.find((item) => item.repoIds.includes(currentWorkspace.repoId)) ?? null : null
    setWorkspace(currentWorkspace)
    setWorkspaceRepo(currentRepo)
    setWorkspaceGroup(currentGroup)
  }, [mode, directory, workspaceId])

  const sortedEntries = useMemo(() => {
    const search = filters.search?.trim().toLocaleLowerCase() ?? ''
    const result = entries.filter((entry) => !search || entry.id.toLocaleLowerCase().includes(search) || entryTitle(entry).toLocaleLowerCase().includes(search))
    result.sort((left, right) => {
      if (sort === 'sequence') return left.sequence - right.sequence
      if (sort === 'title') return entryTitle(left).localeCompare(entryTitle(right)) || left.sequence - right.sequence
      return right.updatedAt.localeCompare(left.updatedAt) || right.sequence - left.sequence
    })
    return result
  }, [entries, filters.search, sort])

  const owners = catalog?.owners ?? []
  const currentSummary = response?.ledger ?? null
  const pageTitle = summaryTitle(currentSummary, effectiveTarget, owners)
  const ownerForPage = currentSummary?.owner ?? effectiveTarget?.owner ?? currentSummary?.formerOwner ?? null
  const pageTier = currentSummary?.tier ?? ownerForPage?.tier ?? 'project'
  const runtimeText = runtimeTip(response ?? catalog)
  const workspaceFolder = workspaceRepo?.kind === 'folder' || workspace?.kind === 'folder'
  const pageLedgerTarget = effectiveTarget

  const locationBases = useMemo<LocationBaseOption[]>(() => {
    const result: LocationBaseOption[] = []
    const addProject = (repo: RepoInfo) => {
      if (repo.kind === 'folder') return
      result.push({ value: `project:${repo.id}`, label: `Project: ${repoName(repo)}`, base: { kind: 'project', id: repo.id } })
    }
    const targetOwner = effectiveTarget?.owner ?? currentSummary?.owner ?? currentSummary?.formerOwner
    if (targetOwner?.tier === 'project') {
      const repo = directory.repos.find((item) => item.id === targetOwner.id)
      if (repo) addProject(repo)
      else if (currentSummary?.ownerPath) result.push({ value: `project:${targetOwner.id}`, label: `Project: ${currentSummary.ownerName ?? currentSummary.name}`, base: { kind: 'project', id: targetOwner.id } })
    } else if (targetOwner?.tier === 'group') {
      const group = directory.groups.find((item) => item.id === targetOwner.id)
      for (const repoId of group?.repoIds ?? []) {
        const repo = directory.repos.find((item) => item.id === repoId)
        if (repo) addProject(repo)
      }
    }
    const currentWorkspace = directory.workspaces.find((item) => item.id === workspaceId)
    if (currentWorkspace) {
      const belongs = !targetOwner || targetOwner.tier === 'project'
        ? !targetOwner || currentWorkspace.repoId === targetOwner.id
        : directory.groups.find((item) => item.id === targetOwner.id)?.repoIds.includes(currentWorkspace.repoId) ?? false
      if (belongs) result.push({ value: `workspace:${currentWorkspace.id}`, label: `Workspace: ${currentWorkspace.name ?? currentWorkspace.id}`, base: { kind: 'workspace', id: currentWorkspace.id } })
    }
    return result
  }, [effectiveTarget, currentSummary, directory, workspaceId])

  const visibleRows = sortedEntries
  const visibleCandidates = useMemo(() => {
    const search = filters.search?.trim().toLocaleLowerCase() ?? ''
    return candidates.filter((candidate) => !search || candidate.entry.id.toLocaleLowerCase().includes(search) || entryTitle(candidate.entry).toLocaleLowerCase().includes(search))
  }, [candidates, filters.search])
  const selectedKeys = useMemo(() => new Set(selected.map(selectionKey)), [selected])
  const triageKeys = useMemo(() => new Set(triageSelected.map(selectionKey)), [triageSelected])

  const openDetail = useCallback(async (entry: LedgerEntry, requestedTarget?: LedgerTarget) => {
    const target = requestedTarget ?? pageLedgerTarget
    if (!target) return
    const generation = ++detailGeneration.current
    setDetailId(entry.id)
    setDetail(null)
    setDetailLoading(true)
    setDetailError('')
    try {
      const result = await ledgerRequest(context, { operation: 'show', target, id: entry.id })
      if (detailGeneration.current !== generation) return
      if (!result.entry) throw new Error(`Ledger entry ${entry.id} was not returned.`)
      setDetail(result.entry)
    } catch (reason) {
      if (detailGeneration.current === generation) setDetailError(errorMessage(reason))
    } finally {
      if (detailGeneration.current === generation) setDetailLoading(false)
    }
  }, [context, pageLedgerTarget])
  const closeDetail = () => {
    detailGeneration.current++
    setDetail(null)
    setDetailId('')
    setDetailError('')
    setActionMessage('')
  }

  const returnToChooser = () => {
    closeDetail()
    setTarget(null)
    setPanelTargetOverride(null)
    setSelected([])
    setSelectionTitles(new Map())
    setTriageSelected([])
    setTriageTitles(new Map())
    setTriageOpen(false)
    setTriageConflict('')
    setConfirmation(null)
    setForm(null)
    setAttachChoice('')
  }

  const editEntry = (entry: LedgerEntry) => {
    closeDetail()
    setForm({ entry })
  }

  const beginNew = () => {
    setDetail(null)
    setDetailId('')
    setForm({ type: 'bug' })
  }

  const saveForm = async (type: LedgerType, content: Record<string, unknown>, entry?: LedgerEntry): Promise<LedgerResponse> => {
    if (!pageLedgerTarget) throw new Error('Choose a ledger before filing an entry.')
    try {
      const result = await ledgerRequest(context, entry
        ? { operation: 'edit', target: pageLedgerTarget, id: entry.id, ifRevision: entry.revision, content }
        : { operation: 'file', target: pageLedgerTarget, type, content })
      await loadEntries()
      return result
    } catch (reason) {
      if (isConflict(reason)) await loadEntries()
      throw reason
    }
  }

  const toggleSelected = (entry: LedgerEntry) => {
    const selection = { id: entry.id, revision: entry.revision }
    const key = selectionKey(selection)
    setSelected((current) => {
      if (current.some((item) => selectionKey(item) === key)) return current.filter((item) => selectionKey(item) !== key)
      if (current.length >= MAX_SELECTIONS) return current
      return [...current, selection]
    })
    setSelectionTitles((current) => {
      const next = new Map(current)
      if (selectedKeys.has(key)) next.delete(key)
      else next.set(key, entryTitle(entry))
      return next
    })
  }

  const toggleTriage = (candidate: LedgerCandidate) => {
    const selection = { id: candidate.entry.id, revision: candidate.entry.revision }
    const key = selectionKey(selection)
    setTriageSelected((current) => {
      if (current.some((item) => selectionKey(item) === key)) return current.filter((item) => selectionKey(item) !== key)
      if (current.length >= MAX_SELECTIONS) return current
      return [...current, selection]
    })
    setTriageTitles((current) => {
      const next = new Map(current)
      if (triageKeys.has(key)) next.delete(key)
      else next.set(key, entryTitle(candidate.entry))
      return next
    })
  }

  const approve = async (selections: LedgerSelection[], onConflict: (message: string) => void) => {
    if (!pageLedgerTarget || selections.length === 0) return
    onConflict('')
    setCandidateError('')
    setActionBusy(true)
    setActionMessage('')
    try {
      await ledgerRequest(context, { operation: 'approve', target: pageLedgerTarget, selections })
      setSelected([])
      setSelectionTitles(new Map())
      setTriageSelected([])
      setTriageTitles(new Map())
      await loadEntries()
      if (triageOpen) await loadCandidates()
      if (detail) await openDetail(detail)
    } catch (reason) {
      if (isConflict(reason)) {
        onConflict('Selected entry revisions changed. The latest rows and candidates have been reloaded; select them again.')
        setSelected([])
        setSelectionTitles(new Map())
        setTriageSelected([])
        setTriageTitles(new Map())
        await loadEntries()
        if (triageOpen) await loadCandidates()
        if (detail) await openDetail(detail)
      } else {
        setActionMessage(errorMessage(reason))
        if (triageOpen) setCandidateError(errorMessage(reason))
      }
    } finally {
      setActionBusy(false)
    }
  }

  const perRowReview = async (entry: LedgerEntry) => approve([{ id: entry.id, revision: entry.revision }], setActionMessage)

  const beginDeleteSelections = (selections: LedgerSelection[], titles: Map<string, string>, sourceEntries: LedgerEntry[]) => {
    if (selections.length === 0) return
    setConfirmation({ kind: 'delete-entries', selections, snapshots: selections.map((selection) => snapshotFor(selection, titles, sourceEntries)) })
  }

  const beginDelete = (entriesToDelete: LedgerEntry[]) => {
    const selections = entriesToDelete.map((entry) => ({ id: entry.id, revision: entry.revision }))
    beginDeleteSelections(selections, new Map(entriesToDelete.map((entry) => [selectionKey({ id: entry.id, revision: entry.revision }), entryTitle(entry)])), entriesToDelete)
  }

  const requestBulkState = (state: Extract<LedgerState, 'resolved' | 'archived'>, selections: LedgerSelection[], titles: Map<string, string>, sourceEntries: LedgerEntry[]) => {
    if (selections.length === 0) return
    setConfirmation({ kind: 'bulk-state', state, selections, snapshots: selections.map((selection) => snapshotFor(selection, titles, sourceEntries)) })
  }

  const openAttachConfirmation = () => {
    if (!currentSummary || !attachChoice) return
    const ownerOption = owners.find((owner) => `${owner.tier}:${owner.id}` === attachChoice)
    if (!ownerOption) return
    setConfirmation({
      kind: 'attach',
      ledgerId: currentSummary.ledgerId,
      revision: currentSummary.revision,
      attachTo: { tier: ownerOption.tier, id: ownerOption.id },
      ownerName: ownerOption.name
    })
  }

  const reloadAfterConflict = async (message: string) => {
    if (triageOpen) setTriageConflict(message)
    else setActionMessage(message)
    setSelected([])
    setSelectionTitles(new Map())
    setTriageSelected([])
    setTriageTitles(new Map())
    await loadEntries()
    if (triageOpen) await loadCandidates()
  }

  const confirmAction = async () => {
    const pending = confirmation
    if (!pending || confirmBusy) return
    setConfirmBusy(true)
    setActionMessage('')
    try {
      switch (pending.kind) {
        case 'bulk-state':
          if (!pageLedgerTarget) throw new Error('The ledger target is no longer available.')
          await ledgerRequest(context, { operation: 'bulk-state', target: pageLedgerTarget, state: pending.state, selections: pending.selections }, true)
          setSelected([])
          setSelectionTitles(new Map())
          setTriageSelected([])
          setTriageTitles(new Map())
          break
        case 'delete-entries':
          if (!pageLedgerTarget) throw new Error('The ledger target is no longer available.')
          await ledgerRequest(context, { operation: 'delete-entries', target: pageLedgerTarget, selections: pending.selections }, true)
          setSelected([])
          setSelectionTitles(new Map())
          break
        case 'delete-ledger':
          await ledgerRequest(context, { operation: 'delete-ledger', target: pageLedgerTarget ?? { ledgerId: pending.ledgerId }, ifLedgerRevision: pending.revision }, true)
          returnToChooser()
          break
        case 'attach':
          await ledgerRequest(context, { operation: 'attach', target: { ledgerId: pending.ledgerId }, attachTo: pending.attachTo, ifLedgerRevision: pending.revision }, true)
          setOwnerTarget({ owner: pending.attachTo })
          setAttachChoice('')
          break
      }
      setConfirmation(null)
      await loadEntries()
      await loadCatalog()
      if (triageOpen) await loadCandidates()
    } catch (reason) {
      setConfirmation(null)
      if (isConflict(reason)) {
        const revision = currentRevisionOf(reason)
        await reloadAfterConflict(revision === null ? 'The ledger changed after these snapshots were displayed. Review the refreshed revisions before confirming again.' : `The ledger changed to revision ${revision}. Review the refreshed revisions before confirming again.`)
      } else {
        if (triageOpen) setCandidateError(errorMessage(reason))
        else setActionMessage(errorMessage(reason))
      }
    } finally {
      setConfirmBusy(false)
    }
  }

  const openTriage = () => {
    setTriageConflict('')
    setTriageOpen(true)
    setTriageSelected([])
    setTriageTitles(new Map())
  }

  const actOnDetail = async (requestBody: Parameters<typeof ledgerRequest>[1]) => {
    if (!detail || !pageLedgerTarget) return
    const id = detail.id
    setActionBusy(true)
    setActionMessage('')
    try {
      await ledgerRequest(context, requestBody)
      await loadEntries()
      await openDetail({ ...detail, id })
    } catch (reason) {
      if (isConflict(reason)) {
        const revision = currentRevisionOf(reason)
        setActionMessage(revision === null ? 'The entry changed while you were acting. Its latest revision has been reloaded.' : `The entry changed to revision ${revision}; review the refreshed entry before trying again.`)
        await loadEntries()
        await openDetail({ ...detail, id })
      } else {
        setActionMessage(errorMessage(reason))
      }
    } finally {
      setActionBusy(false)
    }
  }

  const setState = (entry: LedgerEntry, state: LedgerState) => actOnDetail({ operation: 'state', target: pageLedgerTarget ?? undefined, id: entry.id, state, ifRevision: entry.revision })
  const reviewDetail = (entry: LedgerEntry) => actOnDetail({ operation: 'approve', target: pageLedgerTarget ?? undefined, selections: [{ id: entry.id, revision: entry.revision }] })
  const revertDetail = (entry: LedgerEntry, toRevision: number) => actOnDetail({ operation: 'revert', target: pageLedgerTarget ?? undefined, id: entry.id, toRevision, ifRevision: entry.revision })

  const toggleTriageCandidate = (candidate: LedgerCandidate) => toggleTriage(candidate)
  const approveTriage = () => void approve(triageSelected, setTriageConflict)

  const openEditById = async (id: string, requestedTarget?: LedgerTarget) => {
    const target = requestedTarget ?? pageLedgerTarget
    const listed = requestedTarget ? undefined : entries.find((entry) => entry.id === id)
    if (listed) {
      setForm({ entry: listed })
      return
    }
    if (!target) throw new Error('The ledger target is not available.')
    const result = await ledgerRequest(context, { operation: 'show', target, id })
    if (!result.entry) throw new Error(`Ledger entry ${id} was not found.`)
    setForm({ entry: result.entry })
  }

  const setOwnerTarget = (next: LedgerTarget | undefined) => {
    if (!next) return
    if (JSON.stringify(effectiveTarget) !== JSON.stringify(next)) {
      setSelected([])
      setSelectionTitles(new Map())
      setTriageSelected([])
      setTriageTitles(new Map())
      setForm(null)
      setConfirmation(null)
      detailGeneration.current++
      setDetail(null)
      setDetailId('')
      setDetailError('')
      setTriageConflict('')
      setActionMessage('')
    }
    if (mode === 'panel') setPanelTargetOverride(next)
    else setTarget(next)
  }

  dispatchRef.current = async (command: LedgerControl) => {
    if (command.target) setOwnerTarget(command.target)
    switch (command.action) {
      case 'scope':
        if (!command.scope || !['worktree', 'project', 'group'].includes(command.scope)) throw new Error('Ledger scope must be worktree, project, or group.')
        setScope(command.scope)
        if (mode === 'panel' && !command.target) setPanelTargetOverride(null)
        break
      case 'filters':
        setFilters((previous) => ({ ...previous, ...(command.filters ?? {}) }))
        break
      case 'sort':
        if (!command.sort || !['activity', 'sequence', 'title'].includes(command.sort)) throw new Error('Ledger sort must be activity, sequence, or title.')
        setSort(command.sort)
        break
      case 'selection':
        setSelected(safeSelections(command.selections))
        setSelectionTitles(new Map())
        break
      case 'detail':
        if (!command.id) throw new Error('Ledger detail requires an entry id.')
        {
          const requestTarget = command.target ?? pageLedgerTarget
          const found = command.target ? undefined : entries.find((entry) => entry.id === command.id)
          if (found) await openDetail(found, requestTarget)
          else if (requestTarget) {
            const result = await ledgerRequest(context, { operation: 'show', target: requestTarget, id: command.id })
            if (!result.entry) throw new Error(`Ledger entry ${command.id} was not found.`)
            await openDetail(result.entry, requestTarget)
          } else throw new Error('Open a ledger before showing an entry.')
        }
        break
      case 'new':
        beginNew()
        break
      case 'edit':
        if (!command.id) throw new Error('Ledger edit requires an entry id.')
        await openEditById(command.id, command.target)
        break
      case 'triage':
        openTriage()
        break
      case 'settings': {
        const requestedOwner = command.target?.owner
        const projectOwner = requestedOwner
          ? requestedOwner.tier === 'project' ? requestedOwner : null
          : currentSummary?.owner?.tier === 'project' ? currentSummary.owner : effectiveTarget?.owner?.tier === 'project' ? effectiveTarget.owner : null
        const repoId = projectOwner ? currentSummary?.repoId ?? projectOwner.id : undefined
        if (!repoId) throw new Error('Ledger settings require a live project ledger.')
        context.openView(LEDGER_SETTINGS_VIEW_ID, { repoId })
        break
      }
    }
  }

  useEffect(() => registerControl?.((command) => dispatchRef.current(command), mode), [registerControl, mode])

  const dialogName = confirmation ? `confirm:${confirmation.kind}` : triageOpen ? 'triage' : form ? (form.entry ? 'edit' : 'new') : detailId ? 'detail' : 'none'
  useEffect(() => {
    report?.({
      view: mode === 'panel' ? 'panel' : effectiveTarget ? 'page' : 'chooser',
      target: effectiveTarget ?? undefined,
      scope,
      filters,
      sort,
      selection: triageOpen ? triageSelected : selected,
      dialog: dialogName,
      entryId: detail?.id || detailId || form?.entry?.id
    })
  }, [report, mode, effectiveTarget, scope, filters, sort, selected, triageSelected, triageOpen, dialogName, detail, detailId, form])

  useEffect(() => {
    return context.subscribe((event) => {
        void loadCatalog()
        void loadEntries()
        if (triageOpen) void loadCandidates()
      }
    })
  }, [context, loadCatalog, loadEntries, loadCandidates, triageOpen])

  const refresh = () => void loadEntries(true)
  const availableOwners = owners.filter((candidate) => Boolean(currentSummary && !candidate.ledgerId && candidate.tier === currentSummary.tier && (!currentSummary.owner || candidate.id !== currentSummary.owner.id)))
  const detached = Boolean(currentSummary && !currentSummary.owner)

  const renderFilters = () => (
    <div className="ledger-filters" aria-label="Ledger filters">
      <label className="search">
        <span>Search title or ID</span>
        <input aria-label="Search ledger" placeholder="Search title or ID" value={filters.search ?? ''} onChange={(event) => setFilters((previous) => ({ ...previous, search: event.target.value }))} />
      </label>
      <label><span>Type</span><select aria-label="Filter by type" value={filters.type ?? ''} onChange={(event) => setFilters((previous) => ({ ...previous, type: event.target.value ? event.target.value as LedgerType : undefined }))}>
        <option value="">All types</option>{TYPE_OPTIONS.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
      </select></label>
      <label><span>State</span><select aria-label="Filter by state" value={filters.state ?? ''} onChange={(event) => setFilters((previous) => ({ ...previous, state: event.target.value ? event.target.value as LedgerState : undefined }))}>
        <option value="">All states</option>{STATE_OPTIONS.map((state) => <option key={state} value={state}>{state[0]!.toUpperCase() + state.slice(1)}</option>)}
      </select></label>
      <label><span>Review</span><select aria-label="Filter by review status" value={filters.reviewed === undefined ? '' : String(filters.reviewed)} onChange={(event) => setFilters((previous) => ({ ...previous, reviewed: event.target.value === '' ? undefined : event.target.value === 'true' }))}>
        <option value="">All review statuses</option><option value="true">Reviewed</option><option value="false">Unreviewed</option>
      </select></label>
      <label><span>Freshness</span><select aria-label="Filter by freshness" value={filters.stale === undefined ? '' : String(filters.stale)} onChange={(event) => setFilters((previous) => ({ ...previous, stale: event.target.value === '' ? undefined : event.target.value === 'true' }))}>
        <option value="">All entries</option><option value="true">Stale</option><option value="false">Not stale</option>
      </select></label>
      {mode === 'page' && <>
        <label><span>Origin workspace</span><input aria-label="Origin workspace" value={filters.workspaceId ?? ''} onChange={(event) => setFilters((previous) => ({ ...previous, workspaceId: event.target.value || undefined }))} /></label>
        <label><span>Origin branch</span><input aria-label="Origin branch" value={filters.branch ?? ''} onChange={(event) => setFilters((previous) => ({ ...previous, branch: event.target.value || undefined }))} /></label>
        <label><span>Sort</span><select aria-label="Sort ledger entries" value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
          <option value="activity">Newest activity</option><option value="sequence">Sequence</option><option value="title">Title</option>
        </select></label>
      </>}
    </div>
  )

  const renderRow = (entry: LedgerEntry) => {
    const currentSelection = { id: entry.id, revision: entry.revision }
    const checked = selectedKeys.has(selectionKey(currentSelection))
    return (
      <li className="ledger-entry-row" key={entry.id} data-entry-id={entry.id}>
        <div className="ledger-row-main">
          {mode === 'page' && <label className="ledger-check-row">
            <input type="checkbox" aria-label={`Select ${entry.id} revision ${entry.revision}`} checked={checked} onChange={() => toggleSelected(entry)} />
          </label>}
          <button type="button" className="ledger-row-title" aria-label={`Show details: ${entry.id}`} onClick={() => { setActionMessage(''); void openDetail(entry) }}>
            <code>{entry.id}</code> · <span className="ledger-badge">{TYPE_LABELS[entry.type]}</span> · <span className="ledger-badge">{entry.state}</span>{entry.reviewed && <span className="ledger-badge reviewed">reviewed</span>} · {entryTitle(entry)}
          </button>
          {mode === 'panel' && scope !== 'worktree' && workspaceId && entry.origin.workspaceId === workspaceId && <span className="ledger-badge">Filed here</span>}
        </div>
        <div className="ledger-row-actions">
          <button type="button" aria-label={`Edit ${entry.id}`} onClick={() => setForm({ entry })}>Edit {entry.id}</button>
          <button type="button" aria-label={`Review ${entry.id}`} disabled={entry.reviewed || actionBusy} onClick={() => void perRowReview(entry)}>Review {entry.id}</button>
          <button type="button" aria-label={`Delete ${entry.id}`} onClick={() => beginDelete([entry])}>Delete {entry.id}</button>
        </div>
      </li>
    )
  }

  const renderChooser = () => (
    <section className="ledger-root ledger-chooser">
      <style>{LEDGER_CSS}</style>
      <header className="ledger-header">
        <div><h1>Open ledger</h1><p className="ledger-summary">Attached and detached ledgers for this runtime</p></div>
        <button type="button" aria-label="Refresh ledger catalog" disabled={catalogLoading} onClick={() => void loadCatalog()}>Refresh</button>
      </header>
      {runtimeText && <p className="ledger-muted" title={runtimeText}>Runtime identity: {response?.runtime.runtimeId ?? catalog?.runtime.runtimeId ?? 'loading'}</p>}
      {catalogError && <div className="ledger-error" role="alert">Ledger catalog could not be loaded: {catalogError} <button type="button" onClick={() => void loadCatalog()}>Retry</button></div>}
      {catalogLoading && <p className="ledger-state-message">Loading ledgers…</p>}
      {!catalogLoading && !catalogError && (catalog?.ledgers?.length ?? 0) === 0 && <p className="ledger-empty">No attached or detached ledgers yet. File an entry to create one.</p>}
      <ul className="ledger-chooser-list">
        {(catalog?.ledgers ?? []).map((summary) => {
          const isDetached = !summary.owner
          const rowLabel = isDetached
            ? `${summary.name}, Detached ${summary.tier} ledger · ${summary.entryCount} ${summary.entryCount === 1 ? 'entry' : 'entries'}`
            : `${summary.name}, ${summary.tier === 'project' ? 'Project' : 'Group'} · ${summary.entryCount} ${summary.entryCount === 1 ? 'entry' : 'entries'}`
          return <li className="ledger-chooser-row" key={summary.ledgerId}>
            <span>{rowLabel}</span>
            <button type="button" aria-label={`Open ledger ${summary.name}`} onClick={() => {
              setOwnerTarget(summary.owner ? { owner: summary.owner } : { ledgerId: summary.ledgerId })
            }}>Open</button>
          </li>
        })}
      </ul>
    </section>
  )

  const renderPanel = () => {
    const noWorkspace = !workspaceId && !directory.loading
    const groupScope = scope === 'group' || workspaceFolder
    return (
      <section className="ledger-root ledger-panel" aria-label="Ledger panel">
        <style>{LEDGER_CSS}</style>
        <header className="ledger-panel-header">
          <h2>Ledger</h2>
          <button type="button" aria-label="Refresh ledger" aria-busy={refreshSpinner} className={refreshSpinner ? 'ledger-refreshing' : ''} title={refreshSpinner ? 'Refreshing ledger…' : 'Refresh ledger'} onClick={refresh}>↻</button>
          <button type="button" onClick={openTriage}>Triage</button>
          <button type="button" onClick={beginNew}>New</button>
        </header>
        <div className="ledger-scope-tabs" role="group" aria-label="Ledger scope">
          <button type="button" aria-pressed={scope === 'worktree'} onClick={() => { setScope('worktree'); setPanelTargetOverride(null) }}>{workspaceFolder ? 'Folder' : 'Worktree'}</button>
          {!workspaceFolder && <button type="button" aria-pressed={scope === 'project'} onClick={() => { setScope('project'); setPanelTargetOverride(null) }}>Project</button>}
          {workspaceGroup && <button type="button" aria-pressed={scope === 'group'} onClick={() => { setScope('group'); setPanelTargetOverride(null) }}>Group</button>}
        </div>
        <div className="ledger-row-meta">
          {currentSummary && currentSummary.owner === null ? 'Detached' : `${groupScope ? 'Group' : 'Project'} · ${groupScope ? workspaceGroup?.name ?? currentSummary?.ownerName ?? 'Unknown group' : currentSummary?.ownerName ?? repoName(workspaceRepo)}`}
          {scope === 'worktree' && workspace && <span> · Filed in {workspace.name ?? workspace.id}</span>}
        </div>
        {renderFilters()}
        {directory.error && <p role="alert" className="ledger-error">Owner catalog could not be loaded: {directory.error} <button type="button" onClick={() => setDirectoryRetry((value) => value + 1)}>Retry</button></p>}
        {directory.loading && <p className="ledger-state-message">Loading ledger…</p>}
        {!directory.loading && noWorkspace && <p className="ledger-empty">Open a workspace to see its ledger.</p>}
        {!directory.loading && missingGroup && <p className="ledger-error">This workspace has no group.</p>}
        {error && <p role="alert" className="ledger-error">{error}<button type="button" onClick={refresh}>Retry</button></p>}
        {!directory.loading && !noWorkspace && !missingGroup && loading && <p className="ledger-state-message">Loading ledger…</p>}
        {!directory.loading && !noWorkspace && !missingGroup && !loading && !error && visibleRows.length === 0 && <div className="ledger-empty"><p>No entries match this view.</p><button type="button" onClick={beginNew}>New entry</button></div>}
        {!directory.loading && !error && <ul className="ledger-entry-list">{visibleRows.map(renderRow)}</ul>}
      </section>
    )
  }

  const renderPage = () => (
    <section className="ledger-root ledger-page">
      <style>{LEDGER_CSS}</style>
      <header className="ledger-header">
        <div><p className="ledger-muted"><button type="button" onClick={() => { returnToChooser(); void loadCatalog() }}>Open ledger</button></p><h1>{pageTitle}</h1>
          <p className="ledger-summary" title={runtimeText}>{pageTier === 'project' ? 'Project' : 'Group'} · {currentSummary ? `${currentSummary.entryCount} entries · revision ${currentSummary.revision}` : 'No ledger yet'}{response?.runtime && <span> · runtime {response.runtime.runtimeId} · profile {response.runtime.profileId}</span>}</p>
        </div>
        <div className="ledger-page-actions">
          {(effectiveTarget?.owner?.tier === 'project' || currentSummary?.owner?.tier === 'project') && <button type="button" onClick={() => {
            const repoId = currentSummary?.repoId ?? effectiveTarget?.owner?.id
            if (repoId) context.openView(LEDGER_SETTINGS_VIEW_ID, { repoId })
          }}>Ledger settings</button>}
          <button type="button" aria-label="Refresh ledger" aria-busy={refreshSpinner} className={refreshSpinner ? 'ledger-refreshing' : ''} title={refreshSpinner ? 'Refreshing ledger…' : 'Refresh ledger'} onClick={refresh}>Refresh</button>
          <button type="button" onClick={openTriage}>Triage</button>
          <button type="button" onClick={beginNew}>New entry</button>
          {currentSummary && <button type="button" onClick={() => setConfirmation({ kind: 'delete-ledger', ledgerId: currentSummary.ledgerId, revision: currentSummary.revision, entryCount: currentSummary.entryCount })}>Delete ledger</button>}
        </div>
      </header>
      <div className="ledger-row-meta" title={runtimeText}>{currentSummary && currentSummary.owner === null ? `Detached ${currentSummary.tier} ledger · former owner ${currentSummary.formerOwner?.id ?? 'unknown'}` : ownerForPage ? `${ownerForPage.tier} · ${currentSummary?.ownerName ?? pageTitle}` : `${pageTier} · ${pageTitle}`}</div>
      {detached && <section className="ledger-attach" aria-label="Attach detached ledger">
        <label><span>Attach ledger to owner</span><select aria-label="Attach ledger to owner" value={attachChoice} onChange={(event) => setAttachChoice(event.target.value)}>
          <option value="">Choose a live owner</option>{availableOwners.map((owner) => <option key={`${owner.tier}:${owner.id}`} value={`${owner.tier}:${owner.id}`}>{owner.tier} · {owner.name}</option>)}
        </select></label>
        <button type="button" disabled={!attachChoice} onClick={openAttachConfirmation}>Attach</button>
        {availableOwners.length === 0 && <p className="ledger-muted">No unoccupied live owners are available.</p>}
      </section>}
      {catalogError && <p role="alert" className="ledger-error">Owner catalog unavailable: {catalogError}</p>}
      {directory.error && <p role="alert" className="ledger-error">Location bases could not be loaded: {directory.error} <button type="button" onClick={() => setDirectoryRetry((value) => value + 1)}>Retry</button></p>}
      {renderFilters()}
      {error && <p role="alert" className="ledger-error">Ledger could not be loaded: {error} <button type="button" onClick={refresh}>Retry</button></p>}
      {actionMessage && <p role="alert" className="ledger-error">{actionMessage}</p>}
      {loading && <p className="ledger-state-message">Loading ledger…</p>}
      {!loading && !error && visibleRows.length === 0 && <div className="ledger-empty"><p>No entries match this view.</p><button type="button" onClick={beginNew}>New entry</button></div>}
      {!error && <ul className="ledger-entry-list">{visibleRows.map(renderRow)}</ul>}
      {selected.length > 0 && <div className="ledger-bulk-actions" aria-label="Selected ledger actions">
        <span>{selected.length} selected</span>
        <button type="button" disabled={actionBusy} onClick={() => void approve(selected, setActionMessage)}>Review ({selected.length})</button>
        <button type="button" onClick={() => requestBulkState('resolved', selected, selectionTitles, entries)}>Resolve selected</button>
        <button type="button" onClick={() => requestBulkState('archived', selected, selectionTitles, entries)}>Archive selected</button>
        <button type="button" onClick={() => beginDeleteSelections(selected, selectionTitles, entries)}>Delete selected</button>
      </div>}
    </section>
  )

  const visible = mode === 'panel' ? renderPanel() : effectiveTarget ? renderPage() : renderChooser()
  return <div className="ledger-root" data-ledger-view={mode === 'panel' ? 'panel' : effectiveTarget ? 'page' : 'chooser'}>
    {visible}
    {form && <LedgerForm
      entry={form.entry}
      initialType={form.type}
      bases={locationBases}
      onCancel={() => setForm(null)}
      onSave={(type, content) => saveForm(type, content, form.entry)}
    />}
    {detailId && !detail && <div className="ledger-modal-backdrop" role="presentation"><section className="ledger-dialog" role="dialog" aria-modal="true" aria-label={`Ledger entry ${detailId}`}><header className="ledger-dialog-header"><h2>{detailId}</h2></header><div className="ledger-dialog-body">{detailLoading ? <p>Loading entry…</p> : <p role="alert" className="ledger-error">{detailError} <button type="button" onClick={() => {
      const entry = entries.find((item) => item.id === detailId)
      if (entry) void openDetail(entry)
    }}>Retry</button></p>}</div><footer className="ledger-dialog-actions"><button type="button" onClick={closeDetail}>Close</button></footer></section></div>}
    {detail && <LedgerDetail
      entry={detail}
      busy={actionBusy}
      error={actionMessage}
      onEdit={() => editEntry(detail)}
      onReview={() => void reviewDetail(detail)}
      onState={(state) => void setState(detail, state)}
      onRevert={(revision) => void revertDetail(detail, revision)}
      onClose={closeDetail}
    />}
    {triageOpen && <LedgerTriage
      candidates={visibleCandidates}
      selections={triageSelected}
      conflict={triageConflict}
      error={candidateError}
      busy={candidateLoading || actionBusy}
      onToggle={toggleTriageCandidate}
      onApprove={approveTriage}
      onBulkState={(state) => requestBulkState(state, triageSelected, triageTitles, visibleCandidates.map((candidate) => candidate.entry))}
      onRetry={() => void loadCandidates()}
      onClose={() => { setTriageOpen(false); setTriageConflict(''); setTriageSelected([]); setTriageTitles(new Map()) }}
    />}
    {confirmation && <div className="ledger-modal-backdrop" role="presentation">
      <section className="ledger-dialog" role="dialog" aria-modal="true" aria-label={confirmation.kind === 'delete-ledger' ? 'Confirm ledger deletion' : confirmation.kind === 'attach' ? 'Confirm ledger attachment' : 'Confirm ledger action'}>
        <header className="ledger-dialog-header"><h2>{confirmation.kind === 'delete-ledger' ? 'Delete ledger?' : confirmation.kind === 'attach' ? 'Attach ledger?' : 'Confirm ledger action'}</h2></header>
        <div className="ledger-dialog-body">
          <p>{confirmation.kind === 'bulk-state' ? `Set ${confirmation.selections.length} displayed entries to ${confirmation.state}? This bulk action requires confirmation and will use the listed immutable id/revision snapshots.`
            : confirmation.kind === 'delete-entries' ? `Permanently delete ${confirmation.selections.length} selected entries and their history? This action uses the listed immutable id/revision snapshots.`
              : confirmation.kind === 'delete-ledger' ? 'Permanently delete this ledger, every entry body, and all history?'
                : `Attach this detached ledger to ${confirmation.ownerName}? The displayed ledger revision must still match.`}</p>
          <ul className="ledger-confirm-snapshots">
            {confirmation.kind === 'bulk-state' || confirmation.kind === 'delete-entries'
              ? confirmation.snapshots.map((snapshot) => <li key={`${snapshot.id}@${snapshot.revision}`}><code>{snapshot.id}</code> · revision {snapshot.revision} · {snapshot.title}</li>)
              : confirmation.kind === 'delete-ledger'
                ? <li><code>{confirmation.ledgerId}</code> · ledger revision {confirmation.revision} · {confirmation.entryCount} entries</li>
                : <li><code>{confirmation.ledgerId}</code> · ledger revision {confirmation.revision} · attach to {confirmation.attachTo.tier} {confirmation.attachTo.id}</li>}
          </ul>
        </div>
        <footer className="ledger-dialog-actions">
          <button type="button" disabled={confirmBusy} onClick={() => setConfirmation(null)}>Cancel</button>
          <button type="button" className="primary" disabled={confirmBusy} onClick={() => void confirmAction()}>Confirm</button>
        </footer>
      </section>
    </div>}
  </div>
}

export function LedgerSidebarSection({ context, report }: { context: UiPluginContext; report?(state: unknown): void }) {
  useEffect(() => report?.({ view: 'navigation', target: undefined, scope: null, filters: {}, sort: 'activity', selection: [], dialog: 'none' }), [report])
  return <div className="ledger-root"><style>{LEDGER_CSS}</style><button type="button" className="ledger-nav-item" onClick={() => context.openView(LEDGER_VIEW_ID)}>Ledger</button></div>
}
