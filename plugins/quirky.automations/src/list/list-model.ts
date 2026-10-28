import type { AutomationRun, AutomationRunsPage, AutomationRunStatus } from '../../types'
import type { AutomationOwner } from '../../dispatch-contract'

export type AutomationListRow = {
  key: string
  id: string
  kind: 'native' | 'external'
  name: string
  projectName: string
  hostId: string
  hostName: string
  prompt: string
  agentId: string | null
  agentName: string | null
  enabled: boolean
  lastRunAt: number | null
  lastStatus: string | null
  lastRunRead: 'loading' | 'available' | 'unavailable'
}
export function sameAutomationOwner(left: AutomationOwner | null | undefined, right: AutomationOwner | null | undefined): boolean {
  if (left == null || right == null) return left === right
  return left.kind === right.kind && left.repoId === right.repoId && left.repoPath === right.repoPath
    && left.workspaceId === right.workspaceId && left.workspacePath === right.workspacePath
    && left.workspaceInstanceId === right.workspaceInstanceId
}

export type AutomationListFilters = {
  query: string
  host: string
  status: 'all' | 'enabled' | 'paused'
  lastRun: 'all' | 'failed' | 'succeeded' | 'never'
  agent: string
}

export type ListFilterResult = { rows: AutomationListRow[]; tooLong: boolean }
export const SEARCH_MAX_CHARACTERS = 512

export function isSearchTooLong(query: string): boolean {
  return Array.from(query).length > SEARCH_MAX_CHARACTERS
}

function isFailedStatus(status: string | null): boolean {
  return status === 'dispatch_failed' || status === 'failed'
}

export function filterListRows(rows: readonly AutomationListRow[], filters: AutomationListFilters): ListFilterResult {
  const tooLong = isSearchTooLong(filters.query)
  const query = tooLong ? '' : filters.query.trim().toLocaleLowerCase()
  const filtered = rows.filter((row) => {
    if (filters.host !== 'all' && row.hostId !== filters.host) return false
    if (filters.status === 'enabled' && !row.enabled) return false
    if (filters.status === 'paused' && row.enabled) return false
    if (filters.lastRun === 'never' && (row.lastRunRead !== 'available' || row.lastRunAt !== null || row.lastStatus !== null)) return false
    if (filters.lastRun === 'succeeded' && (row.lastRunRead !== 'available' || row.lastStatus !== 'completed')) return false
    if (filters.lastRun === 'failed' && (row.lastRunRead !== 'available' || !isFailedStatus(row.lastStatus))) return false
    if (filters.agent !== '' && row.agentId !== filters.agent) return false
    if (!query) return true
    return [row.name, row.projectName, row.prompt, row.agentName ?? '', row.hostName]
      .some((value) => value.toLocaleLowerCase().includes(query))
  })
  return { rows: filtered, tooLong }
}

export type ListSort = 'name' | 'lastRun'
export type SortDirection = 'asc' | 'desc'

export function sortDirectionFor(sort: ListSort): SortDirection {
  return sort === 'name' ? 'asc' : 'desc'
}

export function toggleListSort(currentSort: ListSort, currentDirection: SortDirection, requested: ListSort): { sort: ListSort; direction: SortDirection } {
  if (currentSort === requested) return { sort: requested, direction: currentDirection === 'asc' ? 'desc' : 'asc' }
  return { sort: requested, direction: sortDirectionFor(requested) }
}

export function sortListRows(rows: readonly AutomationListRow[], sort: ListSort, direction: SortDirection): AutomationListRow[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    if (sort === 'name') return sign * (left.name.localeCompare(right.name) || left.key.localeCompare(right.key))
    const leftHasRun = left.lastRunAt !== null
    const rightHasRun = right.lastRunAt !== null
    if (leftHasRun !== rightHasRun) return leftHasRun ? -1 : 1
    if (left.lastRunAt !== null && right.lastRunAt !== null && left.lastRunAt !== right.lastRunAt) {
      return sign * (left.lastRunAt - right.lastRunAt)
    }
    return left.name.localeCompare(right.name) || left.key.localeCompare(right.key)
  })
}

export type DashboardStatus = 'successful' | 'failed' | 'progress' | 'skipped' | 'other'

export function dashboardStatusBucket(status: string): DashboardStatus {
  if (status === 'completed') return 'successful'
  if (status === 'dispatch_failed') return 'failed'
  if (status === 'pending' || status === 'dispatching' || status === 'dispatched') return 'progress'
  if (status.startsWith('skipped_')) return 'skipped'
  return 'other'
}

export type DashboardMetrics = {
  successful24h: number
  failed24h: number
  successful7d: number
  failed7d: number
}

const DAY_MS = 86_400_000

export function summarizeDashboardRuns(runs: readonly AutomationRun[], now: number): DashboardMetrics {
  const metrics: DashboardMetrics = { successful24h: 0, failed24h: 0, successful7d: 0, failed7d: 0 }
  for (const run of runs) {
    if (run.scheduledFor > now) continue
    const bucket = dashboardStatusBucket(run.status)
    if (run.scheduledFor >= now - DAY_MS) {
      if (bucket === 'successful') metrics.successful24h++
      if (bucket === 'failed') metrics.failed24h++
    }
    if (run.scheduledFor >= now - 7 * DAY_MS) {
      if (bucket === 'successful') metrics.successful7d++
      if (bucket === 'failed') metrics.failed7d++
    }
  }
  return metrics
}

export type UsageSummary = {
  kind: 'no-runs' | 'not-yet' | 'unavailable' | 'known'
  knownRuns: number
  totalRuns: number
  cost: number | null
  tokens: number | null
  costRuns: number
  tokenRuns: number
  partialTokenRuns: number
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function emptyUsageSummary(kind: 'no-runs' | 'not-yet' | 'unavailable', totalRuns: number): UsageSummary {
  return { kind, knownRuns: 0, totalRuns, cost: null, tokens: null, costRuns: 0, tokenRuns: 0, partialTokenRuns: 0 }
}

export function summarizeUsage(runs: readonly AutomationRun[]): UsageSummary {
  if (runs.length === 0) return emptyUsageSummary('no-runs', 0)
  let cost = 0
  let costRuns = 0
  let tokens = 0
  let tokenRuns = 0
  let partialTokenRuns = 0
  let knownRuns = 0
  for (const run of runs) {
    const usage = run.usage
    if (usage === null || usage === undefined || usage.status !== 'known') continue
    const costValue = finiteNumber(usage.estimatedCostUsd)
    let tokenValue = finiteNumber(usage.totalTokens)
    let partialTokens = false
    if (tokenValue === null) {
      const inputTokens = finiteNumber(usage.inputTokens)
      const outputTokens = finiteNumber(usage.outputTokens)
      if (inputTokens !== null && outputTokens !== null) tokenValue = inputTokens + outputTokens
      else if (inputTokens !== null) {
        tokenValue = inputTokens
        partialTokens = true
      } else if (outputTokens !== null) {
        tokenValue = outputTokens
        partialTokens = true
      }
    }
    let runHasUsage = false
    if (costValue !== null) {
      cost += costValue
      costRuns++
      runHasUsage = true
    }
    if (tokenValue !== null) {
      tokens += tokenValue
      tokenRuns++
      if (partialTokens) partialTokenRuns++
      runHasUsage = true
    }
    if (runHasUsage) knownRuns++
  }
  if (knownRuns === 0) {
    const allStillRunning = runs.every((run) => run.status === 'pending' || run.status === 'dispatching' || run.status === 'dispatched')
    return emptyUsageSummary(allStillRunning && runs.every((run) => run.usage == null) ? 'not-yet' : 'unavailable', runs.length)
  }
  return {
    kind: 'known',
    knownRuns,
    totalRuns: runs.length,
    cost: costRuns === 0 ? null : cost,
    tokens: tokenRuns === 0 ? null : tokens,
    costRuns,
    tokenRuns,
    partialTokenRuns
  }
}

export type RunContentSource = 'output' | 'precheck' | 'error' | 'usage' | 'empty'
export type RunContent = { source: RunContentSource; content: string; truncated: boolean; annotation: string | null }

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function runContent(run: AutomationRun): RunContent {
  const snapshot = run.outputSnapshot
  if (snapshot && typeof snapshot.content === 'string' && snapshot.content.trim() !== '') {
    return {
      source: 'output', content: snapshot.content, truncated: snapshot.truncated === true,
      annotation: snapshot.truncated === true ? 'Latest saved output' : null
    }
  }
  const precheck = run.precheckResult
  if (precheck) {
    const stderr = text(precheck.stderr)
    const stdout = text(precheck.stdout)
    const content = stderr && stdout ? `${stderr}\n\n${stdout}` : stderr ?? stdout
    if (content) return { source: 'precheck', content, truncated: precheck.stderrTruncated === true || precheck.stdoutTruncated === true, annotation: null }
  }
  const error = text(run.error)
  if (error) return { source: 'error', content: error, truncated: false, annotation: null }
  const usageMessage = run.usage
    ? [
        text(run.usage.unavailableReason),
        text(run.usage.costUnavailableReason),
        text(run.usage.tokensUnavailableReason)
      ].filter((reason, index, reasons): reason is string => reason !== null && reasons.indexOf(reason) === index).join('\n\n')
    : ''
  if (usageMessage) return { source: 'usage', content: usageMessage, truncated: false, annotation: null }
  return { source: 'empty', content: 'No output content available.', truncated: false, annotation: null }
}

const RERUN_STATUSES: Partial<Record<AutomationRunStatus, true>> = {
  dispatch_failed: true,
  skipped_unavailable: true,
  skipped_needs_interactive_auth: true
}

export function canRerun(status: string): boolean {
  return RERUN_STATUSES[status as AutomationRunStatus] === true
}

export function foldedOccurrences(run: AutomationRun): { count: number; latestAt: number } | null {
  const count = Number.isSafeInteger(run.occurrenceCount) ? Math.max(1, run.occurrenceCount) : 1
  return count > 1 ? { count, latestAt: run.lastOccurrenceAt ?? run.scheduledFor } : null
}

export function appendRunPage(existing: readonly AutomationRun[], page: AutomationRunsPage): { runs: AutomationRun[]; nextCursor: string | null } {
  const seen = new Set(existing.map((run) => run.id))
  const runs = [...existing]
  for (const run of page.runs) {
    if (seen.has(run.id)) continue
    seen.add(run.id)
    runs.push(run)
  }
  return { runs, nextCursor: page.nextCursor }
}

export type SafeInlineToken =
  | { type: 'text'; value: string }
  | { type: 'strong' | 'emphasis' | 'code'; value: string }
  | { type: 'link'; value: string; href: string }

function safeHref(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

export function parseSafeMarkdownInline(source: string): SafeInlineToken[] {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g
  const tokens: SafeInlineToken[] = []
  const pushText = (value: string) => {
    if (!value) return
    const previous = tokens[tokens.length - 1]
    if (previous?.type === 'text') previous.value += value
    else tokens.push({ type: 'text', value })
  }
  let offset = 0
  for (const match of source.matchAll(pattern)) {
    const value = match[0]
    const start = match.index ?? offset
    pushText(source.slice(offset, start))
    if (value.startsWith('**') && value.endsWith('**')) tokens.push({ type: 'strong', value: value.slice(2, -2) })
    else if (value.startsWith('__') && value.endsWith('__')) tokens.push({ type: 'strong', value: value.slice(2, -2) })
    else if (value.startsWith('`') && value.endsWith('`')) tokens.push({ type: 'code', value: value.slice(1, -1) })
    else if (value.startsWith('*') && value.endsWith('*')) tokens.push({ type: 'emphasis', value: value.slice(1, -1) })
    else if (value.startsWith('_') && value.endsWith('_')) tokens.push({ type: 'emphasis', value: value.slice(1, -1) })
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      if (link && safeHref(link[2]!)) tokens.push({ type: 'link', value: link[1]!, href: link[2]! })
      else pushText(value)
    }
    offset = start + value.length
  }
  pushText(source.slice(offset))
  return tokens
}
