import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { ItemTarget, ProjectTarget, TasksSurfaceProps } from '../contracts'
import { Markdown } from '../issue/Markdown'
import { openReview } from '../review-navigation'
import {
  asItems,
  asViews,
  boardColumns,
  boardGroupField,
  fieldDataType,
  fieldDisplayValue,
  fieldValue,
  groupProjectItems,
  hostFromUrl,
  isDraft,
  isIssue,
  isRestricted,
  nonEmpty,
  normalizeProjectTarget,
  normalizeField,
  projectIdentity,
  projectViewIdentity,
  record,
  type ProjectBoardColumn,
  type ProjectField,
  type ProjectGroup,
  type ProjectItem,
  type ProjectView
} from './model'
import { buildRoadmapTimeline, type RoadmapTimeline, type RoadmapZoom } from './timeline'

const linkCommand = 'command:quirky.tasks/open-link'
const copyTextCommand = 'command:quirky.tasks/copy-text'
const DOCS_URL = 'https://docs.github.com/en/issues/planning-your-work-with-projects/managing-your-projects/about-projects'
const text: CSSProperties = { color: 'var(--text, inherit)' }
const muted: CSSProperties = { color: 'var(--muted, #8a909e)' }
const panel: CSSProperties = { ...text, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0, overflow: 'hidden', padding: 12, boxSizing: 'border-box' }
const button: CSSProperties = { ...text, background: 'var(--bg-raised, transparent)', border: '1px solid var(--border, currentColor)', borderRadius: 5, padding: '5px 9px', cursor: 'pointer' }
const inputStyle: CSSProperties = { ...text, background: 'var(--bg, transparent)', border: '1px solid var(--border, currentColor)', borderRadius: 5, padding: '6px 8px', minWidth: 0 }
const ISSUE_TYPE_FIELD: ProjectField = { id: 'ISSUE_TYPE', name: 'Issue type', dataType: 'ISSUE_TYPE', options: [] }

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const raw = record(error)
  return typeof raw?.message === 'string' ? raw.message : 'The GitHub Projects request failed.'
}

function errorReason(error: unknown): string {
  const raw = record(error)
  const data = record(raw?.data)
  const nested = record(data?.data)
  for (const value of [raw?.reason, raw?.code, data?.reason, data?.code, nested?.reason]) {
    if (typeof value === 'string') return value.toLowerCase().replaceAll('-', '_')
  }
  const message = errorMessage(error).toLowerCase()
  if (message.includes('scope') || message.includes('resource not accessible')) return 'scope_missing'
  if (message.includes('not logged in') || message.includes('auth')) return 'auth_required'
  if (message.includes('too many') || message.includes('too large') || message.includes('500 items')) return 'too_large'
  if (message.includes('not found')) return 'not_found'
  if (message.includes('schema')) return 'schema_drift'
  if (message.includes('unsupported') && message.includes('layout')) return 'unsupported_layout'
  return 'unknown'
}
function hostFromError(error: unknown): string | null {
  const data = record(record(error)?.data)
  const explicit = nonEmpty(data?.host)
  if (explicit) return explicit
  const message = errorMessage(error)
  const match = /--hostname\s+([^\s]+)/i.exec(message) ?? /\bto\s+([a-z0-9.-]+)/i.exec(message)
  return match?.[1]?.replace(/[.,;]+$/, '').toLowerCase() ?? null
}

function object(value: unknown): Record<string, unknown> {
  return record(value) ?? {}
}


function projectItemUrl(item: ProjectItem, project: ProjectTarget): string | null {
  const content = item.content
  const expectedHost = (project.host ?? hostFromUrl(project.url) ?? 'github.com').toLowerCase()
  const direct = nonEmpty(content?.url)
  if (direct) {
    try {
      const url = new URL(direct)
      const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname)
      const kind = content?.kind === 'pullRequest' ? 'pull' : content?.kind === 'issue' ? 'issues' : null
      const number = Number(content?.number)
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
        url.host.toLowerCase() !== expectedHost || !match || match[3] !== kind ||
        (Number.isSafeInteger(number) && number > 0 && Number(match[4]) !== number)) return null
      return direct
    } catch {
      return null
    }
  }
  const slug = nonEmpty(content?.repository)
  const match = slug ? /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(slug) : null
  const number = Number(content?.number)
  const kind = content?.kind === 'pullRequest' ? 'pull' : content?.kind === 'issue' ? 'issues' : null
  return match?.[1] && match[2] && kind && Number.isSafeInteger(number) && number > 0
    ? `https://${expectedHost}/${match[1]}/${match[2]}/${kind}/${number}`
    : null
}

function parseRepoSlug(item: ProjectItem, project: ProjectTarget): { host: string; owner: string; repo: string } | null {
  const urlValue = projectItemUrl(item, project)
  if (!urlValue) return null
  try {
    const url = new URL(urlValue)
    const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/[1-9]\d*\/?$/.exec(url.pathname)
    return match?.[1] && match[2] ? { host: url.host.toLowerCase(), owner: match[1].toLowerCase(), repo: match[2].toLowerCase() } : null
  } catch {
    return null
  }
}

function localRemoteIdentities(value: unknown): Array<{ host: string; owner: string; repo: string }> {
  const raw = object(value)
  const found: Array<{ host: string; owner: string; repo: string }> = []
  const add = (entry: unknown) => {
    const candidate = object(entry)
    const host = nonEmpty(candidate.host)
    const owner = nonEmpty(candidate.owner)
    const repo = nonEmpty(candidate.repo)
    if (host && owner && repo) found.push({ host: host.toLowerCase(), owner: owner.toLowerCase(), repo: repo.toLowerCase() })
  }
  add(raw.origin)
  add(raw.repository)
  add(raw.issueRepository)
  for (const candidate of Array.isArray(raw.candidates) ? raw.candidates : []) add(candidate)
  return found
}

function repositoryAllowedIds(state: TasksSurfaceProps['state'], allIds: string[]): Set<string> {
  const session = state.navigation.repoIds
  const preference = state.preferences.defaultRepoSelection
  const selected = session ?? preference
  return selected === null ? new Set(allIds) : new Set(selected)
}

type LocalRepo = { id: string; name: string; path: string; worktree: string; repoId: string }
type RepoResolution = { state: 'ready' | 'updating'; matches: LocalRepo[]; excludedMatches: LocalRepo[]; contextWorktree: LocalRepo | null }

async function matchLocalRepositories(context: TasksSurfaceProps['context'], state: TasksSurfaceProps['state'], slug: { host: string; owner: string; repo: string } | null): Promise<RepoResolution> {
  if (!slug) return { state: 'ready', matches: [], excludedMatches: [], contextWorktree: null }
  let repositories: unknown[]
  try {
    const raw: unknown = await context.call('quirky.repo/list', {})
    repositories = Array.isArray(raw) ? raw : []
  } catch {
    return { state: 'updating', matches: [], excludedMatches: [], contextWorktree: null }
  }
  const gitRepositories = repositories.flatMap((value) => {
    const repo = record(value)
    const id = nonEmpty(repo?.id)
    if (!repo || repo.kind !== 'git' || id === null || typeof repo.path !== 'string') return []
    return [{ id, name: nonEmpty(repo.displayName) ?? nonEmpty(repo.name) ?? id, path: repo.path }]
  })
  const selectedIds = repositoryAllowedIds(state, gitRepositories.map((repo) => repo.id))
  let failed = false
  const probes = await Promise.all(gitRepositories.map(async (repo): Promise<{ repo: LocalRepo; matches: boolean } | null> => {
    let worktrees: unknown[]
    try {
      const raw: unknown = await context.call('quirky.worktree/list', { repo: repo.id })
      worktrees = Array.isArray(raw) ? raw : []
    } catch {
      failed = true
      return null
    }
    const preferred = worktrees.find((candidate) => {
      const value = record(candidate)
      return value?.repoId === repo.id && value.isMain === true && typeof value.id === 'string'
    }) ?? worktrees.find((candidate) => record(candidate)?.repoId === repo.id && typeof record(candidate)?.id === 'string')
    const worktree = nonEmpty(record(preferred)?.id)
    if (worktree === null) return null
    const local = { ...repo, worktree, repoId: repo.id }
    try {
      const identity = await context.call('quirky.hosting/repository', { worktree })
      const matches = localRemoteIdentities(identity).some((remote) => remote.host === slug.host && remote.owner === slug.owner && remote.repo === slug.repo)
      return { repo: local, matches }
    } catch {
      failed = true
      return { repo: local, matches: false }
    }
  }))
  const available = probes.flatMap((probe) => probe ? [probe] : [])
  const allMatches = available.filter((probe) => probe.matches).map((probe) => probe.repo)
  const contextWorktree = available.find((probe) => selectedIds.has(probe.repo.id))?.repo ?? available[0]?.repo ?? null
  return {
    state: failed ? 'updating' : 'ready',
    matches: allMatches.filter((repo) => selectedIds.has(repo.id)),
    excludedMatches: allMatches.filter((repo) => !selectedIds.has(repo.id)),
    contextWorktree
  }
}

function itemTarget(item: ProjectItem, project: ProjectTarget, worktree: string): ItemTarget | null {
  const content = item.content
  const kind = content?.kind === 'pullRequest' ? 'pullRequest' : content?.kind === 'issue' ? 'issue' : null
  const number = Number(content?.number)
  const url = projectItemUrl(item, project)
  const slug = parseRepoSlug(item, project)
  if (kind === null || !Number.isSafeInteger(number) || number < 1 || !url || !slug) return null
  return {
    worktree,
    kind,
    number,
    url,
    projectId: project.id,
    itemId: item.id,
    host: slug.host,
    owner: slug.owner,
    repo: slug.repo
  }
}

function sourceIdentity(project: ProjectTarget): string {
  return project.host ?? hostFromUrl(project.url) ?? 'github.com'
}

function projectUrl(project: ProjectTarget): string {
  return /^https:\/\//i.test(project.url) ? project.url : `https://${sourceIdentity(project)}/${project.ownerType === 'organization' ? 'orgs' : 'users'}/${project.owner}/projects/${project.number}`
}
function projectViewUrl(project: ProjectTarget, view: ProjectView | null): string {
  const base = projectUrl(project)
  const viewNumber = Number(view?.number ?? project.viewNumber)
  if (!Number.isSafeInteger(viewNumber) || viewNumber < 1) return base
  const url = new URL(base)
  const projectPath = url.pathname.replace(/\/views\/[^/]+\/?$/, '').replace(/\/+$/, '')
  return `${url.origin}${projectPath}/views/${viewNumber}`
}

function dataTypeIsReadOnly(field: ProjectField): boolean {
  const type = fieldDataType(field)
  const name = field.name?.trim().toLowerCase() ?? ''
  return type === 'REPOSITORY' || type === 'PARENT_ISSUE' || name === 'repository' || name === 'parent' || name === 'parent issue' || name === 'title'
}


export function ProjectsSurface({ context, state, refresh }: TasksSurfaceProps) {
  const [selectedProject, setSelectedProject] = useState<ProjectTarget | null>(null)
  const project = selectedProject ?? state.navigation.project
  const projectKey = project ? projectIdentity(project) : ''
  const preferredView = project ? (project.viewId ?? state.projects.lastViewByProject[projectKey]) : undefined
  const [localViewId, setLocalViewId] = useState('')
  const activeViewId = localViewId || preferredView || ''
  const [views, setViews] = useState<ProjectView[]>([])
  const [table, setTable] = useState<Record<string, unknown> | null>(null)
  const [loadingViews, setLoadingViews] = useState(false)
  const [loadingTable, setLoadingTable] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [chooseView, setChooseView] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')
  const [addInput, setAddInput] = useState('')
  const [browseProjects, setBrowseProjects] = useState<ProjectTarget[]>([])
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseError, setBrowseError] = useState<unknown>(null)
  const [browseErrorHost, setBrowseErrorHost] = useState<string | null>(null)
  const [partialFailures, setPartialFailures] = useState<ProjectRecord[]>([])
  const [pickerBusy, setPickerBusy] = useState(false)
  const [mainError, setMainError] = useState<unknown>(null)
  const [writeError, setWriteError] = useState<unknown>(null)
  const [errorAnnouncement, setErrorAnnouncement] = useState('')
  const [queryDraft, setQueryDraft] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [queryBusy, setQueryBusy] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<{ fieldId: string; direction: 'asc' | 'desc' | 'view' } | null>(null)
  const [itemPreview, setItemPreview] = useState<ProjectItem | null>(null)
  const [itemPreviewGuidance, setItemPreviewGuidance] = useState('')
  const [actionHelp, setActionHelp] = useState<{ item: ProjectItem; text: string; externalUrl: string | null; offerAddRepo?: boolean } | null>(null)
  const [addRepoPath, setAddRepoPath] = useState('')
  const [addingRepo, setAddingRepo] = useState(false)
  const [previewDetails, setPreviewDetails] = useState<ProjectRecord | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [busyItem, setBusyItem] = useState('')
  const [issueTypesByItem, setIssueTypesByItem] = useState<Record<string, Array<{ id: string; name: string }>>>({})
  const [deviceColumns, setDeviceColumns] = useState<{ hidden: string[]; widths: Record<string, number> }>({ hidden: [], widths: {} })
  const [zoom, setZoom] = useState<RoadmapZoom>(() => readZoom())
  const projectGeneration = useRef(0)
  const viewGeneration = useRef(0)
  const tableGeneration = useRef(0)
  const writeEpoch = useRef(0)
  const mutationGeneration = useRef(new Map<string, number>())
  const warnedSubIssues = useRef(false)
  const roadmapScroller = useRef<HTMLDivElement>(null)
  const previewGeneration = useRef(0)
  const currentView = views.find((view) => view.id === activeViewId) ?? (record(table?.view) as ProjectView | null)
  const queryKey = project && currentView ? projectViewIdentity(project, currentView.id) : ''
  const persistedQuery = queryKey ? state.projects.queryByView[queryKey] ?? (typeof currentView?.filter === 'string' ? currentView.filter : '') : ''
  const queryOverrideForView = queryKey ? state.projects.queryByView[queryKey] : undefined
  const tableItems = useMemo(() => asItems(table?.items), [table])
  const tableFields = useMemo(() => {
    const raw = Array.isArray(table?.fields) ? table.fields : currentView?.fields ?? []
    return raw.flatMap((value) => {
      const field = normalizeField(value)
      return field === null ? [] : [field]
    })
  }, [table, currentView])
  const roadmapModel = useMemo(() => buildRoadmapTimeline(tableFields, tableItems, zoom), [tableFields, tableItems, zoom])
  const layout = String(table?.layout ?? currentView?.layout ?? '').toUpperCase()
  const viewFilter = typeof currentView?.filter === 'string' ? currentView.filter : ''
  const activeQuery = appliedQuery
  const isQueryDirty = queryDraft !== activeQuery

  useEffect(() => {
    projectGeneration.current += 1
    viewGeneration.current += 1
    tableGeneration.current += 1
    setLocalViewId('')
    setViews([])
    setTable(null)
    setMainError(null)
    setWriteError(null)
    setErrorAnnouncement('')
    setActionHelp(null)
    previewGeneration.current += 1
    setItemPreview(null)
    setItemPreviewGuidance('')
    setPreviewDetails(null)
    setPreviewLoading(false)
    setChooseView(false)
    setSort(null)
    if (project) void loadViewsForProject(project)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey])

  useEffect(() => {
    if (!project || !currentView) {
      setQueryDraft('')
      setAppliedQuery('')
      return
    }
    setQueryDraft(persistedQuery)
    setAppliedQuery(persistedQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])

  useEffect(() => {
    const key = project && currentView ? projectViewIdentity(project, currentView.id) : ''
    if (!key || typeof localStorage === 'undefined') {
      setDeviceColumns({ hidden: [], widths: {} })
      return
    }
    setDeviceColumns(readDeviceColumns(key))
  }, [projectKey, currentView?.id])

  useEffect(() => {
    if (selectedProject && state.navigation.project && projectIdentity(selectedProject) === projectIdentity(state.navigation.project)) setSelectedProject(null)
  }, [state.navigation.project, selectedProject])

  async function loadViewsForProject(target: ProjectTarget) {
    const request = ++viewGeneration.current
    const projectRequest = projectGeneration.current
    setLoadingViews(true)
    setMainError(null)
    try {
      const raw = await context.call('quirky.tasks/projectView', { action: 'list', project: target })
      if (request !== viewGeneration.current || projectRequest !== projectGeneration.current) return
      const response = object(raw)
      const nextViews = asViews(object(response.result).views ?? response.views ?? raw)
      setViews(nextViews)
      const savedId = target.viewId ?? state.projects.lastViewByProject[projectIdentity(target)]
      const requestedId = target.viewNumber ? nextViews.find((view) => Number(view.number) === target.viewNumber)?.id : undefined
      const initial = savedId && nextViews.some((view) => view.id === savedId) ? savedId : requestedId
      if (initial) {
        setLocalViewId(initial)
        setChooseView(false)
        await loadTableFor(target, initial, state.projects.queryByView[projectViewIdentity(target, initial)] ?? undefined, false)
      } else {
        setLocalViewId('')
        setChooseView(true)
      }
    } catch (error) {
      if (request === viewGeneration.current && projectRequest === projectGeneration.current) setMainError(error)
    } finally {
      if (request === viewGeneration.current && projectRequest === projectGeneration.current) setLoadingViews(false)
    }
  }

  async function loadTableFor(target: ProjectTarget, viewId: string, query: string | undefined, refreshNow: boolean): Promise<boolean> {
    const request = ++tableGeneration.current
    const projectRequest = projectGeneration.current
    const observedWriteEpoch = writeEpoch.current
    setLoadingTable(true)
    setMainError(null)
    const params = {
      action: refreshNow ? 'refresh' : 'load',
      project: target,
      viewId,
      ...(query === undefined ? {} : { query })
    }
    let loaded = false
    try {
      const raw = await context.call('quirky.tasks/projectView', params)
      if (request !== tableGeneration.current || projectRequest !== projectGeneration.current || observedWriteEpoch !== writeEpoch.current) return false
      const response = object(raw)
      const resultValue = response.result ?? response.table ?? raw
      const result = object(resultValue)
      const tableResult = object(result.result ?? resultValue)
      setTable(tableResult)
      const loadedView = record(tableResult.view)
      if (loadedView && typeof loadedView.id === 'string') setViews((previous) => previous.map((view) => view.id === loadedView.id ? { ...view, ...loadedView, id: loadedView.id as string } : view))
      setMainError(null)
      loaded = true
      if (tableResult.parentFieldDropped === true && !warnedSubIssues.current) {
        warnedSubIssues.current = true
        context.toast('Sub-issue data is unavailable for your token.', 'GitHub did not return parent issue fields for this project view.')
      }
    } catch (error) {
      if (request === tableGeneration.current && projectRequest === projectGeneration.current && observedWriteEpoch === writeEpoch.current) setMainError(error)
    } finally {
      if (request === tableGeneration.current && projectRequest === projectGeneration.current) setLoadingTable(false)
    }
    return loaded
  }

  async function browseProjects(force = false) {
    setPickerBusy(true)
    setBrowseError(null)
    setBrowseErrorHost(null)
    try {
      const result = object(await context.call('quirky.tasks/projects', { ...(force ? { refresh: true } : {}) }))
      const found = (Array.isArray(result.projects) ? result.projects : []).flatMap((value) => normalizeProjectTarget(value) ? [normalizeProjectTarget(value)!] : []).slice(0, 32)
      setBrowseProjects(found)
      setPartialFailures(Array.isArray(result.partialFailures) ? result.partialFailures.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [])
      setBrowseOpen(true)
    } catch (error) {
      setBrowseError(error)
      setBrowseErrorHost(hostFromError(error))
      setBrowseOpen(true)
    } finally {
      setPickerBusy(false)
    }
  }

  async function chooseProject(action: 'add' | 'select', inputOrProject: string | ProjectTarget, viewNumber?: number) {
    setPickerBusy(true)
    setBrowseError(null)
    setBrowseErrorHost(null)
    try {
      const args = typeof inputOrProject === 'string'
        ? { action, input: inputOrProject, ...(viewNumber === undefined ? {} : { viewNumber }) }
        : { action, project: inputOrProject }
      const raw = await context.call('quirky.tasks/projectSelect', args)
      const response = object(raw)
      const selected = normalizeProjectTarget(response.project ?? response.target ?? response.selected) ?? (typeof inputOrProject === 'object' ? inputOrProject : null)
      if (selected) {
        setSelectedProject(selected)
        setLocalViewId(selected.viewId ?? '')
        setViews([])
        setTable(null)
        setPickerOpen(false)
        setBrowseOpen(false)
        setPickerSearch('')
        await loadViewsForProject(selected)
      }
    } catch (error) {
      const inputHost = typeof inputOrProject === 'string' ? hostFromUrl(inputOrProject) : inputOrProject.host ?? hostFromUrl(inputOrProject.url)
      setBrowseErrorHost(inputHost ?? hostFromError(error))
      setBrowseError(error)
    } finally {
      setPickerBusy(false)
    }
  }

  async function changeView(viewId: string) {
    if (!project) return
    const view = views.find((candidate) => candidate.id === viewId)
    if (!view || !supportedLayout(view.layout)) return
    const prior = activeViewId
    setLocalViewId(viewId)
    setSort(null)
    setChooseView(false)
    const nextQuery = state.projects.queryByView[projectViewIdentity(project, viewId)] ?? (typeof view.filter === 'string' ? view.filter : '')
    setAppliedQuery(nextQuery)
    setQueryDraft(nextQuery)
    try {
      await context.call('quirky.tasks/projectView', { action: 'select', project, viewId })
    } catch (error) {
      setLocalViewId(prior)
      setMainError(error)
      return
    }
    await loadTableFor(project, viewId, state.projects.queryByView[projectViewIdentity(project, viewId)] ?? undefined, false)
  }

  async function applyQuery(value: string) {
    if (!project || !currentView || queryBusy) return
    if (value === activeQuery) {
      setQueryDraft(activeQuery)
      return
    }
    setQueryBusy(true)
    const previous = activeQuery
    setAppliedQuery(value)
    setQueryDraft(value)
    try {
      const loaded = await loadTableFor(project, currentView.id, value, false)
      if (!loaded) {
        setAppliedQuery(previous)
        setQueryDraft(previous)
      }
    } finally {
      setQueryBusy(false)
    }
  }

  async function refreshProject() {
    if (project && currentView) {
      await loadTableFor(project, currentView.id, queryOverrideForView, true)
      return
    }
    if (project) {
      await loadViewsForProject(project)
      return
    }
    if (addInput.trim()) {
      await chooseProject('add', addInput.trim())
      return
    }
    await browseProjects(true)
    await refresh()
  }

  async function togglePin(target: ProjectTarget) {
    try {
      await context.call('quirky.tasks/projectSelect', { action: state.projects.pinned.some((candidate) => projectIdentity(candidate) === projectIdentity(target)) ? 'unpin' : 'pin', project: target })
    } catch (error) {
      context.toast('Could not update project pins', errorMessage(error))
    }
  }

  async function updateDeviceColumns(change: (value: { hidden: string[]; widths: Record<string, number> }) => { hidden: string[]; widths: Record<string, number> }) {
    if (!project || !currentView) return
    const key = projectViewIdentity(project, currentView.id)
    const next = change(deviceColumns)
    next.hidden = [...new Set(next.hidden)].filter((id) => id !== 'title')
    next.widths = Object.fromEntries(Object.entries(next.widths).flatMap(([id, width]) => {
      const number = Number(width)
      return Number.isFinite(number) && number >= 60 ? [[id, Math.min(800, Math.round(number))]] : []
    }))
    setDeviceColumns(next)
    writeDeviceColumns(key, next)
  }

  function commitOptimistic(itemId: string, fieldId: string, value: unknown, clear: boolean) {
    const key = `${itemId}|${fieldId}`
    const mine = (mutationGeneration.current.get(key) ?? 0) + 1
    mutationGeneration.current.set(key, mine)
    writeEpoch.current += 1
    setTable((previous) => {
      if (!previous) return previous
      const items = asItems(previous.items).map((item) => {
        if (item.id !== itemId) return item
        const values = item.fieldValues ?? []
        const nextValues = clear
          ? values.filter((entry) => entry.fieldId !== fieldId)
          : values.some((entry) => entry.fieldId === fieldId)
            ? values.map((entry) => entry.fieldId === fieldId ? { ...entry, value } : entry)
            : [...values, { fieldId, value }]
        return { ...item, fieldValues: nextValues }
      })
      return { ...previous, items }
    })
    return { key, mine }
  }

  async function editProjectField(item: ProjectItem, field: ProjectField, value: unknown, clear = false) {
    if (!project || isRestricted(item) || isDraft(item) || dataTypeIsReadOnly(field)) return
    const oldValues = item.fieldValues ?? []
    const mutation = commitOptimistic(item.id, field.id, value, clear)
    try {
      const args: Record<string, unknown> = { action: 'field', projectId: project.id, itemId: item.id, fieldId: field.id, host: project.host ?? hostFromUrl(project.url) ?? undefined, ...(clear ? { clear: true } : { value }) }
      await context.call('quirky.tasks/projectEdit', args)
      if (mutationGeneration.current.get(mutation.key) === mutation.mine) {
        setWriteError(null)
        setErrorAnnouncement('')
        await loadTableFor(project, currentView?.id ?? activeViewId, queryOverrideForView, false)
      }
    } catch (error) {
      if (mutationGeneration.current.get(mutation.key) === mutation.mine) {
        writeEpoch.current += 1
        setTable((previous) => previous ? {
          ...previous,
          items: asItems(previous.items).map((candidate) => candidate.id === item.id ? { ...candidate, fieldValues: oldValues } : candidate)
        } : previous)
        setWriteError(error)
        setErrorAnnouncement('Project field update was rolled back locally; GitHub did not confirm the change.')
        await loadTableFor(project, currentView?.id ?? activeViewId, queryOverrideForView, false)
      }
    }
  }

  async function editIssueCollection(item: ProjectItem, field: ProjectField, raw: string) {
    if (!project || !isIssue(item) || isRestricted(item) || isDraft(item)) return
    const values = raw.split(',').map((part) => part.trim().replace(/^@/, '')).filter(Boolean)
    const targetProp = fieldDataType(field) === 'USERS' || /assignee/i.test(field.name ?? '') ? 'assignees' : 'labels'
    const old = Array.isArray(item.content?.[targetProp]) ? item.content?.[targetProp] : []
    const key = `${item.id}|${targetProp}`
    const mine = (mutationGeneration.current.get(key) ?? 0) + 1
    mutationGeneration.current.set(key, mine)
    writeEpoch.current += 1
    setTable((previous) => previous ? { ...previous, items: asItems(previous.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, [targetProp]: values } } : candidate) } : previous)
    try {
      await context.call('quirky.tasks/projectEdit', { action: 'issue', projectId: project.id, itemId: item.id, kind: 'issue', number: item.content?.number, host: project.host ?? hostFromUrl(project.url) ?? undefined, [targetProp]: values })
      if (mutationGeneration.current.get(key) === mine) {
        setWriteError(null)
        setErrorAnnouncement('')
        await loadTableFor(project, currentView?.id ?? activeViewId, queryOverrideForView, false)
      }
    } catch (error) {
      if (mutationGeneration.current.get(key) === mine) {
        writeEpoch.current += 1
        setTable((previous) => previous ? { ...previous, items: asItems(previous.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, [targetProp]: old } } : candidate) } : previous)
        setWriteError(error)
        const data = record(record(error)?.data)
        const completed = Array.isArray(data?.completedSteps) ? data.completedSteps.filter((step) => typeof step === 'string') : []
        setErrorAnnouncement(data?.partial === true ? `Partial write: GitHub completed ${completed.join(', ') || 'part of the change'} before failing.` : 'The issue field update failed; the previous value was restored.')
        await loadTableFor(project, currentView?.id ?? activeViewId, queryOverrideForView, false)
      }
    }
  }

  async function updateIssueType(item: ProjectItem, issueType: { id: string; name: string }) {
    if (!project || !isIssue(item) || isRestricted(item) || isDraft(item)) return
    if (project.ownerType === 'user') {
      setWriteError(new Error('GitHub issue type edits are currently supported only for organization-owned Projects (hosting API D38).'))
      return
    }
    const key = `${item.id}|issueType`
    const mine = (mutationGeneration.current.get(key) ?? 0) + 1
    mutationGeneration.current.set(key, mine)
    const previous = item.content?.issueType ?? null
    writeEpoch.current += 1
    setTable((prior) => prior ? { ...prior, items: asItems(prior.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, issueType } } : candidate) } : prior)
    try {
      await context.call('quirky.tasks/projectEdit', {
        action: 'issueType', projectId: project.id, itemId: item.id, kind: 'issue',
        number: item.content?.number, host: project.host ?? hostFromUrl(project.url) ?? undefined, issueTypeId: issueType.id
      })
      if (mutationGeneration.current.get(key) === mine) {
        setWriteError(null)
        setErrorAnnouncement('')
        await loadTableFor(project, currentView?.id ?? activeViewId, queryOverrideForView, false)
      }
    } catch (error) {
      if (mutationGeneration.current.get(key) === mine) {
        writeEpoch.current += 1
        setTable((prior) => prior ? { ...prior, items: asItems(prior.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, issueType: previous } } : candidate) } : prior)
        setWriteError(error)
        await loadTableFor(project, currentView?.id ?? activeViewId, queryOverrideForView, false)
      }
    }
  }

  async function loadIssueTypes(item: ProjectItem) {
    if (!project || project.ownerType !== 'organization' || issueTypesByItem[item.id]) return
    try {
      const response = object(await context.call('quirky.tasks/projectEdit', {
        action: 'issueType', projectId: project.id, itemId: item.id, kind: 'issue',
        number: item.content?.number, host: project.host ?? hostFromUrl(project.url) ?? undefined
      }))
      const result = object(response.result)
      const options = Array.isArray(result.issueTypes) ? result.issueTypes.flatMap((value) => {
        const issueType = record(value)
        const id = nonEmpty(issueType?.id)
        const name = nonEmpty(issueType?.name)
        return id && name && issueType?.enabled !== false ? [{ id, name }] : []
      }) : []
      setIssueTypesByItem((previous) => ({ ...previous, [item.id]: options }))
    } catch (error) {
      setMainError(error)
    }
  }

  function showProjectCardPreview(item: ProjectItem, guidance: string) {
    previewGeneration.current += 1
    setItemPreview(item)
    setItemPreviewGuidance(guidance)
    setPreviewDetails(null)
    setPreviewLoading(false)
  }

  async function loadProjectItemPreview(item: ProjectItem, target: ItemTarget, guidance: string) {
    if (!target.projectId || !target.itemId) {
      showProjectCardPreview(item, guidance)
      return
    }
    const request = ++previewGeneration.current
    setItemPreview(item)
    setItemPreviewGuidance(guidance)
    setPreviewDetails(null)
    setPreviewLoading(true)
    try {
      const result = await context.call('quirky.hosting/projectItemDetails', {
        worktree: target.worktree,
        projectId: target.projectId,
        itemId: target.itemId,
        ...(target.host ? { host: target.host } : {})
      })
      if (request !== previewGeneration.current) return
      const details = record(result)
      if (details) setPreviewDetails(details)
      else setItemPreviewGuidance('GitHub did not return additional details. The Project card preview is still available.')
    } catch (error) {
      if (request === previewGeneration.current) setItemPreviewGuidance(`${guidance ? `${guidance} ` : ''}Could not load additional GitHub details: ${errorMessage(error)}`)
    } finally {
      if (request === previewGeneration.current) setPreviewLoading(false)
    }
  }

  async function openItem(item: ProjectItem) {
    if (!project || isRestricted(item) || isDraft(item)) {
      showProjectCardPreview(item, isRestricted(item) ? 'Restricted project content cannot be opened or edited.' : 'Draft project cards do not have an issue or pull-request detail page.')
      return
    }
    const resolution = await matchLocalRepositories(context, state, parseRepoSlug(item, project))
    if (resolution.state === 'updating') {
      const fallback = resolution.contextWorktree
      const target = fallback ? itemTarget(item, project, fallback.worktree) : null
      if (item.content?.kind === 'pullRequest' && target) {
        await loadProjectItemPreview(item, target, 'Repository matching is still updating; showing the exact Project item instead.')
      } else {
        showProjectCardPreview(item, 'Repository list is updating. This preview uses the Project card until local repository matching is ready.')
      }
      return
    }
    if (resolution.matches.length > 1) {
      showProjectCardPreview(item, 'This item matches multiple selected repositories. Its Project identity is shown here; select one repository to open local issue details.')
      return
    }
    const worktree = resolution.matches[0]?.worktree ?? resolution.contextWorktree?.worktree
    if (!worktree) {
      showProjectCardPreview(item, 'No registered local worktree is available for the Project item detail route. The Project card preview is shown instead.')
      return
    }
    const target = itemTarget(item, project, worktree)
    if (!target) {
      showProjectCardPreview(item, 'This Project card has no valid issue or pull-request identity.')
      return
    }
    try {
      if (target.kind === 'pullRequest') {
        if (resolution.matches.length === 1) {
          await openReview(context, { worktree: target.worktree, number: target.number, tab: 'conversation' })
          return
        }
        const reason = resolution.excludedMatches.length > 0 ? 'This pull request is outside the selected repositories. ' : ''
        await loadProjectItemPreview(item, target, `${reason}Project data is read by its exact Project item identity.`)
        return
      }
      await context.call('quirky.tasks/navigate', { mode: 'projects', detail: target, project })
    } catch (error) {
      setActionHelp({ item, text: `Could not open project item: ${errorMessage(error)}`, externalUrl: projectItemUrl(item, project) })
    }
  }

  async function startItem(item: ProjectItem, forceNew = false) {
    const externalUrl = project ? projectItemUrl(item, project) : null
    if (!project || isRestricted(item) || isDraft(item)) {
      setActionHelp({ item, text: isDraft(item) ? 'Draft project cards are not startable.' : 'Restricted project content cannot be opened or started.', externalUrl })
      return
    }
    const resolution = await matchLocalRepositories(context, state, parseRepoSlug(item, project))
    if (resolution.state === 'updating') {
      setActionHelp({ item, text: 'Repository list is updating. Retry once local repositories finish loading.', externalUrl })
      return
    }
    if (resolution.matches.length > 1) {
      setActionHelp({ item, text: 'This item matches multiple selected repositories. Select one repository before starting work.', externalUrl })
      return
    }
    if (resolution.matches.length === 0) {
      const message = resolution.excludedMatches.length > 0
        ? 'This item is outside the selected repositories. Change the Tasks repository selection to start work.'
        : 'Repository not in Quirky. Add a local clone of this GitHub repository, then start work from the project row.'
      setActionHelp({ item, text: message, externalUrl, offerAddRepo: resolution.excludedMatches.length === 0 })
      return
    }
    const matched = resolution.matches[0]!
    const target = itemTarget(item, project, matched.worktree)
    if (!target) return
    const content = item.content ?? {}
    const name = typeof content.title === 'string' && content.title.trim() ? content.title.trim().slice(0, 80) : `${content.kind === 'pullRequest' ? 'PR' : 'Issue'} #${content.number}`
    const url = externalUrl ?? ''
    const prompt = `Work on this GitHub ${content.kind === 'pullRequest' ? 'pull request' : 'issue'}: ${name}\\n\\n${url}${typeof content.body === 'string' && content.body.trim() ? `\\n\\n${content.body}` : ''}`
    const existingLink = linkedWorkspace(item, state, project)
    const workspaceAction = existingLink && !forceNew ? 'resume' : 'start'
    setBusyItem(item.id)
    try {
      const response = object(await context.call('quirky.tasks/workspace', {
        target,
        action: workspaceAction,
        ...(workspaceAction === 'start' ? { newWorkspace: true, name, prompt, setup: 'inherit' } : {})
      }))
      if (response.kind === 'composer') {
        context.toast('Workspace setup required', 'The Project item context is prefilled in the workspace composer.')
      } else if (response.kind === 'created' || response.kind === 'resumed' || response.kind === 'linked') {
        setActionHelp(null)
        context.toast(response.kind === 'resumed' ? 'Workspace resumed' : 'Workspace started', name)
      } else {
        setActionHelp({ item, text: 'The workspace action returned an unrecognized result. No success was reported.', externalUrl })
      }
    } catch (error) {
      setActionHelp({ item, text: `Could not start work: ${errorMessage(error)}`, externalUrl })
    } finally {
      setBusyItem('')
    }
  }
  async function addLocalRepository(item: ProjectItem) {
    const path = addRepoPath.trim()
    if (path.length === 0 || addingRepo) return
    setAddingRepo(true)
    try {
      const added = object(await context.call('quirky.repo/add', { path }))
      setActionHelp(null)
      setAddRepoPath('')
      context.toast('Repository added', String(added.name ?? added.id ?? path))
      await startItem(item)
    } catch (error) {
      setActionHelp({ item, text: `Could not add this repository: ${errorMessage(error)}`, externalUrl: project ? projectItemUrl(item, project) : null, offerAddRepo: true })
    } finally {
      setAddingRepo(false)
    }
  }



  async function invokeLink(url: string | null, commandId: string) {
    if (!url || !/^https:\/\//i.test(url)) return
    try {
      await context.executeCommand(commandId, { url })
    } catch (error) {
      context.toast('Could not open link', errorMessage(error))
    }
  }
  async function copyAuthCommand(value: string) {
    try {
      await context.executeCommand(copyTextCommand, { text: value })
      context.toast('Command copied', 'Paste the GitHub command into a terminal.')
    } catch (error) {
      context.toast('Could not copy command', errorMessage(error))
    }
  }

  function renderAuthHelp(error: unknown) {
    const host = browseErrorHost ?? (project ? sourceIdentity(project) : hostFromError(error)) ?? 'github.com'
    const enterprise = host.toLowerCase() !== 'github.com'
    const option = enterprise ? ` --hostname ${host}` : ''
    const command = `gh auth refresh${option} -s project -s read:org -s repo`
    const login = `gh auth login${option}`
    const reason = errorReason(error)
    return <section role="alert" style={{ ...text, border: '1px solid var(--amber, #f0b429)', borderRadius: 8, padding: 14, display: 'grid', gap: 8 }}>
      <strong>{reason === 'auth_required' ? `GitHub login is required for ${host}.` : `GitHub Projects access is missing for ${host}.`}</strong>
      <span>Projects need the <code>project</code>, <code>read:org</code>, and <code>repo</code> scopes on the account used by the hosting plugin.</span>
      <label style={{ display: 'grid', gap: 4 }}>Refresh scopes <code><input aria-label="GitHub project scope refresh command" readOnly value={command} style={{ ...inputStyle, width: '100%', fontFamily: 'monospace' }} onFocus={(event) => event.currentTarget.select()} /></code></label>
      <button type="button" style={button} onClick={() => void copyAuthCommand(command)}>Copy refresh command</button>
      <label style={{ display: 'grid', gap: 4 }}>Sign in <code><input aria-label="GitHub login command" readOnly value={login} style={{ ...inputStyle, width: '100%', fontFamily: 'monospace' }} onFocus={(event) => event.currentTarget.select()} /></code></label>
      <button type="button" style={button} onClick={() => void copyAuthCommand(login)}>Copy login command</button>
      <span>If <code>GH_TOKEN</code>, <code>GITHUB_TOKEN</code>, <code>GH_ENTERPRISE_TOKEN</code>, or <code>GITHUB_ENTERPRISE_TOKEN</code> is exported, it overrides the stored <code>gh</code> login. Remove it from the environment before refreshing scopes, then restart Quirky.</span>
      <span>If your organization enforces SAML SSO, authorize the token for that organization after login.</span>
      <div style={{ display: 'flex', gap: 8 }}><button type="button" style={button} onClick={() => void refreshProject()}>Reload</button><button type="button" style={button} onClick={() => void invokeLink(DOCS_URL, linkCommand)}>Docs</button></div>
    </section>
  }

  function renderProjectError(error: unknown) {
    const reason = errorReason(error)
    if (reason === 'auth_required' || reason === 'scope_missing') return renderAuthHelp(error)
    const data = record(record(error)?.data) ?? {}
    if (reason === 'too_large') {
      const count = Number(data.totalCount)
      return <ErrorCard title={Number.isFinite(count) ? `This view has ${count} items — too large to render in Quirky.` : 'This view is too large to render in Quirky.'} message="Narrow the view's filter on GitHub, then reload the project." onOpen={() => void invokeLink(project ? projectUrl(project) : null, linkCommand)} onRetry={() => void refreshProject()} />
    }
    if (reason === 'unsupported_layout') return <ErrorCard title="This project view layout is unsupported." message="Choose a table, board, or roadmap view. The original view remains available on GitHub." onOpen={() => void invokeLink(project ? projectUrl(project) : null, linkCommand)} onRetry={() => void refreshProject()} />
    if (reason === 'not_found') return <ErrorCard title="Could not find this project or view." message="It may have been removed, moved, or is not visible to the current GitHub account." onOpen={() => void invokeLink(project ? projectUrl(project) : null, linkCommand)} onRetry={() => void refreshProject()} />
    if (reason === 'schema_drift') return <ErrorCard title="GitHub returned a Projects schema Quirky does not recognize." message="The project data could not be interpreted safely. Retry later or open the project on GitHub." onOpen={() => void invokeLink(project ? projectUrl(project) : null, linkCommand)} onRetry={() => void refreshProject()} />
    return <ErrorCard title="Could not load this GitHub project." message={errorMessage(error)} onOpen={() => void invokeLink(project ? projectUrl(project) : null, linkCommand)} onRetry={() => void refreshProject()} />
  }

  const pickerQuery = pickerSearch.trim().toLowerCase()
  const matchesPickerQuery = (candidate: ProjectTarget) => pickerQuery.length === 0 || `${candidate.title ?? ''} ${candidate.owner} ${candidate.number} ${candidate.host ?? ''}`.toLowerCase().includes(pickerQuery)
  const pinnedProjects = state.projects.pinned.filter(matchesPickerQuery)
  const recentProjects = state.projects.recent.slice(0, 10).filter(matchesPickerQuery)
  const pinnedIdentities = new Set(state.projects.pinned.map(projectIdentity))
  const recentIdentities = new Set(state.projects.recent.slice(0, 10).map(projectIdentity))
  const pickerCandidates = browseProjects.filter((candidate) => matchesPickerQuery(candidate) && !pinnedIdentities.has(projectIdentity(candidate)) && !recentIdentities.has(projectIdentity(candidate)))

  if (!project) return <main style={{ ...panel, justifyContent: 'flex-start' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button type="button" style={button} onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen}>{state.projects.pinned.length || state.projects.recent.length ? 'Choose a project' : 'Choose a project'}</button>
      <span style={muted}>Projects v2</span>
    </div>
    <div style={{ border: '1px dashed var(--border, currentColor)', borderRadius: 8, padding: 24, textAlign: 'center', ...muted }}>Choose a project to get started.</div>
    {pickerOpen && renderPicker()}
    {browseError && <div role="alert">{renderProjectError(browseError)}</div>}
  </main>

  const columns = tableColumns(tableFields, deviceColumns.hidden)
  const sortedItems = sortItems(tableItems, tableFields, sort, currentView)
  const tableGroups = currentView ? groupProjectItems(sortedItems, currentView.groupByFields?.[0] ?? null) : []

  function renderPicker() {
    return <div role="dialog" aria-label="Choose a GitHub project" style={{ ...text, border: '1px solid var(--border, currentColor)', background: 'var(--bg-raised, #1d2027)', borderRadius: 8, padding: 12, display: 'grid', gap: 8, maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>Choose a project</strong><button type="button" style={{ ...button, marginLeft: 'auto' }} aria-label="Close project picker" onClick={() => setPickerOpen(false)}>Close</button></div>
      <input style={inputStyle} aria-label="Search projects" placeholder="Search projects" value={pickerSearch} onChange={(event) => setPickerSearch(event.currentTarget.value)} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={button} onClick={() => void browseProjects(false)} disabled={pickerBusy}>{pickerBusy ? 'Browse all (loading…)' : 'Browse all'}</button>
        <button type="button" style={button} onClick={() => void browseProjects(true)} disabled={pickerBusy}>Reload browse</button>
      </div>
      {pinnedProjects.length > 0 && <ProjectChoiceSection title="Pinned" projects={pinnedProjects} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
      {recentProjects.length > 0 && <ProjectChoiceSection title="Recent" projects={recentProjects} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
      {browseOpen && <ProjectChoiceSection title="Browse all" projects={pickerCandidates} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
      {browseOpen && pickerCandidates.length === 0 && !pickerBusy && !browseError && <p role="status" style={muted}>{pickerQuery ? 'No projects match this search.' : 'No additional projects were found. Add a project URL or owner/number below.'}</p>}
      {partialFailures.length > 0 && <p role="status" style={muted}>Some organization projects could not be listed. Paste a project URL below to reach missing ones.</p>}
      {browseError && renderProjectError(browseError)}
      <form onSubmit={(event) => { event.preventDefault(); if (addInput.trim()) void chooseProject('add', addInput.trim()) }} style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--border, currentColor)', paddingTop: 10 }}>
        <label htmlFor="project-reference">Add by URL or owner/number</label>
        <div style={{ display: 'flex', gap: 6 }}><input id="project-reference" style={{ ...inputStyle, flex: 1 }} value={addInput} onChange={(event) => setAddInput(event.currentTarget.value)} placeholder="https://github.com/orgs/team/projects/3/views/4" /><button style={button} type="submit" disabled={pickerBusy || addInput.trim().length === 0}>{pickerBusy ? 'Adding…' : 'Add'}</button></div>
      </form>
    </div>
  }

  const selectedView = currentView
  const openItemActions = (item: ProjectItem) => {
    const linked = linkedWorkspace(item, state, project) !== null
    return <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
      <button type="button" style={button} onClick={(event) => { event.stopPropagation(); void invokeLink(projectItemUrl(item, project), linkCommand) }} aria-label={`Open ${item.content?.kind ?? 'project item'} on GitHub`}>GitHub</button>
      <button type="button" style={button} disabled={busyItem === item.id || isRestricted(item) || isDraft(item)} onClick={(event) => { event.stopPropagation(); void startItem(item) }} aria-label={`${linked ? 'Resume' : 'Start work on'} ${String(item.content?.title ?? 'project item')}`}>{busyItem === item.id ? 'Starting…' : linked ? 'Resume' : 'Start work'}</button>
      {linked && <button type="button" style={button} disabled={busyItem === item.id} onClick={(event) => { event.stopPropagation(); void startItem(item, true) }} aria-label={`Start new workspace for ${String(item.content?.title ?? 'project item')}`}>Start new</button>}
    </div>
  }

  return <main style={panel}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, flexWrap: 'wrap' }}>
      <button type="button" style={button} onClick={() => { setPickerOpen((open) => !open); setBrowseError(null) }} aria-expanded={pickerOpen}>{project.title || `${project.owner}/${project.number}`}</button>
      <span style={muted}>{project.ownerType} · {sourceIdentity(project)}</span>
      <button type="button" style={{ ...button, marginLeft: 'auto' }} aria-label="Open view in GitHub" onClick={() => void invokeLink(projectViewUrl(project, selectedView), linkCommand)}>Open view in GitHub</button>
      <button type="button" style={{ ...button }} aria-label={selectedPin ? 'Remove project pin' : 'Pin project'} onClick={() => void togglePin(project)}>{selectedPin ? 'Unpin' : 'Pin'}</button>
      <button type="button" style={button} onClick={() => void refreshProject()} disabled={loadingTable || loadingViews} aria-label={loadingTable ? 'Refreshing project' : 'Refresh project'}>{loadingTable ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    {pickerOpen && renderPicker()}
    {loadingViews && views.length === 0 && <div role="status" style={muted}>Loading project views…</div>}
    <div role="tablist" aria-label="Project views" style={{ display: 'flex', gap: 6, overflowX: 'auto', borderBottom: '1px solid var(--border, currentColor)', paddingBottom: 6 }}>
      {views.map((view) => {
        const supported = supportedLayout(view.layout)
        return <button key={view.id} type="button" role="tab" aria-selected={view.id === activeViewId} disabled={!supported} title={supported ? undefined : `Quirky does not support ${String(view.layout ?? 'unknown')} project views yet.`} onClick={() => void changeView(view.id)} style={{ ...button, opacity: supported ? 1 : 0.5, borderColor: view.id === activeViewId ? 'var(--accent, #4f8ff7)' : 'var(--border, currentColor)' }}>{layoutLabel(view.layout)} · {view.name ?? 'View'}{!supported ? ' (Unsupported)' : ''}</button>
      })}
      {views.length === 0 && !loadingViews && <span style={muted}>No views found.</span>}
    </div>
    {selectedView && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input data-tasks-search type="search" aria-label="Search project items" placeholder={selectedView.filter || 'GitHub search, e.g. assignee:@me is:open'} value={queryDraft} onChange={(event) => setQueryDraft(event.currentTarget.value)} onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') { event.preventDefault(); void applyQuery(queryDraft) }
        if (event.key === 'Escape') { event.preventDefault(); setQueryDraft(activeQuery) }
      }} onBlur={() => { if (queryDraft !== activeQuery) void applyQuery(queryDraft) }} style={{ ...inputStyle, flex: '1 1 260px', maxWidth: 620, borderColor: isQueryDirty ? 'var(--amber, #f0b429)' : undefined }} />
      {isQueryDirty && <span role="status" style={{ color: 'var(--amber, #f0b429)' }}>Unapplied</span>}
      {queryBusy && <span role="status" style={muted}>Applying…</span>}
      <span aria-label="Project item count" style={{ ...muted, border: '1px solid var(--border, currentColor)', borderRadius: 12, padding: '2px 8px' }}>{table?.totalCount === null || table?.totalCount === undefined ? tableItems.length : String(table.totalCount)} items</span>
      <button type="button" style={button} onClick={() => setColumnsOpen((open) => !open)} aria-expanded={columnsOpen}>Configure columns</button>
    </div>}
    {columnsOpen && selectedView && <ColumnConfigurator fields={tableFields} hidden={deviceColumns.hidden} widths={deviceColumns.widths} onChange={(id, visible) => void updateDeviceColumns((previous) => ({ ...previous, hidden: visible ? previous.hidden.filter((hidden) => hidden !== id) : [...previous.hidden, id] }))} onWidth={(id, width) => void updateDeviceColumns((previous) => ({ ...previous, widths: { ...previous.widths, [id]: Math.max(60, width) } }))} />}
    {mainError && <div role="alert">{renderProjectError(mainError)}</div>}
    {writeError && <div role="alert">{renderProjectError(writeError)}</div>}
    {errorAnnouncement && <div role="status" style={{ color: 'var(--amber, #f0b429)' }}>{errorAnnouncement}</div>}
    {chooseView && <section style={{ display: 'grid', gap: 10, border: '1px solid var(--border, currentColor)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><button type="button" style={button} onClick={() => { setChooseView(false); setPickerOpen(true) }}>← Back</button><strong>Choose a view</strong></div>
      {loadingViews ? <span role="status">Loading views…</span> : views.length === 0 ? <span>No views found.</span> : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{views.map((view) => <button key={view.id} type="button" style={button} disabled={!supportedLayout(view.layout)} title={supportedLayout(view.layout) ? undefined : `Quirky does not support ${String(view.layout ?? 'unknown')} views yet.`} onClick={() => void changeView(view.id)}>{view.name} · {layoutLabel(view.layout)}{!supportedLayout(view.layout) ? ' · Unsupported' : ''}</button>)}</div>}
    </section>}
    {loadingTable && table === null && <div role="status" aria-label="Loading project view" style={{ display: 'grid', gap: 8 }}>{Array.from({ length: 6 }, (_, index) => <div key={index} style={{ height: 30, background: 'var(--bg-raised, #1d2027)', borderRadius: 4 }} />)}</div>}
    {!chooseView && !loadingViews && !mainError && selectedView && table !== null && tableItems.length === 0 && <div role="status" style={{ border: '1px dashed var(--border, currentColor)', borderRadius: 8, padding: 20, ...muted }}>{activeQuery || viewFilter ? 'No items match this view’s filter.' : <><strong style={text}>This view has no items yet.</strong><br />Recently added items can take a while to appear.</>}</div>}
    {!chooseView && table !== null && tableItems.length > 0 && <div style={{ minHeight: 0, flex: 1, overflow: 'auto', border: '1px solid var(--border, currentColor)', borderRadius: 6 }}>
      {layout === 'TABLE' && <ProjectTable items={sortedItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={(key) => setCollapsedGroups((previous) => toggleSet(previous, key))} sort={sort} onSort={toggleSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout === 'BOARD' && <ProjectBoard items={tableItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={(key) => setCollapsedGroups((previous) => toggleSet(previous, key))} sort={sort} onSort={toggleSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} onMove={editProjectField} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout === 'ROADMAP' && <ProjectRoadmap model={roadmapModel} items={tableItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={(key) => setCollapsedGroups((previous) => toggleSet(previous, key))} sort={sort} onSort={toggleSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} zoom={zoom} onZoom={(value) => { setZoom(value); saveZoom(value) }} onToday={() => scrollToToday(roadmapScroller.current, roadmapModel.todayIndex, roadmapModel.tickWidth)} scroller={roadmapScroller} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout !== 'TABLE' && layout !== 'BOARD' && layout !== 'ROADMAP' && <div role="alert">{renderProjectError(new Error('unsupported_layout'))}</div>}
    </div>}
    {!loadingTable && !loadingViews && table === null && !mainError && !chooseView && <div style={muted}>Choose a project view to load its items.</div>}
    {actionHelp && <div role="dialog" aria-label="Project item guidance" style={{ ...text, position: 'fixed', inset: '20% 24%', zIndex: 90, background: 'var(--bg-raised, #1d2027)', border: '1px solid var(--border, currentColor)', borderRadius: 10, padding: 16, boxShadow: '0 10px 40px #0008', display: 'grid', alignContent: 'start', gap: 10 }}>
      <strong>GitHub project item</strong><p>{actionHelp.text}</p>
      {actionHelp.offerAddRepo && <form onSubmit={(event) => { event.preventDefault(); void addLocalRepository(actionHelp.item) }} style={{ display: 'grid', gap: 6 }}>
        <label htmlFor="local-project-repo-path">Local repository path</label>
        <div style={{ display: 'flex', gap: 6 }}><input id="local-project-repo-path" style={{ ...inputStyle, flex: 1 }} value={addRepoPath} onChange={(event) => setAddRepoPath(event.currentTarget.value)} placeholder="/path/to/local/clone" /><button type="submit" style={button} disabled={addingRepo || addRepoPath.trim().length === 0}>{addingRepo ? 'Adding…' : 'Add repo'}</button></div>
      </form>}
      <div style={{ display: 'flex', gap: 8 }}><button type="button" style={button} onClick={() => void invokeLink(actionHelp.externalUrl, linkCommand)} disabled={!actionHelp.externalUrl}>Open in GitHub</button><button type="button" style={button} onClick={() => setActionHelp(null)}>Close</button></div>
    </div>}
    {itemPreview && <ProjectItemPreview item={itemPreview} url={projectItemUrl(itemPreview, project)} guidance={itemPreviewGuidance} details={previewDetails} loading={previewLoading} onClose={() => { previewGeneration.current += 1; setItemPreview(null); setItemPreviewGuidance(''); setPreviewDetails(null); setPreviewLoading(false); setActionHelp(null) }} onOpen={() => void invokeLink(projectItemUrl(itemPreview, project), linkCommand)} />}
  </main>

  function toggleSort(fieldId: string) {
    setSort((previous) => previous?.fieldId !== fieldId ? { fieldId, direction: 'asc' } : previous.direction === 'asc' ? { fieldId, direction: 'desc' } : previous.direction === 'desc' ? null : { fieldId, direction: 'asc' })
  }
}

function supportedLayout(layout: unknown): boolean {
  const normalized = typeof layout === 'string' ? layout.toUpperCase() : ''
  return normalized === 'TABLE' || normalized === 'BOARD' || normalized === 'ROADMAP'
}

function layoutLabel(layout: unknown): string {
  const value = typeof layout === 'string' ? layout.toUpperCase() : ''
  if (value === 'TABLE') return 'Table'
  if (value === 'BOARD') return 'Board'
  if (value === 'ROADMAP') return 'Roadmap'
  return value ? `${value[0]}${value.slice(1).toLowerCase()}` : 'Unsupported'
}

function toggleSet(previous: Set<string>, key: string): Set<string> {
  const next = new Set(previous)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

function linkedWorkspace(item: ProjectItem, state: TasksSurfaceProps['state'], project: ProjectTarget): string | null {
  const url = nonEmpty(item.content?.url)
  if (url && state.links[url]) return state.links[url]!.name
  const repository = nonEmpty(item.content?.repository)
  const parts = repository ? /^([^/]+)\/([^/]+)$/.exec(repository) : null
  const host = project.host ?? hostFromUrl(project.url)
  const kind = item.content?.kind === 'pullRequest' ? 'pullRequest' : 'issue'
  const number = Number(item.content?.number)
  if (!host || !parts?.[1] || !parts[2] || !Number.isSafeInteger(number) || number < 1) return null
  const key = `${host.toLowerCase()}|${kind}|${parts[1].toLowerCase()}/${parts[2].toLowerCase()}|${number}`
  return state.links[key]?.name ?? null
}

function tableColumns(fields: ProjectField[], hidden: string[]): Array<{ id: string; label: string; field: ProjectField | null; kind: 'title' | 'type' | 'field' }> {
  const visible = new Set(hidden)
  return [
    { id: 'title', label: 'Title', field: null, kind: 'title' as const },
    ...(visible.has('type') ? [] : [{ id: 'type', label: 'Type', field: null, kind: 'type' as const }]),
    ...fields.filter((field) => field.name?.toLowerCase() !== 'title' && field.name?.toLowerCase() !== 'type' && !visible.has(field.id)).map((field) => ({ id: field.id, label: field.name ?? field.id, field, kind: 'field' as const }))
  ]
}

function sortItems(items: ProjectItem[], fields: ProjectField[], sort: { fieldId: string; direction: 'asc' | 'desc' | 'view' } | null, view?: ProjectView): ProjectItem[] {
  const selected = sort ?? (view?.sortByFields?.[0] ? { fieldId: String(record(view.sortByFields[0]?.field)?.id ?? ''), direction: String(view.sortByFields[0]?.direction).toLowerCase() === 'desc' ? 'desc' as const : 'asc' as const } : null)
  if (!selected?.fieldId) return items
  const field = fields.find((candidate) => candidate.id === selected.fieldId)
  const valueFor = (item: ProjectItem): string | number => {
    if (selected.fieldId === 'title') return String(item.content?.title ?? '').toLocaleLowerCase()
    if (selected.fieldId === 'type') return String(item.content?.kind ?? '')
    if (!field) return fieldDisplayValue(item, { id: selected.fieldId, name: selected.fieldId })
    const value = fieldValue(item, field.id)
    return typeof value === 'number' ? value : fieldDisplayValue(item, field).toLocaleLowerCase()
  }
  const decorated = items.map((item, index) => ({ item, index, value: valueFor(item) }))
  decorated.sort((left, right) => {
    const compared = typeof left.value === 'number' && typeof right.value === 'number' ? left.value - right.value : String(left.value).localeCompare(String(right.value), undefined, { numeric: true, sensitivity: 'base' })
    if (compared === 0) return left.index - right.index
    return selected.direction === 'desc' ? -compared : compared
  })
  return decorated.map((value) => value.item)
}

function ColumnConfigurator(props: { fields: ProjectField[]; hidden: string[]; widths: Record<string, number>; onChange(id: string, visible: boolean): void; onWidth(id: string, width: number): void }) {
  const widthControl = (id: string, label: string, defaultWidth: number) => <input type="range" min={60} max={800} value={Math.max(60, props.widths[id] ?? defaultWidth)} aria-label={`${label} column width`} onChange={(event) => props.onWidth(id, Number(event.currentTarget.value))} />
  return <fieldset style={{ ...text, border: '1px solid var(--border, currentColor)', borderRadius: 6, display: 'flex', flexWrap: 'wrap', gap: 10 }}><legend>Configure columns</legend>
    <label style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 5, alignItems: 'center' }}><input type="checkbox" checked disabled />Title{widthControl('title', 'Title', 360)}</label>
    <label style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={!props.hidden.includes('type')} onChange={(event) => props.onChange('type', event.currentTarget.checked)} />Type{widthControl('type', 'Type', 140)}</label>
    {props.fields.filter((field) => field.name?.toLowerCase() !== 'title' && field.name?.toLowerCase() !== 'type').map((field) => {
      const visible = !props.hidden.includes(field.id)
      return <label key={field.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={visible} onChange={(event) => props.onChange(field.id, event.currentTarget.checked)} />{field.name ?? field.id}{widthControl(field.id, field.name ?? field.id, 140)}</label>
    })}
  </fieldset>
}

function ProjectChoiceSection(props: { title: string; projects: ProjectTarget[]; current: ProjectTarget | null; onChoose(project: ProjectTarget): void; onPin(project: ProjectTarget): void; pinnedIdentities: Set<string> }) {
  if (props.projects.length === 0) return null
  return <section style={{ display: 'grid', gap: 4 }}><strong>{props.title}</strong>{props.projects.map((project) => {
    const pinned = props.pinnedIdentities.has(projectIdentity(project))
    return <div key={projectIdentity(project)} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
      <button type="button" style={{ ...button, flex: 1, textAlign: 'left', borderColor: props.current && projectIdentity(project) === projectIdentity(props.current) ? 'var(--accent, #4f8ff7)' : undefined }} onClick={() => props.onChoose(project)}>{project.title || `${project.owner}/${project.number}`}<span style={{ ...muted, marginLeft: 8 }}>{project.ownerType} · {project.host ?? hostFromUrl(project.url)}</span></button>
      <button type="button" style={button} aria-label={pinned ? 'Remove pin' : 'Pin project'} onClick={() => props.onPin(project)}>{pinned ? 'Unpin' : 'Pin'}</button>
    </div>
  })}</section>
}

function ErrorCard(props: { title: string; message: string; onOpen(): void; onRetry(): void }) {
  return <section role="alert" style={{ ...text, border: '1px solid var(--danger, #e5534b)', borderRadius: 8, padding: 14, display: 'grid', gap: 8 }}><strong>{props.title}</strong><span>{props.message}</span><div style={{ display: 'flex', gap: 8 }}><button type="button" style={button} onClick={props.onRetry}>Retry</button><button type="button" style={button} onClick={props.onOpen}>Open in GitHub</button></div></section>
}

function ProjectItemPreview(props: { item: ProjectItem; url: string | null; guidance?: string; details: ProjectRecord | null; loading: boolean; onClose(): void; onOpen(): void }) {
  const detail = record(props.details)
  const content = record(detail?.item) ?? props.item.content ?? {}
  const body = typeof content.body === 'string' ? content.body : ''
  const comments = Array.isArray(detail?.comments) ? detail.comments.slice(0, 20).flatMap((value) => record(value) ? [record(value)!] : []) : []
  const timeline = Array.isArray(detail?.timeline) ? detail.timeline.slice(0, 20).flatMap((value) => record(value) ? [record(value)!] : []) : []
  const partialFailures = Array.isArray(detail?.partialFailures) ? detail.partialFailures.filter((value) => typeof value === 'string') : []
  const labels = Array.isArray(content.labels) ? content.labels.filter((value) => typeof value === 'string') : []
  const assignees = Array.isArray(content.assignees) ? content.assignees.filter((value) => typeof value === 'string') : []
  const kind = content.kind === 'pullRequest' ? 'Pull request' : 'Issue'
  return <div role="dialog" aria-label="GitHub item preview" style={{ ...text, position: 'fixed', inset: '12% 18%', zIndex: 100, background: 'var(--bg-raised, #1d2027)', border: '1px solid var(--border, currentColor)', borderRadius: 10, padding: 16, boxShadow: '0 10px 40px #0008', overflow: 'auto', display: 'grid', gap: 8, alignContent: 'start' }}>
    <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}><strong>GitHub item preview</strong><button type="button" style={{ ...button, marginLeft: 'auto' }} onClick={props.onClose}>Close</button></header>
    {props.guidance && <p role="status" style={muted}>{props.guidance}</p>}
    {props.loading && <span role="status">Loading GitHub item details…</span>}
    <h2 style={{ margin: '4px 0' }}>{String(content.title ?? (isRestricted(props.item) ? 'Restricted item' : 'Untitled item'))}</h2>
    <p style={muted}>{String(content.repository ?? 'Repository unavailable')} · {kind} {content.number ? `#${content.number}` : ''}{content.state ? ` · ${String(content.state)}` : ''}{content.author ? ` · @${String(content.author)}` : ''}</p>
    {content.headRefName && <p style={muted}>{String(content.baseRefName ?? '')} ← {String(content.headRefName)}</p>}
    {labels.length > 0 && <p style={muted}>Labels: {labels.join(', ')}</p>}
    {assignees.length > 0 && <p style={muted}>Assignees: {assignees.join(', ')}</p>}
    {body && <article aria-label="Description"><Markdown source={body} /></article>}
    {partialFailures.length > 0 && <p role="status" style={muted}>Some GitHub details are unavailable: {partialFailures.join('; ')}</p>}
    {comments.length > 0 && <section aria-label="Recent comments"><h3>Comments</h3>{comments.map((comment, index) => <article key={String(comment.id ?? index)} style={{ borderTop: '1px solid var(--border, currentColor)', paddingTop: 6 }}><span style={muted}>{String(comment.author ?? 'Unknown author')} · {String(comment.createdAt ?? '')}</span><Markdown source={String(comment.body ?? '')} /></article>)}</section>}
    {timeline.length > 0 && <details><summary>Activity ({timeline.length})</summary>{timeline.map((event, index) => <p key={String(event.id ?? index)}>{String(event.type ?? event.event ?? 'Activity')} · {String(event.createdAt ?? '')} · {String(event.actor ?? '')}</p>)}</details>}
    {isRestricted(props.item) && <p>This project card is restricted by GitHub permissions; its content cannot be displayed or edited.</p>}
    <button type="button" style={button} onClick={props.onOpen} disabled={!props.url}>Open in GitHub</button>
  </div>
}
 
function ProjectTable(props: {
  items: ProjectItem[]
  fields: ProjectField[]
  columns: Array<{ id: string; label: string; field: ProjectField | null; kind: 'title' | 'type' | 'field' }>
  widths: Record<string, number>
  issueTypesByItem: Record<string, Array<{ id: string; name: string }>>
  onLoadIssueTypes(item: ProjectItem): void
  view?: ProjectView
  groups: ProjectGroup[]
  collapsed: Set<string>
  onToggleGroup(key: string): void
  sort: { fieldId: string; direction: 'asc' | 'desc' | 'view' } | null
  onSort(id: string): void
  onFieldEdit(item: ProjectItem, field: ProjectField, value: unknown, clear?: boolean): Promise<void>
  onCollectionEdit(item: ProjectItem, field: ProjectField, value: string): Promise<void>
  onIssueTypeEdit(item: ProjectItem, issueType: { id: string; name: string }): Promise<void>
  onOpen(item: ProjectItem): void
  actions(item: ProjectItem): ReactNode
  project: ProjectTarget
}) {
  const widths = props.columns.map((column) => Math.max(60, props.widths[column.id] ?? (column.id === 'title' ? 360 : column.id === 'type' ? 140 : 140)))
  const lefts: number[] = []
  for (let index = 0; index < widths.length; index += 1) lefts[index] = widths.slice(0, index).reduce((sum, width) => sum + width, 0)
  const styleSticky = (index: number, header = false): CSSProperties => index < 2 ? { position: 'sticky', left: lefts[index], zIndex: header ? 5 : 2, background: 'var(--bg-raised, #1d2027)' } : {}
  const groupField = props.view?.groupByFields?.[0] ?? null
  const hasIssueTypeField = props.fields.some((field) => fieldDataType(field) === 'ISSUE_TYPE' || /issue.?type/i.test(field.name ?? ''))
  return <table style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: widths.reduce((sum, width) => sum + width, 180), width: 'max-content', tableLayout: 'fixed', ...text }}>
    <colgroup>{props.columns.map((column, index) => <col key={column.id} style={{ width: widths[index] }} />)}<col style={{ width: 170 }} /></colgroup>
    <thead style={{ position: 'sticky', top: 0, zIndex: 4, background: 'var(--bg-raised, #1d2027)' }}><tr>{props.columns.map((column, index) => <th key={column.id} scope="col" style={{ ...styleSticky(index, true), textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid var(--border, currentColor)', top: 0, width: widths[index], minWidth: widths[index], boxSizing: 'border-box' }}><button type="button" style={{ ...button, border: 0, padding: 0, background: 'transparent', fontWeight: 600 }} onClick={() => props.onSort(column.id)}>{column.label}{props.sort?.fieldId === column.id ? props.sort.direction === 'asc' ? ' ↑' : props.sort.direction === 'desc' ? ' ↓' : '' : ''}</button></th>)}<th scope="col" style={{ textAlign: 'right', padding: 7, borderBottom: '1px solid var(--border, currentColor)', position: 'sticky', right: 0, top: 0, zIndex: 5, background: 'var(--bg-raised, #1d2027)' }}>Actions</th></tr></thead>
    <tbody>{props.groups.map((group) => {
      const groupKey = `${props.view?.id ?? 'view'}|${group.key}`
      const isCollapsed = props.collapsed.has(groupKey)
      const groupItems = groupField ? group.items : props.items
      return <Fragment key={groupKey}>
        {groupField && <tr><th colSpan={props.columns.length + 1} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border, currentColor)', background: 'var(--bg, #16181d)' }}><button type="button" aria-expanded={!isCollapsed} style={{ ...button, border: 0, padding: 0, background: 'transparent' }} onClick={() => props.onToggleGroup(groupKey)}>{isCollapsed ? '▸' : '▾'} {group.label} · {group.items.length}{group.range ? ` · ${group.range}` : ''}{group.current ? ' · Current' : ''}</button></th></tr>}
        {!isCollapsed && groupItems.map((item) => <tr key={item.id} onDoubleClick={() => props.onOpen(item)} style={{ borderBottom: '1px solid var(--border, currentColor)' }}>
          {props.columns.map((column, index) => <td key={column.id} style={{ ...styleSticky(index), padding: 7, borderBottom: '1px solid var(--border, currentColor)', width: widths[index], minWidth: widths[index], maxWidth: widths[index], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {column.kind === 'title' ? <button type="button" style={{ ...button, background: 'transparent', border: 0, padding: 0, textAlign: 'left', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} onClick={() => props.onOpen(item)} title={String(item.content?.title ?? '')}>{String(item.content?.title ?? (isRestricted(item) ? 'Restricted item' : 'Untitled'))}</button> : column.kind === 'type' ? item.content?.kind === 'issue' ? <div style={{ display: 'grid', gap: 3 }}><span>Issue</span>{!hasIssueTypeField && <ProjectFieldCell item={item} field={ISSUE_TYPE_FIELD} project={props.project} issueTypes={props.issueTypesByItem[item.id]} onLoadIssueTypes={props.onLoadIssueTypes} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} />}</div> : <span>{String(item.content?.kind === 'pullRequest' ? 'Pull request' : item.content?.kind === 'draft' ? 'Draft' : 'Restricted')}</span> : <ProjectFieldCell item={item} field={column.field!} project={props.project} issueTypes={props.issueTypesByItem[item.id]} onLoadIssueTypes={props.onLoadIssueTypes} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} />}
          </td>)}
          <td style={{ position: 'sticky', right: 0, zIndex: 2, background: 'var(--bg, #16181d)', padding: 4, borderBottom: '1px solid var(--border, currentColor)', textAlign: 'right' }}>{props.actions(item)}</td>
        </tr>)}
      </Fragment>
    })}</tbody>
  </table>
}


function ProjectFieldCell(props: {
  item: ProjectItem
  field: ProjectField
  project: ProjectTarget
  issueTypes?: Array<{ id: string; name: string }>
  onLoadIssueTypes(item: ProjectItem): void
  onFieldEdit(item: ProjectItem, field: ProjectField, value: unknown, clear?: boolean): Promise<void>
  onCollectionEdit(item: ProjectItem, field: ProjectField, value: string): Promise<void>
  onIssueTypeEdit(item: ProjectItem, issueType: { id: string; name: string }): Promise<void>
}) {
  const type = fieldDataType(props.field)
  const readonly = dataTypeIsReadOnly(props.field) || isRestricted(props.item) || isDraft(props.item)
  const current = fieldDisplayValue(props.item, props.field)
  const options = props.field.options ?? []
  if (readonly) return <span style={muted} title={current}>{current}</span>
  if ((type === 'LABELS' || type === 'USERS' || /label|assignee/i.test(props.field.name ?? '')) && isIssue(props.item)) {
    const propName = type === 'USERS' || /assignee/i.test(props.field.name ?? '') ? 'assignees' : 'labels'
    const raw = props.item.content?.[propName]
    const values = Array.isArray(raw) ? raw.map((entry) => typeof entry === 'string' ? entry : String(record(entry)?.login ?? record(entry)?.name ?? '')).filter(Boolean).join(', ') : ''
    return <InlineText value={values} ariaLabel={`${props.field.name ?? propName} for issue ${String(props.item.content?.number ?? '')}`} placeholder="Comma-separated values" onSave={(value) => props.onCollectionEdit(props.item, props.field, value)} />
  }
  if ((type === 'ISSUE_TYPE' || /issue.?type/i.test(props.field.name ?? '')) && isIssue(props.item)) {
    if (props.project.ownerType === 'user') return <span style={muted}>Issue types require an organization-owned Project (hosting API D38).</span>
    const currentType = record(props.item.content?.issueType)
    const choices = props.issueTypes ?? options
    if (choices.length === 0 && currentType === null) return <button type="button" style={{ ...button, padding: 0 }} onFocus={() => props.onLoadIssueTypes(props.item)} onClick={() => props.onLoadIssueTypes(props.item)}>Load issue types</button>
    return <select aria-label="Issue type" style={inputStyle} value={String(currentType?.id ?? '')} onFocus={() => props.onLoadIssueTypes(props.item)} onChange={(event) => {
      const selected = choices.find((candidate) => candidate.id === event.currentTarget.value)
      if (selected) void props.onIssueTypeEdit(props.item, { id: selected.id, name: String(selected.name ?? selected.id) })
    }}><option value="" disabled>{currentType?.name ? String(currentType.name) : 'Choose issue type'}</option>{choices.map((option) => <option key={option.id} value={option.id}>{String(option.name ?? option.id)}</option>)}</select>
  }
  if (type === 'MULTI_SELECT') {
    const raw = fieldValue(props.item, props.field.id)
    const row = record(raw)
    const selected = Array.isArray(raw)
      ? raw.flatMap((entry) => {
          const value = typeof entry === 'string' ? entry : nonEmpty(record(entry)?.id)
          return value ? [value] : []
        })
      : Array.isArray(row?.multiSelectOptionIds) ? row.multiSelectOptionIds.filter((value): value is string => typeof value === 'string') : []
    return <select multiple size={Math.max(2, Math.min(5, options.length))} aria-label={props.field.name ?? 'Project field'} style={inputStyle} value={selected} onChange={(event) => {
      const values = Array.from(event.currentTarget.selectedOptions, (option) => option.value)
      if (values.length === 0) void props.onFieldEdit(props.item, props.field, undefined, true)
      else void props.onFieldEdit(props.item, props.field, { multiSelectOptionIds: values })
    }}>{options.map((option) => <option key={option.id} value={option.id}>{String(option.name ?? option.id)}</option>)}</select>
  }
  if (type === 'SINGLE_SELECT' || type === 'ITERATION') return <select aria-label={props.field.name ?? 'Project field'} style={inputStyle} value={selectedOptionId(fieldValue(props.item, props.field.id), options)} onChange={(event) => {
    const selected = event.currentTarget.value
    if (!selected) void props.onFieldEdit(props.item, props.field, undefined, true)
    else void props.onFieldEdit(props.item, props.field, type === 'ITERATION' ? { iterationId: selected } : { singleSelectOptionId: selected })
  }}><option value="">No {props.field.name ?? 'field'}</option>{options.map((option) => <option key={option.id} value={option.id}>{String(option.name ?? option.id)}</option>)}</select>
  if (type === 'TEXT' || type === 'NUMBER' || type === 'DATE') {
    const raw = fieldValue(props.item, props.field.id)
    const rawValue = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : String(record(raw)?.text ?? record(raw)?.number ?? record(raw)?.date ?? '')
    return <InlineText value={rawValue} ariaLabel={props.field.name ?? 'Project field'} type={type === 'NUMBER' ? 'number' : type === 'DATE' ? 'date' : 'text'} onSave={(value) => {
      if (value === '') return props.onFieldEdit(props.item, props.field, undefined, true)
      if (type === 'NUMBER') {
        const number = Number(value)
        if (!Number.isFinite(number)) return Promise.reject(new Error('Enter a finite number.'))
        return props.onFieldEdit(props.item, props.field, { number })
      }
      return props.onFieldEdit(props.item, props.field, { [type === 'DATE' ? 'date' : 'text']: value })
    }} />
  }
  if (type === 'LABELS' || type === 'USERS' || type === 'REPOSITORY' || type === 'PARENT_ISSUE') return <span style={muted}>{current}</span>
  return <span style={muted}>{current}</span>
}

function selectedOptionId(value: unknown, options: ProjectRecord[]): string {
  if (typeof value === 'string') return options.some((option) => option.id === value) ? value : ''
  const raw = record(value)
  const id = typeof raw?.singleSelectOptionId === 'string' ? raw.singleSelectOptionId : typeof raw?.id === 'string' ? raw.id : typeof raw?.iterationId === 'string' ? raw.iterationId : typeof raw?.optionId === 'string' ? raw.optionId : ''
  return options.some((option) => option.id === id) ? id : ''
}

function InlineText(props: { value: string; ariaLabel: string; onSave(value: string): Promise<void>; type?: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (!editing) setDraft(props.value) }, [props.value, editing])
  if (!editing) return <button type="button" style={{ ...button, background: 'transparent', border: 0, padding: 0, textAlign: 'left', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} aria-label={`Edit ${props.ariaLabel}`} onClick={() => setEditing(true)} title={props.value}>{props.value || '—'}</button>
  return <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}><input autoFocus type={props.type ?? 'text'} aria-label={props.ariaLabel} placeholder={props.placeholder} value={draft} style={{ ...inputStyle, width: 140 }} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setDraft(props.value); setEditing(false) } if (event.key === 'Enter') { event.preventDefault(); void save() } }} /><button type="button" style={button} disabled={saving} aria-label={`Save ${props.ariaLabel}`} onClick={() => void save()}>{saving ? '…' : '✓'}</button><button type="button" style={button} aria-label={`Cancel ${props.ariaLabel} edit`} onClick={() => { setDraft(props.value); setEditing(false) }}>×</button>{error && <span role="alert">{error}</span>}</span>
  async function save() {
    if (saving || draft === props.value) { setEditing(false); return }
    setSaving(true)
    setError('')
    try { await props.onSave(draft); setEditing(false) } catch (failure) { setError(errorMessage(failure)) } finally { setSaving(false) }
  }
}


function ProjectBoard(props: {
  items: ProjectItem[]
  fields: ProjectField[]
  columns: Array<{ id: string; label: string; field: ProjectField | null; kind: 'title' | 'type' | 'field' }>
  widths: Record<string, number>
  issueTypesByItem: Record<string, Array<{ id: string; name: string }>>
  onLoadIssueTypes(item: ProjectItem): void
  view?: ProjectView
  groups: ProjectGroup[]
  collapsed: Set<string>
  onToggleGroup(key: string): void
  sort: { fieldId: string; direction: 'asc' | 'desc' | 'view' } | null
  onSort(id: string): void
  onFieldEdit(item: ProjectItem, field: ProjectField, value: unknown, clear?: boolean): Promise<void>
  onCollectionEdit(item: ProjectItem, field: ProjectField, value: string): Promise<void>
  onIssueTypeEdit(item: ProjectItem, issueType: { id: string; name: string }): Promise<void>
  onMove(item: ProjectItem, field: ProjectField, value: unknown, clear: boolean): Promise<void>
  onOpen(item: ProjectItem): void
  actions(item: ProjectItem): ReactNode
  project: ProjectTarget
}) {
  const group = props.view ? boardGroupField(props.view, props.fields) : null
  if (!group) return <section style={{ display: 'grid', gap: 10, padding: 16 }}><div role="status">This board view has no single-select or iteration field to group by, so Quirky is listing items instead.</div><ProjectTable items={props.items} fields={props.fields} columns={props.columns} widths={props.widths} issueTypesByItem={props.issueTypesByItem} onLoadIssueTypes={props.onLoadIssueTypes} view={props.view} groups={props.groups} collapsed={props.collapsed} onToggleGroup={props.onToggleGroup} sort={props.sort} onSort={props.onSort} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} onOpen={props.onOpen} actions={props.actions} project={props.project} /></section>
  const columns = boardColumns(props.items, group)
  const type = fieldDataType(group)
  const boardOptions = group.options ?? []
  const currentValue = (item: ProjectItem): string => {
    const raw = fieldValue(item, group.id)
    const id = typeof raw === 'string' ? raw : nonEmpty(record(raw)?.singleSelectOptionId) ?? nonEmpty(record(raw)?.iterationId) ?? nonEmpty(record(raw)?.id) ?? nonEmpty(record(raw)?.optionId)
    const name = typeof raw === 'string' ? raw : nonEmpty(record(raw)?.title) ?? nonEmpty(record(raw)?.name)
    const option = boardOptions.find((candidate) => candidate.id === id || candidate.name === name)
    return option?.id ?? id ?? ''
  }
  const move = (item: ProjectItem, column: ProjectBoardColumn) => {
    if (column.readOnly || isRestricted(item) || isDraft(item)) return
    if (column.value === null) void props.onMove(item, group, undefined, true)
    else void props.onMove(item, group, type === 'ITERATION' ? { iterationId: column.value } : { singleSelectOptionId: column.value }, false)
  }
  return <div style={{ display: 'flex', gap: 12, overflowX: 'auto', padding: 12, minHeight: 0 }}>
    {columns.map((column) => <section key={column.id} aria-label={column.label} onDragOver={(event) => { if (!column.readOnly) event.preventDefault() }} onDrop={(event) => {
      event.preventDefault()
      if (column.readOnly) return
      const itemId = event.dataTransfer.getData('text/quirky-project-item')
      const item = props.items.find((candidate) => candidate.id === itemId)
      if (item) move(item, column)
    }} style={{ width: 272, minWidth: 272, border: '1px solid var(--border, currentColor)', borderRadius: 8, padding: 8, background: 'var(--bg, #16181d)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>{column.label} <span style={muted}>{column.items.length}</span>{column.readOnly && <span style={muted}> · Read only</span>}</h3>
      {column.items.map((item) => {
        const itemValue = currentValue(item)
        const itemOption = boardOptions.find((option) => option.id === itemValue)
        const isDeleted = itemValue !== '' && itemOption === undefined && column.value !== null
        return <article key={item.id} draggable={!column.readOnly && !isRestricted(item) && !isDraft(item)} onDragStart={(event) => { event.dataTransfer.setData('text/quirky-project-item', item.id); event.dataTransfer.effectAllowed = 'move' }} style={{ border: '1px solid var(--border, currentColor)', borderRadius: 6, padding: 8, background: 'var(--bg-raised, #1d2027)', display: 'grid', gap: 6, opacity: column.readOnly ? 0.7 : 1 }}>
          <button type="button" style={{ ...button, padding: 0, border: 0, background: 'transparent', textAlign: 'left' }} onClick={() => props.onOpen(item)}>{item.content?.kind === 'pullRequest' ? '⑂ ' : '● '}{String(item.content?.title ?? 'Restricted item')}</button>
          <span style={muted}>{item.content?.kind === 'pullRequest' ? 'PR' : item.content?.kind === 'issue' ? 'Issue' : 'Draft'} {item.content?.number ? `#${item.content.number}` : ''} · {String(item.content?.repository ?? 'Repository unavailable')}</span>
          <div style={{ display: 'flex', gap: 4 }}>{assigneeAvatars(item).map((user) => <span key={user.login} title={user.login} style={{ borderRadius: 14, border: '1px solid var(--border, currentColor)', width: 24, height: 24, overflow: 'hidden', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>{user.avatarUrl ? <img src={user.avatarUrl} alt={user.login} width={24} height={24} /> : user.login.slice(0, 2).toUpperCase()}</span>)}</div>
          <label style={{ display: 'grid', gap: 3, ...muted }}>Move card<select aria-label={`Move ${String(item.content?.title ?? 'item')}`} value={itemValue} disabled={column.readOnly || isRestricted(item) || isDraft(item)} style={inputStyle} onChange={(event) => {
            const selected = event.currentTarget.value
            const next = columns.find((candidate) => candidate.value === selected) ?? columns.find((candidate) => candidate.value === null)
            if (next) move(item, next)
          }}><option value="">No {group.name ?? 'field'}</option>{isDeleted && <option value={itemValue} disabled>Deleted option · Read only</option>}{boardOptions.map((option) => <option key={option.id} value={option.id}>{String(option.name ?? option.id)}</option>)}</select></label>
          {props.actions(item)}
        </article>
      })}
    </section>)}
  </div>
}

function assigneeAvatars(item: ProjectItem): Array<{ login: string; avatarUrl: string | null }> {
  const assignees = item.content?.assignees
  if (!Array.isArray(assignees)) return []
  return assignees.slice(0, 3).flatMap((entry) => {
    const user = record(entry)
    const login = nonEmpty(user?.login)
    return login ? [{ login, avatarUrl: nonEmpty(user?.avatarUrl) }] : typeof entry === 'string' ? [{ login: entry, avatarUrl: null }] : []
  })
}

function ProjectRoadmap(props: {
  model: RoadmapTimeline
  items: ProjectItem[]
  fields: ProjectField[]
  columns: Array<{ id: string; label: string; field: ProjectField | null; kind: 'title' | 'type' | 'field' }>
  widths: Record<string, number>
  issueTypesByItem: Record<string, Array<{ id: string; name: string }>>
  onLoadIssueTypes(item: ProjectItem): void
  view?: ProjectView
  groups: ProjectGroup[]
  collapsed: Set<string>
  onToggleGroup(key: string): void
  sort: { fieldId: string; direction: 'asc' | 'desc' | 'view' } | null
  onSort(id: string): void
  onFieldEdit(item: ProjectItem, field: ProjectField, value: unknown, clear?: boolean): Promise<void>
  onCollectionEdit(item: ProjectItem, field: ProjectField, value: string): Promise<void>
  onIssueTypeEdit(item: ProjectItem, issueType: { id: string; name: string }): Promise<void>
  zoom: RoadmapZoom
  onZoom(value: RoadmapZoom): void
  onToday(): void
  scroller: RefObject<HTMLDivElement | null>
  onOpen(item: ProjectItem): void
  actions(item: ProjectItem): ReactNode
  project: ProjectTarget
}) {
  const model = props.model
  if (!model.placementFieldName) return <section style={{ padding: 16, display: 'grid', gap: 8 }}><div role="status">This roadmap view has no date or iteration field to place items on, so Quirky is listing items instead.</div><ProjectTable items={props.items} fields={props.fields} columns={props.columns} widths={props.widths} issueTypesByItem={props.issueTypesByItem} onLoadIssueTypes={props.onLoadIssueTypes} view={props.view} groups={props.groups} collapsed={props.collapsed} onToggleGroup={props.onToggleGroup} sort={props.sort} onSort={props.onSort} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} onOpen={props.onOpen} actions={props.actions} project={props.project} /></section>
  const totalWidth = model.ticks.length * model.tickWidth
  return <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8, padding: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>Placed by {model.placementFieldName}{model.targetFieldName ? ` → ${model.targetFieldName}` : ''}</strong><span style={muted}>{model.undatedCount} without dates</span><button type="button" style={{ ...button, marginLeft: 'auto' }} onClick={props.onToday}>Today</button>{(['month', 'quarter', 'year'] as const).map((value) => <button key={value} type="button" style={{ ...button, borderColor: props.zoom === value ? 'var(--accent, #4f8ff7)' : undefined }} aria-pressed={props.zoom === value} onClick={() => props.onZoom(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
    <div ref={props.scroller} style={{ overflow: 'auto', minHeight: 0, border: '1px solid var(--border, currentColor)', borderRadius: 6 }}>
      <div style={{ width: 300 + totalWidth, minWidth: 300 + totalWidth }}>
        <div style={{ display: 'grid', gridTemplateColumns: `300px ${totalWidth}px`, position: 'sticky', top: 0, zIndex: 3, background: 'var(--bg-raised, #1d2027)' }}><strong style={{ padding: 8, borderBottom: '1px solid var(--border, currentColor)' }}>Item</strong><div style={{ display: 'flex', borderBottom: '1px solid var(--border, currentColor)' }}>{model.ticks.map((tick) => <div key={tick.startDate.toISOString()} style={{ width: model.tickWidth, minWidth: model.tickWidth, padding: 6, boxSizing: 'border-box', borderLeft: '1px solid var(--border, currentColor)', ...muted }}>{tick.label}</div>)}</div></div>
        {model.placements.map((placement) => {
          const item = props.items.find((candidate) => candidate.id === placement.itemId)
          const from = placement.from.toISOString().slice(0, 10)
          const to = placement.to.toISOString().slice(0, 10)
          return <div key={placement.itemId} style={{ display: 'grid', gridTemplateColumns: `300px ${totalWidth}px`, minHeight: 38, borderBottom: '1px solid var(--border, currentColor)' }}>
            <div style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg, #16181d)', padding: 6, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
              <button type="button" style={{ ...button, border: 0, padding: 0, background: 'transparent', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => { if (item) props.onOpen(item) }}>{placement.title}</button>
              {item && props.actions(item)}
            </div>
            <div style={{ position: 'relative', width: totalWidth, minHeight: 38, backgroundImage: `repeating-linear-gradient(to right, transparent, transparent ${model.tickWidth - 1}px, var(--border, #2b2f3a) ${model.tickWidth - 1}px, var(--border, #2b2f3a) ${model.tickWidth}px)` }}>
              {model.todayIndex !== null && <span aria-hidden="true" style={{ position: 'absolute', left: model.todayIndex * model.tickWidth, top: 0, bottom: 0, borderLeft: '2px solid var(--amber, #f0b429)', zIndex: 1 }} />}
              {placement.marker ? <span role="img" aria-label={`${placement.title} date marker: ${from}`} title={from} style={{ position: 'absolute', left: placement.left, top: 9, width: 12, height: 20, background: 'var(--accent, #4f8ff7)', borderRadius: 3, zIndex: 2 }} /> : <span role="img" aria-label={`${placement.title} ${from} to ${to}`} title={`${from} – ${to}`} style={{ position: 'absolute', left: placement.left, top: 11, width: Math.max(8, placement.width), height: 16, background: 'var(--accent, #4f8ff7)', borderRadius: 7, zIndex: 2 }} />}
            </div>
          </div>
        })}
      </div>
    </div>
    {model.undatedCount > 0 && <details><summary>{model.undatedCount} items without dates</summary><ul>{props.items.filter((item) => !model.placements.some((placement) => placement.itemId === item.id)).map((item) => <li key={item.id}><button type="button" style={button} onClick={() => props.onOpen(item)}>{String(item.content?.title ?? 'Restricted item')}</button> · {String(item.content?.repository ?? 'Repository unavailable')} {props.actions(item)}</li>)}</ul></details>}
  </section>
}
function scrollToToday(element: HTMLDivElement | null, index: number | null, tickWidth: number) {
  if (!element || index === null) return
  element.scrollTo({ left: Math.max(0, 300 + index * tickWidth - element.clientWidth / 2), behavior: 'smooth' })
}

function readZoom(): RoadmapZoom {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem('quirky.tasks.projects.roadmapZoom')
    return value === 'quarter' || value === 'year' ? value : 'month'
  } catch {
    return 'month'
  }
}

function saveZoom(value: RoadmapZoom) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('quirky.tasks.projects.roadmapZoom', value) } catch { return }
}

function readDeviceColumns(key: string): { hidden: string[]; widths: Record<string, number> } {
  try {
    if (typeof localStorage === 'undefined') return { hidden: [], widths: {} }
    const raw = localStorage.getItem(`quirky.tasks.projects.columns.${key}`)
    const parsed = raw ? record(JSON.parse(raw)) : null
    const hidden = Array.isArray(parsed?.hidden) ? parsed.hidden.filter((value): value is string => typeof value === 'string' && value !== 'title') : []
    const widths = record(parsed?.widths) ?? {}
    const validWidths = Object.fromEntries(Object.entries(widths).flatMap(([id, width]) => typeof width === 'number' && Number.isFinite(width) && width >= 60 ? [[id, Math.min(800, width)]] : []))
    return { hidden, widths: validWidths }
  } catch {
    return { hidden: [], widths: {} }
  }
}

function writeDeviceColumns(key: string, value: { hidden: string[]; widths: Record<string, number> }) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(`quirky.tasks.projects.columns.${key}`, JSON.stringify(value)) } catch { return }
}
