import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Badge, Button, ContextMenuList, EmptyState, FormRow, IconButton, StatusDot, Tabs, TextField, type ContextMenuItem } from '@quirky/ui'
import type { AutomationDefinition, AutomationRun, AutomationRunsPage } from '../../types'
import type { AutomationOwner, AutomationTargetResolution } from '../../dispatch-contract'
import { describeAutomationSchedule } from '../../schedule'
import { AUTOMATIONS_SETTINGS_VIEW, type AutomationEditorData, type AutomationNavigation, type AutomationSurfaceProps, type ExternalJob, type ExternalManager } from '../ui-contracts'
import { SafeMarkdown } from './SafeMarkdown'
import {
  appendRunPage,
  canRerun,
  dashboardStatusBucket,
  filterListRows,
  foldedOccurrences,
  isSearchTooLong,
  runContent,
  sortListRows,
  summarizeDashboardRuns,
  summarizeUsage,
  toggleListSort,
  sameAutomationOwner,
  type AutomationListRow,
  type DashboardMetrics,
  type UsageSummary,
  type ListSort,
  type SortDirection
} from './list-model'

const API = 'quirky.automations/'
const ASK_BEFORE_DELETE_SETTING = 'setting:quirky.automations/ask-before-delete'
const RUN_PAGE_SIZE = 25
const RUN_RENDER_LIMIT = 100
const DASHBOARD_RENDER_LIMIT = 100
const AUTOMATION_PAGE_VIEW = 'view:quirky.session/worktree'
const RERUN_PENDING_MS = 800



type FetchState = {
  nativeLoading: boolean
  nativeLoaded: boolean
  definitions: AutomationDefinition[]
  nativeError: string | null
  editorData: AutomationEditorData | null
  editorError: string | null
  externalLoading: boolean
  externalLoaded: boolean
  managers: ExternalManager[]
  externalError: string | null
  lastRuns: Record<string, AutomationRun | null>
  lastRunsLoaded: boolean
  lastRunErrors: string[]
  dashboardRuns: AutomationRun[]
  dashboardLoaded: boolean
  dashboardLoading: boolean
  dashboardErrors: string[]
}

const INITIAL_FETCH_STATE: FetchState = {
  nativeLoading: true, nativeLoaded: false, definitions: [], nativeError: null,
  editorData: null, editorError: null, externalLoading: true, externalLoaded: false, managers: [], externalError: null,
  lastRuns: {}, lastRunsLoaded: false, lastRunErrors: [], dashboardRuns: [], dashboardLoaded: false, dashboardLoading: false, dashboardErrors: []
}

type NativeDeleteDialog = { kind: 'native'; definition: AutomationDefinition; skipNextTime: boolean; error: string | null }
type ExternalDeleteDialog = { kind: 'external'; manager: ExternalManager; job: ExternalJob; error: string | null }
type DeleteDialog = NativeDeleteDialog | ExternalDeleteDialog

type TargetProbe = { available: boolean; error: string | null }
type HistoryState = { automationId: string | null; runs: AutomationRun[]; cursor: string | null; loaded: boolean; loading: boolean; error: string | null }
type DetailUsageState = { automationId: string | null; runs: AutomationRun[]; loaded: boolean; loading: boolean; error: string | null }
type ReadAllRunsResult = { runs: AutomationRun[]; error: string | null }
type RunDetailState = { runId: string | null; run: AutomationRun | null; loading: boolean; error: string | null }
type OpenTarget = { kind: 'session' | 'workspace'; workspaceId: string; sessionId: string | null }
type ListReportProps = AutomationSurfaceProps & { report?: (state: unknown) => void }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function reportText(value: string | null): string | null {
  return value === null ? null : value.length > 500 ? `${value.slice(0, 500)}…` : value
}

function reportIds(values: readonly string[]): string[] {
  return values.slice(0, 100).map((value) => value.length > 256 ? `${value.slice(0, 256)}…` : value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function callApi<T>(context: UiPluginContext, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return await context.call(method.startsWith('setting.') ? method : `${API}${method}`, params) as T
}

function validateRunPage(value: unknown): AutomationRunsPage {
  if (!isRecord(value) || !Array.isArray(value.runs) || !(value.nextCursor === null || typeof value.nextCursor === 'string')) {
    throw new Error('Run history returned an invalid page.')
  }
  return value as unknown as AutomationRunsPage
}

async function readRunPage(context: UiPluginContext, automationId: string | null, limit: number, cursor: string | null): Promise<AutomationRunsPage> {
  const page = await callApi<unknown>(context, 'runs', {
    ...(automationId === null ? {} : { automationId }), limit, ...(cursor === null ? {} : { cursor })
  })
  return validateRunPage(page)
}

async function readAllRuns(context: UiPluginContext, automationId: string | null): Promise<ReadAllRunsResult> {
  let runs: AutomationRun[] = []
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  do {
    let page: AutomationRunsPage
    try {
      page = await readRunPage(context, automationId, 100, cursor)
    } catch (error) {
      return { runs, error: errorMessage(error) }
    }
    runs = appendRunPage(runs, page).runs
    if (page.nextCursor === null) return { runs, error: null }
    if (seenCursors.has(page.nextCursor)) return { runs, error: 'Run history repeated a paging cursor.' }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  } while (true)
}

function expectedOwner(definition: AutomationDefinition): Record<string, unknown> {
  return definition.owner && typeof definition.owner === 'object' ? { expectedOwner: definition.owner } : {}
}

function assertOwnerUnchanged(displayed: AutomationDefinition, fresh: AutomationDefinition): void {
  if (displayed.id !== fresh.id || !sameAutomationOwner(displayed.owner, fresh.owner)) {
    throw new Error('Automation ownership changed since this view loaded. Refresh before acting.')
  }
}

async function freshDefinition(context: UiPluginContext, id: string): Promise<AutomationDefinition> {
  const definition = await callApi<AutomationDefinition>(context, 'show', { id })
  if (!definition || definition.id !== id) throw new Error('The automation could not be refreshed from its owner.')
  return definition
}

async function checkTarget(context: UiPluginContext, id: string): Promise<TargetProbe> {
  try {
    const result = await callApi<AutomationTargetResolution>(context, 'target', { id })
    if (!result || result.available !== true) return { available: false, error: result && 'error' in result ? result.error : 'The automation target is unavailable.' }
    if (!result.target || result.target.owner?.kind !== 'local') {
      return { available: false, error: 'Only locally owned automation targets are available from this client.' }
    }
    return { available: true, error: null }
  } catch (error) {
    return { available: false, error: errorMessage(error) }
  }
}

function hostLabel(data: AutomationEditorData | null, hostId: string | null | undefined): string {
  if (!hostId) return 'Unknown host'
  return data?.hosts.find((host) => host.id === hostId)?.label ?? (hostId === 'local' ? 'This Mac' : hostId)
}

function projectLabel(data: AutomationEditorData | null, projectId: string): string {
  return data?.projects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
}

function agentLabel(data: AutomationEditorData | null, agentId: string | null): string {
  if (!agentId) return 'External'
  return data?.agents.find((agent) => agent.id === agentId)?.label ?? (agentId === 'claude' ? 'Claude' : agentId === 'codex' ? 'Codex' : agentId)
}

function parseExternalDate(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function buildListRows(data: FetchState): AutomationListRow[] {
  const nativeRows = data.definitions.map<AutomationListRow>((definition) => {
    const project = data.editorData?.projects.find((candidate) => candidate.id === definition.projectId)
    const hostId = project?.hostId ?? 'unknown'
    const latest = data.lastRuns[definition.id] ?? null
    return {
      key: `native:${definition.id}`, id: definition.id, kind: 'native' as const,
      name: definition.name, projectName: project?.name ?? 'Unknown project', hostId, hostName: hostLabel(data.editorData, hostId),
      prompt: definition.prompt, agentId: definition.agentId, agentName: agentLabel(data.editorData, definition.agentId), enabled: definition.enabled,
      lastRunAt: latest?.scheduledFor ?? definition.lastRunAt ?? null, lastStatus: latest?.status ?? null,
      lastRunRead: data.nativeError !== null || data.lastRunErrors.includes(definition.id) ? 'unavailable' : data.lastRunsLoaded ? 'available' : 'loading'
    }
  })
  const externalRows = data.managers.flatMap((manager) => manager.jobs.map<AutomationListRow>((job) => ({
    key: `external:${manager.id}:${job.id}`, id: job.id, kind: 'external' as const,
    name: job.name || job.id, projectName: 'OpenClaw', hostId: manager.hostId || 'unknown', hostName: manager.label || 'Unknown host',
    prompt: job.promptPreview, agentId: null, agentName: null, enabled: job.enabled, lastRunAt: parseExternalDate(job.lastRunAt), lastStatus: job.lastStatus,
    lastRunRead: data.externalError !== null || manager.status === 'unavailable' ? 'unavailable' : 'available'
  })))
  return [...nativeRows, ...externalRows]
}

function formatDate(value: number | null | undefined, timezone?: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable'
  const date = new Date(value)
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

function formatRelative(value: number | null, now: number): string {
  if (value === null) return 'Never ran'
  const delta = value - now
  if (delta === 0) return 'now'
  const absolute = Math.abs(delta)
  let unit: Intl.RelativeTimeFormatUnit
  let divisor: number
  if (absolute < 3_600_000) {
    unit = 'minute'
    divisor = 60_000
  } else if (absolute < 86_400_000) {
    unit = 'hour'
    divisor = 3_600_000
  } else {
    unit = 'day'
    divisor = 86_400_000
  }
  const rounded = Math.max(1, Math.round(absolute / divisor))
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.sign(delta) * rounded, unit)
}

function formatNextRun(value: number | null, enabled: boolean, timezone?: string): string {
  if (!enabled) return 'Paused'
  if (value === null) return 'Unavailable'
  return `${formatDate(value, timezone)} (${formatRelative(value, Date.now())})`
}

function formatCost(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function usageLabel(runs: readonly AutomationRun[]): string {
  const summary = summarizeUsage(runs)
  if (summary.kind === 'no-runs') return 'No run usage yet'
  if (summary.kind === 'not-yet') return 'No run usage yet'
  if (summary.kind === 'unavailable') return 'Usage unavailable'
  const pieces = [
    summary.cost === null ? null : `${formatCost(summary.cost)} est.${summary.costRuns < summary.totalRuns ? ` (${summary.costRuns}/${summary.totalRuns} runs)` : ''}`,
    summary.tokens === null ? null : `${formatTokens(summary.tokens)} tokens${summary.partialTokenRuns > 0 ? ' (partial)' : ''}${summary.tokenRuns < summary.totalRuns ? ` (${summary.tokenRuns}/${summary.totalRuns} runs)` : ''}`
  ].filter((piece): piece is string => piece !== null)
  return pieces.join(' · ')
}
function usageCostLabel(summary: UsageSummary): string {
  if (summary.kind === 'known' && summary.cost !== null) {
    return `${formatCost(summary.cost)}${summary.costRuns < summary.totalRuns ? ` (${summary.costRuns}/${summary.totalRuns} runs)` : ''}`
  }
  return summary.kind === 'no-runs' || summary.kind === 'not-yet' ? 'Not available yet' : 'Unavailable'
}

function usageTokensLabel(summary: UsageSummary): string {
  if (summary.kind === 'known' && summary.tokens !== null) {
    return `${formatTokens(summary.tokens)} tokens${summary.partialTokenRuns > 0 ? ' (partial)' : ''}${summary.tokenRuns < summary.totalRuns ? ` (${summary.tokenRuns}/${summary.totalRuns} runs)` : ''}`
  }
  return summary.kind === 'no-runs' || summary.kind === 'not-yet' ? 'Not available yet' : 'Unavailable'
}

function usageCoverageLabel(summary: UsageSummary): string {
  if (summary.kind === 'known') {
    return `Spend data ${summary.costRuns}/${summary.totalRuns} · token data ${summary.tokenRuns}/${summary.totalRuns}${summary.partialTokenRuns > 0 ? ' · partial token totals' : ''}`
  }
  if (summary.kind === 'no-runs') return 'No runs'
  if (summary.kind === 'not-yet') return 'No run usage yet'
  return 'Unavailable'
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Queued', dispatching: 'Starting', dispatched: 'Launched', completed: 'Done',
    skipped_precheck: 'Precheck skipped', skipped_missed: 'Skipped', skipped_unavailable: 'Unavailable',
    skipped_needs_interactive_auth: 'Needs credentials', dispatch_failed: 'Failed'
  }
  return labels[status] ?? status
}

function AutomationRunStatus({ status }: { status: string }) {
  const bucket = dashboardStatusBucket(status)
  const tone = bucket === 'successful' ? 'working' : bucket === 'failed' ? 'failing' : bucket === 'progress' ? 'accent' : bucket === 'skipped' ? 'needs-you' : 'neutral'
  const indicator = bucket === 'successful' ? 'done' : bucket === 'failed' ? 'failing' : bucket === 'progress' ? 'working' : bucket === 'skipped' ? 'needs-you' : 'idle'
  return <span className="auto-run-status"><StatusDot status={indicator} /><Badge tone={tone}>{statusLabel(status)}</Badge></span>
}


function detailWorkspace(definition: AutomationDefinition, data: AutomationEditorData | null): string {
  if (definition.workspaceMode === 'new_per_run') return `Create from ${definition.baseBranch || 'Project default'}`
  return data?.workspaces.find((workspace) => workspace.id === definition.workspaceId)?.name ?? definition.workspaceId ?? 'Workspace unavailable'
}

function runWorkspace(run: AutomationRun): string {
  return run.workspaceDisplayName || run.workspaceId || 'No workspace'
}

function launchSummary(run: AutomationRun, data: AutomationEditorData | null): string {
  const settings = run.launchSettings
  if (!settings) return ''
  if (typeof settings.summary === 'string' && settings.summary.trim()) return settings.summary
  const agentId = typeof settings.agent === 'string' ? settings.agent : null
  return agentId ? agentLabel(data, agentId) : ''
}

function externalStatusLabel(status: string | null): string {
  if (!status) return 'No run yet'
  if (status === 'completed') return 'Done'
  if (status === 'dispatch_failed' || status === 'failed') return 'Failed'
  if (status.startsWith('skipped_')) return 'Skipped'
  return statusLabel(status)
}
function canManageExternal(manager: ExternalManager): boolean {
  return manager.id === 'openclaw:local' && manager.provider === 'openclaw' && manager.hostId === 'local'
    && manager.status === 'ready' && manager.canManage && manager.owner.provider === 'openclaw'
    && manager.owner.hostId === 'local' && manager.owner.generation.trim() !== ''
}

function normalizeManagers(value: unknown): ExternalManager[] {
  if (!isRecord(value) || !Array.isArray(value.managers)) throw new Error('OpenClaw returned an invalid manager list.')
  return value.managers.map((candidate, managerIndex) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.provider !== 'string'
      || typeof candidate.hostId !== 'string' || typeof candidate.label !== 'string'
      || (candidate.status !== 'ready' && candidate.status !== 'unavailable') || typeof candidate.canManage !== 'boolean'
      || !(candidate.error === null || typeof candidate.error === 'string') || !isRecord(candidate.owner)
      || typeof candidate.owner.provider !== 'string' || typeof candidate.owner.hostId !== 'string' || typeof candidate.owner.generation !== 'string'
      || !Array.isArray(candidate.jobs)) {
      throw new Error(`OpenClaw manager ${managerIndex + 1} returned invalid data.`)
    }
    const jobs = candidate.jobs.map((job, jobIndex) => {
      if (!isRecord(job) || typeof job.id !== 'string' || typeof job.name !== 'string' || typeof job.schedule !== 'string'
        || typeof job.enabled !== 'boolean' || typeof job.state !== 'string' || typeof job.promptPreview !== 'string'
        || !(job.nextRunAt === null || typeof job.nextRunAt === 'string') || !(job.lastRunAt === null || typeof job.lastRunAt === 'string')
        || !(job.lastStatus === null || typeof job.lastStatus === 'string') || !(job.lastError === null || typeof job.lastError === 'string')
        || !(job.runCount === null || typeof job.runCount === 'number') || !Array.isArray(job.runs)) {
        throw new Error(`OpenClaw job ${jobIndex + 1} in ${candidate.label} returned invalid data.`)
      }
      return job
    })
    return { ...candidate, jobs } as unknown as ExternalManager
  })
}

function filterDashboardRows(runs: readonly AutomationRun[], definitions: readonly AutomationDefinition[], data: AutomationEditorData | null, navigation: AutomationNavigation): { runs: AutomationRun[]; tooLong: boolean } {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  const tooLong = isSearchTooLong(navigation.runQuery)
  const query = tooLong ? '' : navigation.runQuery.trim().toLocaleLowerCase()
  return {
    tooLong,
    runs: runs.filter((run) => {
      const definition = definitionsById.get(run.automationId)
      const projectId = typeof run.runContext?.projectId === 'string' ? run.runContext.projectId : definition?.projectId
      const project = data?.projects.find((candidate) => candidate.id === projectId)
      const hostId = project?.hostId ?? (typeof run.runContext?.hostId === 'string' ? run.runContext.hostId : 'unknown')
      if (navigation.host !== 'all' && hostId !== navigation.host) return false
      if (navigation.runStatus !== 'all' && dashboardStatusBucket(run.status) !== navigation.runStatus) return false
      if (!query) return true
      return [definition?.name ?? '', run.title, run.automationId, project?.name ?? ''].some((value) => value.toLocaleLowerCase().includes(query))
    })
  }
}

function getAutomationHostId(definition: AutomationDefinition | null, data: AutomationEditorData | null): string | null {
  if (!definition) return null
  return data?.projects.find((project) => project.id === definition.projectId)?.hostId ?? null
}

function stopKeyboardPropagation(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === 'Escape') event.stopPropagation()
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

async function getRunTarget(context: UiPluginContext, run: AutomationRun, owner: AutomationOwner): Promise<OpenTarget | null> {
  if (owner.kind !== 'local' || run.workspaceId === null || run.workspaceId === '') return null
  const [workspaceResult, sessionResult] = await Promise.allSettled([
    context.call('quirky.worktree/list', {}),
    run.sessionKind === 'structured' && run.sessionId !== null
      ? context.call('quirky.session/get', { session: run.sessionId })
      : Promise.reject(new Error('No structured session was recorded.'))
  ])
  if (workspaceResult.status !== 'fulfilled' || !Array.isArray(workspaceResult.value)) throw new Error('Workspace availability could not be checked.')
  const workspace = workspaceResult.value.find((candidate) => isRecord(candidate) && candidate.id === run.workspaceId)
  if (!isRecord(workspace) || workspace.repoId !== owner.repoId) return null
  if (sessionResult.status === 'fulfilled' && isRecord(sessionResult.value)
    && sessionResult.value.id === run.sessionId && sessionResult.value.kind === 'structured'
    && sessionResult.value.worktreeId === run.workspaceId) {
    return { kind: 'session', workspaceId: run.workspaceId, sessionId: run.sessionId }
  }
  return { kind: 'workspace', workspaceId: run.workspaceId, sessionId: null }
}

export function AutomationsPage(props: AutomationSurfaceProps) {
  const report = (props as ListReportProps).report
  const navigation = props.state.navigation
  const [data, setData] = useState<FetchState>(INITIAL_FETCH_STATE)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog | null>(null)
  const [showSettingsLink, setShowSettingsLink] = useState(false)
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null)
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [agentFilterQuery, setAgentFilterQuery] = useState('')
  const [targetChecks, setTargetChecks] = useState<Record<string, TargetProbe>>({})
  const [detailState, setDetailState] = useState<{ id: string | null; definition: AutomationDefinition | null; loading: boolean; error: string | null }>({ id: null, definition: null, loading: false, error: null })
  const [history, setHistory] = useState<HistoryState>({ automationId: null, runs: [], cursor: null, loaded: false, loading: false, error: null })
  const [detailUsage, setDetailUsage] = useState<DetailUsageState>({ automationId: null, runs: [], loaded: false, loading: false, error: null })
  const [historyStarts, setHistoryStarts] = useState<number[]>([0])
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(0)
  const [historyRetry, setHistoryRetry] = useState(0)
  const [usageRetry, setUsageRetry] = useState(0)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [runDetail, setRunDetail] = useState<RunDetailState>({ runId: null, run: null, loading: false, error: null })
  const [runRetry, setRunRetry] = useState(0)
  const [runAutomation, setRunAutomation] = useState<AutomationDefinition | null>(null)
  const [runOpenTarget, setRunOpenTarget] = useState<OpenTarget | null>(null)
  const [runOpenError, setRunOpenError] = useState<string | null>(null)
  const [rerunPending, setRerunPending] = useState(false)
  const rerunGate = useRef(false)
  const [dashboardVisibleCount, setDashboardVisibleCount] = useState(DASHBOARD_RENDER_LIMIT)
  const loadGeneration = useRef(0)
  const dashboardGeneration = useRef(0)
  const rowElements = useRef(new Map<string, HTMLTableRowElement>())
  const rowMenuTriggerElements = useRef(new Map<string, HTMLButtonElement>())
  const historyElements = useRef(new Map<string, HTMLTableRowElement>())
  const reloadPromise = useRef<Promise<void> | null>(null)
  const reloadAgain = useRef(false)
  const mounted = useRef(false)
  const reloadLatest = useRef<() => Promise<void>>(() => Promise.resolve())
  const historyRequestGeneration = useRef(0)
  const activeHistoryAutomationId = navigation.page === 'detail' && navigation.tab === 'runs' ? navigation.automationId : null
  const historySelection = useRef({ automationId: activeHistoryAutomationId })
  if (historySelection.current.automationId !== activeHistoryAutomationId) {
    historySelection.current = { automationId: activeHistoryAutomationId }
  }
  const historyEffectAutomationId = useRef<string | null>(null)

  const reload = useCallback((): Promise<void> => {
    if (reloadPromise.current !== null) {
      reloadAgain.current = true
      return reloadPromise.current
    }
    const load = async () => {
      while (mounted.current) {
        reloadAgain.current = false
        const generation = ++loadGeneration.current
        setData((current) => ({
          ...current, nativeLoading: current.definitions.length === 0, externalLoading: current.managers.length === 0,
          nativeError: null, editorError: null, externalError: null
        }))
        const [definitionsResult, editorResult, externalResult] = await Promise.allSettled([
          callApi<AutomationDefinition[]>(props.context, 'list', {}),
          callApi<AutomationEditorData>(props.context, 'editorData', {}),
          callApi<unknown>(props.context, 'externalList', {})
        ])
        if (!mounted.current || generation !== loadGeneration.current) return
        const definitions = definitionsResult.status === 'fulfilled' && Array.isArray(definitionsResult.value) ? definitionsResult.value : null
        setData((current) => {
          const next = { ...current, nativeLoading: false, externalLoading: false }
          if (definitionsResult.status === 'fulfilled' && Array.isArray(definitionsResult.value)) {
            next.definitions = definitionsResult.value
            next.nativeLoaded = true
            next.nativeError = null
            next.lastRunErrors = []
            next.lastRunsLoaded = false
          } else if (definitionsResult.status === 'rejected') next.nativeError = errorMessage(definitionsResult.reason)
          else next.nativeError = 'The automation list returned an invalid response.'
          if (editorResult.status === 'fulfilled') {
            next.editorData = editorResult.value
            next.editorError = null
          } else next.editorError = errorMessage(editorResult.reason)
          if (externalResult.status === 'fulfilled') {
            try {
              next.managers = normalizeManagers(externalResult.value)
              next.externalLoaded = true
              next.externalError = null
            } catch (error) {
              next.externalError = errorMessage(error)
            }
          } else next.externalError = errorMessage(externalResult.reason)
          return next
        })
        if (definitions === null) return
        const lastRuns: Record<string, AutomationRun | null> = {}
        const errors: string[] = []
        for (let index = 0; index < definitions.length; index += 8) {
          const group = definitions.slice(index, index + 8)
          const results = await Promise.allSettled(group.map(async (definition) => {
            const page = await readRunPage(props.context, definition.id, 1, null)
            return { id: definition.id, run: page.runs[0] ?? null }
          }))
          if (!mounted.current || generation !== loadGeneration.current) return
          results.forEach((result, resultIndex) => {
            const id = group[resultIndex]!.id
            if (result.status === 'fulfilled') lastRuns[id] = result.value.run
            else {
              lastRuns[id] = null
              errors.push(id)
            }
          })
        }
        if (!mounted.current || generation !== loadGeneration.current) return
        setData((current) => ({ ...current, lastRuns, lastRunsLoaded: true, lastRunErrors: errors }))
        if (!reloadAgain.current) return
      }
    }
    const promise = Promise.resolve().then(load)
    reloadPromise.current = promise
    const clear = () => {
      if (reloadPromise.current !== promise) return
      reloadPromise.current = null
      if (reloadAgain.current && mounted.current) {
        reloadAgain.current = false
        void reloadLatest.current()
      }
    }
    void promise.then(clear, clear)
    return promise
  }, [props.context])
  reloadLatest.current = reload

  useEffect(() => {
    mounted.current = true
    void reload()
    const unsubscribe = props.context.subscribe((event) => {
      if (!mounted.current || event.type !== `${API}changed`) return
      void reload()
      setHistoryRetry((current) => current + 1)
      setUsageRetry((current) => current + 1)
      setRunRetry((current) => current + 1)
    })
    return () => {
      mounted.current = false
      unsubscribe()
      reloadAgain.current = false
      loadGeneration.current++
      dashboardGeneration.current++
    }
  }, [props.context, reload])

  useEffect(() => {
    if (navigation.page !== 'runs' || !data.nativeLoaded) {
      dashboardGeneration.current++
      setData((current) => ({ ...current, dashboardLoaded: false, dashboardLoading: false, dashboardErrors: [] }))
      return
    }
    const generation = ++dashboardGeneration.current
    setData((current) => ({ ...current, dashboardLoading: true, dashboardLoaded: false, dashboardRuns: [], dashboardErrors: [] }))
    const load = async () => {
      const result: AutomationRun[] = []
      const errors: string[] = []
      for (let index = 0; index < data.definitions.length; index += 6) {
        const group = data.definitions.slice(index, index + 6)
        const loaded = await Promise.allSettled(group.map(async (definition) => ({ id: definition.id, ...(await readAllRuns(props.context, definition.id)) })))
        if (generation !== dashboardGeneration.current) return
        for (const outcome of loaded) {
          if (outcome.status === 'fulfilled') {
            result.push(...outcome.value.runs)
            if (outcome.value.error !== null) errors.push(outcome.value.id)
          } else {
            const failedIndex = loaded.indexOf(outcome)
            errors.push(group[failedIndex]?.id ?? 'unknown')
          }
        }
      }
      if (generation !== dashboardGeneration.current) return
      result.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      setData((current) => ({ ...current, dashboardRuns: result, dashboardLoaded: true, dashboardLoading: false, dashboardErrors: errors }))
    }
    void load().catch((error: unknown) => {
      if (generation === dashboardGeneration.current) setData((current) => ({ ...current, dashboardLoading: false, dashboardLoaded: false, dashboardErrors: [...current.dashboardErrors, errorMessage(error)] }))
    })
  }, [data.definitions, data.nativeLoaded, navigation.page, props.context])

  useEffect(() => {
    if (navigation.page !== 'detail' || !navigation.automationId) {
      setDetailState({ id: null, definition: null, loading: false, error: null })
      return
    }
    const id = navigation.automationId
    let cancelled = false
    setDetailState({ id, definition: data.definitions.find((definition) => definition.id === id) ?? null, loading: true, error: null })
    void freshDefinition(props.context, id).then((definition) => {
      if (!cancelled) setDetailState({ id, definition, loading: false, error: null })
    }).catch((error: unknown) => {
      if (!cancelled) setDetailState((current) => ({ ...current, id, loading: false, error: errorMessage(error) }))
    })
    return () => { cancelled = true }
  }, [data.definitions, navigation.automationId, navigation.page, props.context])

  useEffect(() => {
    const id = navigation.page === 'detail' && navigation.tab === 'runs' ? navigation.automationId : null
    const sameAutomation = historyEffectAutomationId.current === id
    historyEffectAutomationId.current = id
    const requestGeneration = ++historyRequestGeneration.current
    const selection = historySelection.current
    if (!id) {
      setHistory({ automationId: null, runs: [], cursor: null, loaded: false, loading: false, error: null })
      setHistoryStarts([0])
      setSelectedHistoryIndex(0)
      return () => { historyRequestGeneration.current++ }
    }
    let cancelled = false
    setHistory((current) => current.automationId === id
      ? { ...current, loading: true, error: null }
      : { automationId: id, runs: [], cursor: null, loaded: false, loading: true, error: null })
    if (!sameAutomation) {
      setHistoryStarts([0])
      setSelectedHistoryIndex(0)
    }
    void readRunPage(props.context, id, RUN_PAGE_SIZE, null).then((page) => {
      if (cancelled || historyRequestGeneration.current !== requestGeneration || historySelection.current !== selection) return
      setHistory((current) => {
        if (current.automationId !== id) return current
        const hasOlderLoaded = current.runs.length > page.runs.length
        const merged = hasOlderLoaded ? appendRunPage(page.runs, { runs: current.runs, nextCursor: current.cursor }) : { runs: page.runs, nextCursor: page.nextCursor }
        return { ...current, runs: merged.runs, cursor: merged.nextCursor, loaded: true, loading: false, error: null }
      })
    }).catch((error: unknown) => {
      if (cancelled || historyRequestGeneration.current !== requestGeneration || historySelection.current !== selection) return
      setHistory((current) => current.automationId === id
        ? { ...current, loading: false, error: errorMessage(error) }
        : current)
    })
    return () => {
      cancelled = true
      if (historyRequestGeneration.current === requestGeneration) historyRequestGeneration.current++
    }
  }, [historyRetry, navigation.automationId, navigation.page, navigation.tab, props.context])
  useEffect(() => {
    const id = navigation.page === 'detail' && navigation.tab === 'overview' ? navigation.automationId : null
    if (!id) {
      setDetailUsage({ automationId: null, runs: [], loaded: false, loading: false, error: null })
      return
    }
    let cancelled = false
    setDetailUsage((current) => current.automationId === id
      ? { ...current, loading: true, error: null }
      : { automationId: id, runs: [], loaded: false, loading: true, error: null })
    void readAllRuns(props.context, id).then((result) => {
      if (cancelled) return
      setDetailUsage((current) => {
        if (current.automationId !== id) return current
        const runs = result.error !== null && current.runs.length > result.runs.length ? current.runs : result.runs
        return { automationId: id, runs, loaded: result.error === null, loading: false, error: result.error }
      })
    }).catch((error: unknown) => {
      if (!cancelled) setDetailUsage((current) => current.automationId === id
        ? { ...current, loaded: false, loading: false, error: errorMessage(error) }
        : { automationId: id, runs: [], loaded: false, loading: false, error: errorMessage(error) })
    })
    return () => { cancelled = true }
  }, [data.definitions, navigation.automationId, navigation.page, navigation.tab, props.context, usageRetry])
  useEffect(() => {
    if (navigation.page !== 'run' || !navigation.runId) {
      setRunDetail({ runId: null, run: null, loading: false, error: null })
      setRunAutomation(null)
      setRunOpenTarget(null)
      setRunOpenError(null)
      setRerunPending(false)
      return
    }
    const runId = navigation.runId
    const cached = runRetry === 0 ? data.dashboardRuns.find((run) => run.id === runId) ?? history.runs.find((run) => run.id === runId) ?? null : null
    let cancelled = false
    setRunAutomation(null)
    setRunOpenTarget(null)
    setRunOpenError(null)
    setRunDetail({ runId, run: cached, loading: true, error: null })
    const findRun = async (): Promise<AutomationRun> => {
      if (cached) return cached
      const automationId = navigation.automationId
      let cursor: string | null = null
      const seen = new Set<string>()
      do {
        const page = await readRunPage(props.context, automationId, 100, cursor)
        const found = page.runs.find((run) => run.id === runId)
        if (found) return found
        if (page.nextCursor === null) break
        if (seen.has(page.nextCursor)) throw new Error('Run history repeated a paging cursor.')
        seen.add(page.nextCursor)
        cursor = page.nextCursor
      } while (true)
      throw new Error('This run is no longer present in available history.')
    }
    void findRun().then(async (run) => {
      if (cancelled) return
      setRunDetail({ runId, run, loading: false, error: null })
      setRunOpenTarget(null)
      setRunOpenError(null)
      let definition: AutomationDefinition
      try {
        definition = await freshDefinition(props.context, run.automationId)
      } catch (error) {
        if (!cancelled) {
          setRunAutomation(null)
          setTargetChecks((current) => ({ ...current, [run.automationId]: { available: false, error: errorMessage(error) } }))
          setRunOpenError(errorMessage(error))
        }
        return
      }
      if (cancelled) return
      setRunAutomation(definition)
      if (definition.owner?.kind !== 'local') {
        const error = 'This run belongs to an automation that cannot be opened from the local authority.'
        setTargetChecks((current) => ({ ...current, [run.automationId]: { available: false, error } }))
        setRunOpenError(error)
        return
      }
      setTargetChecks((current) => ({ ...current, [run.automationId]: { available: false, error: 'Checking target availability…' } }))
      const probe = await checkTarget(props.context, run.automationId)
      if (cancelled) return
      setTargetChecks((current) => ({ ...current, [run.automationId]: probe }))
      try {
        const target = await getRunTarget(props.context, run, definition.owner)
        if (!cancelled) setRunOpenTarget(target)
      } catch (error) {
        if (!cancelled) setRunOpenError(errorMessage(error))
      }
    }).catch((error: unknown) => {
      if (!cancelled) setRunDetail({ runId, run: null, loading: false, error: errorMessage(error) })
    })
    return () => { cancelled = true }
  }, [data.dashboardRuns, data.definitions, history.runs, navigation.automationId, navigation.page, navigation.runId, props.context, runRetry])

  const nativeRows = useMemo(() => buildListRows(data), [data])
  const filters = useMemo(() => filterListRows(nativeRows, {
    query: navigation.query, host: navigation.host, status: navigation.status, lastRun: navigation.lastRun, agent: navigation.agent
  }), [nativeRows, navigation.agent, navigation.host, navigation.lastRun, navigation.query, navigation.status])
  const sortedRows = useMemo(() => sortListRows(filters.rows, navigation.sort as ListSort, navigation.direction as SortDirection), [filters.rows, navigation.direction, navigation.sort])
  const hostChoices = useMemo(() => {
    const candidates = [...(data.editorData?.hosts.map(({ id, label }) => ({ id, label })) ?? []), ...data.managers.map(({ hostId, label }) => ({ id: hostId, label }))]
    const seen = new Set<string>()
    return candidates.filter((host) => host.id !== 'all' && !seen.has(host.id) && seen.add(host.id))
  }, [data.editorData, data.managers])
  const dashboardResult = useMemo(() => filterDashboardRows(data.dashboardRuns, data.definitions, data.editorData, navigation), [data.dashboardRuns, data.definitions, data.editorData, navigation])
  const dashboardMetrics: DashboardMetrics = useMemo(() => summarizeDashboardRuns(data.dashboardRuns, Date.now()), [data.dashboardRuns])
  const reportState = useMemo(() => ({
    kind: 'automation-page', page: navigation.page, openMenuKey,
    loading: { native: data.nativeLoading, external: data.externalLoading, latestRuns: data.nativeLoaded && !data.lastRunsLoaded, detail: detailState.loading, history: history.loading, usageHistory: detailUsage.loading, runDetails: runDetail.loading, dashboard: data.dashboardLoading },
    busy: busyAction ?? (refreshing ? 'refresh' : rerunPending ? 'rerun' : null),
    errors: { native: reportText(data.nativeError), editorData: reportText(data.editorError), external: reportText(data.externalError), latestRuns: reportIds(data.lastRunErrors), action: reportText(actionError), detail: reportText(detailState.error), history: reportText(history.error), usageHistory: reportText(detailUsage.error), runDetails: reportText(runDetail.error), runOpen: reportText(runOpenError) },
    selected: { automationId: reportText(navigation.automationId), runId: reportText(navigation.runId), tab: navigation.tab, rowKey: reportText(selectedRowKey), historyRunId: reportText(history.runs[(historyStarts[historyStarts.length - 1] ?? 0) + selectedHistoryIndex]?.id ?? null) },
    dialog: deleteDialog === null ? null : deleteDialog.kind === 'native'
      ? { kind: 'native-delete', automationId: reportText(deleteDialog.definition.id), skipNextTime: deleteDialog.skipNextTime, error: reportText(deleteDialog.error) }
      : { kind: 'external-delete', managerId: reportText(deleteDialog.manager.id), jobId: reportText(deleteDialog.job.id), error: reportText(deleteDialog.error) },
    target: navigation.automationId ? { available: targetChecks[navigation.automationId]?.available ?? null, error: reportText(targetChecks[navigation.automationId]?.error ?? null) } : null,
    runNavigation: runOpenTarget ? { kind: runOpenTarget.kind, workspaceId: reportText(runOpenTarget.workspaceId) } : null,
    definitionCount: data.definitions.length, definitionIds: reportIds(data.definitions.map((definition) => definition.id)),
    rowCount: sortedRows.length, visibleRowKeys: reportIds(sortedRows.map((row) => row.key)),
    history: { loadedCount: history.runs.length || detailUsage.runs.length, visibleRunIds: reportIds(history.runs.slice(historyStarts[historyStarts.length - 1] ?? 0, (historyStarts[historyStarts.length - 1] ?? 0) + RUN_RENDER_LIMIT).map((run) => run.id)), cursorAvailable: history.cursor !== null, unavailable: history.error !== null || data.lastRunErrors.length > 0 || detailUsage.error !== null, unavailableCount: data.lastRunErrors.length + (history.error ? 1 : 0) + (detailUsage.error ? 1 : 0) },
    dashboard: { counts: dashboardMetrics, loadedCount: data.dashboardRuns.length, visibleRunIds: reportIds(dashboardResult.runs.map((run) => run.id)), unavailableCount: data.dashboardErrors.length, loaded: data.dashboardLoaded },
    external: { loaded: data.externalLoaded, unavailableManagerIds: reportIds(data.managers.filter((manager) => manager.status === 'unavailable').map((manager) => manager.id)) },
    settingsLinkAvailable: showSettingsLink,
    listHistory: { loaded: data.lastRunsLoaded, unavailableAutomationIds: reportIds(data.lastRunErrors) }
  }), [actionError, busyAction, data.dashboardErrors.length, data.dashboardLoaded, data.dashboardLoading, data.dashboardRuns.length, data.definitions, data.editorError, data.externalError, data.externalLoaded, data.externalLoading, data.lastRunErrors, data.lastRunsLoaded, data.managers, data.nativeError, data.nativeLoaded, data.nativeLoading, dashboardMetrics, dashboardResult.runs, deleteDialog, detailState.error, detailState.loading, detailUsage.error, detailUsage.loading, detailUsage.runs.length, history.cursor, history.error, history.loading, history.runs.length, historyStarts, navigation, openMenuKey, refreshing, rerunPending, runDetail.error, runDetail.loading, runOpenError, runOpenTarget, selectedHistoryIndex, selectedRowKey, showSettingsLink, sortedRows, targetChecks])

  useEffect(() => { report?.(reportState) }, [report, reportState])

  const navigate = useCallback(async (patch: Partial<AutomationNavigation>) => {
    try {
      await callApi(props.context, 'uiNavigate', patch as Record<string, unknown>)
      setActionError(null)
    } catch (error) {
      setActionError(errorMessage(error))
    }
  }, [props.context])

  const refreshAll = useCallback(async () => {
    setOpenMenuKey(null)
    rowMenuTriggerElements.current.clear()
    setRefreshing(true)
    setActionError(null)
    try {
      await props.refresh()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setRefreshing(false)
    }
    await reload()
  }, [props.refresh, reload])

  const targetForMenu = useCallback(async (id: string) => {
    setTargetChecks((current) => ({ ...current, [id]: { available: false, error: 'Checking target availability…' } }))
    const probe = await checkTarget(props.context, id)
    setTargetChecks((current) => ({ ...current, [id]: probe }))
  }, [props.context])
  useEffect(() => {
    if (navigation.page === 'detail' && navigation.automationId) void targetForMenu(navigation.automationId)
  }, [navigation.automationId, navigation.page, targetForMenu])
  const displayedDefinition = useCallback((id: string) => {
    if (detailState.id === id && detailState.definition) return detailState.definition
    return data.definitions.find((definition) => definition.id === id) ?? null
  }, [data.definitions, detailState.definition, detailState.id])

  const openEditor = useCallback(async (id?: string, template?: string) => {
    setBusyAction(id ? `edit:${id}` : 'create')
    setActionError(null)
    try {
      if (id) {
        const displayed = displayedDefinition(id)
        if (!displayed) throw new Error('Automation must be refreshed before editing.')
        const fresh = await freshDefinition(props.context, id)
        assertOwnerUnchanged(displayed, fresh)
        await callApi(props.context, 'openEditor', { id: fresh.id })
      } else {
        const local = data.editorData?.hosts.find((host) => host.id === 'local' && host.available)
        if (!local) throw new Error('No available local automation host is configured.')
        await callApi(props.context, 'openEditor', template ? { template } : {})
      }
    } catch (error) {
      const message = errorMessage(error)
      setActionError(message)
      props.notify(id ? 'Could not edit automation' : 'Could not create automation', 'error')
    } finally {
      setBusyAction(null)
    }
  }, [data.editorData, displayedDefinition, props.context, props.notify])

  const runNative = useCallback(async (id: string) => {
    setBusyAction(`run:${id}`)
    setActionError(null)
    try {
      const displayed = displayedDefinition(id)
      if (!displayed) throw new Error('Automation must be refreshed before running.')
      const fresh = await freshDefinition(props.context, id)
      assertOwnerUnchanged(displayed, fresh)
      const probe = await checkTarget(props.context, id)
      if (!probe.available) throw new Error(probe.error ?? 'The automation target is unavailable.')
      const run = await callApi<AutomationRun>(props.context, 'run', { id, ...expectedOwner(fresh) })
      props.notify('Automation run queued.', 'success')
      setSelectedRowKey(`native:${id}`)
      await reload()
      if (navigation.page === 'detail' && navigation.automationId === id && navigation.tab === 'runs') setHistoryRetry((current) => current + 1)
      return run
    } catch (error) {
      const message = errorMessage(error)
      setActionError(message)
      props.notify('Could not queue automation run', 'error')
      return null
    } finally {
      setBusyAction(null)
    }
  }, [displayedDefinition, navigation.automationId, navigation.page, navigation.tab, props.context, props.notify, reload])

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    setBusyAction(`${enabled ? 'resume' : 'pause'}:${id}`)
    setActionError(null)
    try {
      const displayed = displayedDefinition(id)
      if (!displayed) throw new Error('Automation must be refreshed before changing its status.')
      const fresh = await freshDefinition(props.context, id)
      assertOwnerUnchanged(displayed, fresh)
      await callApi(props.context, 'edit', { id, enabled, ...expectedOwner(fresh) })
      props.notify(enabled ? 'Automation resumed.' : 'Automation paused.', 'success')
      await reload()
    } catch (error) {
      setActionError(errorMessage(error))
      props.notify('Could not update automation', 'error')
    } finally {
      setBusyAction(null)
    }
  }, [displayedDefinition, props.context, props.notify, reload])

  const deleteNative = useCallback(async (definition: AutomationDefinition) => {
    setBusyAction(`delete:${definition.id}`)
    setActionError(null)
    try {
      const fresh = await freshDefinition(props.context, definition.id)
      assertOwnerUnchanged(definition, fresh)
      await callApi(props.context, 'remove', { id: fresh.id, yes: true, ...expectedOwner(fresh) })
      props.notify('Automation deleted. Existing workspaces were not removed.', 'success')
      setDeleteDialog(null)
      await reload()
      if (navigation.page === 'detail' && navigation.automationId === definition.id) {
        await navigate({ page: 'list', automationId: null, runId: null, tab: 'overview' })
      }
    } catch (error) {
      const message = errorMessage(error)
      setActionError(message)
      setDeleteDialog((current) => current?.kind === 'native' ? { ...current, error: message } : current)
      props.notify('Could not delete automation', 'error')
    } finally {
      setBusyAction(null)
    }
  }, [navigation.automationId, navigation.page, navigate, props.context, props.notify, reload])

  const beginNativeDelete = useCallback(async (id: string) => {
    setBusyAction(`confirm-delete:${id}`)
    setActionError(null)
    try {
      const displayed = displayedDefinition(id)
      if (!displayed) throw new Error('Automation must be refreshed before deletion.')
      const definition = await freshDefinition(props.context, id)
      assertOwnerUnchanged(displayed, definition)
      let askBeforeDelete = true
      try {
        const setting = await callApi<{ value: unknown }>(props.context, 'setting.get', { id: ASK_BEFORE_DELETE_SETTING })
        if (typeof setting.value === 'boolean') askBeforeDelete = setting.value
      } catch {
        setActionError('The delete preference could not be checked; confirmation is required.')
      }
      if (!askBeforeDelete) await deleteNative(definition)
      else setDeleteDialog({ kind: 'native', definition, skipNextTime: false, error: null })
    } catch (error) {
      setActionError(errorMessage(error))
      props.notify('Could not prepare automation deletion', 'error')
    } finally {
      setBusyAction(null)
    }
  }, [deleteNative, displayedDefinition, props.context, props.notify])

  const confirmNativeDelete = useCallback(async () => {
    if (!deleteDialog || deleteDialog.kind !== 'native') return
    if (deleteDialog.skipNextTime) {
      setBusyAction(`preference:${deleteDialog.definition.id}`)
      try {
        await callApi(props.context, 'setting.set', { id: ASK_BEFORE_DELETE_SETTING, value: false })
      } catch (error) {
        const message = `Could not save the delete preference: ${errorMessage(error)}`
        setDeleteDialog((current) => current?.kind === 'native' ? { ...current, error: message } : current)
        setBusyAction(null)
        return
      }
      props.notify('We’ll skip this confirmation next time. Change this preference in Settings.', 'info')
      setShowSettingsLink(true)
      setBusyAction(null)
    }
    await deleteNative(deleteDialog.definition)
  }, [deleteDialog, deleteNative, props.context, props.notify])

  const openExternalDelete = useCallback((manager: ExternalManager, job: ExternalJob) => {
    if (!canManageExternal(manager)) {
      setActionError(manager.error ?? 'This external host cannot be managed from the local client.')
      return
    }
    setDeleteDialog({ kind: 'external', manager, job, error: null })
  }, [])

  const externalAction = useCallback(async (manager: ExternalManager, job: ExternalJob, action: 'pause' | 'resume' | 'run' | 'delete') => {
    if (!canManageExternal(manager)) {
      const message = manager.error ?? 'This external host cannot be managed from the local client.'
      setActionError(message)
      return
    }
    setBusyAction(`external:${action}:${job.id}`)
    setActionError(null)
    try {
      await props.context.call(`${API}externalAction`, {
        owner: manager.owner, jobId: job.id, action, ...(action === 'delete' ? { yes: true } : {})
      })
      if (action === 'delete') {
        props.notify('External automation deleted.', 'success')
        setDeleteDialog(null)
      } else if (action === 'run') props.notify('External automation queued.', 'success')
      else props.notify(`External automation ${action === 'pause' ? 'paused' : 'resumed'}.`, 'success')
      await reload()
    } catch (error) {
      const message = errorMessage(error)
      setActionError(message)
      setDeleteDialog((current) => current?.kind === 'external' ? { ...current, error: message } : current)
      props.notify('External automation action failed.', 'error')
    } finally {
      setBusyAction(null)
    }
  }, [props.context, props.notify, reload])

  const loadMoreHistory = useCallback(async () => {
    const automationId = history.automationId
    if (!automationId || automationId !== activeHistoryAutomationId || !history.cursor || history.loading) return
    const cursor = history.cursor
    const requestGeneration = historyRequestGeneration.current
    const selection = historySelection.current
    const currentLength = history.runs.length
    const windowStart = historyStarts[historyStarts.length - 1] ?? 0
    setHistory((current) => current.automationId === automationId ? { ...current, loading: true, error: null } : current)
    try {
      const page = await readRunPage(props.context, automationId, RUN_PAGE_SIZE, cursor)
      if (!mounted.current || historyRequestGeneration.current !== requestGeneration || historySelection.current !== selection) return
      if (page.nextCursor === cursor) throw new Error('Run history repeated a paging cursor.')
      const merged = appendRunPage(history.runs, page)
      const newlyLoaded = merged.runs.length - currentLength
      if (newlyLoaded > 0 && currentLength <= windowStart + RUN_RENDER_LIMIT && merged.runs.length > windowStart + RUN_RENDER_LIMIT) {
        setHistoryStarts((current) => {
          const currentStart = current[current.length - 1] ?? 0
          return currentStart === windowStart ? [...current, currentStart + newlyLoaded] : current
        })
        setSelectedHistoryIndex(0)
      }
      setHistory((current) => {
        if (!mounted.current || historyRequestGeneration.current !== requestGeneration || historySelection.current !== selection
          || current.automationId !== automationId || current.cursor !== cursor) return current
        const next = appendRunPage(current.runs, page)
        return { ...current, runs: next.runs, cursor: next.nextCursor, loaded: true, loading: false, error: null }
      })
    } catch (error) {
      if (!mounted.current || historyRequestGeneration.current !== requestGeneration || historySelection.current !== selection) return
      setHistory((current) => current.automationId === automationId
        ? { ...current, loading: false, error: errorMessage(error) }
        : current)
    }
  }, [activeHistoryAutomationId, history.automationId, history.cursor, history.loading, history.runs, historyStarts, props.context])

  const rerun = useCallback(async (run: AutomationRun) => {
    if (!canRerun(run.status) || rerunPending || rerunGate.current || busyAction !== null) return
    const startedAt = Date.now()
    rerunGate.current = true
    setRerunPending(true)
    setActionError(null)
    try {
      const displayed = runAutomation
      if (!displayed || displayed.id !== run.automationId) throw new Error('Automation must be refreshed before rerunning.')
      const fresh = await freshDefinition(props.context, run.automationId)
      assertOwnerUnchanged(displayed, fresh)
      const probe = await checkTarget(props.context, run.automationId)
      if (!probe.available) throw new Error(probe.error ?? 'The automation target is unavailable.')
      await callApi<AutomationRun>(props.context, 'run', { id: run.automationId, ...expectedOwner(fresh) })
      props.notify('Automation run queued.', 'success')
      await reload()
    } catch (error) {
      const message = errorMessage(error)
      setActionError(message)
      props.notify('Could not queue automation run', 'error')
    } finally {
      const remaining = Math.max(0, RERUN_PENDING_MS - (Date.now() - startedAt))
      setTimeout(() => {
        rerunGate.current = false
        setRerunPending(false)
      }, remaining)
    }
  }, [busyAction, props.context, props.notify, reload, rerunPending, runAutomation])

  useEffect(() => {
    function keydown(event: globalThis.KeyboardEvent) {
      if (deleteDialog || event.defaultPrevented) return
      if (event.key === 'Escape' && openMenuKey !== null) {
        event.preventDefault()
        event.stopPropagation()
        const trigger = rowMenuTriggerElements.current.get(openMenuKey)
        setOpenMenuKey(null)
        trigger?.focus()
        rowMenuTriggerElements.current.delete(openMenuKey)
        return
      }
      if (openMenuKey !== null) return
      if (isEditableTarget(event.target)) return
      if (navigation.page === 'detail' && event.key === 'Escape') {
        event.preventDefault()
        void navigate({ page: 'list', automationId: null, runId: null, tab: 'overview' })
      } else if (navigation.page === 'detail' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        void navigate({ tab: navigation.tab === 'overview' ? 'runs' : 'overview' })
      } else if (navigation.page === 'runs' && event.key === 'Escape') {
        event.preventDefault()
        void navigate({ page: 'list', automationId: null, runId: null })
      } else if (navigation.page === 'run' && event.key === 'Escape') {
        event.preventDefault()
        if (navigation.automationId) void navigate({ page: 'detail', runId: null, automationId: navigation.automationId, tab: 'runs' })
        else void navigate({ page: 'runs', runId: null, automationId: null })
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [deleteDialog, navigation.automationId, navigation.page, navigation.tab, navigate, openMenuKey])

  const runPage = useCallback((run: AutomationRun) => {
    setSelectedHistoryIndex(0)
    setDashboardVisibleCount(DASHBOARD_RENDER_LIMIT)
    void navigate({ page: 'run', automationId: run.automationId, runId: run.id })
  }, [navigate])

  const openNativeDetail = useCallback((id: string) => {
    setSelectedRowKey(`native:${id}`)
    setOpenMenuKey(null)
    rowMenuTriggerElements.current.clear()
    void navigate({ page: 'detail', automationId: id, runId: null, tab: 'overview' })
  }, [navigate])

  const openRowMenu = useCallback((key: string) => {
    if (openMenuKey !== null && openMenuKey !== key) rowMenuTriggerElements.current.delete(openMenuKey)
    const trigger = rowElements.current.get(key)?.querySelector<HTMLButtonElement>('.auto-row-menu__trigger')
    if (trigger) rowMenuTriggerElements.current.set(key, trigger)
    setOpenMenuKey(key)
  }, [openMenuKey])

  const onListRowKeyDown = useCallback((event: KeyboardEvent<HTMLTableRowElement>, row: AutomationListRow) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const currentIndex = sortedRows.findIndex((candidate) => candidate.key === row.key)
      const nextIndex = Math.max(0, Math.min(sortedRows.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)))
      const next = sortedRows[nextIndex]
      if (next) {
        setSelectedRowKey(next.key)
        rowElements.current.get(next.key)?.focus()
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (row.kind === 'native') openNativeDetail(row.id)
      else openRowMenu(row.key)
    }
  }, [openNativeDetail, openRowMenu, sortedRows])

  const openRunTarget = useCallback(() => {
    if (!runOpenTarget) return
    props.context.openView(AUTOMATION_PAGE_VIEW, {
      worktree: runOpenTarget.workspaceId,
      ...(runOpenTarget.kind === 'session' && runOpenTarget.sessionId ? { session: runOpenTarget.sessionId } : {})
    })
  }, [props.context, runOpenTarget])

  const activeHostLabel = hostChoices.find((host) => host.id === navigation.host)?.label ?? navigation.host
  const agentChoices = (data.editorData?.agents ?? []).filter((agent) => agent.label.toLocaleLowerCase().includes(agentFilterQuery.toLocaleLowerCase()))
  const clearListFilters = () => void navigate({ host: 'all', status: 'all', lastRun: 'all', agent: '' })
  const listFilterCount = Number(navigation.host !== 'all') + Number(navigation.status !== 'all') + Number(navigation.lastRun !== 'all') + Number(navigation.agent !== '')
  const dashboardFilterCount = Number(navigation.host !== 'all') + Number(navigation.runStatus !== 'all')

  const renderRowMenu = (row: AutomationListRow): ReactNode => {
    if (row.kind === 'native') {
      const definition = data.definitions.find((candidate) => candidate.id === row.id)
      const target = targetChecks[row.id]
      const mutationDisabled = busyAction !== null || !definition
      const runDisabled = mutationDisabled || target?.available !== true
      const items: ContextMenuItem[] = [
        { id: 'run', label: 'Run Now', enabled: !runDisabled, onSelect: () => { void runNative(row.id) } },
        ...(target?.available === false && target.error
          ? [{ id: 'target-unavailable', label: `Run Now unavailable: ${target.error}`, enabled: false }]
          : []),
        { id: 'edit', label: 'Edit', enabled: !mutationDisabled, onSelect: () => { void openEditor(row.id) } },
        { id: 'toggle', label: row.enabled ? 'Pause' : 'Resume', enabled: !mutationDisabled, onSelect: () => { void setEnabled(row.id, !row.enabled) } },
        { label: '', separator: true },
        { id: 'delete', label: 'Delete', enabled: !mutationDisabled, danger: true, onSelect: () => { void beginNativeDelete(row.id) } }
      ]
      return <div className="auto-row-menu" onClick={(event) => event.stopPropagation()}>
        <IconButton
          label="Automation actions"
          className="auto-row-menu__trigger"
          aria-haspopup="menu"
          aria-expanded={openMenuKey === row.key}
          onClick={(event) => {
            const opening = openMenuKey !== row.key
            if (opening) {
              if (openMenuKey !== null) rowMenuTriggerElements.current.delete(openMenuKey)
              rowMenuTriggerElements.current.set(row.key, event.currentTarget)
            } else rowMenuTriggerElements.current.delete(row.key)
            setOpenMenuKey(opening ? row.key : null)
            if (opening) void targetForMenu(row.id)
          }}
        >•••</IconButton>
        {openMenuKey === row.key && <div className="auto-row-menu-panel" onContextMenu={(event) => event.preventDefault()}>
          <ContextMenuList
            label="Automation actions"
            items={items}
            onChoose={(item) => item.onSelect?.()}
            onClose={() => {
              const trigger = rowMenuTriggerElements.current.get(row.key)
              setOpenMenuKey(null)
              trigger?.focus()
              rowMenuTriggerElements.current.delete(row.key)
            }}
          />
        </div>}
      </div>
    }
    const manager = data.managers.find((candidate) => candidate.id === row.key.split(':').slice(1, -1).join(':'))
      ?? data.managers.find((candidate) => candidate.hostId === row.hostId)
    const job = manager?.jobs.find((candidate) => candidate.id === row.id)
    const manageable = manager !== undefined && canManageExternal(manager)
    const items: ContextMenuItem[] = []
    if (!manageable) items.push({ id: 'unavailable', label: manager?.error ?? 'This OpenClaw host is unavailable or cannot be managed here.', enabled: false })
    if (job && manager) {
      items.push(
        { id: 'run', label: 'Run Now', enabled: manageable && busyAction === null, onSelect: () => { void externalAction(manager, job, 'run') } },
        { id: 'toggle', label: job.enabled ? 'Pause' : 'Resume', enabled: manageable && busyAction === null, onSelect: () => { void externalAction(manager, job, job.enabled ? 'pause' : 'resume') } },
        { label: '', separator: true },
        { id: 'delete', label: 'Delete', enabled: manageable && busyAction === null, danger: true, onSelect: () => openExternalDelete(manager, job) }
      )
    }
    return <div className="auto-row-menu" onClick={(event) => event.stopPropagation()}>
      <IconButton
        label="External automation actions"
        className="auto-row-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={openMenuKey === row.key}
        onClick={(event) => {
          const opening = openMenuKey !== row.key
          if (opening) {
            if (openMenuKey !== null) rowMenuTriggerElements.current.delete(openMenuKey)
            rowMenuTriggerElements.current.set(row.key, event.currentTarget)
          } else rowMenuTriggerElements.current.delete(row.key)
          setOpenMenuKey(opening ? row.key : null)
        }}
      >•••</IconButton>
      {openMenuKey === row.key && <div className="auto-row-menu-panel">
        <ContextMenuList
          label="External automation actions"
          items={items}
          onChoose={(item) => item.onSelect?.()}
          onClose={() => {
            const trigger = rowMenuTriggerElements.current.get(row.key)
            setOpenMenuKey(null)
            trigger?.focus()
            rowMenuTriggerElements.current.delete(row.key)
          }}
        />
      </div>}
    </div>
  }

  const renderList = () => {
    const externalUnavailable = data.managers.some((manager) => manager.status === 'unavailable')
    const hasLoadedEmpty = data.nativeLoaded && data.definitions.length === 0 && data.externalLoaded && !externalUnavailable && data.managers.every((manager) => manager.jobs.length === 0)
    const lastRunFilterPending = navigation.lastRun !== 'all' && data.nativeLoaded && !data.lastRunsLoaded
    const lastRunFilterUnavailable = navigation.lastRun !== 'all' && (data.nativeError !== null || data.externalError !== null || data.lastRunErrors.length > 0 || externalUnavailable)
    const noFiltersMatch = data.nativeLoaded && data.externalLoaded && sortedRows.length === 0 && !hasLoadedEmpty && !lastRunFilterPending && !lastRunFilterUnavailable && (!externalUnavailable || nativeRows.length > 0)
    const localHost = data.editorData?.hosts.find((host) => host.id === 'local')
    const canCreateLocally = localHost?.available === true
    const latestStatus = (row: AutomationListRow) => {
      if (row.lastRunRead === 'loading') return 'Loading…'
      if (row.lastRunRead === 'unavailable') return 'History unavailable'
      return row.lastStatus ? statusLabel(row.lastStatus) : row.lastRunAt === null ? 'Never ran' : 'Status unavailable'
    }
    return <main className="auto-automations" aria-label="Automations">
      <header className="auto-page-header">
        <div><h1>Automations</h1><span className="auto-cell-sub">Schedule structured agent work and review its run history.</span></div>
        <div className="auto-toolbar">
          <Button onClick={() => void refreshAll()} disabled={refreshing} aria-label="Refresh automations">{refreshing ? 'Refreshing…' : 'Refresh automations'}</Button>
          <Button onClick={() => void navigate({ page: 'runs', automationId: null, runId: null, host: 'all' })}>Runs</Button>
          <Button variant="primary" onClick={() => void openEditor()} disabled={busyAction !== null || !canCreateLocally}>{busyAction === 'create' ? 'Opening…' : 'New Automation'}</Button>
        </div>
      </header>
      {showSettingsLink && <div className="auto-info" role="status">The confirmation preference was saved. <Button onClick={() => { setShowSettingsLink(false); props.context.openView(AUTOMATIONS_SETTINGS_VIEW) }}>Open Settings</Button><Button onClick={() => setShowSettingsLink(false)}>Dismiss</Button></div>}
      {lastRunFilterPending && <div className="auto-info" role="status">Loading run history before applying this filter…</div>}
      {lastRunFilterUnavailable && <div className="auto-warning" role="status">Run-history filter results are incomplete because some history could not be loaded.</div>}
      {data.nativeError && <div className="auto-error" role="alert">Automations could not be loaded. {data.nativeError} <Button onClick={() => void refreshAll()}>Retry</Button></div>}
      {data.editorError && <div className="auto-warning" role="status">Project, host, and agent labels are incomplete because the catalog could not be loaded: {data.editorError}</div>}
      {data.editorData && !canCreateLocally && <div className="auto-warning" role="status">{localHost?.reason ?? 'No available local automation host is configured.'}</div>}
      {data.externalError && <div className="auto-warning" role="status">OpenClaw jobs could not be checked; native automation rows remain available. {data.externalError} <Button onClick={() => void refreshAll()}>Retry</Button></div>}
      {data.editorData?.errors.map((error, index) => <div className="auto-warning" role="status" key={`${index}:${error}`}>{error}</div>)}
      {data.lastRunErrors.length > 0 && <div className="auto-warning" role="status">Run history is unavailable for {data.lastRunErrors.length} automation{data.lastRunErrors.length === 1 ? '' : 's'}; list rows remain available.</div>}
      {data.managers.filter((manager) => manager.status === 'unavailable').map((manager) => <div className="auto-warning" role="status" key={`unavailable:${manager.id}`}>{manager.label} is unavailable. Its jobs could not be read: {manager.error ?? 'No manager response was available.'} <Button onClick={() => void refreshAll()}>Retry</Button></div>)}
      {data.externalLoaded && data.managers.filter((manager) => manager.status === 'ready' && !canManageExternal(manager)).map((manager) => <div className="auto-warning" role="status" key={manager.id}>{manager.label}: this host is read-only or unsupported for local OpenClaw actions. Jobs are not changed on another host.</div>)}
      <div className="auto-toolbar">
        <TextField label="Search automations" className="auto-search" type="search" placeholder="Search…" aria-label="Search automations" value={navigation.query} onChange={(event) => void navigate({ query: event.target.value })} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const current = sortedRows.findIndex((row) => row.key === selectedRowKey)
            const nextIndex = current < 0 ? 0 : Math.max(0, Math.min(sortedRows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
            const row = sortedRows[nextIndex]
            if (row) {
              setSelectedRowKey(row.key)
              rowElements.current.get(row.key)?.focus()
            }
          } else if (event.key === 'Enter') {
            event.preventDefault()
            const row = sortedRows.find((candidate) => candidate.key === selectedRowKey) ?? sortedRows[0]
            if (row?.kind === 'native') openNativeDetail(row.id)
            else if (row) openRowMenu(row.key)
          }
        }} />
        {filters.tooLong && <span role="status" title="Search text is too long — list is unfiltered" className="auto-warning">Too long</span>}
        <details className="auto-filter-menu"><summary>Filters{listFilterCount ? ` (${listFilterCount})` : ''}</summary><div className="auto-filter-panel">
          <div><strong>Host</strong><div className="auto-filter-choices"><Button aria-pressed={navigation.host === 'all'} onClick={() => void navigate({ host: 'all' })}>All hosts</Button>{hostChoices.map((host) => <Button key={host.id} aria-pressed={navigation.host === host.id} onClick={() => void navigate({ host: host.id })}>{host.label}</Button>)}</div></div>
          <FormRow label="Status" htmlFor="auto-list-status">
            <select id="auto-list-status" aria-label="Filter by status" value={navigation.status} onChange={(event) => void navigate({ status: event.target.value as AutomationNavigation['status'] })}><option value="all">All</option><option value="enabled">Enabled</option><option value="paused">Paused</option></select>
          </FormRow>
          <FormRow label="Last run" htmlFor="auto-list-last-run">
            <select id="auto-list-last-run" aria-label="Filter by last run" value={navigation.lastRun} onChange={(event) => void navigate({ lastRun: event.target.value as AutomationNavigation['lastRun'] })}><option value="all">All</option><option value="failed">Failed</option><option value="succeeded">Succeeded</option><option value="never">Never ran</option></select>
          </FormRow>
          <div><TextField label="Search agents" type="search" aria-label="Search agents" placeholder="Search agents…" value={agentFilterQuery} onChange={(event) => setAgentFilterQuery(event.target.value)} /><div className="auto-filter-choices"><Button aria-pressed={navigation.agent === ''} onClick={() => void navigate({ agent: '' })}>All agents</Button>{agentChoices.map((agent) => <Button key={agent.id} aria-pressed={navigation.agent === agent.id} onClick={() => void navigate({ agent: agent.id })}>{agent.label}</Button>)}</div>{data.editorData && agentChoices.length === 0 && <p className="auto-muted">No agents match your search.</p>}</div>
          <Button onClick={clearListFilters}>Clear filters</Button>
        </div></details>
      </div>
      <div className="auto-filter-pills" aria-label="Active filters">
        {navigation.host !== 'all' && <Button className="auto-pill" aria-label={`Remove ${activeHostLabel} filter`} onClick={() => void navigate({ host: 'all' })}>Host: {activeHostLabel} ×</Button>}
        {navigation.status !== 'all' && <Button className="auto-pill" aria-label={`Remove ${navigation.status} filter`} onClick={() => void navigate({ status: 'all' })}>Status: {navigation.status} ×</Button>}
        {navigation.lastRun !== 'all' && <Button className="auto-pill" aria-label={`Remove ${navigation.lastRun} filter`} onClick={() => void navigate({ lastRun: 'all' })}>Last run: {navigation.lastRun} ×</Button>}
        {navigation.agent !== '' && <Button className="auto-pill" aria-label={`Remove ${agentLabel(data.editorData, navigation.agent)} filter`} onClick={() => void navigate({ agent: '' })}>Agent: {agentLabel(data.editorData, navigation.agent)} ×</Button>}
        {listFilterCount > 0 && <Button onClick={clearListFilters}>Clear all</Button>}
      </div>
      {hasLoadedEmpty && <section className="auto-empty-automations" aria-label="Empty automations">
        <EmptyState message="No automations across loaded hosts." />
        <h2>Start from a template</h2>
        <div className="auto-template-grid">
          {[
            ['repo-health-weekday', 'Weekday repo audit', 'Weekdays at 9:00 AM'],
            ['release-prep-weekly', 'Release readiness review', 'Thursdays at 2:00 PM'],
            ['recurring-review-daily', 'Daily change review', 'Daily at 4:30 PM'],
            ['maintenance-hourly', 'Hourly maintenance check', 'Hourly at :15']
          ].map(([template, name, schedule]) => <Button className="auto-template" key={template} onClick={() => void openEditor(undefined, template)} disabled={busyAction !== null || !canCreateLocally}><strong>{name}</strong><span>{schedule}</span><span className="auto-muted">Create from template</span></Button>)}
        </div>
        <Button variant="primary" onClick={() => void openEditor()} disabled={!canCreateLocally}>Add new</Button>
      </section>}
      {noFiltersMatch && <div className="auto-empty-message" role="status"><EmptyState message={data.nativeLoading || data.externalLoading ? 'Loading automation rows…' : nativeRows.length === 0 ? 'No automations are available from the loaded hosts.' : navigation.query && !filters.tooLong ? 'No automations match your search.' : 'No automations match your filters.'} /></div>}
      {(sortedRows.length > 0 || data.nativeLoading || data.externalLoading) && <div className="auto-table-wrap"><table className="auto-table" aria-label="Automation list"><thead><tr>
        <th scope="col" aria-sort={navigation.sort === 'name' ? (navigation.direction === 'asc' ? 'ascending' : 'descending') : 'none'}><Button className="sort-button" onClick={() => void navigate(toggleListSort(navigation.sort as ListSort, navigation.direction as SortDirection, 'name'))}>Name{navigation.sort === 'name' ? navigation.direction === 'asc' ? ' ↑' : ' ↓' : ''}</Button></th>
        <th scope="col">Schedule</th><th scope="col">Project</th><th scope="col">Host</th><th scope="col">Next run</th>
        <th scope="col" aria-sort={navigation.sort === 'lastRun' ? (navigation.direction === 'asc' ? 'ascending' : 'descending') : 'none'}><Button className="sort-button" onClick={() => void navigate(toggleListSort(navigation.sort as ListSort, navigation.direction as SortDirection, 'lastRun'))}>Last run{navigation.sort === 'lastRun' ? navigation.direction === 'asc' ? ' ↑' : ' ↓' : ''}</Button></th>
        <th scope="col">Status</th><th scope="col">Agent / usage</th><th scope="col">Actions</th></tr></thead><tbody>
        {sortedRows.map((row) => {
          const definition = row.kind === 'native' ? data.definitions.find((candidate) => candidate.id === row.id) : null
          const latest = row.kind === 'native' ? data.lastRuns[row.id] : null
          const manager = row.kind === 'external' ? data.managers.find((candidate) => candidate.jobs.some((job) => job.id === row.id)) : null
          const job = manager?.jobs.find((candidate) => candidate.id === row.id)
          const rowUsage = row.lastRunRead === 'loading' ? 'Loading run usage…' : row.lastRunRead === 'unavailable' ? 'Usage unavailable' : latest ? usageLabel([latest]) : row.kind === 'native' && row.lastRunAt === null && row.lastStatus === null ? 'No run usage yet' : row.kind === 'native' ? 'Usage unavailable' : 'External scheduler'
          return <tr key={row.key} data-row-key={row.key} ref={(element) => { if (element) rowElements.current.set(row.key, element); else rowElements.current.delete(row.key) }} tabIndex={0} aria-selected={selectedRowKey === row.key} onFocus={() => setSelectedRowKey(row.key)} onClick={() => { if (row.kind === 'native') openNativeDetail(row.id) }} onContextMenu={(event) => { event.preventDefault(); openRowMenu(row.key); if (row.kind === 'native') void targetForMenu(row.id) }} onKeyDown={(event) => onListRowKeyDown(event, row)}>
            <td><strong>{row.name}</strong>{row.kind === 'external' && <span className="auto-cell-sub">External · OpenClaw · {job?.runCount !== null && job?.runCount !== undefined ? `${job.runCount} runs` : 'Run count unavailable'}</span>}</td>
            <td>{definition ? describeAutomationSchedule(definition.rrule).label : job?.schedule ?? 'Unavailable'}</td>
            <td>{row.projectName}{definition && definition.workspaceMode === 'existing' && <span className="auto-cell-sub">{detailWorkspace(definition, data.editorData)}</span>}{job?.promptPreview && <span className="auto-cell-sub">{job.promptPreview}</span>}</td>
            <td>{row.hostName}{row.kind === 'external' && manager?.status === 'unavailable' && <span className="auto-cell-sub">Unknown or unavailable host</span>}</td>
            <td>{definition ? formatNextRun(definition.nextRunAt, definition.enabled, definition.timezone) : job ? formatNextRun(parseExternalDate(job.nextRunAt), job.enabled) : 'Unavailable'}</td>
            <td>{row.lastRunRead === 'loading' ? 'Loading…' : row.lastRunRead === 'unavailable' ? 'History unavailable' : row.lastRunAt === null && row.lastStatus === null ? 'Never ran' : <>{latestStatus(row)}<span className="auto-cell-sub">{row.lastRunAt === null ? 'Time unavailable' : formatRelative(row.lastRunAt, Date.now())}</span></>}{job?.lastError && <span className="auto-cell-sub" title={job.lastError}>{job.lastError.length > 180 ? `${job.lastError.slice(0, 180)}…` : job.lastError}</span>}</td>
            <td><Badge tone={row.enabled ? 'working' : 'neutral'}>{row.enabled ? 'Enabled' : 'Paused'}</Badge>{row.kind === 'external' && <span className="auto-cell-sub">{job?.state ?? externalStatusLabel(row.lastStatus)}</span>}</td>
            <td title={`${row.agentName ?? 'External'} · ${row.hostName} · ${rowUsage}`}>{row.agentName ?? '—'}<span className="auto-cell-sub">{rowUsage}</span></td>
            <td>{renderRowMenu(row)}</td>
          </tr>
        })}
      </tbody></table></div>}
      {data.nativeLoaded && data.externalLoaded && sortedRows.length === 0 && !hasLoadedEmpty && !noFiltersMatch && !lastRunFilterPending && !lastRunFilterUnavailable && (!externalUnavailable || nativeRows.length > 0) && <div className="auto-empty-message"><EmptyState message="No automations match the current view." /></div>}
      {actionError && <div className="auto-error" role="alert">{actionError}</div>}
      {busyAction && <div className="auto-info" role="status">Working: {busyAction}</div>}
    </main>
  }

  const renderDetail = () => {
    const id = navigation.automationId
    const definition = detailState.id === id ? detailState.definition : data.definitions.find((candidate) => candidate.id === id) ?? null
    if (!id) return <main className="auto-automations"><div role="alert"><EmptyState message="No automation is selected." action={{ label: 'Back to automations', onAction: () => void navigate({ page: 'list', automationId: null }) }} /></div></main>
    const target = targetChecks[id]
    const lastRun = data.lastRuns[id] ?? null
    const latestHistory = detailUsage.automationId === id && detailUsage.loaded ? detailUsage.runs : []
    const usageRuns = detailUsage.automationId === id && detailUsage.loaded ? latestHistory : lastRun ? [lastRun] : []
    const usageLoading = detailUsage.automationId !== id || (detailUsage.loading && !detailUsage.loaded)
    const usageUnavailable = detailUsage.automationId === id && detailUsage.error !== null
    const usage = usageUnavailable
      ? { kind: 'unavailable' as const, knownRuns: 0, totalRuns: detailUsage.runs.length, cost: null, tokens: null, costRuns: 0, tokenRuns: 0, partialTokenRuns: 0 }
      : summarizeUsage(usageRuns)
    const project = data.editorData?.projects.find((candidate) => candidate.id === definition?.projectId)
    const ownerHost = project?.hostId ?? (definition?.runContext && typeof definition.runContext.hostId === 'string' ? definition.runContext.hostId : null)
    const sshHost = ownerHost?.startsWith('ssh:') === true
    const schedule = definition ? describeAutomationSchedule(definition.rrule) : null
    const runWindowStart = historyStarts[historyStarts.length - 1] ?? 0
    const historyRows = history.runs.slice(runWindowStart, runWindowStart + RUN_RENDER_LIMIT)
    const selectedHistoryRun = historyRows[selectedHistoryIndex] ?? historyRows[0]
    return <main className="auto-automations" aria-label="Automation details">
      <div className="auto-breadcrumb"><Button onClick={() => void navigate({ page: 'list', automationId: null, runId: null })}>Automations</Button><span>›</span><span>{definition?.name ?? 'Automation'}</span></div>
      {detailState.error && <div className="auto-warning" role="status">Automation details could not be refreshed. {detailState.error}{definition ? ' Showing the last loaded definition; mutations remain guarded by a fresh owner read.' : ''}</div>}
      {detailState.loading && !definition && <div className="auto-info" role="status">Loading automation…</div>}
      {!definition && !detailState.loading && <div className="auto-error" role="alert">Automation details are unavailable. {detailState.error ?? ''}<Button onClick={() => void reload()}>Retry</Button></div>}
      {definition && <>
        {detailUsage.error && <div className="auto-warning" role="status">Run history is unavailable from this host. This does not mean the automation failed or has no runs. {detailUsage.error} <Button onClick={() => setUsageRetry((current) => current + 1)}>Retry</Button></div>}
        <header className="auto-detail-header"><div><h1>{definition.name}</h1><Badge tone={definition.enabled ? 'working' : 'neutral'}>{definition.enabled ? 'Enabled' : 'Paused'}</Badge><span className="auto-cell-sub">{project?.name ?? 'Unknown project'} / {detailWorkspace(definition, data.editorData)} · {hostLabel(data.editorData, ownerHost)}</span></div>
          <div className="auto-toolbar"><Button variant="primary" disabled={busyAction !== null || target?.available !== true || detailState.error !== null} title={target?.error ?? undefined} onClick={() => void runNative(definition.id)}>Run Now</Button>
            <Button disabled={busyAction !== null || detailState.error !== null} onClick={() => void openEditor(definition.id)}>Edit automation</Button>
            <Button disabled={busyAction !== null || detailState.error !== null} onClick={() => void setEnabled(definition.id, !definition.enabled)}>{definition.enabled ? 'Pause automation' : 'Resume automation'}</Button>
            <Button variant="destructive" disabled={busyAction !== null || detailState.error !== null} onClick={() => void beginNativeDelete(definition.id)}>Delete automation</Button>
          </div>
        </header>
        {target?.available === false && <div className="auto-warning" role="status">This automation cannot be run from the local host: {target.error}</div>}
        {sshHost && <div className="auto-info">This automation runs only while the local authority can reach its SSH host. If credentials are required or the host is unavailable, the run is recorded as skipped.</div>}
        <Tabs label="Automation detail tabs" items={[{ id: 'overview', label: 'Overview' }, { id: 'runs', label: 'Runs' }]} value={navigation.tab} onChange={(tab) => void navigate({ tab: tab as AutomationNavigation['tab'] })} />
        {navigation.tab === 'overview' && <>
          {schedule && <div className="auto-metric-grid">
            <div className="auto-metric"><strong>Schedule</strong><span>{schedule.label}</span></div>
            <div className="auto-metric"><strong>Next run</strong><span>{formatNextRun(definition.nextRunAt, definition.enabled, definition.timezone)}</span></div>
            <div className="auto-metric"><strong>Host</strong><span>{hostLabel(data.editorData, ownerHost)}</span></div>
            <div className="auto-metric"><strong>{definition.workspaceMode === 'new_per_run' ? 'Create from' : 'Run location'}</strong><span>{detailWorkspace(definition, data.editorData)}</span></div>
            <div className="auto-metric"><strong>Session</strong><span>{definition.reuseSession ? 'Reuse live session' : 'Fresh each run'}</span></div>
            {definition.sourceContext && <div className="auto-metric"><strong>Source</strong><span>{typeof definition.sourceContext.provider === 'string' ? definition.sourceContext.provider : typeof definition.sourceContext.source === 'string' ? definition.sourceContext.source : 'Task source attached'}</span></div>}
            <div className="auto-metric"><strong>Grace</strong><span>{definition.missedRunGraceMinutes === 0 ? 'No grace' : definition.missedRunGraceMinutes < 60 ? `${definition.missedRunGraceMinutes} minutes` : `${definition.missedRunGraceMinutes / 60} hours`}</span></div>
            <div className="auto-metric"><strong>Precheck</strong><span>{definition.precheck ? `Enabled, ${definition.precheck.timeoutSeconds}s` : 'None'}</span>{definition.precheck && <code>{definition.precheck.command}</code>}</div>
            <div className="auto-metric"><strong>Agent</strong><span>{agentLabel(data.editorData, definition.agentId)}</span></div>
          </div>}
          <div className="auto-metric-grid">
            <div className="auto-metric"><strong>Last run</strong><span>{lastRun ? `${statusLabel(lastRun.status)} · ${formatRelative(lastRun.scheduledFor, Date.now())}` : usageUnavailable ? 'Run history unavailable' : definition.lastRunAt !== undefined ? `${formatDate(definition.lastRunAt)} · status unavailable` : usageLoading ? 'Loading…' : 'No runs yet'}</span></div>
            <div className="auto-metric"><strong>Est. spend</strong><span className={usage.cost === null ? 'auto-usage-missing' : ''}>{usageLoading ? 'Loading…' : usageCostLabel(usage)}</span></div>
            <div className="auto-metric"><strong>Tokens</strong><span className={usage.tokens === null ? 'auto-usage-missing' : ''}>{usageLoading ? 'Loading…' : usageTokensLabel(usage)}</span></div>
            <div className="auto-metric"><strong>Usage coverage</strong><span>{usageLoading ? 'Loading run history…' : usageCoverageLabel(usage)}</span></div>
          </div>
          {history.error && <div className="auto-warning" role="status">Run history is unavailable from this host. This does not mean the automation failed or has no runs. {history.error}</div>}
          <section className="auto-prompt-disclosure"><div className="auto-section-heading"><strong>Prompt</strong><Button aria-expanded={promptExpanded} onClick={() => setPromptExpanded(!promptExpanded)}>{promptExpanded ? 'Show less' : 'Show more'}</Button></div><pre>{promptExpanded ? definition.prompt : definition.prompt.slice(0, 400)}{!promptExpanded && definition.prompt.length > 400 ? '…' : ''}</pre></section>
        </>}
        {navigation.tab === 'runs' && <section aria-label="Run history"><div className="auto-section-heading"><h2>Run history</h2><span>{history.loaded ? `${history.runs.length} loaded` : ''}</span></div>
          {history.loading && history.runs.length === 0 && <div className="auto-info" role="status">Loading runs…</div>}
          {history.error && <div className="auto-error" role="alert">Run history is unavailable from this host. This does not mean the automation failed or has no runs. {history.error} <Button onClick={() => setHistoryRetry((current) => current + 1)}>Retry</Button></div>}
          {history.loaded && history.runs.length === 0 && <EmptyState message="No runs yet." />}
          {historyRows.length > 0 && <div className="auto-table-wrap"><table className="auto-table" aria-label="Run history"><thead><tr><th>Run</th><th>Workspace</th><th>Spend</th><th>Tokens</th><th>Status</th></tr></thead><tbody>
            {historyRows.map((run, index) => {
              const usage = summarizeUsage([run])
              const occurrence = foldedOccurrences(run)
              return <tr key={run.id} ref={(element) => { if (element) historyElements.current.set(run.id, element); else historyElements.current.delete(run.id) }} tabIndex={0} aria-selected={selectedHistoryRun?.id === run.id} onFocus={() => setSelectedHistoryIndex(index)} onClick={() => runPage(run)} onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const nextIndex = Math.max(0, Math.min(historyRows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
                  setSelectedHistoryIndex(nextIndex)
                  const nextRun = historyRows[nextIndex]
                  if (nextRun) historyElements.current.get(nextRun.id)?.focus()
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  runPage(run)
                }
              }}>
                <td>{run.title}<span className="auto-cell-sub">{formatDate(run.scheduledFor, definition.timezone)} · {run.trigger}{occurrence ? ` · ${occurrence.count} times, most recently ${formatDate(occurrence.latestAt, definition.timezone)}` : ''}</span></td>
                <td>{runWorkspace(run)}</td><td>{usageCostLabel(usage)}</td><td>{usageTokensLabel(usage)}</td><td><AutomationRunStatus status={run.status} /></td>
              </tr>
            })}
          </tbody></table></div>}
          {historyStarts.length > 1 && <Button onClick={() => { setHistoryStarts((current) => current.slice(0, -1)); setSelectedHistoryIndex(0) }}>Show newer runs</Button>}
          {history.runs.length > runWindowStart + RUN_RENDER_LIMIT && <Button onClick={() => {
            const maximumStart = Math.max(0, history.runs.length - RUN_RENDER_LIMIT)
            setHistoryStarts((current) => {
              const currentStart = current[current.length - 1] ?? 0
              return currentStart < maximumStart ? [...current, Math.min(currentStart + RUN_PAGE_SIZE, maximumStart)] : current
            })
            setSelectedHistoryIndex(0)
          }}>Show older runs</Button>}
          {history.cursor && <Button disabled={history.loading} onClick={() => void loadMoreHistory()}>{history.loading ? 'Loading…' : 'Load older runs'}</Button>}
          {history.runs.length > RUN_RENDER_LIMIT && <p className="auto-muted">At most {RUN_RENDER_LIMIT} run rows are mounted at once.</p>}
        </section>}
      </>}
      {actionError && <div className="auto-error" role="alert">{actionError}</div>}
    </main>
  }

  const renderDashboard = () => {
    const visibleRuns = dashboardResult.runs.slice(0, dashboardVisibleCount)
    const names = new Map(data.definitions.map((definition) => [definition.id, definition.name]))
    const hostForRun = (run: AutomationRun) => {
      const projectId = typeof run.runContext?.projectId === 'string' ? run.runContext.projectId : data.definitions.find((definition) => definition.id === run.automationId)?.projectId
      const hostId = data.editorData?.projects.find((project) => project.id === projectId)?.hostId
        ?? (typeof run.runContext?.hostId === 'string' ? run.runContext.hostId : null)
      return { id: hostId ?? 'unknown', label: hostLabel(data.editorData, hostId) }
    }
    const dashboardHosts = [...new Map(data.definitions.map((definition) => {
      const hostId = getAutomationHostId(definition, data.editorData)
      return [hostId ?? 'unknown', { id: hostId ?? 'unknown', label: hostLabel(data.editorData, hostId) }] as const
    })).values()]
    return <main className="auto-automations" aria-label="Automation runs">
      <div className="auto-breadcrumb"><Button onClick={() => void navigate({ page: 'list', runId: null, automationId: null })}>Automations</Button><span>›</span><span>Runs</span></div>
      <header className="auto-page-header"><div><h1>Runs</h1><span className="auto-cell-sub">Recent automation activity and outcomes.</span></div><div className="auto-toolbar"><Button disabled={refreshing} onClick={() => void refreshAll()} aria-label="Refresh runs">{refreshing ? 'Refreshing…' : 'Refresh runs'}</Button><Button onClick={() => void navigate({ page: 'list', runId: null, automationId: null })}>Back to automations</Button></div></header>
      {data.nativeError && <div className="auto-error" role="alert">Automations could not be loaded; run history cannot be described reliably. {data.nativeError} <Button onClick={() => void refreshAll()}>Retry</Button></div>}
      {data.dashboardErrors.length > 0 && <div className="auto-warning" role="status">Run history is unavailable for {data.dashboardErrors.length} automation{data.dashboardErrors.length === 1 ? '' : 's'}. Counts include available history only.</div>}
      <div className="auto-dashboard-cards" aria-label="Run summary">
        <div className="auto-dashboard-card"><span>Successful · 24h</span><strong>{dashboardMetrics.successful24h}</strong></div>
        <div className="auto-dashboard-card"><span>Failed · 24h</span><strong>{dashboardMetrics.failed24h}</strong></div>
        <div className="auto-dashboard-card"><span>Successful · 7d</span><strong>{dashboardMetrics.successful7d}</strong></div>
        <div className="auto-dashboard-card"><span>Failed · 7d</span><strong>{dashboardMetrics.failed7d}</strong></div>
      </div>
      <div className="auto-toolbar">
        <TextField label="Search runs" className="auto-search" type="search" placeholder="Search runs…" aria-label="Search runs" value={navigation.runQuery} onChange={(event) => void navigate({ runQuery: event.target.value })} />
        {dashboardResult.tooLong && <span title="Search text is too long — runs are unfiltered" className="auto-warning" role="status">Too long</span>}
        <details className="auto-filter-menu"><summary>Filters{dashboardFilterCount ? ` (${dashboardFilterCount})` : ''}</summary><div className="auto-filter-panel"><div><strong>Host</strong><div className="auto-filter-choices"><Button aria-pressed={navigation.host === 'all'} onClick={() => void navigate({ host: 'all' })}>All hosts</Button>{dashboardHosts.map((host) => <Button key={host.id} aria-pressed={navigation.host === host.id} onClick={() => void navigate({ host: host.id })}>{host.label}</Button>)}</div></div>
          <FormRow label="Status" htmlFor="auto-runs-status">
            <select id="auto-runs-status" aria-label="Filter runs by status" value={navigation.runStatus} onChange={(event) => void navigate({ runStatus: event.target.value as AutomationNavigation['runStatus'] })}><option value="all">All statuses</option><option value="successful">Successful</option><option value="failed">Failed</option><option value="progress">In progress</option><option value="skipped">Skipped</option></select>
          </FormRow>
        </div></details>
      </div>
      <div className="auto-filter-pills">{navigation.host !== 'all' && <Button className="auto-pill" aria-label={`Remove ${activeHostLabel} filter`} onClick={() => void navigate({ host: 'all' })}>Host: {activeHostLabel} ×</Button>}{navigation.runStatus !== 'all' && <Button className="auto-pill" aria-label={`Remove ${navigation.runStatus} filter`} onClick={() => void navigate({ runStatus: 'all' })}>Status: {navigation.runStatus} ×</Button>}{dashboardFilterCount > 0 && <Button onClick={() => void navigate({ host: 'all', runStatus: 'all' })}>Clear filters</Button>}</div>
      {data.dashboardLoading && data.dashboardRuns.length === 0 && <div className="auto-info" role="status">Loading runs…</div>}
      {data.dashboardLoaded && data.dashboardRuns.length === 0 && data.dashboardErrors.length === 0 && <EmptyState message="No runs yet. Runs appear here after an automation is triggered." />}
      {data.dashboardLoaded && data.dashboardRuns.length > 0 && dashboardResult.runs.length === 0 && <EmptyState message={navigation.runQuery && !dashboardResult.tooLong ? 'No runs match your search.' : 'No runs match your filters.'} />}
      {visibleRuns.length > 0 && <div className="auto-table-wrap"><table className="auto-table" aria-label="Automation runs"><thead><tr><th>Automation</th><th>Triggered</th><th>Trigger</th><th>Host</th><th>Status</th></tr></thead><tbody>
        {visibleRuns.map((run) => {
          const host = hostForRun(run)
          return <tr key={run.id} tabIndex={0} onClick={() => runPage(run)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); runPage(run) } }}>
            <td>{names.get(run.automationId) ?? 'Unknown automation'}<span className="auto-cell-sub">{run.title}</span></td><td>{formatDate(run.scheduledFor)}<span className="auto-cell-sub">{formatRelative(run.scheduledFor, Date.now())}</span></td><td>{run.trigger}</td><td>{host.label}</td><td><AutomationRunStatus status={run.status} /></td>
          </tr>
        })}
      </tbody></table></div>}
      {dashboardResult.runs.length > dashboardVisibleCount && <Button onClick={() => setDashboardVisibleCount((current) => Math.min(dashboardResult.runs.length, current + DASHBOARD_RENDER_LIMIT))}>Load more runs</Button>}
      {data.dashboardErrors.length > 0 && <Button onClick={() => void refreshAll()}>Retry run history</Button>}
      {actionError && <div className="auto-error" role="alert">{actionError}</div>}
    </main>
  }

  const renderRunDetail = () => {
    const run = runDetail.run
    const content = run ? runContent(run) : null
    const dashboardName = run ? data.definitions.find((definition) => definition.id === run.automationId)?.name : null
    const rerunnable = run !== null && canRerun(run.status)
    const runTarget = run ? targetChecks[run.automationId] : undefined
    const currentAgent = run ? launchSummary(run, data.editorData) : ''
    const runHostId = run ? getAutomationHostId(runAutomation, data.editorData) ?? (typeof run.runContext?.hostId === 'string' ? run.runContext.hostId : null) : null
    const runHost = hostLabel(data.editorData, runHostId)
    return <main className="auto-automations" aria-label="Run details">
      <div className="auto-breadcrumb"><Button onClick={() => void navigate({ page: 'list', runId: null, automationId: null })}>Automations</Button><span>›</span><Button onClick={() => navigation.automationId ? void navigate({ page: 'detail', automationId: navigation.automationId, runId: null, tab: 'runs' }) : void navigate({ page: 'runs', runId: null, automationId: null })}>{dashboardName ?? 'Runs'}</Button><span>›</span><span>Run details</span></div>
      {runDetail.loading && !run && <div className="auto-info" role="status">Loading run…</div>}
      {runDetail.loading && run && <div className="auto-info" role="status">Refreshing run and navigation availability…</div>}
      {runDetail.error && <div className="auto-error" role="alert">Run details are unavailable. {runDetail.error} <Button onClick={() => setRunRetry((current) => current + 1)}>Retry</Button></div>}
      {run && <>
        <header className="auto-run-header"><div><h1>{run.title}</h1><span className="auto-cell-sub">{formatDate(run.scheduledFor)} · Quirky · {runHost} · {runWorkspace(run)}{currentAgent ? ` · ${currentAgent}` : ''}</span></div>
          <div className="auto-toolbar"><AutomationRunStatus status={run.status} />{rerunnable && <Button variant="primary" disabled={rerunPending || busyAction !== null || runAutomation?.owner?.kind !== 'local' || runTarget?.available !== true} title={runTarget?.error ?? (runAutomation?.owner?.kind !== 'local' ? 'Only locally owned automations can be rerun from this client.' : undefined)} onClick={() => void rerun(run)}>{rerunPending ? 'Queueing…' : 'Rerun'}</Button>}{runOpenTarget && <Button onClick={openRunTarget}>{runOpenTarget.kind === 'session' ? 'View run' : 'Open workspace'}</Button>}</div>
        </header>
        {rerunnable && runTarget?.available === false && runTarget.error !== 'Checking target availability…' && <div className="auto-warning" role="status">Rerun unavailable: {runTarget.error}</div>}
        <div className="auto-metric-grid"><div className="auto-metric"><strong>Scheduled for</strong><span>{formatDate(run.scheduledFor)}</span></div><div className="auto-metric"><strong>Trigger</strong><span>{run.trigger}</span></div><div className="auto-metric"><strong>Workspace</strong><span>{runWorkspace(run)}</span></div><div className="auto-metric"><strong>Agent / launch</strong><span>{currentAgent || 'Unavailable'}</span></div></div>
        {content?.annotation && <div className="auto-info">{content.annotation}. The saved output may not include the full run transcript.</div>}
        {content && <section className="auto-run-output" aria-label="Saved run output"><SafeMarkdown content={content.content} /></section>}
        {!runOpenTarget && run.workspaceId && runOpenError && <div className="auto-warning" role="status">No workspace or session navigation link is available. {runOpenError} <Button onClick={() => setRunRetry((current) => current + 1)}>Retry availability check</Button></div>}
        {!runOpenTarget && run.workspaceId && !runOpenError && !runOpenTarget && <div className="auto-muted">No extant structured session or workspace is available for navigation.</div>}
      </>}
      {actionError && <div className="auto-error" role="alert">{actionError}</div>}
    </main>
  }

  return <>
    {navigation.page === 'detail' ? renderDetail() : navigation.page === 'runs' ? renderDashboard() : navigation.page === 'run' ? renderRunDetail() : renderList()}
    {deleteDialog && <div className="auto-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyAction) setDeleteDialog(null) }}>
      {deleteDialog.kind === 'native' ? <section className="auto-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-delete-title" onKeyDown={stopKeyboardPropagation}>
        <h2 id="auto-delete-title">Delete Automation</h2><p>Delete {deleteDialog.definition.name} and its run history. Workspaces created by previous runs are not deleted.</p>
        <div className="auto-info">{deleteDialog.definition.workspaceMode === 'new_per_run' ? 'New workspace each run' : `Selected workspace: ${detailWorkspace(deleteDialog.definition, data.editorData)}`}</div>
        <FormRow label="Don’t ask again" htmlFor="auto-delete-skip-next">
          <input id="auto-delete-skip-next" type="checkbox" checked={deleteDialog.skipNextTime} onChange={(event) => setDeleteDialog({ ...deleteDialog, skipNextTime: event.target.checked, error: null })} />
        </FormRow>
        {deleteDialog.error && <div className="auto-error" role="alert">{deleteDialog.error}</div>}
        <div className="auto-dialog-actions"><Button disabled={busyAction !== null} onClick={() => setDeleteDialog(null)}>Cancel</Button><Button variant="destructive" disabled={busyAction !== null} onClick={() => void confirmNativeDelete()}>{busyAction?.startsWith('delete:') ? 'Deleting…' : 'Delete'}</Button></div>
      </section> : <section className="auto-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-external-delete-title" onKeyDown={stopKeyboardPropagation}>
        <h2 id="auto-external-delete-title">Delete External Automation</h2><p>Delete {deleteDialog.job.name || deleteDialog.job.id} from {deleteDialog.manager.label}? This changes the OpenClaw job only and does not remove native automation history.</p>
        <div className="auto-info">External jobs are managed by OpenClaw on the local host. The manager must remain available to confirm the captured owner.</div>
        {deleteDialog.error && <div className="auto-error" role="alert">{deleteDialog.error}</div>}
        <div className="auto-dialog-actions"><Button disabled={busyAction !== null} onClick={() => setDeleteDialog(null)}>Cancel</Button><Button variant="destructive" disabled={busyAction !== null} onClick={() => void externalAction(deleteDialog.manager, deleteDialog.job, 'delete')}>{busyAction?.startsWith('external:delete:') ? 'Deleting…' : 'Delete external job'}</Button></div>
      </section>}
    </div>}
  </>
}
