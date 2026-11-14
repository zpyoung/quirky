import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import {
  Badge,
  Button,
  ControlIcon,
  Dialog,
  InlineError,
  ListRow,
  NoticeLine,
  SectionHeader,
  SelectField,
  StatusDot,
  TextField,
  ToolIcon,
} from '@quirky/ui'
import type { JsonRecord, ReviewData } from '../contracts'
import {
  consumePendingSitterOpen,
  formatLedgerEntry,
  formatRemainingBudget,
  isDisarmableSitter,
  sitterActionLabel,
  sitterReasonText,
  sitterStatusPresentation,
  subscribeOpenSitter,
} from './data'
import type {
  ChecksSitterState,
  SitterApprovalScope,
  SitterBranchUpdateMode,
  SitterCapabilities,
  SitterCapabilityKey,
  SitterCapabilityMode,
  SitterMergeCheckScope,
  SitterMergeMethod,
  SitterOpenEscalation,
} from './data'

const STOPPING_HELP = 'Stopping prevents new actions; an in-flight provider operation may finish.'
const CAPABILITY_KEYS: readonly SitterCapabilityKey[] = ['updateBranch', 'resolveConflicts', 'fixChecks', 'merge']

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}

function mode(value: unknown): SitterCapabilityMode {
  return value === 'on' || value === 'gated' ? value : 'off'
}

function fieldMode(value: unknown): SitterBranchUpdateMode {
  return value === 'rebase' ? 'rebase' : 'merge-base-update'
}

function fieldMergeMethod(value: unknown): '' | Exclude<SitterMergeMethod, null> {
  return value === 'merge' || value === 'squash' || value === 'rebase' ? value : ''
}

function fieldMergeScope(value: unknown): SitterMergeCheckScope {
  return value === 'required' ? 'required' : 'all'
}

function emptyCapabilities(): SitterCapabilities {
  return { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'off' }
}


function SitterCapabilityField({
  label,
  value,
  onChange,
}: {
  label: string
  value: SitterCapabilityMode
  onChange(value: SitterCapabilityMode): void
}) {
  return (
    <SelectField label={label} value={value} onChange={(event) => onChange(mode(event.target.value))}>
      <option value="off">Off</option>
      <option value="gated">Ask</option>
      <option value="on">On</option>
    </SelectField>
  )
}

export function SitterSafetyStrip({
  context,
  sitterState,
  busy = false,
  error = null,
  onStoppedAll,
}: {
  context: UiPluginContext
  sitterState: ChecksSitterState
  busy?: boolean
  error?: string | null
  onStoppedAll(): void | Promise<void>
}) {
  const [requestBusy, setRequestBusy] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const stopAll = async () => {
    setRequestError(null)
    setRequestBusy(true)
    let nextError: string | null = null
    try {
      await context.executeCommand('command:quirky.reviews/stop-all-sitters', {})
    } catch (cause) {
      nextError = messageOf(cause, 'PR Sitters could not be stopped.')
    }
    try {
      await onStoppedAll()
    } catch (cause) {
      if (nextError === null) nextError = messageOf(cause, 'PR Sitter status could not be refreshed.')
    }
    setRequestError(nextError)
    setRequestBusy(false)
  }

  return (
    <section className="ui-stack" aria-label="PR Sitter safety">
      <SectionHeader title="PR Sitter safety" />
      <div className="ui-cluster">
        <Button
          variant="destructive"
          disabled={sitterState.activeCount === 0 || busy || requestBusy}
          onClick={() => { void stopAll() }}
        >
          Stop all PR Sitters
        </Button>
        <NoticeLine>{STOPPING_HELP}</NoticeLine>
      </div>
      {(error ?? requestError) && <InlineError message={error ?? requestError ?? ''} />}
    </section>
  )
}

export function SitterRow({
  context,
  activeWorktree,
  review,
  lookup,
  sitterState,
  loadingDetail,
  onRefreshSitter,
  onAfterAction,
}: {
  context: UiPluginContext
  activeWorktree: string | null
  review: ReviewData | null
  lookup: JsonRecord | null
  sitterState: ChecksSitterState
  loadingDetail: boolean
  onRefreshSitter(includeDetail: boolean): Promise<void>
  onAfterAction(): void | Promise<void>
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<SitterCapabilities>(emptyCapabilities)
  const [branchUpdateMode, setBranchUpdateMode] = useState<SitterBranchUpdateMode>('merge-base-update')
  const [mergeMethod, setMergeMethod] = useState<'' | Exclude<SitterMergeMethod, null>>('')
  const [mergeCheckScope, setMergeCheckScope] = useState<SitterMergeCheckScope>('all')
  const [budgetHours, setBudgetHours] = useState('4')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [debugCopied, setDebugCopied] = useState(false)
  const activeWorktreeRef = useRef(activeWorktree)
  activeWorktreeRef.current = activeWorktree
  const dialogWorktreeRef = useRef(activeWorktree)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sitterCandidate = sitterState.sitter
  const currentSitter = activeWorktree !== null && sitterCandidate !== null && sitterCandidate.enrollment.worktreeId === activeWorktree
    ? sitterCandidate
    : null
  const detail = currentSitter ? sitterState.detail : null
  const ownerContact = detail?.ownerContact ?? currentSitter?.ownerContact
  const effectiveStatus = detail?.status ?? currentSitter?.status ?? null
  const statusPresentation = currentSitter
    ? sitterStatusPresentation({
      status: effectiveStatus ?? currentSitter.status,
      ownerContact: ownerContact ?? currentSitter.ownerContact,
      observedAtMs: detail?.observedAtMs ?? currentSitter.observedAtMs,
    })
    : null
  const unavailableOwner = ownerContact === 'unverifiable'
  const escalations = (detail?.openEscalations ?? currentSitter?.openEscalations ?? [])
    .filter((escalation) => escalation.status === 'open' || escalation.status === 'escalated')
  const approvalEscalations = currentSitter && effectiveStatus?.state === 'held'
    ? escalations.filter((escalation) => escalation.approvalScope !== undefined)
    : []
  const rowPayload = currentSitter?.enrollment.kindPayload
  const formSitterId = currentSitter
    ? `${currentSitter.target.watcherId}:${currentSitter.enrollment.commandRevision}`
    : `${activeWorktree ?? ''}:new`
  const payloadBranchMode = fieldMode(rowPayload?.branchUpdateMode)
  const payloadMergeMethod = fieldMergeMethod(rowPayload?.mergeMethod)
  const payloadMergeScope = fieldMergeScope(rowPayload?.mergeCheckScope)
  const wallClockBudgetMs = currentSitter?.enrollment.budget.wallClockActiveMs
  const payloadBudgetHours = typeof wallClockBudgetMs === 'number' ? String(wallClockBudgetMs / 3_600_000) : '4'
  const storedCapabilities = currentSitter?.enrollment.capabilities
  const updateBranchCapability = mode(storedCapabilities?.updateBranch)
  const resolveConflictsCapability = mode(storedCapabilities?.resolveConflicts)
  const fixChecksCapability = mode(storedCapabilities?.fixChecks)
  const mergeCapability = mode(storedCapabilities?.merge)

  useEffect(() => {
    setCapabilities({
      updateBranch: updateBranchCapability,
      resolveConflicts: resolveConflictsCapability,
      fixChecks: fixChecksCapability,
      merge: mergeCapability,
    })
    setBranchUpdateMode(payloadBranchMode)
    setMergeMethod(payloadMergeMethod)
    setMergeCheckScope(payloadMergeScope)
    setBudgetHours(payloadBudgetHours)
  }, [formSitterId, updateBranchCapability, resolveConflictsCapability, fixChecksCapability, mergeCapability, payloadBranchMode, payloadMergeMethod, payloadMergeScope, payloadBudgetHours])

  const openForWorktree = useCallback((worktree: string | null) => {
    if (worktree !== activeWorktreeRef.current || !consumePendingSitterOpen(worktree)) return
    dialogWorktreeRef.current = worktree
    setActionError(null)
    setDialogOpen(true)
    void onRefreshSitter(true)
  }, [onRefreshSitter])

  useEffect(() => {
    const unsubscribe = subscribeOpenSitter(openForWorktree)
    if (consumePendingSitterOpen(activeWorktree)) {
      dialogWorktreeRef.current = activeWorktree
      setActionError(null)
      setDialogOpen(true)
      void onRefreshSitter(true)
    }
    return unsubscribe
  }, [activeWorktree, onRefreshSitter, openForWorktree])

  useEffect(() => {
    if (!dialogOpen || dialogWorktreeRef.current === activeWorktree) return
    setDialogOpen(false)
    setActionError(null)
    void onRefreshSitter(false)
  }, [activeWorktree, dialogOpen, onRefreshSitter])

  useEffect(() => () => {
    if (copyTimer.current !== null) {
      clearTimeout(copyTimer.current)
      copyTimer.current = null
    }
  }, [])

  const dismissDialog = () => {
    setDialogOpen(false)
    setActionError(null)
    void onRefreshSitter(false)
  }

  const runAction = async (key: string, command: string, args: JsonRecord, refresh = true) => {
    setActionError(null)
    setBusyAction(key)
    try {
      await context.executeCommand(command, args)
      if (refresh) await onAfterAction()
      return true
    } catch (cause) {
      setActionError(messageOf(cause, 'The PR Sitter action failed.'))
      return false
    } finally {
      setBusyAction(null)
    }
  }

  const setCapability = (key: SitterCapabilityKey, value: SitterCapabilityMode) => {
    setCapabilities((previous) => {
      switch (key) {
        case 'updateBranch': return { ...previous, updateBranch: value }
        case 'resolveConflicts': return { ...previous, resolveConflicts: value }
        case 'fixChecks': return { ...previous, fixChecks: value }
        case 'merge': return { ...previous, merge: value }
      }
    })
  }

  const gitStatus = lookup && typeof lookup.gitStatus === 'object' && lookup.gitStatus !== null && !Array.isArray(lookup.gitStatus)
    ? lookup.gitStatus as JsonRecord
    : null
  const branchMissing = gitStatus?.branch === null
  const invalidBudget = budgetHours.trim() === '' || !Number.isFinite(Number(budgetHours)) || Number(budgetHours) <= 0
  const reviewGuard = review === null || review.state !== 'open'
  const submitWarning = !activeWorktree
    ? 'The worktree path is unavailable.'
    : branchMissing
      ? 'A checked-out branch is required to arm PR Sitter.'
      : reviewGuard
        ? review?.state === 'closed' || review?.state === 'merged'
          ? 'Only an open review can be armed.'
          : 'An open review is required to arm PR Sitter.'
        : invalidBudget
          ? 'Enter a positive, finite active-time budget.'
          : null
  const canSubmit = submitWarning === null && !unavailableOwner && busyAction === null

  const armSitter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeWorktree || !review || !canSubmit) return
    const parsedBudget = Number(budgetHours)
    if (!Number.isFinite(parsedBudget) || parsedBudget <= 0) return
    await runAction('arm', 'command:quirky.reviews/arm-sitter', {
      worktree: activeWorktree,
      capabilities,
      branchUpdateMode,
      mergeMethod: mergeMethod === '' ? null : mergeMethod,
      mergeCheckScope,
      budgetHours: parsedBudget,
    })
  }

  const approve = async (escalation: SitterOpenEscalation) => {
    if (!activeWorktree || !currentSitter || !escalation.approvalScope) return
    await runAction(`approve:${escalation.escalationId}`, 'command:quirky.reviews/approve-sitter', {
      worktree: activeWorktree,
      watcherId: currentSitter.target.watcherId,
      escalationId: escalation.escalationId,
      expectedScope: escalation.approvalScope,
    })
  }

  const stopSitter = async () => {
    if (!activeWorktree || !currentSitter) return
    await runAction('stop', 'command:quirky.reviews/stop-sitter', {
      worktree: activeWorktree,
      watcherId: currentSitter.target.watcherId,
    })
  }

  const copyDebugReport = async () => {
    if (!activeWorktree || !currentSitter) return
    setDebugCopied(false)
    if (copyTimer.current !== null) {
      clearTimeout(copyTimer.current)
      copyTimer.current = null
    }
    const copied = await runAction('debug', 'command:quirky.reviews/copy-sitter-debug', {
      worktree: activeWorktree,
      watcherId: currentSitter.target.watcherId,
    }, false)
    if (!copied) return
    setDebugCopied(true)
    copyTimer.current = setTimeout(() => {
      setDebugCopied(false)
      copyTimer.current = null
    }, 2_000)
  }

  const supportedReview = review !== null && (review.provider === 'github' || review.provider === 'gitlab')
  const row = currentSitter
  const showRearm = row !== null && (effectiveStatus?.state === 'disabled' || effectiveStatus?.state === 'parked')
  const showStop = row !== null && isDisarmableSitter(row)
  const journal = detail?.journal ?? []
  const activity = journal.slice().sort((left, right) => right.seq - left.seq).slice(0, 20)
  const statusForDialog = effectiveStatus ?? row?.status ?? null
  const currentPhase = row ? row.phase ?? statusForDialog?.state ?? 'unknown' : null
  const reason = row ? sitterReasonText({ status: statusForDialog ?? row.status, enrollment: row.enrollment }) : null
  const lastConfirmed = statusPresentation?.label.startsWith('Host unreachable · last confirmed ')
    ? statusPresentation.label.slice('Host unreachable · last confirmed '.length)
    : 'an unknown time ago'

  return (
    <>
      {supportedReview && <ListRow
        title={<span className="ui-cluster"><ToolIcon name="robot" hue="blue" /> PR Sitter</span>}
        mainLabel="PR Sitter"
        status={row && statusPresentation ? statusPresentation.dot : undefined}
        statusLabel={row && statusPresentation ? statusPresentation.label : undefined}
        trailing={<span className="ui-cluster">
          {row && statusPresentation && <Badge tone={statusPresentation.tone}>{statusPresentation.label}</Badge>}
          <ControlIcon name="caret-right" />
        </span>}
        onClick={() => {
          void context.executeCommand('command:quirky.reviews/open-sitter', activeWorktree ? { worktree: activeWorktree } : {})
            .catch((cause: unknown) => setActionError(messageOf(cause, 'The PR Sitter dialog could not be opened.')))
        }}
      />}

      <Dialog open={dialogOpen} title="PR Sitter" size="wide" scrollBody onClose={dismissDialog} actions={<Button onClick={dismissDialog}>Close</Button>}>
        <section className="ui-stack">
          <p>{review?.provider === 'gitlab'
            ? 'Watch this merge request and choose which actions Quirky may take.'
            : 'Watch this pull request and choose which actions Quirky may take.'}</p>
          {sitterState.otherActiveCount > 0 && <section className="ui-stack">
            <p>{sitterState.otherActiveCount === 1
              ? '1 sitter is active on another review.'
              : `${sitterState.otherActiveCount} sitters are active on other reviews.`}</p>
            <NoticeLine>{STOPPING_HELP}</NoticeLine>
          </section>}
          {actionError && <InlineError message={actionError} />}
          {!row ? (
            <form className="ui-stack" onSubmit={(event) => { void armSitter(event) }}>
              <SectionHeader title="Choose capabilities" />
              {CAPABILITY_KEYS.map((key) => {
                const labels: Record<SitterCapabilityKey, string> = {
                  updateBranch: 'Update branch',
                  resolveConflicts: 'Resolve conflicts',
                  fixChecks: 'Fix checks',
                  merge: 'Merge',
                }
                return <SitterCapabilityField key={key} label={labels[key]} value={capabilities[key]} onChange={(value) => setCapability(key, value)} />
              })}
              <NoticeLine>Actions set to Ask hold for your approval before running.</NoticeLine>
              <SelectField label="Branch update" value={branchUpdateMode} onChange={(event) => setBranchUpdateMode(fieldMode(event.target.value))}>
                <option value="merge-base-update">Merge base into branch (recommended)</option>
                <option value="rebase">Rebase onto base</option>
              </SelectField>
              {branchUpdateMode === 'rebase' && <NoticeLine>Rebasing rewrites commit SHAs, may dismiss approvals, and force-pushes the rewritten branch.</NoticeLine>}
              <SelectField label="Merge method" value={mergeMethod} onChange={(event) => setMergeMethod(fieldMergeMethod(event.target.value))}>
                <option value="">Repository default</option>
                <option value="merge">Merge commit</option>
                <option value="squash">Squash and merge</option>
                <option value="rebase">Rebase and merge</option>
              </SelectField>
              <SelectField label="Merge check scope" value={mergeCheckScope} onChange={(event) => setMergeCheckScope(fieldMergeScope(event.target.value))}>
                <option value="all">All checks</option>
                <option value="required">Required checks only</option>
              </SelectField>
              <TextField
                label="Active-time budget (hours)"
                type="number"
                step="0.25"
                value={budgetHours}
                help="Counts only while a worker or action is active. Default: 4 hours."
                onChange={(event) => setBudgetHours(event.target.value)}
              />
              {submitWarning && <NoticeLine>{submitWarning}</NoticeLine>}
              {unavailableOwner && <NoticeLine>The owner cannot currently be reached. Re-arming is unavailable.</NoticeLine>}
              <Button variant="primary" type="submit" disabled={!canSubmit}>
                {busyAction === 'arm' ? 'Arming…' : 'Arm PR Sitter'}
              </Button>
            </form>
          ) : (
            <section className="ui-stack">
              <SectionHeader title="Status" />
              {statusPresentation && <div className="ui-cluster">
                <StatusDot status={statusPresentation.dot} label={statusPresentation.label} />
                <Badge tone={statusPresentation.tone}>{statusPresentation.label}</Badge>
              </div>}
              {loadingDetail && !detail && <p role="status" className="ui-text-muted">Loading sitter details…</p>}
              <dl className="ui-stack">
                <div><dt>Active budget remaining</dt><dd>{formatRemainingBudget(row.budget, row.enrollment.budget)}</dd></div>
                {row.enrollment.budget.turns !== null && <div><dt>Worker turns</dt><dd>{row.budget.turns} / {row.enrollment.budget.turns}</dd></div>}
                <div><dt>Current phase</dt><dd>{currentPhase}</dd></div>
              </dl>
              {reason && <p>{reason}</p>}
              {unavailableOwner && <NoticeLine>Last confirmed {lastConfirmed}; the owner cannot currently be reached. The watcher may still be running.</NoticeLine>}
              {escalations.length > 0 && <section className="ui-stack" aria-label="Open escalations">
                <SectionHeader title="Open escalations" />
                <ul className="ui-stack">{escalations.map((escalation) => <li key={escalation.escalationId}>
                  {escalation.escalationKind} · {escalation.status}: {escalation.reason ?? escalation.detail ?? 'No additional detail.'}
                </li>)}</ul>
              </section>}
              {approvalEscalations.map((escalation) => {
                const scope = escalation.approvalScope as SitterApprovalScope
                return <section className="ui-stack" aria-label="Held approval" key={`approval:${escalation.escalationId}`}>
                  <SectionHeader title={sitterActionLabel(scope.actionKind)} />
                  <dl className="ui-stack">
                    <div><dt>Review state</dt><dd>{scope.contentIdentity}</dd></div>
                    {scope.preparedCommitSha && <div><dt>Commit</dt><dd><code>{scope.preparedCommitSha}</code></dd></div>}
                  </dl>
                  <Button
                    variant="primary"
                    disabled={unavailableOwner || busyAction !== null}
                    onClick={() => { void approve(escalation) }}
                  >
                    {busyAction === `approve:${escalation.escalationId}` ? 'Approving…' : 'Approve this action'}
                  </Button>
                </section>
              })}
              <details className="ui-stack">
                <summary>Activity ledger</summary>
                {detail ? activity.length > 0
                  ? <ol className="ui-stack">{activity.map((entry) => {
                    const formatted = formatLedgerEntry(entry)
                    return <li key={entry.eventId}><span>{formatted.title}</span> · <time>{formatted.timestamp}</time></li>
                  })}</ol>
                  : <p className="ui-text-muted">No activity has been recorded.</p>
                  : <p className="ui-text-muted">Open sitter details to load the activity ledger.</p>}
              </details>
              {showStop && <div className="ui-stack">
                <div className="ui-cluster">
                  <Button variant="destructive" disabled={unavailableOwner || busyAction !== null} onClick={() => { void stopSitter() }}>
                    {busyAction === 'stop' ? 'Stopping…' : 'Stop this sitter'}
                  </Button>
                  <NoticeLine>{STOPPING_HELP}</NoticeLine>
                </div>
                {unavailableOwner && <p className="ui-text-muted">Stopping is disabled while the owner cannot be reached.</p>}
              </div>}
              <Button disabled={busyAction !== null} onClick={() => { void copyDebugReport() }}>
                {debugCopied ? 'Debug report copied' : busyAction === 'debug' ? 'Copying debug report…' : 'Copy debug report'}
              </Button>
              {showRearm && <form className="ui-stack" onSubmit={(event) => { void armSitter(event) }}>
                <SectionHeader title="Re-arm PR Sitter" />
                {CAPABILITY_KEYS.map((key) => {
                  const labels: Record<SitterCapabilityKey, string> = {
                    updateBranch: 'Update branch',
                    resolveConflicts: 'Resolve conflicts',
                    fixChecks: 'Fix checks',
                    merge: 'Merge',
                  }
                  return <SitterCapabilityField key={key} label={labels[key]} value={capabilities[key]} onChange={(value) => setCapability(key, value)} />
                })}
                <NoticeLine>Actions set to Ask hold for your approval before running.</NoticeLine>
                <SelectField label="Branch update" value={branchUpdateMode} onChange={(event) => setBranchUpdateMode(fieldMode(event.target.value))}>
                  <option value="merge-base-update">Merge base into branch (recommended)</option>
                  <option value="rebase">Rebase onto base</option>
                </SelectField>
                {branchUpdateMode === 'rebase' && <NoticeLine>Rebasing rewrites commit SHAs, may dismiss approvals, and force-pushes the rewritten branch.</NoticeLine>}
                <SelectField label="Merge method" value={mergeMethod} onChange={(event) => setMergeMethod(fieldMergeMethod(event.target.value))}>
                  <option value="">Repository default</option>
                  <option value="merge">Merge commit</option>
                  <option value="squash">Squash and merge</option>
                  <option value="rebase">Rebase and merge</option>
                </SelectField>
                <SelectField label="Merge check scope" value={mergeCheckScope} onChange={(event) => setMergeCheckScope(fieldMergeScope(event.target.value))}>
                  <option value="all">All checks</option>
                  <option value="required">Required checks only</option>
                </SelectField>
                <TextField
                  label="Active-time budget (hours)"
                  type="number"
                  step="0.25"
                  value={budgetHours}
                  help="Counts only while a worker or action is active. Default: 4 hours."
                  onChange={(event) => setBudgetHours(event.target.value)}
                />
                {submitWarning && <NoticeLine>{submitWarning}</NoticeLine>}
                {unavailableOwner && <NoticeLine>The owner cannot currently be reached. Re-arming is unavailable.</NoticeLine>}
                <Button variant="primary" type="submit" disabled={!canSubmit}>
                  {busyAction === 'arm' ? 'Re-arming…' : 'Re-arm PR Sitter'}
                </Button>
              </form>}
            </section>
          )}
        </section>
      </Dialog>
    </>
  )
}
