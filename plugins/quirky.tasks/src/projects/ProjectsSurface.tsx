import { Badge, Button, Dialog, EmptyState, IconButton, InlineError, NoticeLine, Tabs, TextField } from '@quirky/ui'
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
import { registerProjectsControl, requestProjectsControl, type ProjectsControlHandler, type ProjectsControlRequest } from './control'

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

type ProjectErrorScope = 'browse' | 'load' | 'write'

function projectErrorText(error: unknown, scope: ProjectErrorScope): string {
  const reason = errorReason(error)
  const host = hostFromError(error) ?? 'github.com'
  if (reason === 'auth_required') return `GitHub login is required for ${host}.`
  if (reason === 'scope_missing') return `GitHub Projects access is missing for ${host}.`
  if (scope === 'browse') return `Could not list GitHub projects. ${errorMessage(error)}`
  if (scope === 'write') {
    const announcement = nonEmpty(record(error)?.announcement) ?? 'The project item update failed.'
    return `${announcement} ${errorMessage(error)}`
  }
  if (reason === 'too_large') {
    const count = Number(record(record(error)?.data)?.totalCount)
    const title = Number.isFinite(count) ? `This view has ${count} items — too large to render in Quirky.` : 'This view is too large to render in Quirky.'
    return `${title} Narrow the view's filter on GitHub, then reload the project.`
  }
  if (reason === 'unsupported_layout') return 'This project view layout is unsupported. Choose a table, board, or roadmap view. The original view remains available on GitHub.'
  if (reason === 'not_found') return 'Could not find this project or view. It may have been removed, moved, or is not visible to the current GitHub account.'
  if (reason === 'schema_drift') return 'GitHub returned a Projects schema Quirky does not recognize. The project data could not be interpreted safely. Retry later or open the project on GitHub.'
  return `Could not load this GitHub project. ${errorMessage(error)}`
}

function withoutQueryOverride(previous: Record<string, string>, key: string, value: string | undefined): Record<string, string> {
  const entries = Object.entries(previous).filter(([candidate]) => candidate !== key)
  return Object.fromEntries(value === undefined ? entries : [...entries, [key, value]])
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
type InlineEditSession = { projectKey: string; viewId: string; revision: number; draft: string; saving: boolean; error: string }
type InlineEditorState = {
  editing: boolean
  draft: string
  saving: boolean
  error: string
  onBegin(): void
  onDraft(value: string): void
  onSave(): void
  onCancel(): void
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void
}
type InlineFieldShape = { clear: boolean; value?: unknown; error?: string }

function inlineEditorKey(itemId: string, fieldId: string): string {
  return JSON.stringify([itemId, fieldId])
}

function inlineCollectionProperty(field: ProjectField): 'labels' | 'assignees' | null {
  const type = fieldDataType(field)
  const name = field.name ?? ''
  if (type === 'USERS' || /assignee/i.test(name)) return 'assignees'
  if (type === 'LABELS' || /label/i.test(name)) return 'labels'
  return null
}

function inlineInitialValue(item: ProjectItem, field: ProjectField): string {
  const collection = isIssue(item) ? inlineCollectionProperty(field) : null
  if (collection !== null) {
    const values = item.content?.[collection]
    return Array.isArray(values)
      ? values.map((entry) => typeof entry === 'string' ? entry : String(record(entry)?.login ?? record(entry)?.name ?? '')).filter(Boolean).join(', ')
      : ''
  }
  const raw = fieldValue(item, field.id)
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw)
  const key = fieldDataType(field).toLowerCase()
  return String(record(raw)?.[key] ?? '')
}

function shapeInlineField(field: ProjectField, draft: string): InlineFieldShape {
  if (draft === '') return { clear: true }
  const type = fieldDataType(field)
  if (type === 'NUMBER') {
    const number = Number(draft)
    return Number.isFinite(number) ? { clear: false, value: { number } } : { clear: false, error: 'Enter a finite number.' }
  }
  if (type === 'DATE') return { clear: false, value: { date: draft } }
  if (type === 'TEXT') return { clear: false, value: { text: draft } }
  return { clear: false, error: 'This field cannot be edited inline.' }
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
  const [browseLoading, setBrowseLoading] = useState(false)
  const [mainError, setMainError] = useState<unknown>(null)
  const [writeError, setWriteError] = useState<unknown>(null)
  const [queryDraft, setQueryDraft] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [localQueryOverrides, setLocalQueryOverrides] = useState<Record<string, string>>({})
  const [queryBusy, setQueryBusy] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<{ fieldId: string; direction: 'asc' | 'desc' | 'view' } | null>(null)
  const [itemPreview, setItemPreview] = useState<ProjectItem | null>(null)
  const [itemPreviewGuidance, setItemPreviewGuidance] = useState('')
  const [openingItem, setOpeningItem] = useState('')
  const [actionHelp, setActionHelp] = useState<{ item: ProjectItem; text: string; externalUrl: string | null; offerAddRepo?: boolean; error?: boolean } | null>(null)
  const [addRepoPath, setAddRepoPath] = useState('')
  const [addingRepo, setAddingRepo] = useState(false)
  const [previewDetails, setPreviewDetails] = useState<ProjectRecord | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [busyItems, setBusyItems] = useState<ReadonlySet<string>>(() => new Set())
  const [createdWorkspaceLinks, setCreatedWorkspaceLinks] = useState<Record<string, string>>({})
  const [issueTypesByItem, setIssueTypesByItem] = useState<Record<string, Array<{ id: string; name: string }>>>({})
  const [deviceColumns, setDeviceColumns] = useState<{ hidden: string[]; widths: Record<string, number> }>({ hidden: [], widths: {} })
  const [zoom, setZoom] = useState<RoadmapZoom>(() => readZoom())
  const [inlineEditors, setInlineEditors] = useState<Map<string, InlineEditSession>>(() => new Map())
  const inlineEditorsRef = useRef(inlineEditors)
  const inlineRevision = useRef(0)
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
  const controlHandler = useRef<ProjectsControlHandler>(() => false)
  const busyItemRef = useRef(new Set<string>())
  const previewGeneration = useRef(0)
  const openingGeneration = useRef(0)
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

  useEffect(() => registerProjectsControl(context, (request) => controlHandler.current(request)), [context])

  useEffect(() => {
    clearInlineEditors()
  }, [projectKey, activeViewId])

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
    openingGeneration.current += 1
    setOpeningItem('')
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
    try {
      const raw = await context.call('quirky.tasks/projectView', { action: 'list', project: target })
      if (request !== viewGeneration.current || projectRequest !== projectGeneration.current) return
      const response = object(raw)
      const nextViews = asViews(object(response.result).views ?? response.views ?? raw)
      setViews(nextViews)
      setMainError(null)
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
    setBrowseLoading(true)
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
      setBrowseLoading(false)
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
        context.toast('Could not switch project views', errorMessage(error))
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
        setLocalQueryOverrides((prior) => withoutQueryOverride(prior, preferenceKey, previousLocalOverride))
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
      await refresh()
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
  function canUseTableSurface(): boolean {
    if (!project || table === null || tableItems.length === 0 || chooseView) return false
    if (layout === 'TABLE') return true
    if (layout === 'BOARD') return currentView === null || boardGroupField(currentView, tableFields) === null
    if (layout === 'ROADMAP') return !roadmapModel.placementFieldName
    return false
  }

  function canUseRoadmapSurface(): boolean {
    return project !== null && table !== null && tableItems.length > 0 && !chooseView && layout === 'ROADMAP' && roadmapModel.placementFieldName !== null
  }

  function editableInlineCell(itemId: string, fieldId: string): { item: ProjectItem; field: ProjectField } | null {
    if (!canUseTableSurface() || activeViewId === '') return null
    const item = tableItems.find((candidate) => candidate.id === itemId)
    const field = tableFields.find((candidate) => candidate.id === fieldId)
    if (!item || !field || isRestricted(item) || isDraft(item) || dataTypeIsReadOnly(field)) return null
    const collection = isIssue(item) ? inlineCollectionProperty(field) : null
    if (collection === null && !['TEXT', 'NUMBER', 'DATE'].includes(fieldDataType(field))) return null
    if (!columns.some((column) => column.id === field.id && column.field?.id === field.id)) return null
    const groupPrefix = currentView?.id ?? 'view'
    const visible = tableGroups.some((group) => group.items.some((candidate) => candidate.id === item.id) && !collapsedGroups.has(`${groupPrefix}|${group.key}`))
    return visible ? { item, field } : null
  }

  function isCurrentInlineSession(session: InlineEditSession): boolean {
    return project !== null && session.projectKey === projectKey && session.projectKey === currentProjectKey.current &&
      session.viewId === activeViewId && session.viewId === currentViewId.current
  }

  function applyControl(request: ProjectsControlRequest): boolean {
    if (request.action === 'picker') {
      const open = request.open ?? !pickerOpen
      setPickerOpen(open)
      if (open) {
        setBrowseError(null)
        setBrowseErrorHost(null)
      }
      return true
    }
    if (request.action === 'column-panel') {
      if (!project || !currentView) return false
      setColumnsOpen(request.open ?? !columnsOpen)
      return true
    }
    if (request.action === 'back-to-picker') {
      if (!chooseView) return false
      setChooseView(false)
      setPickerOpen(true)
      setBrowseError(null)
      setBrowseErrorHost(null)
      return true
    }
    if (request.action === 'sort') {
      if (!canUseTableSurface() || !columns.some((column) => column.id === request.fieldId)) return false
      toggleSort(request.fieldId)
      return true
    }
    if (request.action === 'group') {
      if (!canUseTableSurface() || !currentView?.groupByFields?.[0] || !tableGroups.some((group) => group.key === request.group)) return false
      setCollapsedGroups((previous) => toggleSet(previous, `${currentView?.id ?? 'view'}|${request.group}`))
      return true
    }
    if (request.action === 'zoom') {
      if (!canUseRoadmapSurface()) return false
      setZoom(request.zoom)
      saveZoom(request.zoom)
      return true
    }
    if (request.action === 'today') {
      if (!canUseRoadmapSurface() || roadmapScroller.current === null || roadmapModel.todayIndex === null) return false
      scrollToToday(roadmapScroller.current, roadmapModel.todayIndex, roadmapModel.tickWidth)
      return true
    }
    if (request.action === 'edit') {
      const key = inlineEditorKey(request.itemId, request.fieldId)
      if (request.open) {
        const target = editableInlineCell(request.itemId, request.fieldId)
        if (!target) return false
        const existing = inlineEditorsRef.current.get(key)
        if (existing && isCurrentInlineSession(existing)) return true
        writeInlineSession(key, {
          projectKey,
          viewId: activeViewId,
          revision: ++inlineRevision.current,
          draft: inlineInitialValue(target.item, target.field),
          saving: false,
          error: ''
        })
        return true
      }
      const existing = inlineEditorsRef.current.get(key)
      if (!existing || !isCurrentInlineSession(existing)) return false
      removeInlineSession(key)
      return true
    }
    if (!project || !currentView || !tableFields.some((field) => field.id === request.fieldId) && !['title', 'type'].includes(request.fieldId)) return false
    void updateDeviceColumns((previous) => ({
      hidden: request.visible === undefined
        ? previous.hidden
        : request.visible
          ? previous.hidden.filter((id) => id !== request.fieldId)
          : [...previous.hidden, request.fieldId],
      widths: request.width === undefined ? previous.widths : { ...previous.widths, [request.fieldId]: request.width }
    }))
    return true
  }

  async function controlProjects(request: ProjectsControlRequest): Promise<void> {
    try {
      await requestProjectsControl(context, request)
    } catch (error) {
      context.log(`tasks: projects control failed: ${errorMessage(error)}`)
      applyControl(request)
    }
  }

  controlHandler.current = applyControl

  function writeInlineSession(key: string, session: InlineEditSession): void {
    const next = new Map(inlineEditorsRef.current)
    next.set(key, session)
    inlineEditorsRef.current = next
    setInlineEditors(next)
  }

  function removeInlineSession(key: string): boolean {
    if (!inlineEditorsRef.current.has(key)) return false
    const next = new Map(inlineEditorsRef.current)
    next.delete(key)
    inlineEditorsRef.current = next
    setInlineEditors(next)
    return true
  }

  function clearInlineEditors(): void {
    if (inlineEditorsRef.current.size === 0) return
    const next = new Map<string, InlineEditSession>()
    inlineEditorsRef.current = next
    setInlineEditors(next)
  }

  function requestSort(fieldId: string): void {
    void controlProjects({ action: 'sort', fieldId })
  }

  function requestGroupToggle(group: string): void {
    void controlProjects({ action: 'group', group })
  }

  function requestRoadmapZoom(zoom: RoadmapZoom): void {
    void controlProjects({ action: 'zoom', zoom })
  }

  function requestToday(): void {
    void controlProjects({ action: 'today' })
  }

  function requestInlineEdit(item: ProjectItem, field: ProjectField, open: boolean): void {
    void controlProjects({ action: 'edit', itemId: item.id, fieldId: field.id, open })
  }

  function updateInlineDraft(item: ProjectItem, field: ProjectField, draft: string): void {
    const key = inlineEditorKey(item.id, field.id)
    const session = inlineEditorsRef.current.get(key)
    if (!session || !isCurrentInlineSession(session)) return
    writeInlineSession(key, { ...session, draft, error: '' })
  }

  async function saveInlineEdit(item: ProjectItem, field: ProjectField): Promise<void> {
    const key = inlineEditorKey(item.id, field.id)
    const session = inlineEditorsRef.current.get(key)
    const target = editableInlineCell(item.id, field.id)
    if (!session || !isCurrentInlineSession(session) || session.saving || !target) return
    if (session.draft === inlineInitialValue(target.item, target.field)) {
      requestInlineEdit(target.item, target.field, false)
      return
    }
    const collection = isIssue(target.item) ? inlineCollectionProperty(target.field) : null
    const shaped = collection === null ? shapeInlineField(target.field, session.draft) : null
    if (shaped?.error) {
      writeInlineSession(key, { ...session, error: shaped.error })
      return
    }
    writeInlineSession(key, { ...session, saving: true, error: '' })
    if (collection !== null) await editIssueCollection(target.item, target.field, session.draft)
    else if (shaped !== null) await editProjectField(target.item, target.field, shaped.value, shaped.clear)
    const latest = inlineEditorsRef.current.get(key)
    if (latest?.revision === session.revision && isCurrentInlineSession(latest)) removeInlineSession(key)
  }

  function handleInlineKeyDown(item: ProjectItem, field: ProjectField, event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestInlineEdit(item, field, false)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void saveInlineEdit(item, field)
    }
  }

  function inlineEditorFor(item: ProjectItem, field: ProjectField): InlineEditorState {
    const session = inlineEditorsRef.current.get(inlineEditorKey(item.id, field.id))
    const active = session && isCurrentInlineSession(session) ? session : null
    return {
      editing: active !== null,
      draft: active?.draft ?? inlineInitialValue(item, field),
      saving: active?.saving ?? false,
      error: active?.error ?? '',
      onBegin: () => requestInlineEdit(item, field, true),
      onDraft: (draft) => updateInlineDraft(item, field, draft),
      onSave: () => { void saveInlineEdit(item, field) },
      onCancel: () => requestInlineEdit(item, field, false),
      onKeyDown: (event) => handleInlineKeyDown(item, field, event)
    }
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
          setWriteError({ ...object(error), message: errorMessage(error), announcement: 'Project field update was rolled back locally; GitHub did not confirm the change.' })
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
        if (currentViewId.current === viewId) await loadTableFor(targetProject, viewId, query, false)
      }
    } catch (error) {
      writeEpoch.current += 1
      if (mutationGeneration.current.get(key) === mine && projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
        setTable((previous) => previous ? { ...previous, items: asItems(previous.items).map((candidate) => candidate.id === item.id ? { ...candidate, content: { ...candidate.content, [targetProp]: old } } : candidate) } : previous)
        const data = record(record(error)?.data)
        const completed = Array.isArray(data?.completedSteps) ? data.completedSteps.filter((step) => typeof step === 'string') : []
        const announcement = data?.partial === true ? `Partial write: GitHub completed ${completed.join(', ') || 'part of the change'} before failing.` : 'The issue field update failed; the previous value was restored.'
        setWriteError({ ...object(error), message: errorMessage(error), announcement })
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
      if (currentProjectKey.current === targetProjectKey && projectGeneration.current === projectRequest) context.toast('Could not load issue types', errorMessage(error))
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
    const title = String(item.content?.title ?? 'project item')
    const openingRequest = ++openingGeneration.current
    setOpeningItem(title)
    const resolution = await matchLocalRepositories(context, state, parseRepoSlug(item, targetProject))
    if (projectGeneration.current !== projectRequest || currentProjectKey.current !== targetProjectKey) {
      if (openingRequest === openingGeneration.current) setOpeningItem('')
      return
    }
    if (openingRequest === openingGeneration.current) setOpeningItem('')
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
      await refresh()
    } catch (error) {
      if (projectGeneration.current === projectRequest && currentProjectKey.current === targetProjectKey) {
        setActionHelp({ item, text: `Could not open project item: ${errorMessage(error)}`, externalUrl: projectItemUrl(item, targetProject), error: true })
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
    const busyKey = `${targetProjectKey}|${item.id}`
    if (busyItemRef.current.has(busyKey)) return
    busyItemRef.current.add(busyKey)
    setBusyItems(new Set(busyItemRef.current))
    const clearBusy = () => {
      busyItemRef.current.delete(busyKey)
      setBusyItems(new Set(busyItemRef.current))
    }
    const resolution = await matchLocalRepositories(context, state, parseRepoSlug(item, targetProject))
    if (projectGeneration.current !== projectRequest || currentProjectKey.current !== targetProjectKey) {
      clearBusy()
      return
    }
    if (resolution.state === 'updating') {
      setActionHelp({ item, text: 'Repository list is updating. Retry once local repositories finish loading.', externalUrl })
      clearBusy()
      return
    }
    if (resolution.matches.length > 1) {
      setActionHelp({ item, text: 'This item matches multiple selected repositories. Select one repository before starting work.', externalUrl })
      clearBusy()
      return
    }
    if (resolution.matches.length === 0) {
      const message = resolution.excludedMatches.length > 0
        ? 'This item is outside the selected repositories. Change the Tasks repository selection to start work.'
        : 'Repository not in Quirky. Add a local clone of this GitHub repository, then start work from the project row.'
      setActionHelp({ item, text: message, externalUrl, offerAddRepo: resolution.excludedMatches.length === 0 })
      clearBusy()
      return
    }
    const matched = resolution.matches[0]!
    const target = itemTarget(item, targetProject, matched.worktree)
    if (!target) {
      clearBusy()
      return
    }
    const content = item.content ?? {}
    const name = typeof content.title === 'string' && content.title.trim() ? content.title.trim().slice(0, 80) : `${content.kind === 'pullRequest' ? 'PR' : 'Issue'} #${content.number}`
    const url = externalUrl ?? ''
    const prompt = `Work on this GitHub ${content.kind === 'pullRequest' ? 'pull request' : 'issue'}: ${name}\n\n${url}${typeof content.body === 'string' && content.body.trim() ? `\n\n${content.body}` : ''}`
    const existingLink = linkedWorkspace(item, state, targetProject, createdWorkspaceLinks)
    const workspaceAction = existingLink && !forceNew ? 'resume' : 'start'
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
          setActionHelp({ item, text: `Workspace ${linkedName} is available, but Tasks could not refresh its link: ${errorMessage(error)}`, externalUrl, error: true })
        }
      } else {
        setActionHelp({ item, text: 'The workspace action returned an unrecognized result. No success was reported.', externalUrl, error: true })
      }
    } catch (error) {
      setActionHelp({ item, text: `Could not start work: ${errorMessage(error)}`, externalUrl, error: true })
    } finally {
      clearBusy()
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
      setActionHelp({ item, text: `Could not add this repository: ${errorMessage(error)}`, externalUrl: project ? projectItemUrl(item, project) : null, offerAddRepo: true, error: true })
    } finally {
      setAddingRepo(false)
    }
  }



  async function openLink(url: string | null) {
    if (!url || !/^https:\/\//i.test(url)) return
    try {
      await context.executeCommand(linkCommand, { url })
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

  function renderAuthHelp(error: unknown, scope: ProjectErrorScope) {
    const host = browseErrorHost ?? (project ? sourceIdentity(project) : hostFromError(error)) ?? 'github.com'
    const enterprise = host.toLowerCase() !== 'github.com'
    const option = enterprise ? ` --hostname ${host}` : ''
    const command = `gh auth refresh${option} -s project -s read:org -s repo`
    const login = `gh auth login${option}`
    return <div className="quirky-tasks-projects__error-card">
      <InlineError message={projectErrorText(error, scope)} action={{ label: 'Reload', onAction: () => { void refreshProject() } }} />
      <section className="quirky-tasks-projects__auth-help">
        <span>Projects need the <code>project</code>, <code>read:org</code>, and <code>repo</code> scopes on the account used by the hosting plugin.</span>
        <TextField label="Refresh scopes" aria-label="GitHub project scope refresh command" readOnly value={command} className="quirky-tasks-projects__command" onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" onClick={() => void copyAuthCommand(command)}>Copy refresh command</Button>
        <TextField label="Sign in" aria-label="GitHub login command" readOnly value={login} className="quirky-tasks-projects__command" onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" onClick={() => void copyAuthCommand(login)}>Copy login command</Button>
        <span>If <code>GH_TOKEN</code>, <code>GITHUB_TOKEN</code>, <code>GH_ENTERPRISE_TOKEN</code>, or <code>GITHUB_ENTERPRISE_TOKEN</code> is exported, it overrides the stored <code>gh</code> login. Remove it from the environment before refreshing scopes, then restart Quirky.</span>
        <span>If your organization enforces SAML SSO, authorize the token for that organization after login.</span>
        <div className="quirky-tasks-projects__actions"><Button type="button" onClick={() => void openLink(DOCS_URL)}>Docs</Button></div>
      </section>
    </div>
  }

  function renderProjectError(error: unknown, scope: ProjectErrorScope = 'load') {
    const reason = errorReason(error)
    if (reason === 'auth_required' || reason === 'scope_missing') return renderAuthHelp(error, scope)
    return <ProjectLoadError
      message={projectErrorText(error, scope)}
      onOpen={() => void openLink(project ? projectUrl(project) : null)}
      onRetry={() => void (scope === 'browse' ? browseProjects(true) : refreshProject())}
    />
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
      <Button type="button" onClick={() => void controlProjects({ action: 'picker', open: !pickerOpen })} aria-expanded={pickerOpen}>Choose a project</Button>
      <span className="ui-text-muted">Projects v2</span>
    </div>
    <EmptyState message="Choose a project to get started." />
    {pickerOpen && renderPicker()}
    {browseError !== null && !pickerOpen && renderProjectError(browseError, 'browse')}
  </main>

  const columns = tableColumns(tableFields, deviceColumns.hidden)
  const sortedItems = sortItems(tableItems, tableFields, sort, currentView ?? undefined)
  const tableGroups = currentView ? groupProjectItems(sortedItems, currentView.groupByFields?.[0] ?? null) : []

  function renderPicker() {
    return <Dialog open={pickerOpen} title="Choose a project" onClose={() => setPickerOpen(false)} closeOnBackdrop={false}>
      <div className="quirky-tasks-project-picker">
        <TextField label="Search projects" placeholder="Search projects" value={pickerSearch} onChange={(event) => setPickerSearch(event.currentTarget.value)} />
        <div className="quirky-tasks-projects__actions">
          <Button type="button" onClick={() => void browseProjects(false)} disabled={pickerBusy}>Browse all</Button>
          <Button type="button" onClick={() => void browseProjects(true)} disabled={pickerBusy}>Reload browse</Button>
        </div>
        {browseLoading && <div role="status"><NoticeLine>Loading projects…</NoticeLine></div>}
        {pinnedProjects.length > 0 && <ProjectChoiceSection title="Pinned" projects={pinnedProjects} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
        {recentProjects.length > 0 && <ProjectChoiceSection title="Recent" projects={recentProjects} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
        {browseOpen && <ProjectChoiceSection title="Browse all" projects={pickerCandidates} current={project} onChoose={(target) => void chooseProject('select', target)} onPin={togglePin} pinnedIdentities={pinnedIdentities} />}
        {browseOpen && pickerCandidates.length === 0 && !pickerBusy && !browseError && <div role="status"><EmptyState message={pickerQuery ? 'No projects match this search.' : 'No additional projects were found. Add a project URL or owner/number below.'} /></div>}
        {partialFailures.length > 0 && <div role="status"><NoticeLine>Some organization projects could not be listed. Paste a project URL below to reach missing ones.</NoticeLine></div>}
        {browseError !== null && renderProjectError(browseError, 'browse')}
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
    const busy = busyItems.has(busyKey)
    return <div className="quirky-tasks-projects__item-actions">
      <Button type="button" onClick={(event) => { event.stopPropagation(); void openLink(projectItemUrl(item, project)) }} aria-label={`Open ${item.content?.kind ?? 'project item'} on GitHub`}>GitHub</Button>
      <Button type="button" disabled={busy || isRestricted(item) || isDraft(item)} onClick={(event) => { event.stopPropagation(); void startItem(item) }} aria-label={`${linked ? 'Resume' : 'Start work on'} ${String(item.content?.title ?? 'project item')}`}>{busy ? 'Starting…' : linked ? 'Resume' : 'Start work'}</Button>
      {linked && <Button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void startItem(item, true) }} aria-label={`Start new workspace for ${String(item.content?.title ?? 'project item')}`}>Start new</Button>}
    </div>
  }

  return <main className="quirky-tasks-projects">
    <div className="quirky-tasks-projects__toolbar">
      <Button type="button" onClick={() => void controlProjects({ action: 'picker', open: !pickerOpen })} aria-expanded={pickerOpen}>{project.title || `${project.owner}/${project.number}`}</Button>
      <span className="ui-text-muted">{project.ownerType} · {sourceIdentity(project)}</span>
      <Button type="button" className="quirky-tasks-projects__toolbar-spacer" aria-label="Open view in GitHub" onClick={() => void openLink(projectViewUrl(project, selectedView))}>Open view in GitHub</Button>
      <Button type="button" aria-label={selectedPin ? 'Remove project pin' : 'Pin project'} onClick={() => void togglePin(project)}>{selectedPin ? 'Unpin' : 'Pin'}</Button>
      <Button type="button" onClick={() => void refreshProject()} disabled={loadingTable || loadingViews} aria-label={loadingTable ? 'Refreshing project' : 'Refresh project'}>{loadingTable ? 'Refreshing…' : 'Refresh'}</Button>
    </div>
    {pickerOpen && renderPicker()}
    {loadingViews && views.length === 0 && <div role="status"><NoticeLine>Loading project views…</NoticeLine></div>}
    {openingItem && <div role="status"><NoticeLine>Opening {openingItem}…</NoticeLine></div>}
    <Tabs
      label="Project views"
      items={views.map((view) => {
        const supported = supportedLayout(view.layout)
        return { id: view.id, label: `${layoutLabel(view.layout)} · ${view.name ?? 'View'}${supported ? '' : ' (Unsupported)'}`, disabled: !supported }
      })}
      value={activeViewId}
      onChange={(id) => void changeView(id)}
    />
    {views.length === 0 && !loadingViews && mainError === null && <EmptyState message="No views found." />}
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
      <Button type="button" onClick={() => void controlProjects({ action: 'column-panel', open: !columnsOpen })} aria-expanded={columnsOpen}>Configure columns</Button>
    </div>}
    {columnsOpen && selectedView && <ColumnConfigurator fields={tableFields} hidden={deviceColumns.hidden} widths={deviceColumns.widths} onChange={(id, visible) => void controlProjects({ action: 'column', fieldId: id, visible })} onWidth={(id, width) => void controlProjects({ action: 'column', fieldId: id, width })} />}
    {mainError !== null && table !== null && !['auth_required', 'scope_missing'].includes(errorReason(mainError)) && <div role="status"><NoticeLine actions={[{ label: 'Retry', onAction: () => { void refreshProject() } }]}>Couldn't load the latest items. Showing the last loaded items. {errorMessage(mainError)}</NoticeLine></div>}
    {mainError !== null && (table === null || ['auth_required', 'scope_missing'].includes(errorReason(mainError))) && renderProjectError(mainError, 'load')}
    {writeError !== null && renderProjectError(writeError, 'write')}
    {chooseView && <section className="quirky-tasks-projects__choose-view">
      <div className="quirky-tasks-projects__choose-view-heading"><Button type="button" onClick={() => void controlProjects({ action: 'back-to-picker' })}>← Back</Button><strong>Choose a view</strong></div>
      {loadingViews ? <div role="status"><NoticeLine>Loading project views…</NoticeLine></div> : views.length > 0 && <div className="quirky-tasks-projects__view-choices">{views.map((view) => <Button key={view.id} type="button" disabled={!supportedLayout(view.layout)} title={supportedLayout(view.layout) ? undefined : `Quirky does not support ${String(view.layout ?? 'unknown')} views yet.`} onClick={() => void changeView(view.id)}>{view.name} · {layoutLabel(view.layout)}{!supportedLayout(view.layout) ? ' · Unsupported' : ''}</Button>)}</div>}
    </section>}
    {loadingTable && table === null && <div role="status" aria-label="Loading project view" className="quirky-tasks-projects__skeletons"><NoticeLine>Loading project items…</NoticeLine>{Array.from({ length: 6 }, (_, index) => <div key={index} className="quirky-tasks-projects__skeleton" />)}</div>}
    {!chooseView && !loadingViews && !mainError && selectedView && table !== null && tableItems.length === 0 && <div role="status" className="quirky-tasks-projects__empty-state">
      <EmptyState message={activeQuery || viewFilter ? 'No items match this view’s filter.' : 'This view has no items yet. Recently added items can take a while to appear.'} />
    </div>}
    {!chooseView && table !== null && tableItems.length > 0 && <div className="quirky-tasks-projects__table-scroll">
      {layout === 'TABLE' && <ProjectTable items={sortedItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={requestGroupToggle} sort={sort} onSort={requestSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} inlineCell={inlineEditorFor} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout === 'BOARD' && <ProjectBoard items={tableItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={requestGroupToggle} sort={sort} onSort={requestSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} inlineCell={inlineEditorFor} onMove={editProjectField} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout === 'ROADMAP' && <ProjectRoadmap model={roadmapModel} items={tableItems} fields={tableFields} columns={columns} widths={deviceColumns.widths} issueTypesByItem={issueTypesByItem} onLoadIssueTypes={loadIssueTypes} view={selectedView ?? undefined} groups={tableGroups} collapsed={collapsedGroups} onToggleGroup={requestGroupToggle} sort={sort} onSort={requestSort} onFieldEdit={editProjectField} onCollectionEdit={editIssueCollection} onIssueTypeEdit={updateIssueType} inlineCell={inlineEditorFor} zoom={zoom} onZoom={requestRoadmapZoom} onToday={requestToday} scroller={roadmapScroller} onOpen={openItem} actions={openItemActions} project={project} />}
      {layout !== 'TABLE' && layout !== 'BOARD' && layout !== 'ROADMAP' && <div role="alert">{renderProjectError(new Error('unsupported_layout'))}</div>}
    </div>}
    {!loadingTable && !loadingViews && table === null && !mainError && !chooseView && <EmptyState message="Choose a project view to load its items." />}
    {actionHelp && <Dialog
      open
      title="GitHub project item guidance"
      onClose={() => setActionHelp(null)}
      closeOnBackdrop={false}
      actions={<Button type="button" onClick={() => void openLink(actionHelp.externalUrl)} disabled={!actionHelp.externalUrl}>Open in GitHub</Button>}
    >
      <div className="quirky-tasks-project-guidance">
        {actionHelp.error ? <InlineError message={actionHelp.text} /> : <p>{actionHelp.text}</p>}
        {actionHelp.offerAddRepo && <form onSubmit={(event) => { event.preventDefault(); void addLocalRepository(actionHelp.item) }} className="quirky-tasks-project-guidance__form">
          <TextField label="Local repository path" id="local-project-repo-path" value={addRepoPath} onChange={(event) => setAddRepoPath(event.currentTarget.value)} placeholder="/path/to/local/clone" />
          <Button type="submit" disabled={addingRepo || addRepoPath.trim().length === 0}>{addingRepo ? 'Adding…' : 'Add repo'}</Button>
        </form>}
      </div>
    </Dialog>}
    {itemPreview && <ProjectItemPreview item={itemPreview} url={projectItemUrl(itemPreview, project)} guidance={itemPreviewGuidance} details={previewDetails} loading={previewLoading} onClose={() => { previewGeneration.current += 1; setItemPreview(null); setItemPreviewGuidance(''); setPreviewDetails(null); setPreviewLoading(false); setActionHelp(null) }} onOpen={() => void openLink(projectItemUrl(itemPreview, project))} />}
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

function ProjectLoadError(props: { message: string; onOpen(): void; onRetry(): void }) {
  return <section className="quirky-tasks-projects__error-card"><InlineError message={props.message} action={{ label: 'Retry', onAction: props.onRetry }} /><Button type="button" onClick={props.onOpen}>Open in GitHub</Button></section>
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
      {props.guidance && <div role="status"><NoticeLine>{props.guidance}</NoticeLine></div>}
      {props.loading && <div role="status"><NoticeLine>Loading GitHub item details…</NoticeLine></div>}
      <h2 className="quirky-tasks-project-preview__title">{String(content.title ?? (isRestricted(props.item) ? 'Restricted item' : 'Untitled item'))}</h2>
      <p className="quirky-tasks-project-preview__meta">{String(content.repository ?? 'Repository unavailable')} · {kind} {content.number ? `#${content.number}` : ''}{content.state ? ` · ${String(content.state)}` : ''}{content.author ? ` · @${String(content.author)}` : ''}</p>
      {typeof content.headRefName === 'string' && content.headRefName.length > 0 && <p className="quirky-tasks-project-preview__meta">{String(content.baseRefName ?? '')} ← {content.headRefName}</p>}
      {labels.length > 0 && <p className="quirky-tasks-project-preview__meta">Labels: {labels.join(', ')}</p>}
      {assignees.length > 0 && <p className="quirky-tasks-project-preview__meta">Assignees: {assignees.join(', ')}</p>}
      {body && <article aria-label="Description"><Markdown source={body} /></article>}
      {partialFailures.length > 0 && <div role="status"><NoticeLine>Some GitHub details are unavailable: {partialFailures.join('; ')}</NoticeLine></div>}
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
  inlineCell(item: ProjectItem, field: ProjectField): InlineEditorState
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
        {groupField && <tr><th colSpan={props.columns.length + 1} className="quirky-tasks-project-table__group"><Button type="button" aria-expanded={!isCollapsed} className="quirky-tasks-project-table__group-toggle" onClick={() => props.onToggleGroup(group.key)}>{isCollapsed ? '▸' : '▾'} {group.label} · {group.items.length}{group.range ? ` · ${group.range}` : ''}{group.current ? ' · Current' : ''}</Button></th></tr>}
        {!isCollapsed && groupItems.map((item) => <tr key={item.id} onDoubleClick={() => props.onOpen(item)} className="quirky-tasks-project-table__row">
          {props.columns.map((column, index) => <td key={column.id} className={index < 2 ? 'quirky-tasks-project-table__cell quirky-tasks-project-table__sticky' : 'quirky-tasks-project-table__cell'} style={stickyStyle(index)}>
            {column.kind === 'title'
              ? <Button type="button" className="quirky-tasks-project-table__title" onClick={() => props.onOpen(item)} title={String(item.content?.title ?? '')}>{String(item.content?.title ?? (isRestricted(item) ? 'Restricted item' : 'Untitled'))}</Button>
              : column.kind === 'type'
                ? item.content?.kind === 'issue'
                  ? <div className="quirky-tasks-projects__type-cell"><span>Issue</span>{!hasIssueTypeField && <ProjectFieldCell item={item} field={ISSUE_TYPE_FIELD} project={props.project} issueTypes={props.issueTypesByItem[item.id]} onLoadIssueTypes={props.onLoadIssueTypes} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} inlineCell={props.inlineCell} />}</div>
                  : <span>{String(item.content?.kind === 'pullRequest' ? 'Pull request' : item.content?.kind === 'draft' ? 'Draft' : 'Restricted')}</span>
                : <ProjectFieldCell item={item} field={column.field!} project={props.project} issueTypes={props.issueTypesByItem[item.id]} onLoadIssueTypes={props.onLoadIssueTypes} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} inlineCell={props.inlineCell} />}
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
  inlineCell(item: ProjectItem, field: ProjectField): InlineEditorState
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
    const editor = props.inlineCell(props.item, props.field)
    return <InlineText value={values} ariaLabel={`${props.field.name ?? propName} for issue ${String(props.item.content?.number ?? '')}`} placeholder="Comma-separated values" {...editor} />
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
    const editor = props.inlineCell(props.item, props.field)
    return <InlineText value={rawValue} ariaLabel={props.field.name ?? 'Project field'} type={type === 'NUMBER' ? 'number' : type === 'DATE' ? 'date' : 'text'} {...editor} />
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

function InlineText(props: { value: string; ariaLabel: string; editing: boolean; draft: string; saving: boolean; error: string; onBegin(): void; onDraft(value: string): void; onSave(): void; onCancel(): void; onKeyDown(event: KeyboardEvent<HTMLInputElement>): void; type?: string; placeholder?: string }) {
  if (!props.editing) return <Button type="button" className="quirky-tasks-projects__inline-trigger" aria-label={`Edit ${props.ariaLabel}`} onClick={props.onBegin} title={props.value}>{props.value || '—'}</Button>
  return <div className="quirky-tasks-projects__inline-editor">
    <input autoFocus type={props.type ?? 'text'} aria-label={props.ariaLabel} placeholder={props.placeholder} value={props.draft} className="quirky-tasks-control quirky-tasks-projects__inline-input" onChange={(event) => props.onDraft(event.currentTarget.value)} onKeyDown={props.onKeyDown} />
    <IconButton label={`Save ${props.ariaLabel}`} disabled={props.saving} onClick={props.onSave}>{props.saving ? '…' : '✓'}</IconButton>
    <IconButton label={`Cancel ${props.ariaLabel} edit`} onClick={props.onCancel}>×</IconButton>
    {props.error && <div className="quirky-tasks-projects__field-error"><InlineError message={props.error} /></div>}
  </div>
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
  inlineCell(item: ProjectItem, field: ProjectField): InlineEditorState
  onMove(item: ProjectItem, field: ProjectField, value: unknown, clear: boolean): Promise<void>
  onOpen(item: ProjectItem): void
  actions(item: ProjectItem): ReactNode
  project: ProjectTarget
}) {
  const group = props.view ? boardGroupField(props.view, props.fields) : null
  if (!group) return <section className="quirky-tasks-project-board__fallback"><div role="status">This board view has no single-select or iteration field to group by, so Quirky is listing items instead.</div><ProjectTable items={props.items} fields={props.fields} columns={props.columns} widths={props.widths} issueTypesByItem={props.issueTypesByItem} onLoadIssueTypes={props.onLoadIssueTypes} view={props.view} groups={props.groups} collapsed={props.collapsed} onToggleGroup={props.onToggleGroup} sort={props.sort} onSort={props.onSort} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} inlineCell={props.inlineCell} onOpen={props.onOpen} actions={props.actions} project={props.project} /></section>
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
  inlineCell(item: ProjectItem, field: ProjectField): InlineEditorState
  zoom: RoadmapZoom
  onZoom(value: RoadmapZoom): void
  onToday(): void
  scroller: RefObject<HTMLDivElement | null>
  onOpen(item: ProjectItem): void
  actions(item: ProjectItem): ReactNode
  project: ProjectTarget
}) {
  const model = props.model
  if (!model.placementFieldName) return <section className="quirky-tasks-project-roadmap__fallback"><div role="status">This roadmap view has no date or iteration field to place items on, so Quirky is listing items instead.</div><ProjectTable items={props.items} fields={props.fields} columns={props.columns} widths={props.widths} issueTypesByItem={props.issueTypesByItem} onLoadIssueTypes={props.onLoadIssueTypes} view={props.view} groups={props.groups} collapsed={props.collapsed} onToggleGroup={props.onToggleGroup} sort={props.sort} onSort={props.onSort} onFieldEdit={props.onFieldEdit} onCollectionEdit={props.onCollectionEdit} onIssueTypeEdit={props.onIssueTypeEdit} inlineCell={props.inlineCell} onOpen={props.onOpen} actions={props.actions} project={props.project} /></section>
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
