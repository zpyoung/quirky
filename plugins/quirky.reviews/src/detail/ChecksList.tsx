import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, EmptyState, InlineError, NoticeLine, SectionHeader, StatusDot } from '@quirky/ui'
import { CHECKS_PANEL, REVIEW_VIEW, type JsonRecord, type ReviewsSurfaceProps } from '../contracts'
import { isRecord, parseCheckDetail, parseChecksResult, reviewContext, safeHttpUrl, type CheckDetail, type ReviewContext } from './data'
import { registerReviewsUiControl, requestReviewsUiControl, type ReviewsUiControlRequest } from '../checks/data'

export type ChecksListProps = ReviewsSurfaceProps & { surface: 'detail' | 'checks'; compact?: boolean }
type CheckRow = JsonRecord & { kind: string; name: string; status: string; conclusion: string | null; url: string | null; checkRunId: number | null; workflowRunId: number | null; suiteId: number | null }
type Severity = 'failure' | 'action' | 'pending' | 'success' | 'neutral'

function severity(check: CheckRow): Severity {
  const status = check.status.toLowerCase()
  const conclusion = (check.conclusion ?? '').toLowerCase()
  if (['action_required', 'action required'].includes(conclusion)) return 'action'
  if (['failure', 'error', 'startup_failure', 'timed_out', 'cancelled'].includes(conclusion)
    || ['failure', 'error', 'action_required'].includes(status)) return 'failure'
  if (status !== 'completed' || ['pending', 'queued', 'in_progress', 'requested', 'waiting'].includes(conclusion)) return 'pending'
  if (['success', 'skipped'].includes(conclusion) || ['success', 'passed'].includes(status)) return 'success'
  return 'neutral'
}

function severityRank(value: Severity): number {
  return value === 'failure' ? 0 : value === 'action' ? 1 : value === 'pending' ? 2 : value === 'success' ? 3 : 4
}


function summaryLabel(checks: CheckRow[] | null, rollup: unknown): string {
  if (checks === null) return 'Checks unavailable'
  if (checks.length === 0) return 'No checks found'
  const failures = checks.filter((check) => severity(check) === 'failure').length
  const actions = checks.filter((check) => severity(check) === 'action').length
  const pending = checks.filter((check) => severity(check) === 'pending').length
  const passed = checks.filter((check) => severity(check) === 'success').length
  if (failures > 0) return `${failures} check${failures === 1 ? '' : 's'} failing`
  if (actions > 0) return `${actions} check${actions === 1 ? '' : 's'} need${actions === 1 ? 's' : ''} action`
  if (pending > 0) return `${pending} check${pending === 1 ? '' : 's'} pending`
  if (rollup === 'success' || passed === checks.length) return 'All checks passing'
  if (passed > 0) return `${passed} of ${checks.length} checks passing`
  return 'Checks need attention'
}

function checkKey(check: CheckRow): string {
  return check.checkRunId !== null ? `check:${check.checkRunId}`
    : check.workflowRunId !== null ? `workflow:${check.workflowRunId}`
      : `${check.kind}:${check.name}`
}

function dateLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function outputFields(value: unknown): { title: string | null; summary: string | null; text: string | null } {
  if (!isRecord(value)) return { title: null, summary: null, text: null }
  return {
    title: typeof value.title === 'string' ? value.title : null,
    summary: typeof value.summary === 'string' ? value.summary : null,
    text: typeof value.text === 'string' ? value.text : null,
  }
}

function jobIsFailed(job: JsonRecord): boolean {
  const conclusion = typeof job.conclusion === 'string' ? job.conclusion.toLowerCase() : ''
  return ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(conclusion)
}

function lastErrorLine(text: string): number {
  const rows = text.split('\n')
  let result = -1
  const pattern = /##\[error\]|::error|error:|FAILED|exit code|ENOENT|EACCES|panic:|AssertionError/i
  for (let index = 0; index < rows.length; index += 1) if (pattern.test(rows[index] ?? '')) result = index
  return result
}

function viewParams(owner: ReviewContext) {
  return { surface: owner.surface, worktree: owner.worktree, number: owner.number, ...(owner.repo === null ? {} : { prRepo: owner.repo }) }
}

function detailMap(state: JsonRecord | null, checkRunId: number): CheckDetail | null {
  if (!isRecord(state) || !isRecord(state.detailsById)) return null
  const value = state.detailsById[String(checkRunId)]
  return parseCheckDetail(value, checkRunId)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function controlValue(request: ReviewsUiControlRequest, keys: string[]) {
  const value = request.value ?? {}
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid check control arguments.')
  return value
}

type ChecksLease = { target: string; generation: number; active: boolean; changed(): void; dispose(): void }

export function ChecksList(props: ChecksListProps) {
  const owner = reviewContext(props.state, props.surface)
  const checksValue = props.surface === 'detail' ? props.state.detail.checks : props.state.checks.checks
  const parsedChecks = owner === null || checksValue === null ? null : parseChecksResult(checksValue, owner.number)
  const rows = parsedChecks?.checks as CheckRow[] | undefined ?? null
  const malformedChecks = checksValue !== null && parsedChecks === null
  const activeLoading = props.surface === 'detail' ? props.state.detail.loading : props.state.checks.loading
  const activeError = props.surface === 'detail' ? props.state.detail.error : props.state.checks.error
  const expanded = props.surface === 'detail' ? props.state.detail.expandedChecks : props.state.checks.expandedChecks
  const expandedSummary = !(props.surface === 'detail' ? props.state.detail.checksCollapsed : props.state.checks.checksCollapsed)
  const surfaceId = props.surface === 'checks' ? CHECKS_PANEL : REVIEW_VIEW
  const repo = owner?.repo
  const head = owner?.review?.headRefOid ?? null
  const headValid = typeof head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)
  const target = JSON.stringify([surfaceId, 'checks-list', owner?.worktree ?? null,
    repo ? { host: repo.host, owner: repo.owner, repo: repo.repo } : null, owner?.number ?? null, head, null])
  const ownerKey = JSON.stringify([target, owner?.generation, Boolean(props.compact)])
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const pendingActionRef = useRef<string | null>(null)
  const actionTokenRef = useRef(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [autoRefreshing, setAutoRefreshing] = useState(false)
  const autoRefreshingRef = useRef(false)
  const attemptedAutoRefreshRef = useRef(new Set<string>())
  const activeLoadsRef = useRef(new Set<string>())
  const [loadingCheckRunIds, setLoadingCheckRunIds] = useState(new Set<string>())
  const [checkDetailErrors, setCheckDetailErrors] = useState(new Map<string, string>())
  const pendingExpandIntentRef = useRef(new Map<string, boolean>())
  const registration = useRef<ChecksLease | null>(null)
  const [generation, setGeneration] = useState<number>()
  const current = useRef<{
    actions(): Array<{ action: string; enabled: boolean }>
    run(request: ReviewsUiControlRequest, isCurrent: () => boolean): unknown | Promise<unknown>
  } | null>(null)
  const checksForView = useMemo(() => [...(rows ?? [])].sort((left, right) => severityRank(severity(left)) - severityRank(severity(right))), [rows])
  const renderedChecks = checksForView.slice(0, props.compact ? 5 : 100)
  const failedCount = checksForView.filter((check) => severity(check) === 'failure' || severity(check) === 'action').length
  const actionableCount = checksForView.filter((check) => check.kind === 'check_run' && (check.workflowRunId !== null || check.checkRunId !== null)).length
  const detailRequest = owner === null ? null : viewParams(owner)
  const checkDetails = (id: number) => detailMap(checksValue, id)
  const detailKey = (id: number) => `${ownerKey}:${id}`
  useLayoutEffect(() => { current.current = { actions, run } })

  useLayoutEffect(() => {
    pendingActionRef.current = null
    actionTokenRef.current += 1
    autoRefreshingRef.current = false
    activeLoadsRef.current.clear()
    pendingExpandIntentRef.current.clear()
    setPendingAction(null)
    setActionError(null)
    setAutoRefreshing(false)
    setLoadingCheckRunIds(new Set())
    setCheckDetailErrors(new Map())
    if (owner === null) { setGeneration(undefined); return }
    const control = registerReviewsUiControl(props.context, {
      surface: surfaceId, slot: 'checks-list', target,
      actions: () => current.current!.actions(),
      run: (request, leaseIsCurrent) => current.current!.run(request, leaseIsCurrent),
    })
    const lease = { ...control, target, active: true }
    registration.current = lease
    setGeneration(control.generation)
    return () => {
      lease.active = false
      lease.dispose()
      if (registration.current === lease) registration.current = null
    }
  }, [props.context, ownerKey])

  useEffect(() => {
    if (props.surface !== 'detail' || owner === null || checksValue !== null || activeLoading || !headValid
      || pendingActionRef.current !== null || attemptedAutoRefreshRef.current.has(ownerKey)) return
    attemptedAutoRefreshRef.current.add(ownerKey)
    autoRefreshingRef.current = true
    setAutoRefreshing(true)
    const lease = registration.current
    const isCurrent = () => lease !== null && lease.active && registration.current === lease
    void props.context.call('quirky.reviews/detailRefreshChecks', viewParams(owner))
      .catch((cause: unknown) => { if (isCurrent()) setActionError(errorText(cause)) })
      .finally(() => {
        if (isCurrent()) { autoRefreshingRef.current = false; setAutoRefreshing(false) }
      })
  }, [props.context, props.surface, ownerKey, checksValue, activeLoading, headValid])

  const requestControl = async (action: string, value?: Record<string, unknown>) => {
    const lease = registration.current
    if (lease === null || lease.target !== target) return
    const isCurrent = () => registration.current === lease && lease.active && lease.generation === generation
    try {
      const result = await requestReviewsUiControl(props.context, {
        target, generation: lease.generation, action, ...(value === undefined ? {} : { value }),
      })
      if (!result.delivered && isCurrent()) setActionError(result.reason === 'target-unavailable'
        ? 'Target review control is no longer available.' : result.reason === 'disabled'
          ? 'That review control is currently disabled.' : 'Unsupported review control action.')
    } catch (cause) { if (isCurrent()) setActionError(errorText(cause)) }
  }

  const perform = async (action: string, isCurrent: () => boolean, operation: () => Promise<unknown>) => {
    if (pendingActionRef.current !== null || !isCurrent()) return
    pendingActionRef.current = action
    const token = ++actionTokenRef.current
    setPendingAction(action)
    setActionError(null)
    try {
      const value = await operation()
      if (!isCurrent() || token !== actionTokenRef.current) return
      if (isRecord(value) && value.refreshed === false && typeof value.refreshError === 'string') setActionError(value.refreshError)
      if (action === 'summary-toggle') await props.refresh()
    } catch (cause) { if (isCurrent() && token === actionTokenRef.current) setActionError(errorText(cause)) }
    finally {
      if (isCurrent() && token === actionTokenRef.current) { pendingActionRef.current = null; setPendingAction(null) }
    }
  }

  const actions = () => {
    const idle = pendingActionRef.current === null
    return [
      { action: 'refresh', enabled: idle && !autoRefreshingRef.current && !activeLoading },
      { action: 'summary-toggle', enabled: idle && rows !== null },
      ...(!props.compact ? [
        { action: 'rerun-failed', enabled: idle && failedCount > 0 },
        { action: 'rerun-all', enabled: idle && actionableCount > 0 },
      ] : []),
      { action: 'fix-checks', enabled: idle && rows !== null && failedCount > 0 },
      { action: 'check-toggle', enabled: rows !== null && rows.length > 0 },
      { action: 'check-open', enabled: (rows ?? []).some((check) => safeHttpUrl(check.url) !== null) },
      { action: 'check-details-open', enabled: (rows ?? []).some((check) => {
        const detail = check.checkRunId !== null && expanded.includes(checkKey(check)) ? checkDetails(check.checkRunId) : null
        return detail !== null && safeHttpUrl(detail.check.detailsUrl ?? detail.check.htmlUrl ?? detail.check.url) !== null
      }) },
      { action: 'copy-job-log', enabled: (rows ?? []).some((check) => {
        const detail = check.checkRunId !== null && expanded.includes(checkKey(check)) ? checkDetails(check.checkRunId) : null
        return detail !== null && detail.logTails.some((log) => log.tail.length > 0
          && new TextEncoder().encode(log.tail).byteLength <= 1_048_576 && detail.jobs.some((job) => job.id === log.jobId))
      }) },
    ]
  }

  const run = async (request: ReviewsUiControlRequest, isCurrent: () => boolean) => {
    if (!isCurrent() || owner === null || detailRequest === null) return
    const action = request.action
    if (['refresh', 'summary-toggle', 'rerun-failed', 'rerun-all', 'fix-checks'].includes(action)) {
      const value = controlValue(request, action === 'summary-toggle' ? ['collapsed'] : [])
      if (action === 'summary-toggle' && value.collapsed !== undefined && typeof value.collapsed !== 'boolean') throw new Error('Invalid check summary state.')
      if (pendingActionRef.current !== null) return
      if (action === 'refresh' && (autoRefreshingRef.current || activeLoading)) return
      if ((action === 'rerun-failed' && (props.compact || failedCount === 0))
        || (action === 'rerun-all' && (props.compact || actionableCount === 0))
        || (action === 'fix-checks' && (rows === null || failedCount === 0))) return
      return perform(action, isCurrent, () => {
        if (action === 'refresh') return props.context.call('quirky.reviews/detailRefreshChecks', detailRequest)
        if (action === 'summary-toggle') return props.context.call('quirky.reviews/detailSetChecksCollapsed', { ...detailRequest, collapsed: value.collapsed ?? expandedSummary })
        if (action === 'fix-checks') return props.context.call('quirky.reviews/checksSetAgentDialog', {
          surface: props.surface, ...(props.surface === 'checks' ? { worktree: owner.worktree } : {}), action: 'fix',
        })
        return props.context.call('quirky.reviews/detailRerunChecks', { ...detailRequest, failedOnly: action === 'rerun-failed' })
      })
    }
    const value = controlValue(request, action === 'check-toggle' ? ['checkId', 'expanded'] : action === 'check-open' ? ['checkId']
      : action === 'copy-job-log' ? ['checkRunId', 'jobId'] : ['checkRunId'])
    if (action === 'check-toggle' || action === 'check-open') {
      if (typeof value.checkId !== 'string') throw new Error('Invalid check identity.')
      const check = rows?.find((item) => checkKey(item) === value.checkId)
      if (!check) throw new Error('That check is no longer available.')
      if (action === 'check-open') {
        const url = safeHttpUrl(check.url)
        if (url === null) throw new Error('The check link is unavailable.')
        try { await props.context.call('quirky.reviews/openLink', { url, worktree: owner.worktree }) }
        catch (cause) { if (isCurrent()) setActionError(errorText(cause)) }
        return
      }
      if (value.expanded !== undefined && typeof value.expanded !== 'boolean') throw new Error('Invalid check expansion state.')
      const id = checkKey(check)
      const next = value.expanded ?? !(pendingExpandIntentRef.current.get(id) ?? expanded.includes(id))
      if (next && check.checkRunId !== null && !headValid) {
        setActionError('A verified pull request head is required to load check details.')
        return
      }
      pendingExpandIntentRef.current.set(id, next)
      try {
        await props.context.call('quirky.reviews/detailExpandCheck', { ...detailRequest, checkId: id, expanded: next })
        if (!isCurrent() || pendingExpandIntentRef.current.get(id) !== true || !next || check.checkRunId === null || !headValid) return
        const key = detailKey(check.checkRunId)
        if (activeLoadsRef.current.has(key)) return
        activeLoadsRef.current.add(key)
        setLoadingCheckRunIds(new Set(activeLoadsRef.current))
        setCheckDetailErrors((previous) => { const errors = new Map(previous); errors.delete(key); return errors })
        try {
          await props.context.call('quirky.reviews/detailLoadCheckDetails', {
            ...detailRequest, expectedHead: head, checkRunId: check.checkRunId,
            ...(check.workflowRunId === null ? {} : { workflowRunId: check.workflowRunId }),
          })
        } catch (cause) {
          if (isCurrent()) setCheckDetailErrors((previous) => new Map(previous).set(key, errorText(cause)))
        } finally {
          if (isCurrent()) { activeLoadsRef.current.delete(key); setLoadingCheckRunIds(new Set(activeLoadsRef.current)) }
        }
      } catch (cause) { if (isCurrent()) setActionError(errorText(cause)) }
      finally {
        if (isCurrent() && pendingExpandIntentRef.current.get(id) === next) pendingExpandIntentRef.current.delete(id)
      }
      return
    }
    if (typeof value.checkRunId !== 'number' || !Number.isSafeInteger(value.checkRunId) || value.checkRunId < 1) throw new Error('Invalid check-run identity.')
    const check = rows?.find((item) => item.checkRunId === value.checkRunId && expanded.includes(checkKey(item)))
    const details = check ? checkDetails(value.checkRunId) : null
    if (details === null) throw new Error('Expanded check details are no longer available.')
    if (action === 'check-details-open') {
      const url = safeHttpUrl(details.check.detailsUrl ?? details.check.htmlUrl ?? details.check.url)
      if (url === null) throw new Error('The check detail link is unavailable.')
      try { await props.context.call('quirky.reviews/openLink', { url, worktree: owner.worktree }) }
      catch (cause) { if (isCurrent()) setActionError(errorText(cause)) }
      return
    }
    if (typeof value.jobId !== 'number' || !Number.isSafeInteger(value.jobId) || value.jobId < 1
      || !details.jobs.some((job) => job.id === value.jobId)) throw new Error('Invalid check job identity.')
    const tail = details.logTails.find((log) => log.jobId === value.jobId)?.tail
    if (typeof tail !== 'string' || tail.length === 0 || new TextEncoder().encode(tail).byteLength > 1_048_576) throw new Error('The job log excerpt is unavailable or too large.')
    try { await navigator.clipboard.writeText(tail) }
    catch (cause) { if (isCurrent()) setActionError(errorText(cause)) }
  }
  const actionKey = JSON.stringify(actions())
  useEffect(() => { registration.current?.changed() }, [actionKey, generation])
  const controlMetadata = { 'data-review-control-target': target, 'data-review-control-generation': generation }
  const errors = <>
    {actionError !== null && <InlineError message={actionError} />}
    {activeError !== null && <InlineError message={activeError} />}
    {malformedChecks && <InlineError message="Couldn’t load checks." />}
    {(parsedChecks?.partialFailures.length ?? 0) > 0 && <InlineError message={parsedChecks!.partialFailures.join(' ')} />}
  </>
  const summary = summaryLabel(rows, parsedChecks?.rollup)
  if (owner === null) return <section className="ui-stack" aria-label="Checks"><EmptyState message="No pull request is selected." /></section>
  if (rows === null) return <section className="ui-stack" aria-label="Checks" {...controlMetadata}>
    <SectionHeader title="Checks" />
    {errors}
    {activeLoading || autoRefreshing ? <EmptyState message="Loading checks…" />
      : malformedChecks || actionError !== null || activeError !== null
        ? <Button disabled={pendingAction !== null} onClick={() => void requestControl('refresh')}>Retry</Button>
        : <><EmptyState message="Check data has not been requested yet." /><Button onClick={() => void requestControl('refresh')}>Load checks</Button></>}
  </section>

  return <section className="ui-stack" aria-label="Checks" {...controlMetadata}>
    <header className="ui-cluster">
      <Button disabled={pendingAction !== null} aria-expanded={expandedSummary} onClick={() => void requestControl('summary-toggle')}>{summary}</Button>
      <Badge tone="working">{checksForView.filter((check) => severity(check) === 'success').length} passing</Badge>
      <Badge tone="failing">{checksForView.filter((check) => severity(check) === 'failure').length} failing</Badge>
      <Badge>{checksForView.filter((check) => severity(check) === 'pending').length} pending</Badge>
      <Badge tone="needs-you">{checksForView.filter((check) => severity(check) === 'action').length} unresolved</Badge>
      <Button disabled={pendingAction !== null || autoRefreshing || activeLoading} onClick={() => void requestControl('refresh')}>{pendingAction === 'refresh' ? 'Refreshing…' : 'Refresh checks'}</Button>
      {!props.compact && <Button disabled={pendingAction !== null || failedCount === 0} title={failedCount === 0 ? 'No failed checks to rerun.' : undefined} onClick={() => void requestControl('rerun-failed')}>Rerun failed</Button>}
      {!props.compact && <Button disabled={pendingAction !== null || actionableCount === 0} title={actionableCount === 0 ? 'No actionable check or workflow run is available.' : undefined} onClick={() => void requestControl('rerun-all')}>Rerun all</Button>}
      {failedCount > 0 ? <Button variant="primary" disabled={pendingAction !== null} onClick={() => void requestControl('fix-checks')}>{props.compact ? 'Fix checks' : 'Fix broken checks'}</Button> : null}
    </header>
    {errors}
    {parsedChecks?.partial === true && parsedChecks.partialFailures.length === 0 ? <NoticeLine>Check data is partial.</NoticeLine> : null}
    {parsedChecks?.truncated === true || checksForView.length > (props.compact ? 5 : 100) ? <NoticeLine>Showing the first {props.compact ? 5 : 100} checks.</NoticeLine> : null}
    {checksForView.length === 0 ? activeLoading || autoRefreshing ? <EmptyState message="Loading checks…" /> : <EmptyState message="No checks reported for this pull request." /> : null}
    {expandedSummary && renderedChecks.length > 0 ? <ol className="ui-stack" style={{ paddingInlineStart: 'var(--ui-space-24)' }}>
      {renderedChecks.map((check) => {
        const key = checkKey(check)
        const isExpanded = expanded.includes(key)
        const detail = check.checkRunId === null ? null : checkDetails(check.checkRunId)
        const loadKey = check.checkRunId === null ? '' : detailKey(check.checkRunId)
        const detailLoadError = checkDetailErrors.get(loadKey)
        const externalUrl = safeHttpUrl(check.url)
        const runIdentity = check.checkRunId ?? check.workflowRunId
        const canLoadDetails = check.checkRunId !== null && headValid
        const label = severity(check)
        const labelText = label === 'failure' ? 'Failing' : label === 'action' ? 'Action required' : label === 'pending' ? 'Pending' : label === 'success' ? 'Passing' : 'Unresolved'
        const tone = label === 'failure' ? 'failing' : label === 'action' ? 'needs-you' : label === 'success' ? 'working' : 'neutral'
        return <li key={key} className="ui-stack">
          <div className="ui-cluster" style={{ justifyContent: 'space-between' }}>
            <Button className="ui-cluster" style={{ flex: '1 1 auto', justifyContent: 'flex-start' }} aria-expanded={isExpanded} aria-label={`${check.name}: ${label}`} onClick={() => void requestControl('check-toggle', { checkId: key })}>
              <Badge tone={tone}>{labelText}</Badge><strong>{check.name}</strong><span>{check.conclusion ?? check.status}</span>
            </Button>
            {externalUrl ? <Button onClick={() => void requestControl('check-open', { checkId: key })}>Open check details</Button> : <span className="ui-text-muted">External check link unavailable</span>}
          </div>
          {isExpanded ? <div className="ui-stack">
            {check.checkRunId === null ? <NoticeLine>This status has no check-run identity or expandable job logs.</NoticeLine>
              : detail === null ? loadingCheckRunIds.has(loadKey) ? <EmptyState message="Loading check details…" />
                : detailLoadError ? <><InlineError message={detailLoadError} /><Button onClick={() => void requestControl('check-toggle', { checkId: key, expanded: true })}>Retry check details</Button></>
                  : !canLoadDetails ? <InlineError message="A verified pull request head is required to load check details." />
                    : <EmptyState message="Check details have not been requested." />
                : <CheckDetailView details={detail} checkRunId={check.checkRunId} workflowRunId={check.workflowRunId}
                  onCopy={(jobId) => { void requestControl('copy-job-log', { checkRunId: check.checkRunId, jobId }) }}
                  onOpen={() => { void requestControl('check-details-open', { checkRunId: check.checkRunId }) }} />}
            {detail !== null && detailLoadError ? <InlineError message={detailLoadError} /> : null}
            {runIdentity !== null ? <p className="ui-text-muted">Check run #{check.checkRunId ?? '—'} · workflow #{check.workflowRunId ?? '—'}</p> : null}
          </div> : null}
        </li>
      })}
    </ol> : null}
  </section>
}

function CheckDetailView(props: { details: CheckDetail; checkRunId: number; workflowRunId: number | null; onCopy(jobId: number): void; onOpen(url: string): void }) {
  const check = props.details.check
  const output = outputFields(check.output)
  const annotations = props.details.annotations.slice(0, 20)
  const jobs = props.details.jobs.slice(0, 100)
  const fullDetailsUrl = safeHttpUrl(check.detailsUrl ?? check.htmlUrl ?? check.url)
  const status = typeof check.status === 'string' ? check.status : 'Status unavailable'
  const outcome = String(check.conclusion ?? check.status).toLowerCase()
  const failed = ['failure', 'error', 'cancelled', 'timed_out', 'startup_failure'].includes(outcome)
  const dotStatus = failed ? 'failing' : ['success', 'passed'].includes(outcome) ? 'working' : 'idle'
  return <section className="ui-stack">
    <SectionHeader title={status} actions={<div className="ui-cluster">
      <StatusDot status={dotStatus} label={`Check status: ${status}`} />
      {fullDetailsUrl ? <Button onClick={() => props.onOpen(fullDetailsUrl)}>View full details</Button> : <span className="ui-text-muted">Full details link unavailable</span>}
    </div>} />
    <p className="ui-text-muted">Started: {dateLabel(check.startedAt ?? check.started_at) ?? 'Unavailable'}</p>
    <p className="ui-text-muted">Completed: {dateLabel(check.completedAt ?? check.completed_at) ?? 'Unavailable'}</p>
    <p className="ui-text-muted">Check run #{props.checkRunId}{props.workflowRunId === null ? '' : ` · Workflow run #${props.workflowRunId}`}</p>
    {output.title ? <h4>{output.title}</h4> : null}
    {output.summary ? <pre style={{ maxWidth: '100%', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{output.summary}</pre> : null}
    {output.text ? <pre style={{ maxWidth: '100%', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{output.text}</pre> : null}
    {annotations.length > 0 ? <section className="ui-stack">
      <SectionHeader title={`Annotations (${annotations.length})`} />
      <ul className="ui-stack">{annotations.map((annotation, index) => <li key={`${index}:${String(annotation.path ?? '')}`}>
        <strong>{String(annotation.title ?? annotation.annotationLevel ?? 'Annotation')}</strong>
        <span className="ui-text-muted">{String(annotation.path ?? '')}{annotation.startLine ? `:${String(annotation.startLine)}` : ''}</span>
        <p>{String(annotation.message ?? annotation.rawDetails ?? '')}</p>
      </li>)}</ul>
    </section> : null}
    {jobs.length > 0 ? <section className="ui-stack">
      <SectionHeader title={`${jobs.some(jobIsFailed) ? 'Failed jobs' : 'Jobs'} (${jobs.length})`} />
      <ul className="ui-stack">{jobs.map((job) => {
        const id = typeof job.id === 'number' ? job.id : null
        const tail = id === null ? null : props.details.logTails.find((item) => item.jobId === id) ?? null
        return <li className="ui-stack" key={id ?? String(job.name ?? 'job')}>
          <div className="ui-cluster">
            <strong>{typeof job.name === 'string' ? job.name : 'Unknown job'}</strong>
            <Badge tone={jobIsFailed(job) ? 'failing' : 'neutral'}>{String(job.conclusion ?? job.status ?? 'Unknown status')}</Badge>
          </div>
          <JobLog job={job} tail={tail?.tail ?? null} partialFailures={props.details.partialFailures} truncated={props.details.truncated} onCopy={props.onCopy} />
        </li>
      })}</ul>
    </section> : null}
    {props.details.partialFailures.length > 0 ? <InlineError message={props.details.partialFailures.join(' ')} /> : null}
    {props.details.truncated ? <NoticeLine>Some logs or job output were omitted at the provider bounds.</NoticeLine> : null}
  </section>
}

function JobLog(props: { job: JsonRecord; tail: string | null; partialFailures: string[]; truncated: boolean; onCopy(jobId: number): void }) {
  const preRef = useRef<HTMLPreElement>(null)
  const jobId = typeof props.job.id === 'number' ? props.job.id : null
  const failed = jobIsFailed(props.job)
  const failedToLoad = jobId !== null && props.partialFailures.some((message) => message.includes(String(jobId)) && message.toLowerCase().includes('log'))
  const lastError = props.tail === null ? -1 : lastErrorLine(props.tail)
  useEffect(() => {
    if (lastError < 0) return
    preRef.current?.querySelector('[data-last-error="true"]')?.scrollIntoView({ block: 'center' })
  }, [props.tail, lastError])
  const failure = failedToLoad ? <InlineError message="Couldn’t load logs. Use Refresh to retry." /> : null
  if (props.tail === null) {
    if (failedToLoad) return failure
    if (failed && props.truncated) return <NoticeLine>Log excerpt wasn’t requested. At most five failed-job excerpts are loaded per check.</NoticeLine>
    if (!failed) return <EmptyState message="Log output is not available yet." />
    return <EmptyState message="No log output was returned." />
  }
  if (props.tail.length === 0) return <>{failure}<EmptyState message="No log output was returned." /></>
  const lines = props.tail.split('\\n')
  return <div className="ui-stack">
    {failure}
    <pre ref={preRef} style={{ maxWidth: '100%', overflow: 'auto', whiteSpace: 'pre-wrap' }}><code>{lines.map((line, index) => <span key={index} data-last-error={index === lastError ? 'true' : undefined}>{line}{index < lines.length - 1 ? '\\n' : ''}</span>)}</code></pre>
    <Button disabled={jobId === null} onClick={() => props.onCopy(jobId!)}>Copy log excerpt</Button>
  </div>
}