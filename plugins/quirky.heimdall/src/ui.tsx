import { Badge, Button, EmptyState, InlineAgentCard, ListRow, SectionHeader, TextArea, TextField, ToolPanelFrame } from '@quirky/ui'
import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { UiStatus, UiTone } from '@quirky/ui'
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

function statusForLabel(label: string): UiStatus {
  if (label.startsWith('Error') || label.startsWith('Host unreachable') || label === 'Malformed') return 'failing'
  if (label === 'Escalated' || label === 'Parked' || label === 'Held') return 'needs-you'
  if (label === 'Acting' || label === 'Watching') return 'working'
  if (label === 'Complete') return 'done'
  return 'idle'
}

function badgeTone(status: UiStatus): UiTone {
  if (status === 'working' || status === 'needs-you' || status === 'failing') return status
  return status === 'done' ? 'accent' : 'neutral'
}

function StatusPill({ row, now }: { row: FleetRow; now: number }) {
  const status = statusPresentation(row, now)
  return (
    <span title={[status.reason, status.detail].filter(Boolean).join(' · ') || status.label}>
      <Badge tone={badgeTone(statusForLabel(status.label))} label={status.label}>{status.label}</Badge>
    </span>
  )
}

function BudgetBar({ row }: { row: FleetRow }) {
  const limit = row.enrollment.budget.wallClockActiveMs
  const used = row.budget.activeMs
  const percent = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.max(0, (used / limit) * 100))
  const warning = percent >= 80
  const label = limit === null ? 'Unlimited active-time budget' : `${percent.toFixed(0)}% of active-time budget used`
  return (
    <Badge tone={warning ? 'needs-you' : 'neutral'} label={label}>
      {(used / 60_000).toFixed(1)} / {limit === null ? '∞' : `${(limit / 60_000).toFixed(1)} min`}
    </Badge>
  )
}

function FleetTable({ rows, now, selectedId, onSelect }: { rows: readonly FleetRow[]; now: number; selectedId: string | null; onSelect(row: FleetRow): void }) {
  if (rows.length === 0) return <EmptyState message="No watchers in the fleet." />
  return (
    <div className="ui-stack">
      {rows.map((row) => {
        const key = targetKey(row.target)
        const selected = key === selectedId
        const pathName = row.enrollment.workspacePath.split(/[\\/]/).filter(Boolean).at(-1)
        const workspaceName = row.workspaceName || pathName || 'Workspace'
        const turnsLimit = row.enrollment.budget.turns
        const status = statusPresentation(row, now)
        const watcherKind = row.enrollment.kind === 'objective' ? 'Objective watcher' : row.enrollment.kind === 'hosted-review' ? 'Hosted review' : row.enrollment.kind
        return (
          <ListRow
            key={key}
            selected={selected}
            status={statusForLabel(status.label)}
            count={row.runningWorkers > 0 ? row.runningWorkers : undefined}
            onClick={() => onSelect(row)}
            title={<><strong>{workspaceName}</strong> · {row.name}</>}
            description={
              <span className="ui-stack">
                <span className="ui-cluster">
                  <span>{row.branch ?? 'Branch unavailable'}</span>
                  {row.ownerLabel && <span>Remote · {row.ownerLabel}</span>}
                  <span>{watcherKind}</span>
                </span>
                <span>{row.runningWorkers > 0 ? `${row.runningWorkers} of ${row.maxConcurrency ?? '∞'} running` : 'No active work'} · Phase {row.phase ?? '—'}</span>
                <span className="ui-cluster">
                  <span>Status:</span>
                  <StatusPill row={row} now={now} />
                  <span>Active time:</span>
                  <BudgetBar row={row} />
                  <span>Turns: {row.budget.turns}/{turnsLimit === null ? '∞' : turnsLimit}</span>
                </span>
                <span className="ui-text-muted">Elapsed {duration(now - row.enrollment.createdAtMs)} · Last tick {timestamp(row.lastSuccessfulTickAtMs)}</span>
              </span>
            }
          />
        )
      })}
    </div>
  )
}

function ActionHistory({ items }: { items: readonly FleetAction[] }) {
  const entries = useMemo(() => [...items].sort((a, b) => b.atMs - a.atMs).slice(0, 30), [items])
  return (
    <ToolPanelFrame title="Fleet action history">
      {entries.length === 0 ? (
        <EmptyState message="No persisted watcher action attempts yet." />
      ) : (
        <div className="ui-stack">
          {entries.map((item) => {
            const tone = item.effect === 'landed' ? 'working' : item.effect === 'not-landed' ? 'failing' : item.effect === 'indeterminate' ? 'needs-you' : 'neutral'
            return (
              <ListRow
                key={`${targetKey(item.target ?? { watcherId: item.watcherId })}:${item.attemptId}`}
                title={<><strong>{item.actionKind}</strong> · {item.watcherName}</>}
                description={
                  <span className="ui-stack">
                    <span className="ui-text-muted">({item.watcherId}){item.ownerLabel ? ` · Remote · ${item.ownerLabel}` : ''}</span>
                    <span className="ui-cluster">
                      <span>{timestamp(item.atMs)}</span>
                      <Badge tone={tone}>{item.state}{item.effect ? ` · ${item.effect}` : ''}</Badge>
                    </span>
                    {item.reason && <span><strong>Reason:</strong> {item.reason}</span>}
                  </span>
                }
              />
            )
          })}
        </div>
      )}
    </ToolPanelFrame>
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
      if (!('data' in event)) return
      const data = event.data
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
    <Button
      className="ui-stack"
      style={{ width: '100%', alignItems: 'stretch', textAlign: 'left' }}
      onClick={() => context.openView(FLEET_VIEW_ID)}
      aria-label="Open Heimdall fleet"
    >
      <strong>Heimdall</strong>
      <span className="ui-text-muted">
        Needs you {groups?.needsYou.length ?? 0} · Lost contact {groups?.lostContact.length ?? 0} · Active {groups?.active.length ?? 0}
      </span>
    </Button>
  )
}

function DecisionTraceList({ traces }: { traces: readonly TickTrace[] }) {
  const groups = groupDecisionTraces(traces)
  if (groups.length === 0) return <EmptyState message="No decision traces yet." />
  return (
    <div className="ui-stack">
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
          <ToolPanelFrame
            key={`${group.firstSeq}-${group.lastSeq}`}
            title={title}
            actions={<Badge tone={trace.exitPath === 'running' ? 'working' : 'neutral'}>{trace.exitPath}</Badge>}
          >
            <div className="ui-stack">
              {trace.exitPath === 'running' && <Badge tone="working">Running</Badge>}
              <div>
                <strong>Saw</strong>
                <pre className="ui-readout">{prettyJson(trace.snapshot ?? 'No snapshot recorded')}</pre>
              </div>
              <div className="ui-stack">
                <strong>Decided</strong>
                <span>{decisionText}</span>
                {action && <pre className="ui-readout">{prettyJson(action)}</pre>}
                {noAction?.detail && <span>{noAction.detail}</span>}
                {noAction?.deviation?.detail && <span>{noAction.deviation.detail}</span>}
                <span>{gateText}</span>
                {trace.gate && trace.gate.verdict !== 'allow' && trace.gate.detail && <span>{trace.gate.detail}</span>}
              </div>
              <div><strong>Declined</strong> · {trace.declined.length > 0 ? trace.declined.join(', ') : 'No phase declined'}</div>
            </div>
          </ToolPanelFrame>
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
    <ToolPanelFrame title="Watcher activity · newest first">
      {entries.length === 0 ? (
        <EmptyState message="No watcher activity yet." />
      ) : (
        <div className="ui-stack">
          {entries.map((entry) => {
            const summary = activitySummary(entry)
            return (
              <details key={`${entry.seq}-${entry.eventId}`}>
                <summary><strong>{entry.kind}</strong> · #{entry.seq} · {timestamp(entry.atMs)}{summary ? ` · ${summary}` : ''}</summary>
                <pre className="ui-readout">{prettyJson(entry)}</pre>
              </details>
            )
          })}
        </div>
      )}
    </ToolPanelFrame>
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
    <ToolPanelFrame title="Open escalations">
      {escalations.length === 0 ? (
        <EmptyState message="No open escalations." />
      ) : (
        <div className="ui-stack">
          {escalations.map((escalation) => {
            const scope = escalation.approvalScope
            const canApprove = escalation.status === 'open' && scope !== undefined
            return (
              <InlineAgentCard
                key={escalation.escalationId}
                title={`${escalation.escalationKind} · ${escalation.status}`}
                status={escalation.status === 'open' ? 'needs-you' : 'idle'}
                description={
                  <div className="ui-stack">
                    <span>Fold {escalation.foldCount}</span>
                    {escalation.reason && <span><strong>Reason:</strong> {escalation.reason}</span>}
                    {escalation.detail && <span><strong>Detail:</strong> {escalation.detail}</span>}
                    {scope && (
                      <div className="ui-stack">
                        <strong>Exact approval scope</strong>
                        <dl className="ui-stack">
                          {approvalScopeText(scope).map(([label, value]) => (
                            <div key={label} className="ui-cluster">
                              <dt>{label}</dt>
                              <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd>
                            </div>
                          ))}
                        </dl>
                        <p className="ui-text-muted">Approve authorizes only this exact action scope. Changed content, evidence, or prepared commit requires a new approval.</p>
                      </div>
                    )}
                  </div>
                }
                action={canApprove ? { label: 'Approve exact action', onAction: () => onApprove(escalation), disabled } : undefined}
              />
            )
          })}
        </div>
      )}
    </ToolPanelFrame>
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
    <ToolPanelFrame title="Workers">
      {workers.length === 0 ? (
        <EmptyState message="No workers reported." />
      ) : (
        <div className="ui-stack">
          {workers.map((worker) => {
            const identity = worker.identity
            const answer = answers[identity.dispatchId] ?? ''
            const exactProcessIdentity = Boolean(identity.sessionId && identity.processIncarnation)
            const question = worker.question && !worker.question.answered ? worker.question : null
            return (
              <div key={identity.dispatchId} className="ui-stack">
                <InlineAgentCard
                  title={worker.title ?? identity.dispatchId}
                  status={worker.state === 'live' ? 'working' : 'idle'}
                  description={
                    <span className="ui-stack">
                      <span>Dispatch {identity.dispatchId}{identity.sessionId ? ` · Session ${identity.sessionId}` : ''}{identity.processIncarnation ? ` · Process ${identity.processIncarnation}` : ''}{identity.pid !== undefined ? ` · PID ${identity.pid}` : ''}</span>
                      {worker.lastContactAtMs !== undefined && <span className="ui-text-muted">Last contact {timestamp(worker.lastContactAtMs)}</span>}
                      <span className="ui-text-muted">{worker.state}</span>
                    </span>
                  }
                />
                <div className="ui-cluster">
                  <Button
                    disabled={disabled || worker.state !== 'live' || !exactProcessIdentity}
                    title={!exactProcessIdentity ? 'Exact session and process-incarnation identity is required to stop a worker safely.' : undefined}
                    onClick={() => onCommand({ kind: 'stop-worker', identity }, `Stop worker ${identity.dispatchId}`)}
                  >Stop</Button>
                  <Button
                    disabled={!canOpenTerminal || !identity.sessionId}
                    title={!canOpenTerminal ? 'Remote worker terminals cannot be opened on this device.' : !identity.sessionId ? 'This worker has no session identity.' : undefined}
                    onClick={() => void openTerminal(worker)}
                  >Open terminal</Button>
                </div>
                {!exactProcessIdentity && <p className="ui-text-muted">Stop is unavailable until the exact session and process-incarnation identity can be verified.</p>}
                {question && (
                  <form
                    className="ui-stack"
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault()
                      if (!answer.trim()) return
                      onCommand({ kind: 'answer-question', messageId: question.messageId, body: answer }, `Answer worker question ${identity.dispatchId}`)
                    }}
                  >
                    <div><strong>Question:</strong> {question.body}</div>
                    <TextArea
                      id={`worker-answer-${identity.dispatchId}`}
                      label="Answer"
                      rows={3}
                      value={answer}
                      onChange={(event) => { const value = event.currentTarget.value; setAnswers((previous) => ({ ...previous, [identity.dispatchId]: value })) }}
                    />
                    <div className="ui-cluster">
                      <Button type="submit" disabled={disabled || !answer.trim()}>Send answer</Button>
                    </div>
                  </form>
                )}
              </div>
            )
          })}
        </div>
      )}
    </ToolPanelFrame>
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
    <section className="ui-stack">
      <ToolPanelFrame title={detail.name} actions={<Button onClick={copyDebug}>Copy debug report</Button>}>
        <div className="ui-stack">
          <div className="ui-cluster">
            <Badge>{detail.enrollment.kind}</Badge>
            <span className="ui-text-muted">{isRemoteTarget(detail.target) ? `Remote · Controlled by ${detail.ownerLabel ?? detail.target.connectionId ?? 'paired owner'}` : 'This device'}</span>
          </div>
          <ListRow
            title="Owner state observed"
            status={status ? statusForLabel(status.label) : 'idle'}
            description={`${duration(now - detail.observedAtMs)} ago · ${status?.label ?? statusSource?.state ?? 'Unknown'}`}
          />
          <ListRow title="Reason" description={currentReason ?? 'No current reason reported.'} />
          {status?.detail && <ListRow title="Detail" description={status.detail} />}
          {detail.enrollment.malformed && <ListRow title="Malformed enrollment" status="failing" description={detail.enrollment.malformed} />}
          {detail.ownerContact === 'unverifiable' && <p className="ui-text-muted">Owner contact is unverifiable; this is the last confirmed state.</p>}
          {detail.readOnly && <p className="ui-text-muted">This enrollment is read-only. Controls are unavailable.</p>}
          {isRemoteTarget(detail.target) && <p className="ui-text-muted">Controls are routed to {detail.ownerLabel ?? 'the paired owner'} and checked against its current host, workspace, watcher revision, and daemon incarnation.</p>}
        </div>
      </ToolPanelFrame>

      {feedback && (
        <div role="status">
          <InlineAgentCard
            title={feedback.command}
            status={feedback.result.kind === 'applied' ? 'done' : feedback.result.kind === 'refused' ? 'needs-you' : 'failing'}
            description={
              <span className="ui-stack">
                <span>{formatCommandResult(feedback.result)}</span>
                {feedback.result.kind === 'indeterminate' && <span>Do not retry automatically; refresh and verify the owner's state before issuing another command.</span>}
              </span>
            }
          />
        </div>
      )}
      {controlsPending && <div role="status"><Badge tone="needs-you">A command is pending; additional controls are disabled until it settles.</Badge></div>}
      {!canCommand && !detail.readOnly && !isRemoteTarget(detail.target) && detail.ownerContact !== 'unverifiable' && <div role="alert" className="ui-error-text">Controls are unavailable for this malformed enrollment.</div>}

      <ToolPanelFrame title="Owner controls">
        <div className="ui-stack">
          <div className="ui-cluster">
            <Button disabled={controlsDisabled || !canResume} onClick={() => onCommand({ kind: 'resume' }, 'Resume watcher')}>Resume</Button>
            <Button disabled={controlsDisabled || !detail.enrollment.enabled || detail.enrollment.paused} onClick={() => onCommand({ kind: 'pause' }, 'Pause watcher')}>Pause</Button>
            <Button disabled={controlsDisabled || !detail.enrollment.enabled} onClick={() => onCommand({ kind: 'disarm' }, 'Disarm watcher')}>Disarm</Button>
            <Button variant="destructive" disabled={controlsDisabled} onClick={onDelete}>Delete watcher</Button>
          </div>
          {detail.enrollment.kind === 'objective' && (
            <form className="ui-stack" onSubmit={applyCap}>
              <TextField
                id={`max-concurrency-${detail.target.watcherId}`}
                label="Max concurrency (1–1,024)"
                type="number"
                min={1}
                max={1024}
                step={1}
                value={capDraft}
                onChange={(event) => setCapDraft(event.currentTarget.value)}
              />
              <div className="ui-cluster">
                <Button type="submit" disabled={controlsDisabled || capDraft === '' || capDraft === String(cap)}>Update cap</Button>
                <Button type="button" disabled={controlsPending || capDraft === String(cap ?? '')} onClick={() => { setCapDraft(cap === null ? '' : String(cap)); setFormError(null) }}>Cancel</Button>
              </div>
            </form>
          )}
        </div>
      </ToolPanelFrame>
      {formError && <div role="alert" className="ui-error-text">{formError}</div>}

      <ToolPanelFrame title="Budget">
        <div className="ui-stack">
          <ListRow title="Active time" description={`${(detail.budget.activeMs / 60_000).toFixed(1)} min / ${detail.enrollment.budget.wallClockActiveMs === null ? '∞' : `${(detail.enrollment.budget.wallClockActiveMs / 60_000).toFixed(1)} min`}`} />
          <ListRow title="Worker turns" description={`${detail.budget.turns} / ${detail.enrollment.budget.turns ?? '∞'}`} />
          {!editingBudget ? (
            <div className="ui-cluster">
              <Button disabled={controlsDisabled} onClick={() => { setEditingBudget(true); setFormError(null) }}>Edit budget</Button>
            </div>
          ) : (
            <form className="ui-stack" onSubmit={applyBudget}>
              <TextField
                id="active-time-limit"
                label="Active-time limit (minutes)"
                type="number"
                min={0}
                step="any"
                placeholder="Unlimited"
                value={budgetDraft.activeMinutes}
                onChange={(event) => { const value = event.currentTarget.value; setBudgetDraft((previous) => ({ ...previous, activeMinutes: value })) }}
              />
              <TextField
                id="worker-turn-limit"
                label="Worker-turn limit"
                type="number"
                min={0}
                step={1}
                placeholder="Unlimited"
                value={budgetDraft.turns}
                onChange={(event) => { const value = event.currentTarget.value; setBudgetDraft((previous) => ({ ...previous, turns: value })) }}
              />
              <p className="ui-text-muted">Leave a limit blank for unlimited (null). Zero is a valid limit and does not resume a parked watcher.</p>
              <div className="ui-cluster">
                <Button type="submit" disabled={controlsDisabled || budgetDraft.activeMinutes === String(detail.enrollment.budget.wallClockActiveMs === null ? '' : detail.enrollment.budget.wallClockActiveMs / 60_000) && budgetDraft.turns === String(detail.enrollment.budget.turns ?? '')}>Apply budget</Button>
                <Button type="button" disabled={controlsPending} onClick={() => {
                  setBudgetDraft({
                    activeMinutes: detail.enrollment.budget.wallClockActiveMs === null ? '' : String(detail.enrollment.budget.wallClockActiveMs / 60_000),
                    turns: detail.enrollment.budget.turns === null ? '' : String(detail.enrollment.budget.turns)
                  })
                  setEditingBudget(false)
                  setFormError(null)
                }}>Cancel</Button>
              </div>
            </form>
          )}
        </div>
      </ToolPanelFrame>

      <OpenEscalations escalations={detail.openEscalations} disabled={controlsDisabled} onApprove={(escalation) => {
        const scope = escalation.approvalScope
        if (scope) onCommand({ kind: 'approve', escalationId: escalation.escalationId, scope }, `Approve ${escalation.escalationKind}`)
      }} />

      <Workers context={context} workers={detail.workers} worktreeId={detail.enrollment.worktreeId} disabled={controlsDisabled} canOpenTerminal={!isRemoteTarget(detail.target)} onCommand={onCommand} />

      <ToolPanelFrame title="Decision trace">
        <DecisionTraceList traces={detail.traces} />
      </ToolPanelFrame>
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
      if (!('data' in event)) return
      const data = event.data
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
    <main className="ui-stack" style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'auto' }} aria-label="Heimdall fleet">
      <ToolPanelFrame
        title="Heimdall fleet"
        actions={
          <div className="ui-cluster">
            {selectedTarget !== null && <Button onClick={() => setSelectedTarget(null)}>Back to fleet</Button>}
            {selectedTarget === null && <Button disabled={refreshing} onClick={() => void refreshFleet()}>{refreshing ? 'Refreshing…' : 'Refresh fleet'}</Button>}
          </div>
        }
      >
        <div className="ui-stack" style={{ padding: 'var(--ui-space-8)' }}>
          {snapshot && <div><Badge tone={snapshot.attentionCount > 0 ? 'needs-you' : 'neutral'}>{snapshot.activeCount} active · {snapshot.attentionCount} need attention</Badge></div>}
          {refreshError && (
            <div role="alert" className="ui-error-text">
              Fleet refresh failed; {snapshot ? 'showing the last confirmed snapshot' : 'no confirmed snapshot is available'}: {refreshError}
            </div>
          )}
          {!snapshot && !refreshError && <EmptyState message="Loading Heimdall fleet…" />}
          {selectedTarget === null && snapshot && (
            <div className="ui-stack">
              <SectionHeader title="Watcher fleet" />
              <FleetTable rows={orderedRows} now={now} selectedId={null} onSelect={(row) => { setFeedback(null); setSelectedTarget(row.target) }} />
              <ActionHistory items={snapshot.actionHistory} />
            </div>
          )}
          {selectedTarget !== null && (
            <div className="ui-stack">
              {detailBusy && !detail && <EmptyState message="Loading watcher details…" />}
              {detailError && (
                <div role="alert" className="ui-stack">
                  <span className="ui-error-text">Could not load watcher details: {detailError}</span>
                  <div className="ui-cluster">
                    <Button onClick={() => void loadDetail(selectedTarget)}>Retry details</Button>
                  </div>
                </div>
              )}
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
            </div>
          )}
        </div>
      </ToolPanelFrame>
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
