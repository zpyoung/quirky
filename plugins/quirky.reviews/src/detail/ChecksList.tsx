import { useEffect, useMemo, useRef, useState } from 'react'
import type { JsonRecord, ReviewsSurfaceProps } from '../contracts'
import { isRecord, parseCheckDetail, parseChecksResult, reviewContext, safeHttpUrl, type CheckDetail, type ReviewContext } from './data'

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

function checkRows(value: JsonRecord | null, number: number): CheckRow[] | null {
  if (value === null) return null
  const parsed = parseChecksResult(value, number)
  if (parsed === null || !Array.isArray(parsed.checks)) return null
  return parsed.checks as unknown as CheckRow[]
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

export function ChecksList(props: ChecksListProps) {
  const owner = reviewContext(props.state, props.surface)
  const checksValue = props.surface === 'detail' ? props.state.detail.checks : props.state.checks.checks
  const rows = owner === null ? null : checkRows(checksValue, owner.number)
  const parsedChecks = owner === null || checksValue === null ? null : parseChecksResult(checksValue, owner.number)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const expandedSummary = !(props.surface === 'detail' ? props.state.detail.checksCollapsed : props.state.checks.checksCollapsed)
  const [actionError, setActionError] = useState<string | null>(null)
  const activeLoads = useRef(new Set<string>())
  const checksForView = useMemo(() => [...(rows ?? [])].sort((left, right) => severityRank(severity(left)) - severityRank(severity(right))), [rows])
  const renderedChecks = checksForView.slice(0, props.compact ? 5 : 100)
  const failedCount = checksForView.filter((check) => severity(check) === 'failure' || severity(check) === 'action').length
  const actionableCount = checksForView.filter((check) => check.kind === 'check_run' && (check.workflowRunId !== null || check.checkRunId !== null)).length
  const expanded = props.surface === 'detail' ? props.state.detail.expandedChecks : props.state.checks.expandedChecks
  const currentGeneration = owner?.generation ?? -1
  const detailRequest = owner === null ? null : viewParams(owner)

  useEffect(() => {
    if (props.surface !== 'detail' || owner === null || props.state.detail.checks !== null) return
    void props.context.call('quirky.reviews/detailRefreshChecks', { ...viewParams(owner) }).catch((error: unknown) => setActionError(errorText(error)))
  }, [props.context, props.surface, owner?.worktree, owner?.number, owner?.generation, props.state.detail.checks])

  const refresh = async () => {
    if (owner === null) return
    setActionError(null)
    setPendingAction('refresh')
    try {
      await props.context.call('quirky.reviews/detailRefreshChecks', { ...viewParams(owner) })
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setPendingAction(null)
    }
  }

  const rerun = async (failedOnly: boolean) => {
    if (owner === null) return
    setPendingAction(failedOnly ? 'rerun-failed' : 'rerun-all')
    setActionError(null)
    try {
      const value = await props.context.call('quirky.reviews/detailRerunChecks', { ...viewParams(owner), failedOnly })
      if (isRecord(value) && value.refreshed === false && typeof value.refreshError === 'string') setActionError(value.refreshError)
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setPendingAction(null)
    }
  }

  const openCheck = async (check: CheckRow) => {
    const url = safeHttpUrl(check.url)
    if (url === null) return
    try {
      await props.context.call('quirky.reviews/openLink', { url })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const openFixDialog = async () => {
    try {
      await props.context.call('quirky.reviews/checksSetAgentDialog', { surface: props.surface, action: 'fix' })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const toggleExpanded = async (check: CheckRow) => {
    if (detailRequest === null) return
    const id = checkKey(check)
    const isExpanded = expanded.includes(id)
    const next = !isExpanded
    try {
      await props.context.call('quirky.reviews/detailExpandCheck', { ...detailRequest, checkId: id, expanded: next })
    } catch (error) {
      setActionError(errorText(error))
      return
    }
    if (next && check.checkRunId !== null && owner?.review?.headRefOid) {
      const loadKey = `${currentGeneration}:${check.checkRunId}`
      if (activeLoads.current.has(loadKey)) return
      activeLoads.current.add(loadKey)
      try {
        await props.context.call('quirky.reviews/detailLoadCheckDetails', {
          ...detailRequest,
          expectedHead: owner.review.headRefOid,
          checkRunId: check.checkRunId,
          ...(check.workflowRunId === null ? {} : { workflowRunId: check.workflowRunId }),
        })
      } catch (error) {
        setActionError(errorText(error))
      } finally {
        activeLoads.current.delete(loadKey)
      }
    }
  }

  const copyTail = async (tail: string) => {
    try {
      await props.context.call('quirky.reviews/copyText', { text: tail })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const summary = summaryLabel(rows, parsedChecks?.rollup)
  if (owner === null) return <section className="review-checks-list" aria-label="Checks"><p>No pull request is selected.</p></section>
  if (rows === null) return <section className="review-checks-list" aria-label="Checks">
    <h3>Checks</h3>
    {props.surface === 'detail' && props.state.detail.loading || props.surface === 'checks' && props.state.checks.loading
      ? <p role="status">Loading checks…</p>
      : <p role="alert">Check data is unavailable.</p>}
    <button type="button" onClick={() => void refresh()}>Retry</button>
  </section>

  const checkDetails = (checkRunId: number | null) => checkRunId === null ? null : detailMap(checksValue, checkRunId)
  const activeLoading = props.surface === 'detail' ? props.state.detail.loading : props.state.checks.loading
  const activeError = props.surface === 'detail' ? props.state.detail.error : props.state.checks.error

  return <section className="review-checks-list" aria-label="Checks">
    <header className="review-checks-toolbar">
      <button type="button" aria-expanded={expandedSummary} onClick={() => {
        void props.context.call('quirky.reviews/detailSetChecksCollapsed', { ...viewParams(owner), collapsed: expandedSummary })
          .then(() => props.refresh()).catch((error: unknown) => setActionError(errorText(error)))
      }}>{summary}</button>
      <span>{checksForView.filter((check) => severity(check) === 'success').length} passing</span>
      <span>{checksForView.filter((check) => severity(check) === 'failure').length} failing</span>
      <span>{checksForView.filter((check) => severity(check) === 'pending').length} pending</span>
      <span>{checksForView.filter((check) => severity(check) === 'action').length} unresolved</span>
      <button type="button" disabled={pendingAction !== null} onClick={() => void refresh()}>{pendingAction === 'refresh' ? 'Refreshing…' : 'Refresh checks'}</button>
      {!props.compact && <button type="button" disabled={pendingAction !== null || failedCount === 0} title={failedCount === 0 ? 'No failed checks to rerun.' : undefined} onClick={() => void rerun(true)}>Rerun failed</button>}
      {!props.compact && <button type="button" disabled={pendingAction !== null || actionableCount === 0} title={actionableCount === 0 ? 'No actionable check or workflow run is available.' : undefined} onClick={() => void rerun(false)}>Rerun all</button>}
      {failedCount > 0 ? <button type="button" onClick={() => void openFixDialog()}>{props.compact ? 'Fix checks' : 'Fix broken checks'}</button> : null}
    </header>

    {actionError ? <p role="alert" className="review-error">{actionError}</p> : null}
    {activeError ? <p role="alert" className="review-error">{activeError}</p> : null}
    {activeLoading && checksForView.length === 0 ? <p role="status">Loading checks…</p> : null}
    {parsedChecks?.partial === true ? <p role="status">Check data is partial{Array.isArray(parsedChecks.partialFailures) ? `: ${parsedChecks.partialFailures.join(' ')}` : '.'}</p> : null}
    {parsedChecks?.truncated === true || checksForView.length > 100 ? <p role="status">Showing the first 100 checks.</p> : null}
    {checksForView.length === 0 ? <p role="status">{props.surface === 'checks' ? 'No checks configured.' : 'No checks found.'}</p> : null}

    {expandedSummary && renderedChecks.length > 0 ? <ol className="review-check-rows">
      {renderedChecks.map((check) => {
        const key = checkKey(check)
        const isExpanded = expanded.includes(key)
        const detail = checkDetails(check.checkRunId)
        const externalUrl = safeHttpUrl(check.url)
        const runIdentity = check.checkRunId ?? check.workflowRunId
        const canLoadDetails = check.checkRunId !== null && typeof owner.review?.headRefOid === 'string'
        const label = severity(check)
        return <li key={key} className={`review-check-row review-check-${label}`}>
          <div className="review-check-row-heading">
            <button type="button" aria-expanded={isExpanded} aria-label={`${check.name}: ${label}`} onClick={() => void toggleExpanded(check)}>
              <span>{label === 'failure' ? 'Failing' : label === 'action' ? 'Action required' : label === 'pending' ? 'Pending' : label === 'success' ? 'Passing' : 'Unresolved'}</span>
              <strong>{check.name}</strong>
              <span>{check.conclusion ?? check.status}</span>
            </button>
            {externalUrl ? <button type="button" onClick={() => void openCheck(check)}>Open check details</button> : <span>External check link unavailable</span>}
          </div>
          {isExpanded ? <div className="review-check-detail">
            {check.checkRunId === null ? <p>This status has no check-run identity or expandable job logs.</p>
              : detail === null ? <p role="status">{activeLoading ? 'Loading check details…' : 'Check details have not been requested.'}</p>
                : <CheckDetailView details={detail} checkRunId={check.checkRunId} workflowRunId={check.workflowRunId}
                  onCopy={(tail) => void copyTail(tail)}
                  onOpen={(url) => { void props.context.call('quirky.reviews/openLink', { url }).catch((error: unknown) => setActionError(errorText(error))) }} />}
            {!canLoadDetails && check.checkRunId !== null ? <p role="alert">A verified pull request head is required to load check details.</p> : null}
            {runIdentity !== null ? <p>Check run #{check.checkRunId ?? '—'} · workflow #{check.workflowRunId ?? '—'}</p> : null}
          </div> : null}
        </li>
      })}
    </ol> : null}
  </section>
}

function CheckDetailView(props: { details: CheckDetail; checkRunId: number; workflowRunId: number | null; onCopy(text: string): void; onOpen(url: string): void }) {
  const check = props.details.check
  const output = outputFields(check.output)
  const annotations = props.details.annotations.slice(0, 20)
  const jobs = props.details.jobs.slice(0, 100)
  const fullDetailsUrl = safeHttpUrl(check.detailsUrl ?? check.htmlUrl ?? check.url)
  return <section className="review-check-full-details">
    <header>
      <strong>{typeof check.status === 'string' ? check.status : 'Status unavailable'}</strong>
      {fullDetailsUrl ? <button type="button" onClick={() => props.onOpen(fullDetailsUrl)}>View full details</button> : <span>Full details link unavailable</span>}
    </header>
    <p>Started: {dateLabel(check.startedAt ?? check.started_at) ?? 'Unavailable'}</p>
    <p>Completed: {dateLabel(check.completedAt ?? check.completed_at) ?? 'Unavailable'}</p>
    <p>Check run #{props.checkRunId}{props.workflowRunId === null ? '' : ` · Workflow run #${props.workflowRunId}`}</p>
    {output.title ? <h4>{output.title}</h4> : null}
    {output.summary ? <pre className="review-check-output">{output.summary}</pre> : null}
    {output.text ? <pre className="review-check-output">{output.text}</pre> : null}
    {annotations.length > 0 ? <section><h4>Annotations ({annotations.length})</h4><ul>{annotations.map((annotation, index) => <li key={`${index}:${String(annotation.path ?? '')}`}>
      <strong>{String(annotation.title ?? annotation.annotationLevel ?? 'Annotation')}</strong>
      <span>{String(annotation.path ?? '')}{annotation.startLine ? `:${String(annotation.startLine)}` : ''}</span>
      <p>{String(annotation.message ?? annotation.rawDetails ?? '')}</p>
    </li>)}</ul></section> : null}
    {jobs.length > 0 ? <section><h4>{jobs.some(jobIsFailed) ? 'Failed jobs' : 'Jobs'} ({jobs.length})</h4><ul>{jobs.map((job) => {
      const id = typeof job.id === 'number' ? job.id : null
      const tail = id === null ? null : props.details.logTails.find((item) => item.jobId === id) ?? null
      return <li key={id ?? String(job.name ?? 'job')}>
        <strong>{typeof job.name === 'string' ? job.name : 'Unknown job'}</strong>
        <span>{String(job.conclusion ?? job.status ?? 'Unknown status')}</span>
        <JobLog job={job} tail={tail?.tail ?? null} partialFailures={props.details.partialFailures} truncated={props.details.truncated} onCopy={props.onCopy} />
      </li>
    })}</ul></section> : null}
    {props.details.partialFailures.length > 0 ? <p role="alert">{props.details.partialFailures.join(' ')}</p> : null}
    {props.details.truncated ? <p role="status">Some logs or job output were omitted at the provider bounds.</p> : null}
  </section>
}

function JobLog(props: { job: JsonRecord; tail: string | null; partialFailures: string[]; truncated: boolean; onCopy(text: string): void }) {
  const preRef = useRef<HTMLPreElement>(null)
  const jobId = typeof props.job.id === 'number' ? props.job.id : null
  const failed = jobIsFailed(props.job)
  const failedToLoad = jobId !== null && props.partialFailures.some((message) => message.includes(String(jobId)) && message.toLowerCase().includes('log'))
  const lastError = props.tail === null ? -1 : lastErrorLine(props.tail)
  useEffect(() => {
    if (lastError < 0) return
    preRef.current?.querySelector('[data-last-error="true"]')?.scrollIntoView({ block: 'center' })
  }, [props.tail, lastError])
  if (props.tail === null) {
    if (failedToLoad) return <p role="alert">Couldn’t load logs. Use Refresh to retry.</p>
    if (failed && props.truncated) return <p>Log excerpt wasn’t requested. At most five failed-job excerpts are loaded per check.</p>
    if (!failed) return <p>Log output is not available yet.</p>
    return <p>No log output was returned.</p>
  }
  if (props.tail.length === 0) return <p>No log output was returned.</p>
  const lines = props.tail.split('\\n')
  return <div className="review-check-log">
    <pre ref={preRef}><code>{lines.map((line, index) => <span key={index} data-last-error={index === lastError ? 'true' : undefined}>{line}{index < lines.length - 1 ? '\\n' : ''}</span>)}</code></pre>
    <button type="button" onClick={() => props.onCopy(props.tail as string)}>Copy log excerpt</button>
  </div>
}