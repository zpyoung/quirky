import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ApprovalScope, TickTrace } from './contracts'
import type { CommandRequest, CommandResult, FleetAction, FleetRow, FleetSnapshot, OpenEscalation, WatcherCommand, WatcherDetail, WatcherTarget, WatcherWorker } from './control-contracts'
import { groupFleetRows, sortFleetRows } from './fleet-selectors'
import { acceptFleetSnapshot, groupDecisionTraces, statusPresentation } from './ui-model'

const FLEET_VIEW_ID = 'view:quirky.heimdall/fleet'
const NAVIGATION_ID = 'sidebar-section:quirky.heimdall/navigation'
const FLEET_CHANGED_EVENT = 'quirky.heimdall/fleetChanged'
const SESSION_VIEW_ID = 'view:quirky.session/worktree'

type MountProps = { input?: unknown; report?(state: unknown): void }
type Feedback = { command: string; result: CommandResult }
type BudgetDraft = { activeMinutes: string; turns: string }

const rootStyle: CSSProperties = {
  boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0,
  overflow: 'auto', padding: 16, background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit'
}
const cardStyle: CSSProperties = {
  background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 12
}
const buttonStyle: CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg-raised)', color: 'var(--text)',
  padding: '6px 10px', cursor: 'pointer', font: 'inherit'
}
const subtleStyle: CSSProperties = { color: 'var(--muted)' }
const rowStyle: CSSProperties = { borderBottom: '1px solid var(--border)', verticalAlign: 'top' }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isFleetAction(value: unknown): value is FleetAction {
  const data = record(value)
  return typeof data.watcherId === 'string' && typeof data.watcherName === 'string' &&
    typeof data.attemptId === 'string' && typeof data.atMs === 'number' && Number.isFinite(data.atMs) &&
    typeof data.actionKind === 'string' &&
    (data.state === 'attempted' || data.state === 'running' || data.state === 'settled') &&
    (data.effect === undefined || data.effect === 'landed' || data.effect === 'not-landed' || data.effect === 'indeterminate') &&
    (data.reason === undefined || typeof data.reason === 'string')
}

function isFleetSnapshot(value: unknown): value is FleetSnapshot {
  const data = record(value)
  return typeof data.generatedAtMs === 'number' && Number.isFinite(data.generatedAtMs) &&
    Array.isArray(data.rows) && Array.isArray(data.actionHistory) && data.actionHistory.every(isFleetAction)
}

function isCommandResult(value: unknown): value is CommandResult {
  const data = record(value)
  if (data.kind === 'applied') return typeof data.appliedAtMs === 'number' && Number.isFinite(data.appliedAtMs)
  if (data.kind === 'refused') return typeof data.reason === 'string' && typeof data.detail === 'string'
  return data.kind === 'indeterminate' && typeof data.detail === 'string'
}

function initialTarget(input: unknown): WatcherTarget | null {
  const value = record(input)
  const nestedTarget = record(value.target)
  const watcherId = nestedTarget.watcherId ?? value.watcherId
  if (typeof watcherId !== 'string' || watcherId === '') return null
  const connectionId = nestedTarget.connectionId
  const pairingRevision = nestedTarget.pairingRevision
  return {
    watcherId,
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
    ...(typeof pairingRevision === 'number' && Number.isSafeInteger(pairingRevision) ? { pairingRevision } : {})
  }
}

function targetKey(target: WatcherTarget): string {
  return JSON.stringify([target.watcherId, target.connectionId ?? null, target.pairingRevision ?? null])
}

function sameTargetOwner(left: WatcherTarget, right: WatcherTarget): boolean {
  return left.watcherId === right.watcherId && (left.connectionId ?? null) === (right.connectionId ?? null)
}

function isRemoteTarget(target: WatcherTarget): boolean {
  return target.connectionId != null || target.pairingRevision != null
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function timestamp(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Never'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function useClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function duration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours === 0) return `${remainingMinutes}m`
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`
}

function formatCommandResult(result: CommandResult): string {
  if (result.kind === 'applied') return `Applied by the owner at ${timestamp(result.appliedAtMs)}.`
  if (result.kind === 'refused') return `Refused · ${result.reason}: ${result.detail}`
  return `Indeterminate · ${result.detail}`
}

function statusColor(label: string): string {
  if (label.startsWith('Error') || label.startsWith('Host unreachable') || label === 'Malformed') return 'var(--amber)'
  if (label === 'Escalated' || label === 'Parked' || label === 'Held') return 'var(--amber)'
  if (label === 'Acting' || label === 'Watching') return 'var(--green)'
  return 'var(--muted)'
}

function StatusPill({ row, now }: { row: FleetRow; now: number }) {
  const status = statusPresentation(row, now)
  return (
    <span
      role="status"
      title={[status.reason, status.detail].filter(Boolean).join(' · ') || status.label}
      style={{ display: 'inline-block', border: '1px solid var(--border)', borderRadius: 999, color: statusColor(status.label), padding: '2px 8px', whiteSpace: 'nowrap' }}
    >
      {status.label}
    </span>
  )
}

function BudgetBar({ row }: { row: FleetRow }) {
  const limit = row.enrollment.budget.wallClockActiveMs
  const used = row.budget.activeMs
  const percent = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.max(0, (used / limit) * 100))
  const warning = percent >= 80
  return (
    <div style={{ minWidth: 108 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
        <span>{(used / 60_000).toFixed(1)} min</span>
        <span style={subtleStyle}>{limit === null ? '∞' : `${(limit / 60_000).toFixed(1)} min`}</span>
      </div>
      <div aria-label={limit === null ? 'Unlimited active-time budget' : `${percent.toFixed(0)}% of active-time budget used`} style={{ height: 4, marginTop: 4, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${percent}%`, background: warning ? 'var(--amber)' : 'var(--accent)' }} />
      </div>
    </div>
  )
}

function FleetTable({ rows, now, selectedId, onSelect }: { rows: readonly FleetRow[]; now: number; selectedId: string | null; onSelect(row: FleetRow): void }) {
  if (rows.length === 0) return <p style={{ ...cardStyle, margin: 0 }}>No watchers in the fleet.</p>
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ borderCollapse: 'collapse', minWidth: 1120, width: '100%', textAlign: 'left' }}>
        <thead>
          <tr>
            {['Workspace', 'Watcher', 'Activity', 'Phase', 'Status', 'Active time', 'Turns', 'Elapsed', 'Last tick'].map((heading) => (
              <th key={heading} scope="col" style={{ padding: '9px 10px', background: 'var(--bg-raised)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = targetKey(row.target)
            const selected = key === selectedId
            const pathName = row.enrollment.workspacePath.split(/[\\/]/).filter(Boolean).at(-1)
            const workspaceName = row.workspaceName || pathName || 'Workspace'
            const turnsLimit = row.enrollment.budget.turns
            return (
              <tr
                key={key}
                aria-selected={selected}
                tabIndex={0}
                onClick={() => onSelect(row)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(row)
                }}
                style={{ ...rowStyle, cursor: 'pointer', background: selected ? 'var(--bg-active)' : undefined }}
              >
                <td style={{ padding: '8px 10px' }}>
                  <div>{workspaceName}</div>
                  <div style={subtleStyle}>{row.branch ?? 'Branch unavailable'}</div>
                  {row.ownerLabel && <div style={subtleStyle}>Remote · {row.ownerLabel}</div>}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <div>{row.name}</div>
                  <div style={subtleStyle}>{row.enrollment.kind === 'objective' ? 'Objective watcher' : row.enrollment.kind === 'hosted-review' ? 'Hosted review' : row.enrollment.kind}</div>
                </td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.runningWorkers > 0 ? `${row.runningWorkers} of ${row.maxConcurrency ?? '∞'} running` : 'No active work'}</td>
                <td style={{ padding: '8px 10px' }}>{row.phase ?? '—'}</td>
                <td style={{ padding: '8px 10px' }}><StatusPill row={row} now={now} /></td>
                <td style={{ padding: '8px 10px' }}><BudgetBar row={row} /></td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{row.budget.turns}/{turnsLimit === null ? '∞' : turnsLimit}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{duration(now - row.enrollment.createdAtMs)}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{timestamp(row.lastSuccessfulTickAtMs)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ActionHistory({ items }: { items: readonly FleetAction[] }) {
  const entries = useMemo(() => [...items].sort((a, b) => b.atMs - a.atMs).slice(0, 30), [items])
  return (
    <section style={cardStyle} aria-label="Fleet action history">
      <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>Fleet action history</h2>
      {entries.length === 0 ? <p style={{ ...subtleStyle, margin: 0 }}>No persisted watcher action attempts yet.</p> : (
        <ol style={{ margin: 0, paddingLeft: 22, display: 'grid', gap: 8 }}>
          {entries.map((item) => (
            <li key={`${targetKey(item.target ?? { watcherId: item.watcherId })}:${item.attemptId}`}>
              <div><strong>{item.actionKind}</strong> · {item.watcherName} <span style={subtleStyle}>({item.watcherId}){item.ownerLabel ? ` · Remote · ${item.ownerLabel}` : ''}</span></div>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span style={subtleStyle}>{timestamp(item.atMs)}</span>
                <span style={{ border: '1px solid var(--border)', borderRadius: 999, color: item.effect === 'landed' ? 'var(--green)' : item.effect === 'not-landed' ? 'var(--danger)' : item.effect === 'indeterminate' ? 'var(--amber)' : 'var(--muted)', padding: '2px 8px' }}>
                  {item.state}{item.effect ? ` · ${item.effect}` : ''}
                </span>
              </div>
              {item.reason && <div><strong>Reason:</strong> {item.reason}</div>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function NavigationEntry({ context }: { context: UiPluginContext }) {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null)
  const latest = useRef<FleetSnapshot | null>(null)
  const accept = useCallback((next: FleetSnapshot) => {
    const accepted = acceptFleetSnapshot(latest.current, next)
    if (accepted === latest.current) return
    latest.current = accepted
    setSnapshot(accepted)
  }, [])
  const refresh = useCallback(async () => {
    try {
      const next = await context.call('quirky.heimdall/fleet', {})
      if (isFleetSnapshot(next)) accept(next)
    } catch {
      // Heimdall may be disabled or unavailable; navigation remains mounted with zeroed counts.
    }
  }, [accept, context])

  useEffect(() => {
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (event.type !== FLEET_CHANGED_EVENT) return
      const data = (event as { data?: unknown }).data
      if (isFleetSnapshot(data)) accept(data)
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refresh()
    })
    void refresh()
    return () => {
      unsubscribe()
      unsubscribeConnection()
    }
  }, [accept, context, refresh])

  const groups = snapshot ? groupFleetRows(snapshot.rows) : null
  return (
    <button
      type="button"
      onClick={() => context.openView(FLEET_VIEW_ID)}
      aria-label="Open Heimdall fleet"
      style={{ ...buttonStyle, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, width: '100%', textAlign: 'left' }}
    >
      <strong>Heimdall</strong>
      <span style={{ ...subtleStyle, fontSize: 11 }}>
        Needs you {groups?.needsYou.length ?? 0} · Lost contact {groups?.lostContact.length ?? 0} · Active {groups?.active.length ?? 0}
      </span>
    </button>
  )
}

function DecisionTraceList({ traces }: { traces: readonly TickTrace[] }) {
  const groups = groupDecisionTraces(traces)
  if (groups.length === 0) return <p style={subtleStyle}>No decision traces yet.</p>
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {groups.map((group) => {
        const trace = group.representative
        const title = group.count > 1 ? `Tick ${group.firstSeq}–${group.lastSeq} ×${group.count}` : `Tick ${group.firstSeq}`
        const decision = trace.decision
        const action = decision?.action
        const noAction = decision?.action === null ? decision : null
        const decisionText = action ? `Act: ${action.kind}` : noAction?.deviation ? `Deviation: ${noAction.deviation.kind}` : noAction?.reason ?? 'No decision recorded'
        const gateText = trace.gate
          ? trace.gate.verdict === 'allow' ? 'Gate: allow' : `Gate: ${trace.gate.verdict} · ${trace.gate.reason}`
          : 'Gate: no verdict'
        return (
          <article key={`${group.firstSeq}-${group.lastSeq}`} style={{ ...cardStyle, display: 'grid', gap: 8 }}>
            <header>
              <strong>{title}</strong> <span style={subtleStyle}>· {trace.exitPath}</span>
            </header>
            {trace.exitPath === 'running' && <strong>Running</strong>}
            <div style={{ display: 'grid', gap: 8 }}>
              <div><strong>Saw</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0', color: 'var(--muted)' }}>{prettyJson(trace.snapshot ?? 'No snapshot recorded')}</pre></div>
              <div>
                <strong>Decided</strong><div>{decisionText}</div>
                {action && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0', color: 'var(--muted)' }}>{prettyJson(action)}</pre>}
                {noAction?.detail && <div>{noAction.detail}</div>}
                {noAction?.deviation?.detail && <div>{noAction.deviation.detail}</div>}
                <div>{gateText}</div>
                {trace.gate && trace.gate.verdict !== 'allow' && trace.gate.detail && <div>{trace.gate.detail}</div>}
              </div>
              <div><strong>Declined</strong><div>{trace.declined.length > 0 ? trace.declined.join(', ') : 'No phase declined'}</div></div>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function activitySummary(entry: WatcherDetail['journal'][number]): string {
  const values = [entry.what, entry.state, entry.effect, entry.status, entry.escalationKind, entry.actionKind, entry.cause, entry.reason, entry.detail]
  return [entry.origin, ...values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')].join(' · ')
}

function ActivityFeed({ detail }: { detail: WatcherDetail }) {
  const entries = useMemo(() => [...detail.journal].sort((a, b) => b.seq - a.seq).slice(0, 30), [detail.journal])
  return (
    <section style={cardStyle}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Watcher activity · newest first</h3>
      {entries.length === 0 ? <p style={subtleStyle}>No watcher activity yet.</p> : (
        <ol style={{ display: 'grid', gap: 6, margin: 0, paddingLeft: 22 }}>
          {entries.map((entry) => {
            const summary = activitySummary(entry)
            return (
              <li key={`${entry.seq}-${entry.eventId}`}>
                <details>
                  <summary style={{ cursor: 'pointer' }}><strong>{entry.kind}</strong> · #{entry.seq} · {timestamp(entry.atMs)}{summary ? ` · ${summary}` : ''}</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0', color: 'var(--muted)' }}>{prettyJson(entry)}</pre>
                </details>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

function approvalScopeText(scope: ApprovalScope): Array<[string, string]> {
  return [
    ['Action kind', scope.actionKind],
    ['Content identity', scope.contentIdentity],
    ['Evidence key', scope.evidenceKey],
    ...(scope.preparedCommitSha === undefined ? [] : [['Prepared commit SHA', scope.preparedCommitSha] as [string, string]])
  ]
}

function OpenEscalations({ escalations, onApprove, disabled }: { escalations: readonly OpenEscalation[]; onApprove(escalation: OpenEscalation): void; disabled: boolean }) {
  return (
    <section style={cardStyle}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Open escalations</h3>
      {escalations.length === 0 ? <p style={subtleStyle}>No open escalations.</p> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {escalations.map((escalation) => {
            const scope = escalation.approvalScope
            const canApprove = escalation.status === 'open' && scope !== undefined
            return (
              <article key={escalation.escalationId} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div><strong>{escalation.escalationKind}</strong> · {escalation.status} · fold {escalation.foldCount}</div>
                {escalation.reason && <div><strong>Reason:</strong> {escalation.reason}</div>}
                {escalation.detail && <div><strong>Detail:</strong> {escalation.detail}</div>}
                {scope && (
                  <div style={{ ...cardStyle, marginTop: 8 }}>
                    <h4 style={{ margin: '0 0 6px' }}>Exact approval scope</h4>
                    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 10px', margin: 0 }}>
                      {approvalScopeText(scope).map(([label, value]) => <div key={label} style={{ display: 'contents' }}><dt style={subtleStyle}>{label}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd></div>)}
                    </dl>
                    <p style={{ color: 'var(--amber)', marginBottom: 0 }}>Approve authorizes only this exact action scope. Changed content, evidence, or prepared commit requires a new approval.</p>
                  </div>
                )}
                {canApprove && (
                  <button type="button" style={{ ...buttonStyle, marginTop: 8 }} disabled={disabled} onClick={() => onApprove(escalation)}>
                    Approve exact action
                  </button>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Workers({
  context, workers, worktreeId, disabled, canOpenTerminal, onCommand
}: {
  context: UiPluginContext
  workers: readonly WatcherWorker[]
  worktreeId: string | null | undefined
  disabled: boolean
  canOpenTerminal: boolean
  onCommand(command: WatcherCommand, label: string): void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const openTerminal = async (worker: WatcherWorker) => {
    const sessionId = worker.identity.sessionId
    if (!sessionId) return
    try {
      let id = worktreeId ?? null
      if (!id) {
        const session = record(await context.call('quirky.session/get', { session: sessionId }))
        id = typeof session.worktreeId === 'string' ? session.worktreeId : null
      }
      if (!id) throw new Error('The session does not belong to a worktree that can be opened.')
      context.openView(SESSION_VIEW_ID, { worktree: id, session: sessionId })
    } catch (error) {
      context.toast('Could not open worker terminal', messageOf(error), { kind: 'error' })
    }
  }
  return (
    <section style={cardStyle}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Workers</h3>
      {workers.length === 0 ? <p style={subtleStyle}>No workers reported.</p> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {workers.map((worker) => {
            const identity = worker.identity
            const answer = answers[identity.dispatchId] ?? ''
            const exactProcessIdentity = Boolean(identity.sessionId && identity.processIncarnation)
            const question = worker.question && !worker.question.answered ? worker.question : null
            return (
              <article key={identity.dispatchId} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div><strong>{worker.title ?? identity.dispatchId}</strong> · {worker.state}</div>
                <div style={subtleStyle}>Dispatch {identity.dispatchId}{identity.sessionId ? ` · Session ${identity.sessionId}` : ''}{identity.processIncarnation ? ` · Process ${identity.processIncarnation}` : ''}{identity.pid !== undefined ? ` · PID ${identity.pid}` : ''}</div>
                {worker.lastContactAtMs !== undefined && <div style={subtleStyle}>Last contact {timestamp(worker.lastContactAtMs)}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={disabled || worker.state !== 'live' || !exactProcessIdentity}
                    title={!exactProcessIdentity ? 'Exact session and process-incarnation identity is required to stop a worker safely.' : undefined}
                    onClick={() => onCommand({ kind: 'stop-worker', identity }, `Stop worker ${identity.dispatchId}`)}
                  >Stop</button>
                  <button type="button" style={buttonStyle} disabled={!canOpenTerminal || !identity.sessionId} title={!canOpenTerminal ? 'Remote worker terminals cannot be opened on this device.' : !identity.sessionId ? 'This worker has no session identity.' : undefined} onClick={() => void openTerminal(worker)}>Open terminal</button>
                </div>
                {!exactProcessIdentity && <p style={subtleStyle}>Stop is unavailable until the exact session and process-incarnation identity can be verified.</p>}
                {question && (
                  <form
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault()
                      if (!answer.trim()) return
                      onCommand({ kind: 'answer-question', messageId: question.messageId, body: answer }, `Answer worker question ${identity.dispatchId}`)
                    }}
                    style={{ display: 'grid', gap: 6, marginTop: 8 }}
                  >
                    <div><strong>Question:</strong> {question.body}</div>
                    <label>Answer<textarea value={answer} onChange={(event) => { const value = event.currentTarget.value; setAnswers((previous) => ({ ...previous, [identity.dispatchId]: value })) }} rows={3} style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, font: 'inherit' }} /></label>
                    <button type="submit" style={buttonStyle} disabled={disabled || !answer.trim()}>Send answer</button>
                  </form>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function objectiveCap(detail: WatcherDetail, row: FleetRow | undefined): number | null {
  const rowCap = row?.maxConcurrency
  if (rowCap !== null && rowCap !== undefined) return rowCap
  const payload = record(detail.enrollment.kindPayload)
  return typeof payload.maxConcurrency === 'number' && Number.isFinite(payload.maxConcurrency) ? payload.maxConcurrency : null
}

function WatcherDetailPane({
  context, detail, row, now, pending, canCommand, feedback, onCommand, onDelete
}: {
  context: UiPluginContext
  detail: WatcherDetail
  row: FleetRow | undefined
  now: number
  pending: boolean
  canCommand: boolean
  feedback: Feedback | null
  onCommand(command: WatcherCommand, label: string): void
  onDelete(): void
}) {
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>({ activeMinutes: '', turns: '' })
  const [editingBudget, setEditingBudget] = useState(false)
  const [capDraft, setCapDraft] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const statusSource = detail.status ?? row?.status
  const status = statusSource ? statusPresentation({ status: statusSource, ownerContact: detail.ownerContact, observedAtMs: detail.observedAtMs }, now) : null
  const cap = detail.enrollment.kind === 'objective' ? objectiveCap(detail, row) : null
  const controlsPending = pending || detail.pendingControls.length > 0
  const controlsDisabled = controlsPending || !canCommand
  const canResume = detail.status?.state !== 'terminal' && detail.enrollment.terminalAtMs === null && (detail.enrollment.paused || detail.enrollment.parkReason !== null)

  useEffect(() => {
    setBudgetDraft({
      activeMinutes: detail.enrollment.budget.wallClockActiveMs === null ? '' : String(detail.enrollment.budget.wallClockActiveMs / 60_000),
      turns: detail.enrollment.budget.turns === null ? '' : String(detail.enrollment.budget.turns)
    })
    setCapDraft(cap === null ? '' : String(cap))
    setFormError(null)
    setEditingBudget(false)
  }, [detail.target.watcherId, detail.enrollment.budget.wallClockActiveMs, detail.enrollment.budget.turns, cap])

  const applyBudget = (event: FormEvent) => {
    event.preventDefault()
    const activeValue = budgetDraft.activeMinutes.trim() === '' ? null : Number(budgetDraft.activeMinutes)
    const turnsValue = budgetDraft.turns.trim() === '' ? null : Number(budgetDraft.turns)
    if (activeValue !== null && (!Number.isFinite(activeValue) || activeValue < 0 || !Number.isFinite(activeValue * 60_000))) {
      setFormError('Active-time limit must be a finite non-negative number of minutes, or blank for unlimited.')
      return
    }
    if (turnsValue !== null && (!Number.isFinite(turnsValue) || !Number.isInteger(turnsValue) || turnsValue < 0)) {
      setFormError('Worker-turn limit must be a non-negative integer, or blank for unlimited.')
      return
    }
    setFormError(null)
    const currentActiveMinutes = detail.enrollment.budget.wallClockActiveMs === null ? '' : String(detail.enrollment.budget.wallClockActiveMs / 60_000)
    const wallClockActiveMs = budgetDraft.activeMinutes === currentActiveMinutes
      ? detail.enrollment.budget.wallClockActiveMs
      : activeValue === null ? null : activeValue * 60_000
    setEditingBudget(false)
    onCommand({ kind: 'adjust-budget', budget: { wallClockActiveMs, turns: turnsValue } }, 'Update budget')
  }

  const applyCap = (event: FormEvent) => {
    event.preventDefault()
    const value = Number(capDraft)
    if (!Number.isSafeInteger(value) || value < 1 || value > 1024) {
      setFormError('Objective concurrency must be an integer from 1 through 1,024.')
      return
    }
    setFormError(null)
    onCommand({ kind: 'set-concurrency', maxConcurrency: value }, 'Update objective concurrency')
  }

  const copyDebug = async () => {
    try {
      const report = await context.call('quirky.heimdall/debugReport', { target: detail.target })
      if (report === null || report === undefined) throw new Error('No debug report is available for this watcher.')
      const text = JSON.stringify(report, null, 2)
      if (typeof text !== 'string') throw new Error('The debug report could not be encoded as JSON.')
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this window.')
      await navigator.clipboard.writeText(text)
      context.toast('Debug report copied', '', { kind: 'success' })
    } catch (error) {
      context.toast('Could not copy the debug report.', messageOf(error), { kind: 'error' })
    }
  }

  const currentReason = status?.reason ?? detail.enrollment.haltReason ?? detail.enrollment.parkReason
  return (
    <section style={{ display: 'grid', gap: 12, minHeight: 0 }}>
      <header style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>{detail.name}</h2>
          <div style={subtleStyle}>{detail.enrollment.kind} · {isRemoteTarget(detail.target) ? `Remote · Controlled by ${detail.ownerLabel ?? detail.target.connectionId ?? 'paired owner'}` : 'This device'} · {statusSource?.state ?? 'unknown'}</div>
        </div>
        <button type="button" style={buttonStyle} onClick={copyDebug}>Copy debug report</button>
      </header>

      <div style={cardStyle}>
        <div><strong>Owner state observed</strong> {duration(now - detail.observedAtMs)} ago · {status?.label ?? statusSource?.state ?? 'Unknown'}</div>
        <div><strong>Reason:</strong> {currentReason ?? 'No current reason reported.'}</div>
        {status?.detail && <div><strong>Detail:</strong> {status.detail}</div>}
        {detail.enrollment.malformed && <div><strong>Malformed enrollment:</strong> {detail.enrollment.malformed}</div>}
        {detail.ownerContact === 'unverifiable' && <div style={{ color: 'var(--amber)' }}>Owner contact is unverifiable; this is the last confirmed state.</div>}
        {detail.readOnly && <div style={{ color: 'var(--amber)' }}>This enrollment is read-only. Controls are unavailable.</div>}
        {isRemoteTarget(detail.target) && <div style={subtleStyle}>Controls are routed to {detail.ownerLabel ?? 'the paired owner'} and checked against its current host, workspace, watcher revision, and daemon incarnation.</div>}
      </div>

      {feedback && (
        <div role="status" style={{ ...cardStyle, borderColor: feedback.result.kind === 'applied' ? 'var(--green)' : feedback.result.kind === 'refused' ? 'var(--amber)' : 'var(--danger)' }}>
          <strong>{feedback.command}:</strong> {formatCommandResult(feedback.result)}
          {feedback.result.kind === 'indeterminate' && <div>Do not retry automatically; refresh and verify the owner's state before issuing another command.</div>}
        </div>
      )}
      {controlsPending && <div role="status" style={cardStyle}>A command is pending; additional controls are disabled until it settles.</div>}
      {!canCommand && !detail.readOnly && !isRemoteTarget(detail.target) && detail.ownerContact !== 'unverifiable' && <div role="alert" style={{ ...cardStyle, color: 'var(--amber)' }}>Controls are unavailable for this malformed enrollment.</div>}

      <section style={cardStyle}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Owner controls</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" style={buttonStyle} disabled={controlsDisabled || !canResume} onClick={() => onCommand({ kind: 'resume' }, 'Resume watcher')}>Resume</button>
          <button type="button" style={buttonStyle} disabled={controlsDisabled || !detail.enrollment.enabled || detail.enrollment.paused} onClick={() => onCommand({ kind: 'pause' }, 'Pause watcher')}>Pause</button>
          <button type="button" style={buttonStyle} disabled={controlsDisabled || !detail.enrollment.enabled} onClick={() => onCommand({ kind: 'disarm' }, 'Disarm watcher')}>Disarm</button>
          <button type="button" style={{ ...buttonStyle, color: 'var(--danger)' }} disabled={controlsDisabled} onClick={onDelete}>Delete watcher</button>
        </div>
        {detail.enrollment.kind === 'objective' && (
          <form onSubmit={applyCap} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 8, marginTop: 12 }}>
            <label>Max concurrency (1–1,024)
              <input type="number" min={1} max={1024} step={1} value={capDraft} onChange={(event) => setCapDraft(event.currentTarget.value)} style={{ display: 'block', marginTop: 4, width: 160, boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 7, font: 'inherit' }} />
            </label>
            <button type="submit" style={buttonStyle} disabled={controlsDisabled || capDraft === '' || capDraft === String(cap)}>Update cap</button>
            <button type="button" style={buttonStyle} disabled={controlsPending || capDraft === String(cap ?? '')} onClick={() => { setCapDraft(cap === null ? '' : String(cap)); setFormError(null) }}>Cancel</button>
          </form>
        )}
      </section>
      {formError && <div role="alert" style={{ ...cardStyle, color: 'var(--danger)' }}>{formError}</div>}

      <section style={cardStyle}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Budget</h3>
        <div>Active time: {(detail.budget.activeMs / 60_000).toFixed(1)} min / {detail.enrollment.budget.wallClockActiveMs === null ? '∞' : `${(detail.enrollment.budget.wallClockActiveMs / 60_000).toFixed(1)} min`}</div>
        <div>Worker turns: {detail.budget.turns} / {detail.enrollment.budget.turns ?? '∞'}</div>
        {!editingBudget ? (
          <button type="button" style={{ ...buttonStyle, marginTop: 8 }} disabled={controlsDisabled} onClick={() => { setEditingBudget(true); setFormError(null) }}>Edit budget</button>
        ) : (
          <form onSubmit={applyBudget} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginTop: 12 }}>
            <label>Active-time limit (minutes)
              <input type="number" min={0} step="any" placeholder="Unlimited" value={budgetDraft.activeMinutes} onChange={(event) => { const value = event.currentTarget.value; setBudgetDraft((previous) => ({ ...previous, activeMinutes: value })) }} style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 7, font: 'inherit' }} />
            </label>
            <label>Worker-turn limit
              <input type="number" min={0} step={1} placeholder="Unlimited" value={budgetDraft.turns} onChange={(event) => { const value = event.currentTarget.value; setBudgetDraft((previous) => ({ ...previous, turns: value })) }} style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 7, font: 'inherit' }} />
            </label>
            <div style={{ gridColumn: '1 / -1', ...subtleStyle }}>Leave a limit blank for unlimited (null). Zero is a valid limit and does not resume a parked watcher.</div>
            <div style={{ display: 'flex', gap: 8, gridColumn: '1 / -1' }}>
              <button type="submit" style={buttonStyle} disabled={controlsDisabled || budgetDraft.activeMinutes === String(detail.enrollment.budget.wallClockActiveMs === null ? '' : detail.enrollment.budget.wallClockActiveMs / 60_000) && budgetDraft.turns === String(detail.enrollment.budget.turns ?? '')}>Apply budget</button>
              <button type="button" style={buttonStyle} disabled={controlsPending} onClick={() => {
                setBudgetDraft({
                  activeMinutes: detail.enrollment.budget.wallClockActiveMs === null ? '' : String(detail.enrollment.budget.wallClockActiveMs / 60_000),
                  turns: detail.enrollment.budget.turns === null ? '' : String(detail.enrollment.budget.turns)
                })
                setEditingBudget(false)
                setFormError(null)
              }}>Cancel</button>
            </div>
          </form>
        )}
      </section>

      <OpenEscalations escalations={detail.openEscalations} disabled={controlsDisabled} onApprove={(escalation) => {
        const scope = escalation.approvalScope
        if (scope) onCommand({ kind: 'approve', escalationId: escalation.escalationId, scope }, `Approve ${escalation.escalationKind}`)
      }} />

      <Workers context={context} workers={detail.workers} worktreeId={detail.enrollment.worktreeId} disabled={controlsDisabled} canOpenTerminal={!isRemoteTarget(detail.target)} onCommand={onCommand} />

      <section style={cardStyle}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Decision trace</h3>
        <DecisionTraceList traces={detail.traces} />
      </section>
      <ActivityFeed detail={detail} />
    </section>
  )
}

function HeimdallFleet({ context, input }: { context: UiPluginContext; input: unknown }) {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null)
  const snapshotRef = useRef<FleetSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [selectedTarget, setSelectedTarget] = useState<WatcherTarget | null>(() => initialTarget(input))
  const [detail, setDetail] = useState<WatcherDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const latestDetailRequest = useRef(0)
  const latestFleetRequest = useRef(0)
  const selectedTargetRef = useRef(selectedTarget)
  selectedTargetRef.current = selectedTarget
  const now = useClock()

  const accept = useCallback((incoming: FleetSnapshot): boolean => {
    const accepted = acceptFleetSnapshot(snapshotRef.current, incoming)
    if (accepted === snapshotRef.current) return false
    snapshotRef.current = accepted
    setSnapshot(accepted)
    return true
  }, [])

  const loadDetail = useCallback(async (requestedTarget: WatcherTarget) => {
    const ticket = ++latestDetailRequest.current
    setDetailBusy(true)
    setDetailError(null)
    const row = snapshotRef.current?.rows.find((item) => targetKey(item.target) === targetKey(requestedTarget))
    const target = row?.target ?? requestedTarget
    try {
      const loaded = await context.call('quirky.heimdall/detail', { target }) as WatcherDetail | null
      if (ticket !== latestDetailRequest.current) return
      if (loaded === null) {
        setDetail(null)
        setDetailError('This watcher is no longer available in the fleet.')
      } else {
        setDetail(loaded)
      }
    } catch (error) {
      if (ticket !== latestDetailRequest.current) return
      setDetail(null)
      setDetailError(messageOf(error))
    } finally {
      if (ticket === latestDetailRequest.current) setDetailBusy(false)
    }
  }, [context])

  const refreshFleet = useCallback(async () => {
    const ticket = ++latestFleetRequest.current
    setRefreshing(true)
    try {
      const incoming = await context.call('quirky.heimdall/fleet', {})
      if (!isFleetSnapshot(incoming)) throw new Error('The fleet response was not a valid snapshot.')
      accept(incoming)
      if (ticket === latestFleetRequest.current) setRefreshError(null)
    } catch (error) {
      if (ticket === latestFleetRequest.current) setRefreshError(messageOf(error))
    } finally {
      if (ticket === latestFleetRequest.current) setRefreshing(false)
    }
  }, [accept, context])

  useEffect(() => {
    void refreshFleet()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (event.type !== FLEET_CHANGED_EVENT) return
      const data = (event as { data?: unknown }).data
      if (!isFleetSnapshot(data)) return
      const changed = accept(data)
      if (changed) {
        setRefreshError(null)
        const target = selectedTargetRef.current
        if (target) void loadDetail(target)
      }
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refreshFleet()
    })
    return () => {
      unsubscribe()
      unsubscribeConnection()
      latestDetailRequest.current += 1
      latestFleetRequest.current += 1
    }
  }, [accept, context, loadDetail, refreshFleet])

  useEffect(() => {
    if (!selectedTarget || !snapshot) return
    const replacement = snapshot.rows.find((row) => sameTargetOwner(row.target, selectedTarget))
    if (replacement && targetKey(replacement.target) !== targetKey(selectedTarget)) setSelectedTarget(replacement.target)
  }, [selectedTarget, snapshot])

  useEffect(() => {
    if (selectedTarget) void loadDetail(selectedTarget)
    else {
      latestDetailRequest.current += 1
      setDetail(null)
      setDetailError(null)
      setDetailBusy(false)
    }
  }, [loadDetail, selectedTarget])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (selectedTarget !== null) setSelectedTarget(null)
      else context.closeView()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [context, selectedTarget])

  const orderedRows = useMemo(() => snapshot ? sortFleetRows(snapshot.rows) : [], [snapshot])
  const selectedRow = selectedTarget ? snapshot?.rows.find((row) => targetKey(row.target) === targetKey(selectedTarget)) : undefined
  const canCommand = Boolean(
    detail && !detail.readOnly && !detail.enrollment.malformed && detail.ownerContact === 'live' &&
    (!isRemoteTarget(detail.target) || Boolean(detail.ownerIncarnation))
  )


  const sendCommand = async (command: WatcherCommand, label: string, confirmedDelete = false) => {
    if (!detail) return
    const request: CommandRequest = { target: detail.target, expectedOwner: detail.ownerFence, command }
    let result: CommandResult
    try {
      const params = {
        ...request,
        ...(isRemoteTarget(detail.target) && detail.ownerIncarnation ? { expectedIncarnation: detail.ownerIncarnation } : {}),
        ...(confirmedDelete ? { yes: true } : {})
      }
      const response = await context.call('quirky.heimdall/command', params)
      result = isCommandResult(response) ? response : { kind: 'indeterminate', detail: 'The owner returned an unrecognized result; the command outcome could not be confirmed.' }
    } catch (error) {
      result = { kind: 'indeterminate', detail: `The command reply could not be confirmed: ${messageOf(error)}` }
    }
    setFeedback({ command: label, result })
    if (result.kind === 'applied') {
      context.toast(`${label} applied`, formatCommandResult(result), { kind: 'success' })
      if (command.kind === 'delete') setSelectedTarget(null)
      void refreshFleet()
      if (command.kind !== 'delete') void loadDetail(detail.target)
    } else if (result.kind === 'refused') {
      context.toast(`${label} refused`, `${result.reason}: ${result.detail}`, { kind: 'warning' })
    } else {
      context.toast(`${label} outcome indeterminate`, `${result.detail} Do not retry automatically; verify the owner's state before issuing another command.`, { kind: 'warning' })
    }
  }

  const submitCommand = async (command: WatcherCommand, label: string) => {
    if (pendingRef.current || !canCommand) return
    pendingRef.current = true
    setFeedback(null)
    setPending(true)
    try {
      await sendCommand(command, label)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const deleteWatcher = async () => {
    if (pendingRef.current || !detail || !canCommand) return
    pendingRef.current = true
    setPending(true)
    setFeedback(null)
    try {
      const confirmed = await context.confirm({
        title: 'Delete watcher?',
        body: `The watcher “${detail.name}” and its saved history will be permanently removed. Worker terminals will not be stopped.`,
        confirmLabel: 'Delete watcher'
      })
      if (confirmed) await sendCommand({ kind: 'delete' }, 'Delete watcher', true)
    } catch (error) {
      context.toast('Could not confirm watcher deletion', messageOf(error), { kind: 'error' })
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <main style={rootStyle}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {selectedTarget !== null ? (
            <button type="button" style={buttonStyle} onClick={() => setSelectedTarget(null)}>Back to fleet</button>
          ) : (
            <button type="button" style={buttonStyle} onClick={() => context.closeView()}>Back</button>
          )}
          <h1 style={{ fontSize: 22, margin: 0 }}>Heimdall fleet</h1>
          {snapshot && <span style={subtleStyle}>{snapshot.activeCount} active · {snapshot.attentionCount} need attention</span>}
        </div>
        {selectedTarget === null && <button type="button" style={buttonStyle} disabled={refreshing} onClick={() => void refreshFleet()}>{refreshing ? 'Refreshing…' : 'Refresh fleet'}</button>}
      </header>

      {refreshError && (
        <div role="alert" style={{ ...cardStyle, color: 'var(--amber)' }}>
          Fleet refresh failed; {snapshot ? 'showing the last confirmed snapshot' : 'no confirmed snapshot is available'}: {refreshError}
        </div>
      )}
      {!snapshot && !refreshError && <p style={cardStyle}>Loading Heimdall fleet…</p>}
      {selectedTarget === null && snapshot && (
        <>
          <section style={{ display: 'grid', gap: 8 }}>
            <h2 style={{ fontSize: 16, margin: 0 }}>Watcher fleet</h2>
            <FleetTable rows={orderedRows} now={now} selectedId={null} onSelect={(row) => { setFeedback(null); setSelectedTarget(row.target) }} />
          </section>
          <ActionHistory items={snapshot?.actionHistory ?? []} />
        </>
      )}
      {selectedTarget !== null && (
        <>
          {detailBusy && !detail && <p style={cardStyle}>Loading watcher details…</p>}
          {detailError && <div role="alert" style={{ ...cardStyle, color: 'var(--danger)' }}><div>Could not load watcher details: {detailError}</div><button type="button" style={{ ...buttonStyle, marginTop: 8 }} onClick={() => void loadDetail(selectedTarget)}>Retry details</button></div>}
          {detail && (
            <WatcherDetailPane
              context={context}
              detail={detail}
              row={selectedRow}
              pending={pending}
              canCommand={canCommand}
              feedback={feedback}
              now={now}
              onCommand={(command, label) => void submitCommand(command, label)}
              onDelete={() => void deleteWatcher()}
            />
          )}
          <ActionHistory items={snapshot?.actionHistory ?? []} />
        </>
      )}
    </main>
  )
}

/** Activates the built-in fleet navigation entry and its full-window operator view. */
export function activate(context: UiPluginContext): void {
  context.provide(NAVIGATION_ID, (element: HTMLElement) => {
    const root = createRoot(element)
    root.render(<NavigationEntry context={context} />)
    return () => queueMicrotask(() => root.unmount())
  })
  context.provide(FLEET_VIEW_ID, (element: HTMLElement, props: MountProps) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    root.render(<HeimdallFleet context={context} input={props.input} />)
    return () => queueMicrotask(() => root.unmount())
  })
}
