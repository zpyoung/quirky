import { Badge, Button, EmptyState, InlineAgentCard, InlineError, ListRow, NoticeLine, SectionHeader, TextArea, TextField, ToolPanelFrame } from '@quirky/ui'
import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { MountCleanup, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { UiStatus, UiTone } from '@quirky/ui'
import type { ApprovalScope, TickTrace } from './contracts'
import type { CommandRequest, CommandResult, FleetAction, FleetRow, FleetSnapshot, OpenEscalation, WatcherCommand, WatcherDetail, WatcherTarget, WatcherWorker } from './control-contracts'
import { groupFleetRows, sortFleetRows } from './fleet-selectors'
import { acceptFleetSnapshot, answerDraftKey, commandEligibility, groupDecisionTraces, ownerEpochKey, sameCommandOwner, statusPresentation, type CommandReceipt } from './ui-model'
import { UI_CONTROL_COMMAND, dispatchFleetControl, registerFleetControl, requestFleetControl, type FleetControlAction, type FleetControlArgs } from './ui-control'
const FLEET_VIEW_ID = 'view:quirky.heimdall/fleet'
const NAVIGATION_ID = 'sidebar-section:quirky.heimdall/navigation'
const FLEET_CHANGED_EVENT = 'quirky.heimdall/fleetChanged'
const SESSION_VIEW_ID = 'view:quirky.session/worktree'

type MountProps = { input?: unknown; report?(state: unknown): void }
type OperationOwner = { generation: string; ownerEpoch: string }
type Feedback = { command: string; result: CommandResult; owner: OperationOwner }
type DetailReceipt = { detail: WatcherDetail; generation: string; ownerEpoch: string; concurrency: number | null }
type Reservation = { key: string; token: string }
type OwnerCommandRequest = CommandRequest & Record<string, unknown>
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
async function readFleetSnapshot(context: UiPluginContext): Promise<FleetSnapshot> {
  const response = await context.call('quirky.heimdall/fleet', {})
  if (!isFleetSnapshot(response)) throw new Error('The fleet response was not a valid snapshot.')
  return response
}

async function readWatcherDetail(context: UiPluginContext, target: WatcherTarget): Promise<WatcherDetail | null> {
  return await context.call('quirky.heimdall/detail', { target }) as WatcherDetail | null
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
  const snapshotRef = useRef<FleetSnapshot | null>(null)
  const [readError, setReadError] = useState<{ message: string; retained: boolean } | null>(null)
  const requestRef = useRef(0)
  const refreshRef = useRef<() => Promise<void>>(async () => {})

  const acceptSnapshot = (incoming: FleetSnapshot): void => {
    const accepted = acceptFleetSnapshot(snapshotRef.current, incoming)
    if (accepted === snapshotRef.current) return
    snapshotRef.current = accepted
    setSnapshot(accepted)
  }

  const refreshFleet = async (): Promise<void> => {
    const ticket = ++requestRef.current
    try {
      const incoming = await readFleetSnapshot(context)
      if (ticket !== requestRef.current) return
      acceptSnapshot(incoming)
      setReadError(null)
    } catch (error) {
      if (ticket !== requestRef.current) return
      setReadError({ message: messageOf(error), retained: snapshotRef.current !== null })
    }
  }
  refreshRef.current = refreshFleet

  useEffect(() => {
    void refreshRef.current()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (event.type !== FLEET_CHANGED_EVENT || !('data' in event) || !isFleetSnapshot(event.data)) return
      acceptSnapshot(event.data)
      setReadError(null)
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refreshRef.current()
    })
    return () => {
      requestRef.current += 1
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context])

  const groups = snapshot ? groupFleetRows(snapshot.rows) : null
  const openFleet = (): void => context.openView(FLEET_VIEW_ID)
  const errorMessage = readError
    ? readError.retained
      ? `Could not refresh the Heimdall fleet; showing the last confirmed counts: ${readError.message}`
      : `Could not load the Heimdall fleet: ${readError.message}`
    : null
  return (
    <div className="ui-stack">
      <Button
        className="ui-stack"
        style={{ width: '100%', alignItems: 'stretch', textAlign: 'left' }}
        onClick={openFleet}
        aria-label="Open Heimdall fleet"
      >
        <strong>Heimdall</strong>
        {snapshot && snapshot.rows.length > 0 && (
          <span className="ui-text-muted">
            Needs you {groups?.needsYou.length ?? 0} · Lost contact {groups?.lostContact.length ?? 0} · Active {groups?.active.length ?? 0}
          </span>
        )}
      </Button>
      {snapshot?.rows.length === 0 && <EmptyState message="No watchers yet." />}
      {!snapshot && !readError && <NoticeLine>Loading fleet…</NoticeLine>}
      {errorMessage && <InlineError message={errorMessage} action={{ label: 'Retry', onAction: () => { void refreshFleet() } }} />}
    </div>
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
  context, workers, worktreeId, disabled, canOpenTerminal, owner, ownerIsCurrent, ownerEpoch, submitCommand
}: {
  context: UiPluginContext
  workers: readonly WatcherWorker[]
  worktreeId: string | null | undefined
  disabled: boolean
  canOpenTerminal: boolean
  owner: OperationOwner
  ownerIsCurrent(owner: OperationOwner): boolean
  ownerEpoch: string
  submitCommand(command: WatcherCommand, label: string, receipt?: CommandReceipt): Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const answerEpoch = useRef(ownerEpoch)

  useEffect(() => {
    if (answerEpoch.current !== ownerEpoch) {
      answerEpoch.current = ownerEpoch
      setAnswers({})
      return
    }
    const current = new Set(workers.flatMap((item) => item.question && !item.question.answered
      ? [answerDraftKey(item.identity, item.question.messageId)]
      : []))
    setAnswers((previous) => Object.fromEntries(
      Object.entries(previous).filter(([key]) => current.has(key))
    ))
  }, [ownerEpoch, workers])

  const openTerminal = async (worker: WatcherWorker): Promise<void> => {
    const sessionId = worker.identity.sessionId
    if (!sessionId || !ownerIsCurrent(owner)) return
    try {
      let worktree = worktreeId ?? null
      if (!worktree) {
        const session = record(await context.call('quirky.session/get', { session: sessionId }))
        if (!ownerIsCurrent(owner)) return
        worktree = typeof session.worktreeId === 'string' ? session.worktreeId : null
      }
      if (!ownerIsCurrent(owner)) return
      if (!worktree) throw new Error('The session does not belong to a worktree that can be opened.')
      context.openView(SESSION_VIEW_ID, { worktree, session: sessionId })
    } catch (error) {
      if (ownerIsCurrent(owner)) context.toast('Could not open worker terminal', messageOf(error), { kind: 'error' })
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
            const question = worker.question && !worker.question.answered ? worker.question : null
            const answerKey = question ? answerDraftKey(identity, question.messageId) : null
            const answer = answerKey ? answers[answerKey] ?? '' : ''
            const exactProcessIdentity = Boolean(identity.sessionId && identity.processIncarnation)
            const answerSubmit = (event: FormEvent): void => {
              event.preventDefault()
              if (!question || !answer.trim()) return
              void submitCommand(
                { kind: 'answer-question', messageId: question.messageId, body: answer },
                `Answer worker question ${identity.dispatchId}`,
                { kind: 'answer', worker: { ...identity }, messageId: question.messageId }
              )
            }
            const updateAnswer = (event: ChangeEvent<HTMLTextAreaElement>): void => {
              const value = event.currentTarget.value
              if (answerKey) setAnswers((previous) => ({ ...previous, [answerKey]: value }))
            }
            const stopWorker = (): void => {
              void submitCommand({ kind: 'stop-worker', identity }, `Stop worker ${identity.dispatchId}`, { kind: 'none' })
            }
            const openWorkerTerminal = (): void => { void openTerminal(worker) }
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
                    onClick={stopWorker}
                  >Stop</Button>
                  <Button
                    disabled={!canOpenTerminal || !identity.sessionId}
                    title={!canOpenTerminal ? 'Remote worker terminals cannot be opened on this device.' : !identity.sessionId ? 'This worker has no session identity.' : undefined}
                    onClick={openWorkerTerminal}
                  >Open terminal</Button>
                </div>
                {!exactProcessIdentity && <p className="ui-text-muted">Stop is unavailable until the exact session and process-incarnation identity can be verified.</p>}
                {question && (
                  <form className="ui-stack" onSubmit={answerSubmit}>
                    <div><strong>Question:</strong> {question.body}</div>
                    <TextArea
                      id={`worker-answer-${identity.dispatchId}`}
                      label="Answer"
                      rows={3}
                      value={answer}
                      onChange={updateAnswer}
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
function canControlDetail(detail: WatcherDetail): boolean {
  return !detail.readOnly && !detail.enrollment.malformed && detail.ownerContact === 'live' &&
    (!isRemoteTarget(detail.target) || Boolean(detail.ownerIncarnation))
}

function sameOperationOwner(left: OperationOwner, right: OperationOwner): boolean {
  return left.generation === right.generation && left.ownerEpoch === right.ownerEpoch
}

function WatcherDetailPane({
  context, detail, row, now, pending, canCommand, feedback, owner, ownerEpoch,
  budgetDraft, editingBudget, budgetEditorRevision, budgetError,
  capDraft, concurrencyRevision, concurrencyError,
  setBudgetDraft, setBudgetError, setConcurrencyError,
  changeBudgetEditor, changeConcurrencyDraft, requestControl, submitCommand, deleteWatcher, ownerIsCurrent
}: {
  context: UiPluginContext
  detail: WatcherDetail
  row: FleetRow | undefined
  now: number
  pending: boolean
  canCommand: boolean
  feedback: Feedback | null
  owner: OperationOwner
  ownerEpoch: string
  budgetDraft: BudgetDraft
  editingBudget: boolean
  budgetEditorRevision: number
  budgetError: string | null
  capDraft: string
  concurrencyRevision: number
  concurrencyError: string | null
  setBudgetDraft(draft: BudgetDraft): void
  setBudgetError(value: string | null): void
  setConcurrencyError(value: string | null): void
  changeBudgetEditor(open: boolean): void
  changeConcurrencyDraft(value: string): void
  requestControl(action: FleetControlAction, revision: number, title: string): void
  submitCommand(command: WatcherCommand, label: string, receipt?: CommandReceipt): Promise<void>
  deleteWatcher(): Promise<void>
  ownerIsCurrent(owner: OperationOwner): boolean
}) {
  const statusSource = detail.status ?? row?.status
  const status = statusSource ? statusPresentation({ status: statusSource, ownerContact: detail.ownerContact, observedAtMs: detail.observedAtMs }, now) : null
  const cap = detail.enrollment.kind === 'objective' ? objectiveCap(detail, row) : null
  const controlsPending = pending || detail.pendingControls.length > 0
  const controlsDisabled = controlsPending || !canCommand
  const canResume = detail.status?.state !== 'terminal' && detail.enrollment.terminalAtMs === null && (detail.enrollment.paused || detail.enrollment.parkReason !== null)

  const applyBudget = (event: FormEvent): void => {
    event.preventDefault()
    const activeValue = budgetDraft.activeMinutes.trim() === '' ? null : Number(budgetDraft.activeMinutes)
    const turnsValue = budgetDraft.turns.trim() === '' ? null : Number(budgetDraft.turns)
    if (activeValue !== null && (!Number.isFinite(activeValue) || activeValue < 0 || !Number.isFinite(activeValue * 60_000))) {
      setBudgetError('Active-time limit must be a finite non-negative number of minutes, or blank for unlimited.')
      return
    }
    if (turnsValue !== null && (!Number.isFinite(turnsValue) || !Number.isInteger(turnsValue) || turnsValue < 0)) {
      setBudgetError('Worker-turn limit must be a non-negative integer, or blank for unlimited.')
      return
    }
    setBudgetError(null)
    const currentActiveMinutes = detail.enrollment.budget.wallClockActiveMs === null ? '' : String(detail.enrollment.budget.wallClockActiveMs / 60_000)
    const wallClockActiveMs = budgetDraft.activeMinutes === currentActiveMinutes
      ? detail.enrollment.budget.wallClockActiveMs
      : activeValue === null ? null : activeValue * 60_000
    changeBudgetEditor(false)
    void submitCommand({ kind: 'adjust-budget', budget: { wallClockActiveMs, turns: turnsValue } }, 'Update budget')
  }

  const applyConcurrency = (event: FormEvent): void => {
    event.preventDefault()
    const value = Number(capDraft)
    if (!Number.isSafeInteger(value) || value < 1 || value > 1024) {
      setConcurrencyError('Objective concurrency must be an integer from 1 through 1,024.')
      return
    }
    setConcurrencyError(null)
    void submitCommand({ kind: 'set-concurrency', maxConcurrency: value }, 'Update objective concurrency')
  }

  const copyDebugReport = async (): Promise<void> => {
    if (!ownerIsCurrent(owner)) return
    try {
      const report = await context.call('quirky.heimdall/debugReport', { target: detail.target })
      if (!ownerIsCurrent(owner)) return
      if (report === null || report === undefined) throw new Error('No debug report is available for this watcher.')
      const text = JSON.stringify(report, null, 2)
      if (typeof text !== 'string') throw new Error('The debug report could not be encoded as JSON.')
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this window.')
      await navigator.clipboard.writeText(text)
      if (ownerIsCurrent(owner)) context.toast('Debug report copied', '', { kind: 'success' })
    } catch (error) {
      if (ownerIsCurrent(owner)) context.toast('Could not copy the debug report.', messageOf(error), { kind: 'error' })
    }
  }

  const updateActiveMinutes = (event: ChangeEvent<HTMLInputElement>): void => {
    setBudgetDraft({ ...budgetDraft, activeMinutes: event.currentTarget.value })
  }
  const updateWorkerTurns = (event: ChangeEvent<HTMLInputElement>): void => {
    setBudgetDraft({ ...budgetDraft, turns: event.currentTarget.value })
  }
  const editBudget = (): void => requestControl('edit-budget', budgetEditorRevision, 'Could not edit the budget')
  const cancelBudget = (): void => requestControl('cancel-budget', budgetEditorRevision, 'Could not cancel the budget edit')
  const cancelConcurrency = (): void => requestControl('cancel-concurrency', concurrencyRevision, 'Could not cancel the concurrency edit')
  const approveEscalation = (escalation: OpenEscalation): void => {
    if (escalation.approvalScope) {
      void submitCommand(
        { kind: 'approve', escalationId: escalation.escalationId, scope: escalation.approvalScope },
        `Approve ${escalation.escalationKind}`,
        { kind: 'none' }
      )
    }
  }
  const copyDebug = (): void => { void copyDebugReport() }

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
      {!canCommand && !detail.readOnly && !isRemoteTarget(detail.target) && detail.ownerContact !== 'unverifiable' && <InlineError message="Controls are unavailable for this malformed enrollment." />}

      <ToolPanelFrame title="Owner controls">
        <div className="ui-stack">
          <div className="ui-cluster">
            <Button disabled={controlsDisabled || !canResume} onClick={() => { void submitCommand({ kind: 'resume' }, 'Resume watcher') }}>Resume</Button>
            <Button disabled={controlsDisabled || !detail.enrollment.enabled || detail.enrollment.paused} onClick={() => { void submitCommand({ kind: 'pause' }, 'Pause watcher') }}>Pause</Button>
            <Button disabled={controlsDisabled || !detail.enrollment.enabled} onClick={() => { void submitCommand({ kind: 'disarm' }, 'Disarm watcher') }}>Disarm</Button>
            <Button variant="destructive" disabled={controlsDisabled} onClick={() => { void deleteWatcher() }}>Delete watcher</Button>
          </div>
          {detail.enrollment.kind === 'objective' && (
            <form className="ui-stack" noValidate onSubmit={applyConcurrency}>
              <TextField
                id={`max-concurrency-${detail.target.watcherId}`}
                label="Max concurrency (1–1,024)"
                type="number"
                min={1}
                max={1024}
                step={1}
                value={capDraft}
                onChange={(event) => changeConcurrencyDraft(event.currentTarget.value)}
              />
              {concurrencyError && <InlineError message={concurrencyError} />}
              <div className="ui-cluster">
                <Button type="submit" disabled={controlsDisabled || capDraft === '' || capDraft === String(cap)}>Update cap</Button>
                <Button type="button" disabled={controlsPending || capDraft === String(cap ?? '')} onClick={cancelConcurrency}>Cancel</Button>
              </div>
            </form>
          )}
        </div>
      </ToolPanelFrame>

      <ToolPanelFrame title="Budget">
        <div className="ui-stack">
          <ListRow title="Active time" description={`${(detail.budget.activeMs / 60_000).toFixed(1)} min / ${detail.enrollment.budget.wallClockActiveMs === null ? '∞' : `${(detail.enrollment.budget.wallClockActiveMs / 60_000).toFixed(1)} min`}`} />
          <ListRow title="Worker turns" description={`${detail.budget.turns} / ${detail.enrollment.budget.turns ?? '∞'}`} />
          {!editingBudget ? (
            <div className="ui-cluster">
              <Button disabled={controlsDisabled} onClick={editBudget}>Edit budget</Button>
            </div>
          ) : (
            <form className="ui-stack" noValidate onSubmit={applyBudget}>
              <TextField
                id="active-time-limit"
                label="Active-time limit (minutes)"
                type="number"
                min={0}
                step="any"
                placeholder="Unlimited"
                value={budgetDraft.activeMinutes}
                onChange={updateActiveMinutes}
              />
              <TextField
                id="worker-turn-limit"
                label="Worker-turn limit"
                type="number"
                min={0}
                step={1}
                placeholder="Unlimited"
                value={budgetDraft.turns}
                onChange={updateWorkerTurns}
              />
              <p className="ui-text-muted">Leave a limit blank for unlimited (null). Zero is a valid limit and does not resume a parked watcher.</p>
              {budgetError && <InlineError message={budgetError} />}
              <div className="ui-cluster">
                <Button type="submit" disabled={controlsDisabled || budgetDraft.activeMinutes === String(detail.enrollment.budget.wallClockActiveMs === null ? '' : detail.enrollment.budget.wallClockActiveMs / 60_000) && budgetDraft.turns === String(detail.enrollment.budget.turns ?? '')}>Apply budget</Button>
                <Button type="button" disabled={controlsPending} onClick={cancelBudget}>Cancel</Button>
              </div>
            </form>
          )}
        </div>
      </ToolPanelFrame>

      <OpenEscalations escalations={detail.openEscalations} disabled={controlsDisabled} onApprove={approveEscalation} />
      <Workers
        context={context}
        workers={detail.workers}
        worktreeId={detail.enrollment.worktreeId}
        disabled={controlsDisabled}
        canOpenTerminal={!isRemoteTarget(detail.target)}
        owner={owner}
        ownerIsCurrent={ownerIsCurrent}
        ownerEpoch={ownerEpoch}
        submitCommand={submitCommand}
      />

      <ToolPanelFrame title="Decision trace">
        <DecisionTraceList traces={detail.traces} />
      </ToolPanelFrame>
      <ActivityFeed detail={detail} />
    </section>
  )
}

function HeimdallFleet({
  context, input, instance, report, updateInputRef, signal
}: {
  context: UiPluginContext
  input: unknown
  instance: string
  report?: (state: unknown) => void
  updateInputRef: { current(input: unknown): boolean }
  signal: AbortSignal
}) {
  const firstTarget = initialTarget(input)
  const [selection, setSelection] = useState(() => ({
    target: firstTarget,
    generation: firstTarget ? crypto.randomUUID() : null
  }))
  const selectionRef = useRef(selection)
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null)
  const snapshotRef = useRef<FleetSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [fleetError, setFleetError] = useState<string | null>(null)
  const [loadedDetail, setLoadedDetail] = useState<DetailReceipt | null>(null)
  const latestDetailRef = useRef<DetailReceipt | null>(null)
  const [detailMissing, setDetailMissing] = useState(false)
  const [detailBusy, setDetailBusy] = useState(Boolean(firstTarget))
  const [detailError, setDetailError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [reservedKeys, setReservedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const reservationsRef = useRef(new Map<string, string>())
  const latestDetailRequest = useRef(0)
  const latestFleetRequest = useRef(0)
  const refreshFleetRef = useRef<() => Promise<void>>(async () => {})
  const loadDetailRef = useRef<(target: WatcherTarget, generation: string) => Promise<void>>(async () => {})
  const acceptSnapshotRef = useRef<(incoming: FleetSnapshot) => boolean>(() => false)
  const now = useClock()

  const [budgetDraft, setBudgetDraftState] = useState<BudgetDraft>({ activeMinutes: '', turns: '' })
  const [editingBudget, setEditingBudget] = useState(false)
  const editingBudgetRef = useRef(false)
  const [budgetEditorRevision, setBudgetEditorRevision] = useState(0)
  const budgetEditorRevisionRef = useRef(0)
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const [capDraft, setCapDraftState] = useState('')
  const capDirtyRef = useRef(false)
  const [concurrencyRevision, setConcurrencyRevision] = useState(0)
  const concurrencyRevisionRef = useRef(0)
  const [concurrencyError, setConcurrencyError] = useState<string | null>(null)

  const setBudgetDraft = (draft: BudgetDraft): void => setBudgetDraftState(draft)
  const setCapDraft = (draft: string): void => setCapDraftState(draft)
  const bumpBudgetEditorRevision = (): void => {
    const next = budgetEditorRevisionRef.current + 1
    budgetEditorRevisionRef.current = next
    setBudgetEditorRevision(next)
  }
  const bumpConcurrencyRevision = (): void => {
    const next = concurrencyRevisionRef.current + 1
    concurrencyRevisionRef.current = next
    setConcurrencyRevision(next)
  }
  const changeBudgetEditor = (open: boolean): void => {
    if (editingBudgetRef.current === open) return
    editingBudgetRef.current = open
    setEditingBudget(open)
    bumpBudgetEditorRevision()
  }

  const confirmedBudget = (detail: WatcherDetail): BudgetDraft => ({
    activeMinutes: detail.enrollment.budget.wallClockActiveMs === null ? '' : String(detail.enrollment.budget.wallClockActiveMs / 60_000),
    turns: detail.enrollment.budget.turns === null ? '' : String(detail.enrollment.budget.turns)
  })
  const confirmedConcurrency = (detail: WatcherDetail): number | null => {
    const row = snapshotRef.current?.rows.find((item) => targetKey(item.target) === targetKey(detail.target))
    return detail.enrollment.kind === 'objective' ? objectiveCap(detail, row) : null
  }
  const changeConcurrencyDraft = (draft: string): void => {
    const cap = latestDetailRef.current?.concurrency ?? null
    const dirty = draft !== (cap === null ? '' : String(cap))
    if (dirty !== capDirtyRef.current) {
      capDirtyRef.current = dirty
      bumpConcurrencyRevision()
    }
    setCapDraft(draft)
  }
  const resetSelectionDrafts = (): void => {
    editingBudgetRef.current = false
    setEditingBudget(false)
    budgetEditorRevisionRef.current = 0
    setBudgetEditorRevision(0)
    setBudgetDraft({ activeMinutes: '', turns: '' })
    setBudgetError(null)
    capDirtyRef.current = false
    concurrencyRevisionRef.current = 0
    setConcurrencyRevision(0)
    setCapDraft('')
    setConcurrencyError(null)
  }
  const selectTarget = (target: WatcherTarget | null): boolean => {
    const current = selectionRef.current
    if (current.target === null && target === null) return true
    if (current.target && target && targetKey(current.target) === targetKey(target)) return true
    const next = { target, generation: target ? crypto.randomUUID() : null }
    selectionRef.current = next
    setSelection(next)
    latestDetailRequest.current += 1
    latestDetailRef.current = null
    setLoadedDetail(null)
    setDetailMissing(false)
    setDetailBusy(target !== null)
    setDetailError(null)
    setFeedback(null)
    resetSelectionDrafts()
    return true
  }
  const applyInput = (nextInput: unknown): boolean => selectTarget(initialTarget(nextInput))
  updateInputRef.current = applyInput

  const acceptSnapshot = (incoming: FleetSnapshot): boolean => {
    const accepted = acceptFleetSnapshot(snapshotRef.current, incoming)
    if (accepted === snapshotRef.current) return false
    snapshotRef.current = accepted
    setSnapshot(accepted)
    const selected = selectionRef.current
    if (selected.target) {
      const replacement = accepted.rows.find((row) => sameTargetOwner(row.target, selected.target!))
      if (replacement && targetKey(replacement.target) !== targetKey(selected.target)) selectTarget(replacement.target)
    }
    return true
  }
  acceptSnapshotRef.current = acceptSnapshot

  const synchronizeDrafts = (previous: DetailReceipt | null, next: DetailReceipt): void => {
    const previousDetail = previous?.generation === next.generation ? previous.detail : null
    if (!previousDetail) {
      setBudgetDraft(confirmedBudget(next.detail))
      setBudgetError(null)
      editingBudgetRef.current = false
      setEditingBudget(false)
      capDirtyRef.current = false
      setCapDraft(next.concurrency === null ? '' : String(next.concurrency))
      setConcurrencyError(null)
      return
    }

    const epochChanged = previous?.ownerEpoch !== next.ownerEpoch
    const budgetChanged =
      previousDetail.enrollment.budget.wallClockActiveMs !== next.detail.enrollment.budget.wallClockActiveMs ||
      previousDetail.enrollment.budget.turns !== next.detail.enrollment.budget.turns
    if (epochChanged || budgetChanged) {
      setBudgetDraft(confirmedBudget(next.detail))
      setBudgetError(null)
      editingBudgetRef.current = false
      setEditingBudget(false)
      bumpBudgetEditorRevision()
    }

    if (epochChanged || previous?.concurrency !== next.concurrency) {
      changeConcurrencyDraft(next.concurrency === null ? '' : String(next.concurrency))
      setConcurrencyError(null)
    }
    if (epochChanged) setFeedback(null)
  }

  const loadDetail = async (requestedTarget: WatcherTarget, generation: string): Promise<void> => {
    if (signal.aborted) return
    const ticket = ++latestDetailRequest.current
    setDetailBusy(true)
    setDetailError(null)
    const row = snapshotRef.current?.rows.find((item) => targetKey(item.target) === targetKey(requestedTarget))
    const target = row?.target ?? requestedTarget
    try {
      const loaded = await readWatcherDetail(context, target)
      if (ticket !== latestDetailRequest.current || selectionRef.current.generation !== generation) return
      if (loaded === null) {
        latestDetailRef.current = null
        setLoadedDetail(null)
        setDetailMissing(true)
      } else {
        const previous = latestDetailRef.current
        const receipt = { detail: loaded, generation, ownerEpoch: ownerEpochKey(loaded), concurrency: confirmedConcurrency(loaded) }
        latestDetailRef.current = receipt
        synchronizeDrafts(previous, receipt)
        setLoadedDetail(receipt)
        setDetailMissing(false)
      }
    } catch (error) {
      if (ticket !== latestDetailRequest.current || selectionRef.current.generation !== generation) return
      setDetailError(messageOf(error))
    } finally {
      if (ticket === latestDetailRequest.current && selectionRef.current.generation === generation) setDetailBusy(false)
    }
  }
  loadDetailRef.current = loadDetail

  const refreshFleet = async (): Promise<void> => {
    if (signal.aborted) return
    const ticket = ++latestFleetRequest.current
    setRefreshing(true)
    try {
      const incoming = await readFleetSnapshot(context)
      if (ticket !== latestFleetRequest.current) return
      acceptSnapshotRef.current(incoming)
      setFleetError(null)
    } catch (error) {
      if (ticket === latestFleetRequest.current) setFleetError(messageOf(error))
    } finally {
      if (ticket === latestFleetRequest.current) setRefreshing(false)
    }
  }
  refreshFleetRef.current = refreshFleet

  useEffect(() => {
    void refreshFleetRef.current()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (event.type !== FLEET_CHANGED_EVENT || !('data' in event) || !isFleetSnapshot(event.data)) return
      const generation = selectionRef.current.generation
      if (!acceptSnapshotRef.current(event.data)) return
      setFleetError(null)
      const selected = selectionRef.current
      if (selected.target && selected.generation && selected.generation === generation) void loadDetailRef.current(selected.target, selected.generation)
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refreshFleetRef.current()
    })
    return () => {
      latestDetailRequest.current += 1
      latestFleetRequest.current += 1
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context])

  useEffect(() => {
    if (selection.target && selection.generation) {
      void loadDetailRef.current(selection.target, selection.generation)
    } else {
      latestDetailRequest.current += 1
      latestDetailRef.current = null
      setLoadedDetail(null)
      setDetailMissing(false)
      setDetailError(null)
      setDetailBusy(false)
    }
  }, [selection.generation])

  const selectedTarget = selection.target
  const currentDetail = loadedDetail?.generation === selection.generation ? loadedDetail : null
  const detail = currentDetail?.detail ?? null
  const orderedRows = useMemo(() => snapshot ? sortFleetRows(snapshot.rows) : [], [snapshot])
  const selectedRow = selectedTarget ? snapshot?.rows.find((row) => targetKey(row.target) === targetKey(selectedTarget)) : undefined
  const canCommand = Boolean(detail && canControlDetail(detail))
  const renderedOwner: OperationOwner | null = currentDetail
    ? { generation: currentDetail.generation, ownerEpoch: currentDetail.ownerEpoch }
    : null
  const ownerIsCurrent = (owner: OperationOwner): boolean => {
    const latest = latestDetailRef.current
    return !signal.aborted && selectionRef.current.generation === owner.generation &&
      latest?.generation === owner.generation && latest.ownerEpoch === owner.ownerEpoch
  }
  const requestKey = (target: WatcherTarget, epoch: string): string => JSON.stringify([targetKey(target), epoch])
  const currentReservationKey = detail ? requestKey(detail.target, currentDetail!.ownerEpoch) : null

  const reserveOperation = (target: WatcherTarget, epoch: string): Reservation | null => {
    const key = requestKey(target, epoch)
    if (reservationsRef.current.has(key)) return null
    const token = crypto.randomUUID()
    reservationsRef.current.set(key, token)
    setReservedKeys(new Set(reservationsRef.current.keys()))
    return { key, token }
  }
  const releaseOperation = (reservation: Reservation): void => {
    if (reservationsRef.current.get(reservation.key) !== reservation.token) return
    reservationsRef.current.delete(reservation.key)
    setReservedKeys(new Set(reservationsRef.current.keys()))
  }
  const makeCommandRequest = (source: WatcherDetail, command: WatcherCommand): OwnerCommandRequest => ({
    target: source.target,
    expectedOwner: source.ownerFence,
    command,
    ...(isRemoteTarget(source.target) && source.ownerIncarnation ? { expectedIncarnation: source.ownerIncarnation } : {})
  })

  const sendCommand = async (
    command: WatcherCommand,
    label: string,
    request: OwnerCommandRequest,
    owner: OperationOwner,
    confirmedDelete = false
  ): Promise<void> => {
    let result: CommandResult
    try {
      const params = confirmedDelete ? { ...request, yes: true } : request
      const response = await context.call('quirky.heimdall/command', params)
      result = isCommandResult(response) ? response : {
        kind: 'indeterminate',
        detail: 'The owner returned an unrecognized result; the command outcome could not be confirmed.'
      }
    } catch (error) {
      result = { kind: 'indeterminate', detail: `The command reply could not be confirmed: ${messageOf(error)}` }
    }

    if (ownerIsCurrent(owner)) setFeedback({ command: label, result, owner })
    if (result.kind === 'applied') {
      context.toast(`${label} applied`, formatCommandResult(result), { kind: 'success' })
      if (ownerIsCurrent(owner)) {
        if (command.kind === 'delete') context.openView(FLEET_VIEW_ID)
        else {
          void refreshFleetRef.current()
          void loadDetailRef.current(request.target, owner.generation)
        }
      }
    } else if (result.kind === 'refused') {
      context.toast(`${label} refused`, `${result.reason}: ${result.detail}`, { kind: 'warning' })
    } else {
      context.toast(`${label} outcome indeterminate`, `${result.detail} Do not retry automatically; verify the owner's state before issuing another command.`, { kind: 'warning' })
    }
  }

  const submitCommand = async (command: WatcherCommand, label: string, receipt: CommandReceipt = { kind: 'none' }): Promise<void> => {
    if (!renderedOwner || !ownerIsCurrent(renderedOwner)) return
    const latest = latestDetailRef.current
    if (!latest || latest.generation !== renderedOwner.generation) return
    const reason = commandEligibility(command, receipt, latest.detail)
    if (reason) {
      context.toast(`${label} not sent`, `${reason}; review it and try again.`, { kind: 'error' })
      return
    }
    if (!canControlDetail(latest.detail) || latest.detail.pendingControls.length > 0 || !ownerIsCurrent(renderedOwner)) return
    const request = makeCommandRequest(latest.detail, command)
    const reservation = reserveOperation(latest.detail.target, latest.ownerEpoch)
    if (!reservation) return
    setFeedback(null)
    try {
      await sendCommand(command, label, request, renderedOwner)
    } finally {
      releaseOperation(reservation)
    }
  }

  const deleteWatcher = async (): Promise<void> => {
    if (!renderedOwner || !ownerIsCurrent(renderedOwner)) return
    const latest = latestDetailRef.current
    if (!latest || latest.generation !== renderedOwner.generation || !canControlDetail(latest.detail) || latest.detail.pendingControls.length > 0) return
    const request = makeCommandRequest(latest.detail, { kind: 'delete' })
    const reservation = reserveOperation(latest.detail.target, latest.ownerEpoch)
    if (!reservation) return
    setFeedback(null)
    try {
      const preview = await context.call('quirky.heimdall/describeCommand', request)
      if (signal.aborted) return
      const described = latestDetailRef.current
      if (!ownerIsCurrent(renderedOwner) || !described || !sameCommandOwner(request, described.detail)) {
        context.toast('Delete watcher not sent', `The watcher's owner changed; review it and try again.`, { kind: 'warning' })
        return
      }
      if (typeof preview !== 'string') {
        context.toast('Delete watcher refused', 'The owner could not provide an applicable deletion preview.', { kind: 'warning' })
        return
      }
      const confirmed = await context.confirm({
        title: 'Delete watcher?',
        body: preview,
        confirmLabel: 'Delete watcher'
      })
      if (signal.aborted) return
      const confirmedDetail = latestDetailRef.current
      if (!ownerIsCurrent(renderedOwner) || !confirmedDetail || !sameCommandOwner(request, confirmedDetail.detail)) {
        context.toast('Delete watcher not sent', `The watcher's owner changed; review it and try again.`, { kind: 'warning' })
        return
      }
      if (confirmed && canControlDetail(confirmedDetail.detail) && confirmedDetail.detail.pendingControls.length === 0) {
        await sendCommand({ kind: 'delete' }, 'Delete watcher', request, renderedOwner, true)
      }
    } catch (error) {
      if (ownerIsCurrent(renderedOwner)) context.toast('Could not confirm watcher deletion', messageOf(error), { kind: 'error' })
    } finally {
      releaseOperation(reservation)
    }
  }

  const controlSessionIsCurrent = (args: FleetControlArgs): boolean => {
    if (signal.aborted || args.instance !== instance || selectionRef.current.generation !== args.generation) return false
    const currentRevision = args.action === 'cancel-concurrency'
      ? concurrencyRevisionRef.current
      : budgetEditorRevisionRef.current
    return currentRevision === args.revision
  }
  const requestControl = async (action: FleetControlAction, revision: number, title: string): Promise<void> => {
    const generation = selectionRef.current.generation
    if (!generation) return
    const args: FleetControlArgs = { action, instance, generation, revision }
    try {
      const result = await requestFleetControl(context, args, signal)
      if (result.delivered === 0 && controlSessionIsCurrent(args)) {
        context.toast(title, 'The watcher view changed before the control arrived.', { kind: 'error' })
      }
    } catch (error) {
      if (controlSessionIsCurrent(args)) context.toast(title, messageOf(error), { kind: 'error' })
    }
  }
  const dispatchControl = (args: FleetControlArgs): boolean => {
    if (signal.aborted) return false
    const current = selectionRef.current
    const latest = latestDetailRef.current
    if (!latest || !current.target || current.generation !== args.generation || latest.generation !== args.generation) return false
    if (args.instance !== instance) return false
    const detailForControl = latest.detail
    const key = requestKey(detailForControl.target, latest.ownerEpoch)
    const pending = reservationsRef.current.has(key) || detailForControl.pendingControls.length > 0

    if (args.action === 'edit-budget') {
      if (args.revision !== budgetEditorRevisionRef.current || editingBudgetRef.current || pending || !canControlDetail(detailForControl)) return false
      setBudgetDraft(confirmedBudget(detailForControl))
      setBudgetError(null)
      changeBudgetEditor(true)
      return true
    }
    if (args.action === 'cancel-budget') {
      if (args.revision !== budgetEditorRevisionRef.current || !editingBudgetRef.current || pending) return false
      setBudgetDraft(confirmedBudget(detailForControl))
      setBudgetError(null)
      changeBudgetEditor(false)
      return true
    }
    if (args.action === 'cancel-concurrency') {
      if (
        args.revision !== concurrencyRevisionRef.current || !capDirtyRef.current || pending ||
        detailForControl.enrollment.kind !== 'objective'
      ) return false
      const cap = latest.concurrency
      changeConcurrencyDraft(cap === null ? '' : String(cap))
      setConcurrencyError(null)
      return true
    }
    return false
  }
  const dispatchControlRef = useRef<(args: FleetControlArgs) => boolean>(() => false)
  dispatchControlRef.current = dispatchControl

  const controlHandler = (args: FleetControlArgs): boolean => dispatchControlRef.current(args)
  useEffect(() => registerFleetControl(context, instance, controlHandler), [context, instance])

  const selectWatcher = (row: FleetRow): void => {
    setFeedback(null)
    context.openView(FLEET_VIEW_ID, { target: row.target })
  }
  const backToFleet = (): void => context.openView(FLEET_VIEW_ID)
  const refreshFleetAction = (): void => { void refreshFleet() }
  const retryDetails = (): void => {
    const current = selectionRef.current
    if (current.target && current.generation) void loadDetail(current.target, current.generation)
  }

  const concurrencyDraftState = selectedTarget === null
    ? 'unavailable'
    : detail?.enrollment.kind === 'objective'
      ? capDirtyRef.current ? 'changed' : 'clean'
      : 'unavailable'
  useEffect(() => {
    report?.({
      view: selection.target ? 'detail' : 'fleet',
      instance,
      generation: selection.generation,
      target: selection.target,
      budgetEditor: selection.target ? editingBudget ? 'open' : 'closed' : 'unavailable',
      budgetEditorRevision: selection.target ? budgetEditorRevision : null,
      concurrencyDraft: concurrencyDraftState,
      concurrencyRevision: selection.target ? concurrencyRevision : null
    })
  }, [report, instance, selection, editingBudget, budgetEditorRevision, concurrencyDraftState, concurrencyRevision])

  useEffect(() => {
    if (!selection.target) return
    const returnOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      context.openView(FLEET_VIEW_ID)
    }
    window.addEventListener('keydown', returnOnEscape)
    return () => window.removeEventListener('keydown', returnOnEscape)
  }, [context, selection.target !== null])
  useEffect(() => {
    if (selection.target) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      context.closeView()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [context, selection.target === null])

  const pendingForCurrent = currentReservationKey !== null && reservedKeys.has(currentReservationKey)
  const fleetErrorMessage = fleetError
    ? snapshot
      ? `Fleet refresh failed; showing the last confirmed snapshot: ${fleetError}`
      : `Could not load the Heimdall fleet: ${fleetError}`
    : null
  const detailErrorMessage = detailError
    ? currentDetail
      ? `Could not refresh watcher details; showing the last confirmed state: ${detailError}`
      : `Could not load watcher details: ${detailError}`
    : null

  return (
    <main className="ui-stack" style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'auto' }} aria-label="Heimdall fleet">
      <ToolPanelFrame
        title="Heimdall fleet"
        actions={
          <div className="ui-cluster">
            {selectedTarget !== null && <Button onClick={backToFleet}>Back to fleet</Button>}
            {selectedTarget === null && <Button disabled={refreshing} onClick={refreshFleetAction}>{refreshing ? 'Refreshing…' : 'Refresh fleet'}</Button>}
          </div>
        }
      >
        <div className="ui-stack" style={{ padding: 'var(--ui-space-8)' }}>
          {snapshot && <div><Badge tone={snapshot.attentionCount > 0 ? 'needs-you' : 'neutral'}><span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{snapshot.activeCount} active · {snapshot.attentionCount} need attention</span></Badge></div>}
          {fleetErrorMessage && <InlineError message={fleetErrorMessage} action={{ label: 'Retry', onAction: refreshFleetAction }} />}
          {!snapshot && !fleetError && <NoticeLine>Loading Heimdall fleet…</NoticeLine>}
          {selectedTarget === null && snapshot && (
            <div className="ui-stack">
              <SectionHeader title="Watcher fleet" />
              <FleetTable rows={orderedRows} now={now} selectedId={null} onSelect={selectWatcher} />
              <ActionHistory items={snapshot.actionHistory} />
            </div>
          )}
          {selectedTarget !== null && (
            <div className="ui-stack">
              {detailBusy && !currentDetail && !detailMissing && !detailError && <NoticeLine>Loading watcher details…</NoticeLine>}
              {detailMissing && <EmptyState message="This watcher is no longer available in the fleet." />}
              {detailErrorMessage && <InlineError message={detailErrorMessage} action={{ label: 'Retry details', onAction: retryDetails }} />}
              {currentDetail && renderedOwner && (
                <WatcherDetailPane
                  key={currentDetail.generation}
                  context={context}
                  detail={currentDetail.detail}
                  row={selectedRow}
                  pending={pendingForCurrent}
                  canCommand={canCommand}
                  feedback={feedback && sameOperationOwner(feedback.owner, renderedOwner) ? feedback : null}
                  now={now}
                  owner={renderedOwner}
                  ownerEpoch={currentDetail.ownerEpoch}
                  budgetDraft={budgetDraft}
                  editingBudget={editingBudget}
                  budgetEditorRevision={budgetEditorRevision}
                  budgetError={budgetError}
                  capDraft={capDraft}
                  concurrencyRevision={concurrencyRevision}
                  concurrencyError={concurrencyError}
                  setBudgetDraft={setBudgetDraft}
                  setBudgetError={setBudgetError}
                  setConcurrencyError={setConcurrencyError}
                  changeBudgetEditor={changeBudgetEditor}
                  changeConcurrencyDraft={changeConcurrencyDraft}
                  requestControl={(action, revision, title) => { void requestControl(action, revision, title) }}
                  submitCommand={submitCommand}
                  deleteWatcher={deleteWatcher}
                  ownerIsCurrent={ownerIsCurrent}
                />
              )}
              {snapshot && <ActionHistory items={snapshot.actionHistory} />}
            </div>
          )}
        </div>
      </ToolPanelFrame>
    </main>
  )
}

/** Activates the built-in fleet navigation entry and its full-window operator view. */
export function activate(context: UiPluginContext): void {
  context.provide(UI_CONTROL_COMMAND, (args: unknown) => dispatchFleetControl(context, args))
  context.provide(NAVIGATION_ID, (element: HTMLElement) => {
    const root = createRoot(element)
    root.render(<NavigationEntry context={context} />)
    return () => queueMicrotask(() => root.unmount())
  })
  context.provide(FLEET_VIEW_ID, (element: HTMLElement, props: MountProps) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    const lifetime = new AbortController()
    const updateInputRef: { current(input: unknown): boolean } = { current: () => false }
    root.render(<HeimdallFleet context={context} input={props.input} instance={crypto.randomUUID()} report={props.report} updateInputRef={updateInputRef} signal={lifetime.signal} />)
    const cleanup = (() => {
      lifetime.abort()
      queueMicrotask(() => root.unmount())
    }) as MountCleanup
    cleanup.updateInput = (input) => !lifetime.signal.aborted && updateInputRef.current(input)
    return cleanup
  })
}
