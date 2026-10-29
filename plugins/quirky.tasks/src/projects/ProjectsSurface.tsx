import { Badge, Button, Dialog, EmptyState, IconButton, Tabs, TextField } from '@quirky/ui'
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
  type ProjectRecord,
  type ProjectView
} from './model'
import { buildRoadmapTimeline, type RoadmapTimeline, type RoadmapZoom } from './timeline'

const linkCommand = 'command:quirky.tasks/open-link'
const copyTextCommand = 'command:quirky.tasks/copy-text'
const DOCS_URL = 'https://docs.github.com/en/issues/planning-your-work-with-projects/managing-your-projects/about-projects'
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
type ProjectFieldOverride = { projectKey: string; itemId: string; fieldId: string; clear: boolean; pending: boolean; value?: unknown }

function projectFieldMutationKey(projectKey: string, itemId: string, fieldId: string): string {
  return JSON.stringify([projectKey, itemId, fieldId])
}

function withProjectField(item: ProjectItem, fieldId: string, value: unknown, clear: boolean): ProjectItem {
  const values = item.fieldValues ?? []
  const fieldValues = clear
    ? values.filter((entry) => entry.fieldId !== fieldId)
    : values.some((entry) => entry.fieldId === fieldId)
      ? values.map((entry) => entry.fieldId === fieldId ? { ...entry, value } : entry)
      : [...values, { fieldId, value }]
  return { ...item, fieldValues }
}

function sameProjectFieldValue(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => sameProjectFieldValue(actual[index], value))
  }
  const expectedRecord = record(expected)
  if (expectedRecord) {
    const actualRecord = record(actual)
    return actualRecord !== null && Object.entries(expectedRecord).every(([key, value]) => sameProjectFieldValue(actualRecord[key], value))
  }
  return Object.is(actual, expected)
}

function preserveProjectFieldOverrides(
  table: ProjectRecord,
  projectKey: string,
  overrides: Map<string, ProjectFieldOverride>
): ProjectRecord {
  if (!Array.isArray(table.items)) return table
  let changed = false
  const items = asItems(table.items).map((item) => {
    let next = item
    for (const [key, override] of overrides) {
      if (override.projectKey !== projectKey || override.itemId !== item.id) continue
      const expected = override.clear ? null : override.value
      if (sameProjectFieldValue(fieldValue(item, override.fieldId), expected)) {
        if (!override.pending) overrides.delete(key)
        continue
      }
      next = withProjectField(next, override.fieldId, override.value, override.clear)
      changed = true
    }
    return next
  })
  return changed ? { ...table, items } : table
}


export function ProjectsSurface({ context, state, refresh }: TasksSurfaceProps) {
  const [selectedProject, setSelectedProject] = useState<ProjectTarget | null>(null)
  const project = selectedProject ?? state.navigation.project
  const projectKey = project ? projectIdentity(project) : ''
  const preferredView = project ? (project.viewId ?? state.projects.lastViewByProject[projectKey]) : undefined
  const [localViewId, setLocalViewId] = useState('')
  const activeViewId = localViewId || preferredView || ''
  const currentProjectKey = useRef(projectKey)
  currentProjectKey.current = projectKey
  const currentViewId = useRef(activeViewId)
  currentViewId.current = activeViewId
  const [views, setViews] = useState<ProjectView[]>([])
  const [table, setTable] = useState<Record<string, unknown> | null>(null)
  const [loadingViews, setLoadingViews] = useState(false)
  const [loadingTable, setLoadingTable] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [chooseView, setChooseView] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')
  const [addInput, setAddInput] = useState('')
  const [browsedProjects, setBrowsedProjects] = useState<ProjectTarget[]>([])
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
  const [localQueryOverrides, setLocalQueryOverrides] = useState<Record<string, string>>({})
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
  const [createdWorkspaceLinks, setCreatedWorkspaceLinks] = useState<Record<string, string>>({})
  const [issueTypesByItem, setIssueTypesByItem] = useState<Record<string, Array<{ id: string; name: string }>>>({})
  const [deviceColumns, setDeviceColumns] = useState<{ hidden: string[]; widths: Record<string, number> }>({ hidden: [], widths: {} })
  const [zoom, setZoom] = useState<RoadmapZoom>(() => readZoom())
  const projectGeneration = useRef(0)
  const viewGeneration = useRef(0)
  const tableGeneration = useRef(0)
  const viewSelectionGeneration = useRef(0)
  const queryGeneration = useRef(0)
  const writeEpoch = useRef(0)
  const mutationGeneration = useRef(new Map<string, number>())
  const projectFieldOverrides = useRef(new Map<string, ProjectFieldOverride>())
  const warnedSubIssues = useRef(false)
  const roadmapScroller = useRef<HTMLDivElement>(null)
  const previewGeneration = useRef(0)
  const currentView = views.find((view) => view.id === activeViewId) ?? (record(table?.view) as ProjectView | null)
  const queryKey = project && currentView ? projectViewIdentity(project, currentView.id) : ''
  const persistedQuery = queryKey ? localQueryOverrides[queryKey] ?? state.projects.queryByView[queryKey] ?? (typeof currentView?.filter === 'string' ? currentView.filter : '') : ''
  const queryOverrideForView = queryKey ? localQueryOverrides[queryKey] ?? state.projects.queryByView[queryKey] : undefined
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
    viewSelectionGeneration.current += 1
    queryGeneration.current += 1
    currentViewId.current = ''
    setQueryBusy(false)
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
    setIssueTypesByItem({})
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
        currentViewId.current = initial
        setLocalViewId(initial)
        setChooseView(false)
        await loadTableFor(target, initial, localQueryOverrides[projectViewIdentity(target, initial)] ?? state.projects.queryByView[projectViewIdentity(target, initial)] ?? undefined, false)
      } else {
        currentViewId.current = ''
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
    const selectionRequest = viewSelectionGeneration.current
    const targetProjectKey = projectIdentity(target)
    const observedWriteEpoch = writeEpoch.current
    const ownsSelection = () =>
      request === tableGeneration.current &&
      projectRequest === projectGeneration.current &&
      selectionRequest === viewSelectionGeneration.current &&
      targetProjectKey === currentProjectKey.current &&
      viewId === currentViewId.current
    const ownsRequest = () => ownsSelection() && observedWriteEpoch === writeEpoch.current
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
      if (!ownsRequest()) return false
      const response = object(raw)
      const resultValue = response.result ?? response.table ?? raw
      const result = object(resultValue)
      const tableResult = preserveProjectFieldOverrides(object(result.result ?? resultValue), targetProjectKey, projectFieldOverrides.current)
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
      if (ownsRequest()) setMainError(error)
    } finally {
      if (ownsSelection()) setLoadingTable(false)
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
      setBrowsedProjects(found)
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
    const targetProject = project
    const targetProjectKey = projectIdentity(targetProject)
    const request = ++viewSelectionGeneration.current
    const prior = activeViewId
    const priorQuery = activeQuery
    currentViewId.current = viewId
    queryGeneration.current += 1
    setQueryBusy(false)
    setLocalViewId(viewId)
    setSort(null)
    setChooseView(false)
    const nextQuery = localQueryOverrides[projectViewIdentity(targetProject, viewId)] ?? state.projects.queryByView[projectViewIdentity(targetProject, viewId)] ?? (typeof view.filter === 'string' ? view.filter : '')
    setAppliedQuery(nextQuery)
    setQueryDraft(nextQuery)
    try {
      await context.call('quirky.tasks/projectView', { action: 'select', project: targetProject, viewId })
    } catch (error) {
      if (request === viewSelectionGeneration.current && currentProjectKey.current === targetProjectKey) {
        currentViewId.current = prior
        setLocalViewId(prior)
        setAppliedQuery(priorQuery)
        setQueryDraft(priorQuery)
        setMainError(error)
      }
      return
    }
    if (request !== viewSelectionGeneration.current || currentProjectKey.current !== targetProjectKey) return
    await loadTableFor(targetProject, viewId, localQueryOverrides[projectViewIdentity(targetProject, viewId)] ?? state.projects.queryByView[projectViewIdentity(targetProject, viewId)] ?? undefined, false)
  }

  async function applyQuery(value: string) {
    if (!project || !currentView || queryBusy) return
    if (value === activeQuery) {
      setQueryDraft(activeQuery)
      return
    }
    const request = ++queryGeneration.current
    const targetProject = project
    const targetProjectKey = projectIdentity(targetProject)
    const viewId = currentView.id
    const preferenceKey = projectViewIdentity(targetProject, viewId)
    const previousLocalOverride = localQueryOverrides[preferenceKey]
    setQueryBusy(true)
    const previous = activeQuery
    setLocalQueryOverrides((prior) => ({ ...prior, [preferenceKey]: value }))
    setAppliedQuery(value)
    setQueryDraft(value)
    try {
      const loaded = await loadTableFor(targetProject, viewId, value, false)
      if (request !== queryGeneration.current || currentProjectKey.current !== targetProjectKey || currentViewId.current !== viewId) return
      if (!loaded) {
        setLocalQueryOverrides((prior) => {
          const next = { ...prior }
          if (previousLocalOverride === undefined) delete next[preferenceKey]
          else next[preferenceKey] = previousLocalOverride
          return next
        })
        setAppliedQuery(previous)
        setQueryDraft(previous)
      }
    } finally {
      if (request === queryGeneration.current) setQueryBusy(false)
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

  function commitOptimistic(projectKey: string, itemId: string, fieldId: string, value: unknown, clear: boolean) {
    const key = projectFieldMutationKey(projectKey, itemId, fieldId)
    const mine = (mutationGeneration.current.get(key) ?? 0) + 1
    mutationGeneration.current.set(key, mine)
    writeEpoch.current += 1
    setTable((previous) => previous ? {
      ...previous,
      items: asItems(previous.items).map((item) => item.id === itemId ? withProjectField(item, fieldId, value, clear) : item)
    } : previous)
    return { key, mine }
  }

  async function editProjectField(item: ProjectItem, field: ProjectField, value: unknown, clear = false) {
    if (!project || isRestricted(item) || isDraft(item) || dataTypeIsReadOnly(field)) return
    const targetProject = project
    const targetProjectKey = projectIdentity(targetProject)
    const projectRequest = projectGeneration.current
    const viewId = currentView?.id ?? activeViewId
    const query = queryOverrideForView
    const key = projectFieldMutationKey(targetProjectKey, item.id, field.id)
    const previousOverride = projectFieldOverrides.current.get(key)
    const previousValue = fieldValue(item, field.id)
    const mutation = commitOptimistic(targetProjectKey, item.id, field.id, value, clear)
    projectFieldOverrides.current.set(key, { projectKey: targetProjectKey, itemId: item.id, fieldId: field.id, clear, pending: true, ...(clear ? {} : { value }) })
    try {
      const args: Record<string, unknown> = { action: 'field', projectId: targetProject.id, itemId: item.id, fieldId: field.id, host: targetProject.host ?? hostFromUrl(targetProject.url) ?? undefined, ...(clear ? { clear: true } : { value }) }
      await context.call('quirky.tasks/projectEdit', args)
      writeEpoch.current += 1
      if (mutationGeneration.current.get(mutation.key) === mutation.mine) {
        projectFieldOverrides.current.set(key, { projectKey: targetProjectKey, itemId: item.id, fieldId: field.id, clear, pending: false, ...(clear ? {} : { value }) })
        if (projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
          setWriteError(null)
          setErrorAnnouncement('')
          if (currentViewId.current === viewId) await loadTableFor(targetProject, viewId, query, false)
        }
      }
    } catch (error) {
      writeEpoch.current += 1
      if (mutationGeneration.current.get(mutation.key) === mutation.mine) {
        const previousConfirmed = previousOverride?.pending === false ? previousOverride : undefined
        if (previousConfirmed) projectFieldOverrides.current.set(key, previousConfirmed)
        else projectFieldOverrides.current.delete(key)
        if (projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
          const rollback = previousConfirmed ?? { clear: previousValue === null, value: previousValue }
          setTable((previous) => previous ? {
            ...previous,
            items: asItems(previous.items).map((candidate) => candidate.id === item.id ? withProjectField(candidate, field.id, rollback.value, rollback.clear) : candidate)
          } : previous)
          setWriteError(error)
          setErrorAnnouncement('Project field update was rolled back locally; GitHub did not confirm the change.')
          if (currentViewId.current === viewId) await loadTableFor(targetProject, viewId, query, false)
        }
      }
    }
  }

  async function editIssueCollection(item: ProjectItem, field: ProjectField, raw: string) {
    if (!project || !isIssue(item) || isRestricted(item) || isDraft(item)) return
    const targetProject = project
    const targetProjectKey = projectIdentity(targetProject)
    const projectRequest = projectGeneration.current
    const viewId = currentView?.id ?? activeViewId
    const query = queryOverrideForView
    const values = raw.split(',').map((part) => part.trim().replace(/^@/, '')).filter(Boolean)
    const targetProp = fieldDataType(field) === 'USERS' || /assignee/i.test(field.name ?? '') ? 'assignees' : 'labels'
    const old = Array.isArray(item.content?.[targetProp]) ? item.content?.[targetProp] : []
    const key = projectFieldMutationKey(targetProjectKey, item.id, targetProp)
    const mine = (mutationGeneration.current.get(key) ?? 0) + 1
    mutationGeneration.current.set(key, mine)
    writeEpoch.current += 1
    setTable((previous) => previous ? { ...previous, items: asItems(previous.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, [targetProp]: values } } : candidate) } : previous)
    try {
      await context.call('quirky.tasks/projectEdit', { action: 'issue', projectId: targetProject.id, itemId: item.id, kind: 'issue', number: item.content?.number, host: targetProject.host ?? hostFromUrl(targetProject.url) ?? undefined, [targetProp]: values })
      writeEpoch.current += 1
      if (mutationGeneration.current.get(key) === mine && projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
        setWriteError(null)
        setErrorAnnouncement('')
        if (currentViewId.current === viewId) await loadTableFor(targetProject, viewId, query, false)
      }
    } catch (error) {
      writeEpoch.current += 1
      if (mutationGeneration.current.get(key) === mine && projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
        setTable((previous) => previous ? { ...previous, items: asItems(previous.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, [targetProp]: old } } : candidate) } : previous)
        setWriteError(error)
        const data = record(record(error)?.data)
        const completed = Array.isArray(data?.completedSteps) ? data.completedSteps.filter((step) => typeof step === 'string') : []
        setErrorAnnouncement(data?.partial === true ? `Partial write: GitHub completed ${completed.join(', ') || 'part of the change'} before failing.` : 'The issue field update failed; the previous value was restored.')
        if (currentViewId.current === viewId) await loadTableFor(targetProject, viewId, query, false)
      }
    }
  }

  async function updateIssueType(item: ProjectItem, issueType: { id: string; name: string }) {
    if (!project || !isIssue(item) || isRestricted(item) || isDraft(item)) return
    const targetProject = project
    const targetProjectKey = projectIdentity(targetProject)
    const projectRequest = projectGeneration.current
    const viewId = currentView?.id ?? activeViewId
    const query = queryOverrideForView
    const key = projectFieldMutationKey(targetProjectKey, item.id, 'issueType')
    const mine = (mutationGeneration.current.get(key) ?? 0) + 1
    mutationGeneration.current.set(key, mine)
    const previous = item.content?.issueType ?? null
    writeEpoch.current += 1
    setTable((prior) => prior ? { ...prior, items: asItems(prior.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, issueType } } : candidate) } : prior)
    try {
      await context.call('quirky.tasks/projectEdit', {
        action: 'issueType', projectId: targetProject.id, itemId: item.id, kind: 'issue',
        number: item.content?.number, host: targetProject.host ?? hostFromUrl(targetProject.url) ?? undefined, issueTypeId: issueType.id
      })
      writeEpoch.current += 1
      if (mutationGeneration.current.get(key) === mine && projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
        setWriteError(null)
        setErrorAnnouncement('')
        if (currentViewId.current === viewId) await loadTableFor(targetProject, viewId, query, false)
      }
    } catch (error) {
      writeEpoch.current += 1
      if (mutationGeneration.current.get(key) === mine && projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
        setTable((prior) => prior ? { ...prior, items: asItems(prior.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, issueType: previous } } : candidate) } : prior)
        setWriteError(error)
        await loadTableFor(targetProject, viewId, query, false)
      }
    }
  }

  async function loadIssueTypes(item: ProjectItem) {
    if (!project || issueTypesByItem[item.id]) return
    const targetProject = project
    const targetProjectKey = projectIdentity(targetProject)
    const projectRequest = projectGeneration.current
    try {
      const response = object(await context.call('quirky.tasks/projectEdit', {
        action: 'issueType', projectId: targetProject.id, itemId: item.id, kind: 'issue',
        number: item.content?.number, host: targetProject.host ?? hostFromUrl(targetProject.url) ?? undefined
      }))
      if (currentProjectKey.current !== targetProjectKey || projectGeneration.current !== projectRequest) return
      const result = object(response.result)
      const options = Array.isArray(result.issueTypes) ? result.issueTypes.flatMap((value) => {
        const issueType = record(value)
        const id = nonEmpty(issueType?.id)
        const name = nonEmpty(issueType?.name)
        return id && name && issueType?.enabled !== false ? [{ id, name }] : []
      }) : []
      setIssueTypesByItem((previous) => ({ ...previous, [item.id]: options }))
    } catch (error) {
      if (currentProjectKey.current === targetProjectKey && projectGeneration.current === projectRequest) setMainError(error)
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
    const targetProject = project
    if (!targetProject || isRestricted(item) || isDraft(item)) {
      showProjectCardPreview(item, isRestricted(item) ? 'Restricted project content cannot be opened or edited.' : 'Draft project cards do not have an issue or pull-request detail page.')
      return
    }
    const targetProjectKey = projectIdentity(targetProject)
    const projectRequest = projectGeneration.current
    const resolution = await matchLocalRepositories(context, state, parseRepoSlug(item, targetProject))
    if (projectGeneration.current !== projectRequest || currentProjectKey.current !== targetProjectKey) return
    if (resolution.state === 'updating') {
      const fallback = resolution.contextWorktree
      const target = fallback ? itemTarget(item, targetProject, fallback.worktree) : null
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
    const target = itemTarget(item, targetProject, worktree)
    if (!target) {
      showProjectCardPreview(item, 'This Project card has no valid issue or pull-request identity.')
      return
    }
    try {
      if (target.kind === 'pullRequest') {
        if (resolution.matches.length === 1) {
          await openReview(context, { ...target, tab: 'conversation' })
          return
        }
        const reason = resolution.excludedMatches.length > 0 ? 'This pull request is outside the selected repositories. ' : ''
        await loadProjectItemPreview(item, target, `${reason}Project data is read by its exact Project item identity.`)
        return
      }
      await context.call('quirky.tasks/navigate', { mode: 'projects', detail: target, project: targetProject })
    } catch (error) {
      if (projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
        setActionHelp({ item, text: `Could not open project item: ${errorMessage(error)}`, externalUrl: projectItemUrl(item, targetProject) })
      }
    }
  }

  async function startItem(item: ProjectItem, forceNew = false) {
    const targetProject = project
    const externalUrl = targetProject ? projectItemUrl(item, targetProject) : null
    if (!targetProject || isRestricted(item) || isDraft(item)) {
      setActionHelp({ item, text: isDraft(item) ? 'Draft project cards are not startable.' : 'Restricted project content cannot be opened or started.', externalUrl })
      return
    }
    const targetProjectKey = projectIdentity(targetProject)
    const projectRequest = projectGeneration.current
    const resolution = await matchLocalRepositories(context, state, parseRepoSlug(item, targetProject))
    if (projectGeneration.current !== projectRequest || currentProjectKey.current !== targetProjectKey) return
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
    const target = itemTarget(item, targetProject, matched.worktree)
    if (!target) return
    const content = item.content ?? {}
    const name = typeof content.title === 'string' && content.title.trim() ? content.title.trim().slice(0, 80) : `${content.kind === 'pullRequest' ? 'PR' : 'Issue'} #${content.number}`
    const url = externalUrl ?? ''
    const prompt = `Work on this GitHub ${content.kind === 'pullRequest' ? 'pull request' : 'issue'}: ${name}\n\n${url}${typeof content.body === 'string' && content.body.trim() ? `\n\n${content.body}` : ''}`
    const existingLink = linkedWorkspace(item, state, targetProject, createdWorkspaceLinks)
    const workspaceAction = existingLink && !forceNew ? 'resume' : 'start'
    const busyKey = `${targetProjectKey}|${item.id}`
    setBusyItem(busyKey)
    try {
      const response = object(await context.call('quirky.tasks/workspace', {
        target,
        action: workspaceAction,
        ...(workspaceAction === 'start' ? { newWorkspace: true, name, prompt, setup: 'inherit' } : {})
      }))
      if (response.kind === 'composer') {
        setActionHelp(null)
        const reason = response.setupDecisionRequired === true
          ? 'Choose whether to run the repository setup script in the workspace composer.'
          : nonEmpty(response.error) ?? 'Choose an agent in the workspace composer.'
        context.toast('Workspace setup required', `${reason} The Project item context is prefilled.`)
      } else if (response.kind === 'created') {
        const createdWorktree = record(response.worktree)
        const workspaceName = nonEmpty(createdWorktree?.name) ?? name
        if (externalUrl) setCreatedWorkspaceLinks((previous) => ({ ...previous, [externalUrl]: workspaceName }))
        const warnings = Array.isArray(response.warnings) ? response.warnings.filter((warning): warning is string => typeof warning === 'string' && warning.length > 0) : []
        const setup = record(response.setup)
        if (setup?.timedOut === true) warnings.push('Repository setup timed out.')
        else if (typeof setup?.exitCode === 'number' && setup.exitCode !== 0) warnings.push(`Repository setup exited with status ${setup.exitCode}.`)
        const issueCommand = record(response.issueCommand)
        if (issueCommand?.timedOut === true) warnings.push('The issue command timed out.')
        else if (typeof issueCommand?.exitCode === 'number' && issueCommand.exitCode !== 0) warnings.push(`The issue command exited with status ${issueCommand.exitCode}.`)
        const fallback = record(response.baseFallback)
        if (nonEmpty(fallback?.message)) warnings.push(nonEmpty(fallback?.message)!)
        const deliveryState = response.promptDelivery
        let delivery = 'No agent prompt-delivery outcome was reported.'
        if (response.agentPending === true || deliveryState === 'pending') {
          delivery = 'The agent session is pending; item context delivery has not been confirmed.'
        } else if (deliveryState === 'pasted') {
          delivery = 'Item context was delivered to the agent by paste.'
        } else if (deliveryState === 'command-line') {
          delivery = 'Item context was delivered to the agent on the command line.'
        } else if (deliveryState === 'unconfirmed') {
          delivery = 'The agent started, but item context delivery could not be confirmed.'
        } else if (deliveryState === 'not-delivered') {
          delivery = 'The workspace exists, but item context was not delivered to the agent.'
        } else if (typeof response.agentSessionId === 'string') {
          delivery = 'The agent session exists, but prompt delivery status is unavailable.'
        }
        try {
          await refresh()
        } catch (error) {
          warnings.push(`Workspace was created, but Tasks could not refresh its link: ${errorMessage(error)}`)
        }
        const warningList = [...new Set(warnings)]
        const details = `Workspace ${workspaceName} was created and linked. ${delivery}${warningList.length > 0 ? ` ${warningList.join(' ')}` : ''}`
        const deliveryConfirmed = response.agentPending !== true && (deliveryState === 'pasted' || deliveryState === 'command-line')
        if (warningList.length > 0 || !deliveryConfirmed) setActionHelp({ item, text: details, externalUrl })
        else setActionHelp(null)
        context.toast(warningList.length > 0 || !deliveryConfirmed ? 'Workspace created with a warning' : 'Workspace started', `${workspaceName}. ${delivery}`)
      } else if (response.kind === 'resumed' || response.kind === 'linked') {
        const linkedName = nonEmpty(record(response.worktree)?.name) ?? name
        if (externalUrl) setCreatedWorkspaceLinks((previous) => ({ ...previous, [externalUrl]: linkedName }))
        setActionHelp(null)
        try {
          await refresh()
          context.toast(response.kind === 'resumed' ? 'Workspace resumed' : 'Workspace linked', linkedName)
        } catch (error) {
          setActionHelp({ item, text: `Workspace ${linkedName} is available, but Tasks could not refresh its link: ${errorMessage(error)}`, externalUrl })
        }
      } else {
        setActionHelp({ item, text: 'The workspace action returned an unrecognized result. No success was reported.', externalUrl })
      }
    } catch (error) {
      setActionHelp({ item, text: `Could not start work: ${errorMessage(error)}`, externalUrl })
    } finally {
      setBusyItem((current) => current === busyKey ? '' : current)
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
    return <section role="alert" className="quirky-tasks-projects__auth-help">
      <strong>{reason === 'auth_required' ? `GitHub login is required for ${host}.` : `GitHub Projects access is missing for ${host}.`}</strong>
      <span>Projects need the <code>project</code>, <code>read:org</code>, and <code>repo</code> scopes on the account used by the hosting plugin.</span>
      <TextField label="Refresh scopes" aria-label="GitHub project scope refresh command" readOnly value={command} className="quirky-tasks-projects__command" onFocus={(event) => event.currentTarget.select()} />
      <Button type="button" onClick={() => void copyAuthCommand(command)}>Copy refresh command</Button>
      <TextField label="Sign in" aria-label="GitHub login command" readOnly value={login} className="quirky-tasks-projects__command" onFocus={(event) => event.currentTarget.select()} />
      <Button type="button" onClick={() => void copyAuthCommand(login)}>Copy login command</Button>
      <span>If <code>GH_TOKEN</code>, <code>GITHUB_TOKEN</code>, <code>GH_ENTERPRISE_TOKEN</code>, or <code>GITHUB_ENTERPRISE_TOKEN</code> is exported, it overrides the stored <code>gh</code> login. Remove it from the environment before refreshing scopes, then restart Quirky.</span>
      <span>If your organization enforces SAML SSO, authorize the token for that organization after login.</span>
      <div className="quirky-tasks-projects__actions"><Button type="button" onClick={() => void refreshProject()}>Reload</Button><Button type="button" onClick={() => void invokeLink(DOCS_URL, linkCommand)}>Docs</Button></div>
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
  const selectedPin = project ? pinnedIdentities.has(projectIdentity(project)) : false
  const recentIdentities = new Set(state.projects.recent.slice(0, 10).map(projectIdentity))
  const pickerCandidates = browsedProjects.filter((candidate) => matchesPickerQuery(candidate) && !pinnedIdentities.has(projectIdentity(candidate)) && !recentIdentities.has(projectIdentity(candidate)))

  if (!project) return <main className="quirky-tasks-projects quirky-tasks-projects--empty">
    <div className="quirky-tasks-projects__toolbar">
      <Button type="button" onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen}>Choose a project</Button>
      <span className="ui-text-muted">Projects v2</span>
    </div>
    <EmptyState message="Choose a project to get started." />
    {pickerOpen && renderPicker()}
    {browseError !== null && <div role="alert">{renderProjectError(browseError)}</div>}
  </main>

  const columns = tableColumns(tableFields, deviceColumns.hidden)
  const sortedItems = sortItems(tableItems, tableFields, sort, currentView ?? undefined)
  const tableGroups = currentView ? groupProjectItems(sortedItems, currentView.groupByFields?.[0] ?? null) : []

  function renderPicker() {
    return <Dialog open={pickerOpen} title="Choose a project" onClose={() => setPickerOpen(false)} closeOnBackdrop={false}>
      <div className="quirky-tasks-project-picker">
        <TextField label="Search projects" placeholder="Search projects" value={pickerSearch} onChange={(event) => setPickerSearch(event.currentTarget.value)} />
        <div className="quirky-tasks-projects__actions">
          <Button type="button" onClick={() => void browseProjects(false)} disabled={pickerBusy}>{pickerBusy ? 'Browse all (loading…)' : 'Browse all'}</Button>
          <Button type="button" onClick={() => void browseProjects(true)} disabled={pickerBusy}>Reload browse</Button>
        </div>
        {pinnedProjects.length > 0 && <ProjectChoiceSection title="Pinned" projects={pinnedProjects} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
        {recentProjects.length > 0 && <ProjectChoiceSection title="Recent" projects={recentProjects} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
        {browseOpen && <ProjectChoiceSection title="Browse all" projects={pickerCandidates} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
        {browseOpen && pickerCandidates.length === 0 && !pickerBusy && !browseError && <p role="status" className="ui-text-muted">{pickerQuery ? 'No projects match this search.' : 'No additional projects were found. Add a project URL or owner/number below.'}</p>}
        {partialFailures.length > 0 && <p role="status" className="ui-text-muted">Some organization projects could not be listed. Paste a project URL below to reach missing ones.</p>}
        {browseError !== null && renderProjectError(browseError)}
        <form onSubmit={(event) => { event.preventDefault(); if (addInput.trim()) void chooseProject('add', addInput.trim()) }} className="quirky-tasks-project-picker__add">
          <TextField label="Add by URL or owner/number" id="project-reference" value={addInput} onChange={(event) => setAddInput(event.currentTarget.value)} placeholder="https://github.com/orgs/team/projects/3/views/4" />
          <Button type="submit" disabled={pickerBusy || addInput.trim().length === 0}>{pickerBusy ? 'Adding…' : 'Add'}</Button>
        </form>
      </div>
    </Dialog>
  }

  const selectedView = currentView
  const openItemActions = (item: ProjectItem) => {
    const linked = linkedWorkspace(item, state, project, createdWorkspaceLinks) !== null
    const busyKey = `${projectKey}|${item.id}`
    const busy = busyItem === busyKey
    return <div className="quirky-tasks-projects__item-actions">
      <Button type="button" onClick={(event) => { event.stopPropagation(); void invokeLink(projectItemUrl(item, project), linkCommand) }} aria-label={`Open ${item.content?.kind ?? 'project item'} on GitHub`}>GitHub</Button>
      <Button type="button" disabled={busy || isRestricted(item) || isDraft(item)} onClick={(event) => { event.stopPropagation(); void startItem(item) }} aria-label={`${linked ? 'Resume' : 'Start work on'} ${String(item.content?.title ?? 'project item')}`}>{busy ? 'Starting…' : linked ? 'Resume' : 'Start work'}</Button>
      {linked && <Button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void startItem(item, true) }} aria-label={`Start new workspace for ${String(item.content?.title ?? 'project item')}`}>Start new</Button>}
    </div>
  }

  return <main className="quirky-tasks-projects">
    <div className="quirky-tasks-projects__toolbar">
      <Button type="button" onClick={() => { setPickerOpen((open) => !open); setBrowseError(null) }} aria-expanded={pickerOpen}>{project.title || `${project.owner}/${project.number}`}</Button>
      <span className="ui-text-muted">{project.ownerType} · {sourceIdentity(project)}</span>
      <Button type="button" className="quirky-tasks-projects__toolbar-spacer" aria-label="Open view in GitHub" onClick={() => void invokeLink(projectViewUrl(project, selectedView), linkCommand)}>Open view in GitHub</Button>
      <Button type="button" aria-label={selectedPin ? 'Remove project pin' : 'Pin project'} onClick={() => void togglePin(project)}>{selectedPin ? 'Unpin' : 'Pin'}</Button>
      <Button type="button" onClick={() => void refreshProject()} disabled={loadingTable || loadingViews} aria-label={loadingTable ? 'Refreshing project' : 'Refresh project'}>{loadingTable ? 'Refreshing…' : 'Refresh'}</Button>
    </div>
    {pickerOpen && renderPicker()}
    {loadingViews && views.length === 0 && <div role="status" className="ui-text-muted">Loading project views…</div>}
    <Tabs
      label="Project views"
      items={views.map((view) => {
        const supported = supportedLayout(view.layout)
        return { id: view.id, label: `${layoutLabel(view.layout)} · ${view.name ?? 'View'}${supported ? '' : ' (Unsupported)'}`, disabled: !supported }
      })}
      value={activeViewId}
      onChange={(id) => void changeView(id)}
    />
    {views.length === 0 && !loadingViews && <span className="ui-text-muted">No views found.</span>}
    {selectedView && <div className="quirky-tasks-projects__query">
      <TextField
        data-tasks-search
        label="Search project items"
        type="search"
        placeholder={selectedView.filter || 'GitHub search, e.g. assignee:@me is:open'}
        value={queryDraft}
        className={isQueryDirty ? 'quirky-tasks-projects__search-input quirky-tasks-projects__search-input--dirty' : 'quirky-tasks-projects__search-input'}
        onChange={(event) => setQueryDraft(event.currentTarget.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') { event.preventDefault(); void applyQuery(queryDraft) }
          if (event.key === 'Escape') { event.preventDefault(); setQueryDraft(activeQuery) }
        }}
        onBlur={() => { if (queryDraft !== activeQuery) void applyQuery(queryDraft) }}
      />
      {isQueryDirty && <span role="status" className="quirky-tasks-projects__warning">Unapplied</span>}
      {queryBusy && <span role="status" className="ui-text-muted">Applying…</span>}
      <Badge label="Project item count">{table?.totalCount === null || table?.totalCount === undefined ? tableItems.length : String(table.totalCount)} items</Badge>
      <Button type="button" onClick={() => setColumnsOpen((open) => !open)} aria-expanded={columnsOpen}>Configure columns</Button>
    </div>}
    {columnsOpen && selectedView && <ColumnConfigurator fields={tableFields} hidden={deviceColumns.hidden} widths={deviceColumns.widths} onChange={(id, visible) => void updateDeviceColumns((previous) => ({ ...previous, hidden: visible ? previous.hidden.filter((hidden) => hidden !== id) : [...previous.hidden, id] }))} onWidth={(id, width) => void updateDeviceColumns((previous) => ({ ...previous, widths: { ...previous.widths, [id]: Math.max(60, width) } }))} />}
    {mainError !== null && <div role="alert">{renderProjectError(mainError)}</div>}
    {writeError !== null && <div role="alert">{renderProjectError(writeError)}</div>}
    {errorAnnouncement && <div role="status" className="quirky-tasks-projects__warning">{errorAnnouncement}</div>}
    {chooseView && <section className="quirky-tasks-projects__choose-view">
      <div className="quirky-tasks-projects__choose-view-heading"><Button type="button" onClick={() => { setChooseView(false); setPickerOpen(true) }}>← Back</Button><strong>Choose a view</strong></div>
      {loadingViews ? <span role="status">Loading views…</span> : views.length === 0 ? <span>No views found.</span> : <div className="quirky-tasks-projects__view-choices">{views.map((view) => <Button key={view.id} type="button" disabled={!supportedLayout(view.layout)} title={supportedLayout(view.layout) ? undefined : `Quirky does not support ${String(view.layout ?? 'unknown')} views yet.`} onClick={() => void changeView(view.id)}>{view.name} · {layoutLabel(view.layout)}{!supportedLayout(view.layout) ? ' · Unsupported' : ''}</Button>)}</div>}
    </section>}
    {loadingTable && table === null && <div role="status" aria-label="Loading project view" className="quirky-tasks-projects__skeletons">{Array.from({ length: 6 }, (_, index) => <div key={index} className="quirky-tasks-projects__skeleton" />)}</div>}
    {!chooseView && !loadingViews && !mainError && selectedView && table !== null && tableItems.length === 0 && <div role="status" className="quirky-tasks-projects__empty-state">
      <EmptyState message={activeQuery || viewFilter ? 'No items match this view’s filter.' : 'This view has no items yet. Recently added items can take a while to appear.'} />
    </div>}
    {!chooseView && table !== null && tableItems.length > 0 && <div className="quirky-tasks-projects__table-scroll">
      {layout === 'TABLE' && <ProjectTable items={sortedItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={(key) => setCollapsedGroups((previous) => toggleSet(previous, key))} sort={sort} onSort={toggleSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout === 'BOARD' && <ProjectBoard items={tableItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={(key) => setCollapsedGroups((previous) => toggleSet(previous, key))} sort={sort} onSort={toggleSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} onMove={editProjectField} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout === 'ROADMAP' && <ProjectRoadmap model={roadmapModel} items={tableItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={(key) => setCollapsedGroups((previous) => toggleSet(previous, key))} sort={sort} onSort={toggleSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} zoom={zoom} onZoom={(value) => { setZoom(value); saveZoom(value) }} onToday={() => scrollToToday(roadmapScroller.current, roadmapModel.todayIndex, roadmapModel.tickWidth)} scroller={roadmapScroller} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout !== 'TABLE' && layout !== 'BOARD' && layout !== 'ROADMAP' && <div role="alert">{renderProjectError(new Error('unsupported_layout'))}</div>}
    </div>}
    {!loadingTable && !loadingViews && table === null && !mainError && !chooseView && <div className="ui-text-muted">Choose a project view to load its items.</div>}
    {actionHelp && <Dialog
      open
      title="GitHub project item guidance"
      onClose={() => setActionHelp(null)}
      closeOnBackdrop={false}
      actions={<Button type="button" onClick={() => void invokeLink(actionHelp.externalUrl, linkCommand)} disabled={!actionHelp.externalUrl}>Open in GitHub</Button>}
    >
      <div className="quirky-tasks-project-guidance">
        <p>{actionHelp.text}</p>
        {actionHelp.offerAddRepo && <form onSubmit={(event) => { event.preventDefault(); void addLocalRepository(actionHelp.item) }} className="quirky-tasks-project-guidance__form">
          <TextField label="Local repository path" id="local-project-repo-path" value={addRepoPath} onChange={(event) => setAddRepoPath(event.currentTarget.value)} placeholder="/path/to/local/clone" />
          <Button type="submit" disabled={addingRepo || addRepoPath.trim().length === 0}>{addingRepo ? 'Adding…' : 'Add repo'}</Button>
        </form>}
      </div>
    </Dialog>}
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

function linkedWorkspace(item: ProjectItem, state: TasksSurfaceProps['state'], project: ProjectTarget, localLinks: Record<string, string> = {}): string | null {
  const url = projectItemUrl(item, project)
  if (url && localLinks[url]) return localLinks[url]!
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
  return <fieldset className="quirky-tasks-projects__columns"><legend>Configure columns</legend>
    <label className="quirky-tasks-projects__column-option"><input type="checkbox" checked disabled />Title{widthControl('title', 'Title', 360)}</label>
    <label className="quirky-tasks-projects__column-option"><input type="checkbox" checked={!props.hidden.includes('type')} onChange={(event) => props.onChange('type', event.currentTarget.checked)} />Type{widthControl('type', 'Type', 140)}</label>
    {props.fields.filter((field) => field.name?.toLowerCase() !== 'title' && field.name?.toLowerCase() !== 'type').map((field) => {
      const visible = !props.hidden.includes(field.id)
      return <label key={field.id} className="quirky-tasks-projects__column-option"><input type="checkbox" checked={visible} onChange={(event) => props.onChange(field.id, event.currentTarget.checked)} />{field.name ?? field.id}{widthControl(field.id, field.name ?? field.id, 140)}</label>
    })}
  </fieldset>
}

function ProjectChoiceSection(props: { title: string; projects: ProjectTarget[]; current: ProjectTarget | null; onChoose(project: ProjectTarget): void; onPin(project: ProjectTarget): void; pinnedIdentities: Set<string> }) {
  if (props.projects.length === 0) return null
  return <section className="quirky-tasks-projects__choice-section"><strong>{props.title}</strong>{props.projects.map((project) => {
    const pinned = props.pinnedIdentities.has(projectIdentity(project))
    const selected = props.current !== null && projectIdentity(project) === projectIdentity(props.current)
    return <div key={projectIdentity(project)} className="quirky-tasks-projects__choice-row">
      <Button type="button" className="quirky-tasks-projects__choice" aria-pressed={selected} onClick={() => props.onChoose(project)}>
        {project.title || `${project.owner}/${project.number}`}
        <span className="quirky-tasks-projects__choice-meta">{project.ownerType} · {project.host ?? hostFromUrl(project.url)}</span>
      </Button>
      <Button type="button" aria-label={pinned ? 'Remove pin' : 'Pin project'} onClick={() => props.onPin(project)}>{pinned ? 'Unpin' : 'Pin'}</Button>
    </div>
  })}</section>
}

function ErrorCard(props: { title: string; message: string; onOpen(): void; onRetry(): void }) {
  return <section role="alert" className="quirky-tasks-projects__error-card"><strong>{props.title}</strong><span>{props.message}</span><div className="quirky-tasks-projects__actions"><Button type="button" onClick={props.onRetry}>Retry</Button><Button type="button" onClick={props.onOpen}>Open in GitHub</Button></div></section>
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
  return <Dialog open title="GitHub item preview" onClose={props.onClose} closeOnBackdrop={false} actions={<Button type="button" variant="primary" onClick={props.onOpen} disabled={!props.url}>Open in GitHub</Button>}>
    <div className="quirky-tasks-project-preview">
      {props.guidance && <p role="status" className="ui-text-muted">{props.guidance}</p>}
      {props.loading && <span role="status">Loading GitHub item details…</span>}
      <h2 className="quirky-tasks-project-preview__title">{String(content.title ?? (isRestricted(props.item) ? 'Restricted item' : 'Untitled item'))}</h2>
      <p className="quirky-tasks-project-preview__meta">{String(content.repository ?? 'Repository unavailable')} · {kind} {content.number ? `#${content.number}` : ''}{content.state ? ` · ${String(content.state)}` : ''}{content.author ? ` · @${String(content.author)}` : ''}</p>
      {typeof content.headRefName === 'string' && content.headRefName.length > 0 && <p className="quirky-tasks-project-preview__meta">{String(content.baseRefName ?? '')} ← {content.headRefName}</p>}
      {labels.length > 0 && <p className="quirky-tasks-project-preview__meta">Labels: {labels.join(', ')}</p>}
      {assignees.length > 0 && <p className="quirky-tasks-project-preview__meta">Assignees: {assignees.join(', ')}</p>}
      {body && <article aria-label="Description"><Markdown source={body} /></article>}
      {partialFailures.length > 0 && <p role="status" className="ui-text-muted">Some GitHub details are unavailable: {partialFailures.join('; ')}</p>}
      {comments.length > 0 && <section aria-label="Recent comments" className="quirky-tasks-project-preview__comments"><h3>Comments</h3>{comments.map((comment, index) => <article key={String(comment.id ?? index)} className="quirky-tasks-project-preview__comment"><span className="ui-text-muted">{String(comment.author ?? 'Unknown author')} · {String(comment.createdAt ?? '')}</span><Markdown source={String(comment.body ?? '')} /></article>)}</section>}
      {timeline.length > 0 && <details><summary>Activity ({timeline.length})</summary>{timeline.map((event, index) => <p key={String(event.id ?? index)}>{String(event.type ?? event.event ?? 'Activity')} · {String(event.createdAt ?? '')} · {String(event.actor ?? '')}</p>)}</details>}
      {isRestricted(props.item) && <p>This project card is restricted by GitHub permissions; its content cannot be displayed or edited.</p>}
    </div>
  </Dialog>
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
  const stickyStyle = (index: number): CSSProperties => index < 2 ? { left: lefts[index] } : {}
  const groupField = props.view?.groupByFields?.[0] ?? null
  const hasIssueTypeField = props.fields.some((field) => fieldDataType(field) === 'ISSUE_TYPE' || /issue.?type/i.test(field.name ?? ''))
  return <table className="quirky-tasks-project-table">
    <colgroup>{props.columns.map((column, index) => <col key={column.id} style={{ width: widths[index] }} />)}<col className="quirky-tasks-project-table__actions-column" /></colgroup>
    <thead><tr>{props.columns.map((column, index) => <th key={column.id} scope="col" className={index < 2 ? 'quirky-tasks-project-table__sticky' : undefined} style={stickyStyle(index)}>
      <Button type="button" className="quirky-tasks-project-table__sort" onClick={() => props.onSort(column.id)}>{column.label}{props.sort?.fieldId === column.id ? props.sort.direction === 'asc' ? ' ↑' : props.sort.direction === 'desc' ? ' ↓' : '' : ''}</Button>
    </th>)}<th scope="col" className="quirky-tasks-project-table__actions-heading">Actions</th></tr></thead>
    <tbody>{props.groups.map((group) => {
      const groupKey = `${props.view?.id ?? 'view'}|${group.key}`
      const isCollapsed = props.collapsed.has(groupKey)
      const groupItems = groupField ? group.items : props.items
      return <Fragment key={groupKey}>
        {groupField && <tr><th colSpan={props.columns.length + 1} className="quirky-tasks-project-table__group"><Button type="button" aria-expanded={!isCollapsed} className="quirky-tasks-project-table__group-toggle" onClick={() => props.onToggleGroup(groupKey)}>{isCollapsed ? '▸' : '▾'} {group.label} · {group.items.length}{group.range ? ` · ${group.range}` : ''}{group.current ? ' · Current' : ''}</Button></th></tr>}
        {!isCollapsed && groupItems.map((item) => <tr key={item.id} onDoubleClick={() => props.onOpen(item)} className="quirky-tasks-project-table__row">
          {props.columns.map((column, index) => <td key={column.id} className={index < 2 ? 'quirky-tasks-project-table__cell quirky-tasks-project-table__sticky' : 'quirky-tasks-project-table__cell'} style={stickyStyle(index)}>
            {column.kind === 'title'
              ? <Button type="button" className="quirky-tasks-project-table__title" onClick={() => props.onOpen(item)} title={String(item.content?.title ?? '')}>{String(item.content?.title ?? (isRestricted(item) ? 'Restricted item' : 'Untitled'))}</Button>
              : column.kind === 'type'
                ? item.content?.kind === 'issue'
                  ? <div className="quirky-tasks-project-table__type-cell"><span>Issue</span>{!hasIssueTypeField && <ProjectFieldCell item={item} field={ISSUE_TYPE_FIELD} project={props.project} issueTypes={props.issueTypesByItem[item.id]} onLoadIssueTypes={props.onLoadIssueTypes} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} />}</div>
                  : <span>{String(item.content?.kind === 'pullRequest' ? 'Pull request' : item.content?.kind === 'draft' ? 'Draft' : 'Restricted')}</span>
                : <ProjectFieldCell item={item} field={column.field!} project={props.project} issueTypes={props.issueTypesByItem[item.id]} onLoadIssueTypes={props.onLoadIssueTypes} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} />}
          </td>)}
          <td className="quirky-tasks-project-table__actions">{props.actions(item)}</td>
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
  if (readonly) return <span className="ui-text-muted" title={current}>{current}</span>
  if ((type === 'LABELS' || type === 'USERS' || /label|assignee/i.test(props.field.name ?? '')) && isIssue(props.item)) {
    const propName = type === 'USERS' || /assignee/i.test(props.field.name ?? '') ? 'assignees' : 'labels'
    const raw = props.item.content?.[propName]
    const values = Array.isArray(raw) ? raw.map((entry) => typeof entry === 'string' ? entry : String(record(entry)?.login ?? record(entry)?.name ?? '')).filter(Boolean).join(', ') : ''
    return <InlineText value={values} ariaLabel={`${props.field.name ?? propName} for issue ${String(props.item.content?.number ?? '')}`} placeholder="Comma-separated values" onSave={(value) => props.onCollectionEdit(props.item, props.field, value)} />
  }
  if ((type === 'ISSUE_TYPE' || /issue.?type/i.test(props.field.name ?? '')) && isIssue(props.item)) {
    const currentType = record(props.item.content?.issueType)
    const choices = props.issueTypes ?? options
    if (choices.length === 0 && currentType === null) return <Button type="button" className="quirky-tasks-projects__field-action" onFocus={() => props.onLoadIssueTypes(props.item)} onClick={() => props.onLoadIssueTypes(props.item)}>Load issue types</Button>
    return <select aria-label="Issue type" className="quirky-tasks-control" value={String(currentType?.id ?? '')} onFocus={() => props.onLoadIssueTypes(props.item)} onChange={(event) => {
      const selected = choices.find((candidate) => candidate.id === event.currentTarget.value)
      if (selected) void props.onIssueTypeEdit(props.item, { id: selected.id, name: String(selected.name ?? selected.id) })
    }}><option value="" disabled>Choose issue type</option>{currentType !== null && !choices.some((option) => option.id === currentType.id) && <option value={String(currentType.id)}>{String(currentType.name ?? currentType.id)}</option>}{choices.map((option) => <option key={option.id} value={option.id}>{String(option.name ?? option.id)}</option>)}</select>
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
    return <select multiple size={Math.max(2, Math.min(5, options.length))} aria-label={props.field.name ?? 'Project field'} className="quirky-tasks-control quirky-tasks-projects__multi-select" value={selected} onChange={(event) => {
      const values = Array.from(event.currentTarget.selectedOptions, (option) => option.value)
      if (values.length === 0) void props.onFieldEdit(props.item, props.field, undefined, true)
      else void props.onFieldEdit(props.item, props.field, { multiSelectOptionIds: values })
    }}>{options.map((option) => <option key={option.id} value={option.id}>{String(option.name ?? option.id)}</option>)}</select>
  }
  if (type === 'SINGLE_SELECT' || type === 'ITERATION') return <select aria-label={props.field.name ?? 'Project field'} className="quirky-tasks-control" value={selectedOptionId(fieldValue(props.item, props.field.id), options)} onChange={(event) => {
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
  if (type === 'LABELS' || type === 'USERS' || type === 'REPOSITORY' || type === 'PARENT_ISSUE') return <span className="ui-text-muted">{current}</span>
  return <span className="ui-text-muted">{current}</span>
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
  if (!editing) return <Button type="button" className="quirky-tasks-projects__inline-trigger" aria-label={`Edit ${props.ariaLabel}`} onClick={() => setEditing(true)} title={props.value}>{props.value || '—'}</Button>
  return <span className="quirky-tasks-projects__inline-editor">
    <input autoFocus type={props.type ?? 'text'} aria-label={props.ariaLabel} placeholder={props.placeholder} value={draft} className="quirky-tasks-control quirky-tasks-projects__inline-input" onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setDraft(props.value); setEditing(false) } if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
    <IconButton label={`Save ${props.ariaLabel}`} disabled={saving} onClick={() => void save()}>{saving ? '…' : '✓'}</IconButton>
    <IconButton label={`Cancel ${props.ariaLabel} edit`} onClick={() => { setDraft(props.value); setEditing(false) }}>×</IconButton>
    {error && <span className="quirky-tasks-projects__field-error" role="alert">{error}</span>}
  </span>
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
  if (!group) return <section className="quirky-tasks-project-board__fallback"><div role="status">This board view has no single-select or iteration field to group by, so Quirky is listing items instead.</div><ProjectTable items={props.items} fields={props.fields} columns={props.columns} widths={props.widths} issueTypesByItem={props.issueTypesByItem} onLoadIssueTypes={props.onLoadIssueTypes} view={props.view} groups={props.groups} collapsed={props.collapsed} onToggleGroup={props.onToggleGroup} sort={props.sort} onSort={props.onSort} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} onOpen={props.onOpen} actions={props.actions} project={props.project} /></section>
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
  return <div className="quirky-tasks-project-board">
    {columns.map((column) => <section key={column.id} aria-label={column.label} className={column.readOnly ? 'quirky-tasks-project-board__column quirky-tasks-project-board__column--readonly' : 'quirky-tasks-project-board__column'} onDragOver={(event) => { if (!column.readOnly) event.preventDefault() }} onDrop={(event) => {
      event.preventDefault()
      if (column.readOnly) return
      const itemId = event.dataTransfer.getData('text/quirky-project-item')
      const item = props.items.find((candidate) => candidate.id === itemId)
      if (item) move(item, column)
    }}>
      <h3 className="quirky-tasks-project-board__column-title">{column.label} <span className="ui-text-muted">{column.items.length}</span>{column.readOnly && <span className="ui-text-muted"> · Read only</span>}</h3>
      {column.items.map((item) => {
        const itemValue = currentValue(item)
        const itemOption = boardOptions.find((option) => option.id === itemValue)
        const isDeleted = itemValue !== '' && itemOption === undefined && column.value !== null
        return <article key={item.id} className={column.readOnly ? 'quirky-tasks-project-board__card quirky-tasks-project-board__card--readonly' : 'quirky-tasks-project-board__card'} draggable={!column.readOnly && !isRestricted(item) && !isDraft(item)} onDragStart={(event) => { event.dataTransfer.setData('text/quirky-project-item', item.id); event.dataTransfer.effectAllowed = 'move' }}>
          <Button type="button" className="quirky-tasks-project-board__card-title" onClick={() => props.onOpen(item)}>{item.content?.kind === 'pullRequest' ? '⑂ ' : '● '}{String(item.content?.title ?? 'Restricted item')}</Button>
          <span className="quirky-tasks-project-board__card-meta">{item.content?.kind === 'pullRequest' ? 'PR' : item.content?.kind === 'issue' ? 'Issue' : 'Draft'} {item.content?.number ? `#${item.content.number}` : ''} · {String(item.content?.repository ?? 'Repository unavailable')}</span>
          <div className="quirky-tasks-project-board__assignees">{assigneeAvatars(item).map((user) => <span key={user.login} title={user.login} className="quirky-tasks-project-board__avatar">{user.avatarUrl ? <img src={user.avatarUrl} alt={user.login} /> : user.login.slice(0, 2).toUpperCase()}</span>)}</div>
          <label className="quirky-tasks-project-board__move">Move card<select aria-label={`Move ${String(item.content?.title ?? 'item')}`} value={itemValue} disabled={column.readOnly || isRestricted(item) || isDraft(item)} className="quirky-tasks-control" onChange={(event) => {
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
  if (!model.placementFieldName) return <section className="quirky-tasks-project-roadmap__fallback"><div role="status">This roadmap view has no date or iteration field to place items on, so Quirky is listing items instead.</div><ProjectTable items={props.items} fields={props.fields} columns={props.columns} widths={props.widths} issueTypesByItem={props.issueTypesByItem} onLoadIssueTypes={props.onLoadIssueTypes} view={props.view} groups={props.groups} collapsed={props.collapsed} onToggleGroup={props.onToggleGroup} sort={props.sort} onSort={props.onSort} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} onOpen={props.onOpen} actions={props.actions} project={props.project} /></section>
  const totalWidth = model.ticks.length * model.tickWidth
  return <section className="quirky-tasks-project-roadmap">
    <div className="quirky-tasks-project-roadmap__toolbar">
      <strong>Placed by {model.placementFieldName}{model.targetFieldName ? ` → ${model.targetFieldName}` : ''}</strong>
      <span className="ui-text-muted">{model.undatedCount} without dates</span>
      <Button type="button" className="quirky-tasks-project-roadmap__toolbar-spacer" onClick={props.onToday}>Today</Button>
      {(['month', 'quarter', 'year'] as const).map((value) => <Button key={value} type="button" aria-pressed={props.zoom === value} onClick={() => props.onZoom(value)}>{value[0]!.toUpperCase() + value.slice(1)}</Button>)}
    </div>
    <div ref={props.scroller} className="quirky-tasks-project-roadmap__scroller">
      <div className="quirky-tasks-project-roadmap__track" style={{ '--roadmap-total-width': `${totalWidth}px`, '--roadmap-tick-width': `${model.tickWidth}px` } as CSSProperties}>
        <div className="quirky-tasks-project-roadmap__grid quirky-tasks-project-roadmap__grid--header">
          <strong className="quirky-tasks-project-roadmap__item-heading">Item</strong>
          <div className="quirky-tasks-project-roadmap__ticks">{model.ticks.map((tick) => <div key={tick.startDate.toISOString()} className="quirky-tasks-project-roadmap__tick" style={{ width: model.tickWidth, minWidth: model.tickWidth }}>{tick.label}</div>)}</div>
        </div>
        {model.placements.map((placement) => {
          const item = props.items.find((candidate) => candidate.id === placement.itemId)
          const from = placement.from.toISOString().slice(0, 10)
          const to = placement.to.toISOString().slice(0, 10)
          return <div key={placement.itemId} className="quirky-tasks-project-roadmap__grid quirky-tasks-project-roadmap__row">
            <div className="quirky-tasks-project-roadmap__item">
              <Button type="button" className="quirky-tasks-project-roadmap__item-title" onClick={() => { if (item) props.onOpen(item) }}>{placement.title}</Button>
              {item && props.actions(item)}
            </div>
            <div className="quirky-tasks-project-roadmap__timeline">
              {model.todayIndex !== null && <span aria-hidden="true" className="quirky-tasks-project-roadmap__today" style={{ left: model.todayIndex * model.tickWidth }} />}
              {placement.marker
                ? <span role="img" aria-label={`${placement.title} date marker: ${from}`} title={from} className="quirky-tasks-project-roadmap__marker" style={{ left: placement.left }} />
                : <span role="img" aria-label={`${placement.title} ${from} to ${to}`} title={`${from} – ${to}`} className="quirky-tasks-project-roadmap__range" style={{ left: placement.left, width: Math.max(8, placement.width) }} />}
            </div>
          </div>
        })}
      </div>
    </div>
    {model.undatedCount > 0 && <details className="quirky-tasks-project-roadmap__undated">
      <summary>{model.undatedCount} items without dates</summary>
      <ul>{props.items.filter((item) => !model.placements.some((placement) => placement.itemId === item.id)).map((item) => <li key={item.id}><Button type="button" onClick={() => props.onOpen(item)}>{String(item.content?.title ?? 'Restricted item')}</Button> · {String(item.content?.repository ?? 'Repository unavailable')} {props.actions(item)}</li>)}</ul>
    </details>}
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
