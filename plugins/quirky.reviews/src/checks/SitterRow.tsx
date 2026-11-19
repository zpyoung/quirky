import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import {
  Badge,
  EmptyState,
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
  isRecord,
  registerReviewsUiControl,
  requestReviewsUiControl,
  sameApprovalScope,
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
  ReviewsUiControlRequest,
} from './data'
import { parseRepoIdentity, repoFromReviewUrl } from '../detail/data'

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
type SitterControlAction = { action: string; enabled: boolean }
type SitterControlLease = { target: string; generation: number; changed(): void; dispose(): void }

function controlDeliveryError(reason: 'target-unavailable' | 'disabled' | 'unknown-action'): string {
  if (reason === 'disabled') return 'This PR Sitter action is currently unavailable.'
  if (reason === 'unknown-action') return 'This PR Sitter action is no longer available.'
  return 'This PR Sitter control is no longer available.'
}

function controlValue(request: ReviewsUiControlRequest, allowed: readonly string[]): Record<string, unknown> {
  const value = request.value
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('Invalid PR Sitter control arguments.')
  }
  return value
}

function useSitterUiControl(options: {
  context: UiPluginContext
  surface: string
  slot: string
  target: string
  active: boolean
  identity?: string
  actions(): SitterControlAction[]
  run(request: ReviewsUiControlRequest, isCurrent: () => boolean): unknown | Promise<unknown>
  onError(message: string): void
}) {
  const actionsRef = useRef(options.actions)
  const runRef = useRef(options.run)
  const errorRef = useRef(options.onError)
  useLayoutEffect(() => {
    actionsRef.current = options.actions
    runRef.current = options.run
    errorRef.current = options.onError
  })
  const registrationRef = useRef<SitterControlLease | null>(null)
  const [reported, setReported] = useState<{ target: string; generation: number } | null>(null)
  const actionsKey = JSON.stringify(options.actions())

  useLayoutEffect(() => {
    if (!options.active) {
      registrationRef.current = null
      setReported(null)
      return
    }
    const registration = registerReviewsUiControl(options.context, {
      surface: options.surface,
      slot: options.slot,
      target: options.target,
      actions: () => actionsRef.current(),
      run: (request, isCurrent) => runRef.current(request, isCurrent),
    })
    const lease = {
      target: options.target,
      generation: registration.generation,
      changed: registration.changed,
      dispose: registration.dispose,
    }
    registrationRef.current = lease
    setReported({ target: lease.target, generation: lease.generation })
    return () => {
      registration.dispose()
      if (registrationRef.current === lease) registrationRef.current = null
    }
  }, [options.active, options.context, options.identity, options.slot, options.surface, options.target])

  useEffect(() => {
    const lease = registrationRef.current
    if (options.active && lease?.target === options.target) lease.changed()
  }, [actionsKey, options.active, options.target])

  async function request(
    action: string,
    value?: Record<string, unknown>,
    sessionIsCurrent: () => boolean = () => true,
  ) {
    const lease = registrationRef.current
    if (!options.active || lease === null || lease.target !== options.target) return null
    const controlRequest: ReviewsUiControlRequest = {
      target: lease.target,
      generation: lease.generation,
      action,
      ...(value === undefined ? {} : { value }),
    }
    try {
      const result = await requestReviewsUiControl(options.context, controlRequest)
      if (registrationRef.current === lease && sessionIsCurrent() && !result.delivered) {
        errorRef.current(controlDeliveryError(result.reason))
      }
      return result
    } catch (failure) {
      if (registrationRef.current === lease && sessionIsCurrent()) {
        errorRef.current(messageOf(failure, 'The PR Sitter action could not be delivered.'))
      }
      return null
    }
  }

  return {
    target: options.target,
    generation: options.active && reported?.target === options.target ? reported.generation : undefined,
    request,
  }
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
  const [requestBusyToken, setRequestBusyToken] = useState<number | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const requestBusyRef = useRef<{ token: number; isCurrent(): boolean } | null>(null)
  const requestTokenRef = useRef(0)
  const target = JSON.stringify(['panel:quirky.reviews/checks', 'sitter-safety-strip', null, null, null, null, null])
  const requestBusyCurrent = requestBusyToken !== null && requestBusyRef.current?.isCurrent() === true
  const stopAllEnabled = sitterState.available && sitterState.activeCount > 0 && !busy && !requestBusyCurrent
  const control = useSitterUiControl({
    context,
    surface: 'panel:quirky.reviews/checks',
    slot: 'sitter-safety-strip',
    target,
    active: true,
    actions: () => [{
      action: 'stop-all',
      enabled: sitterState.available && sitterState.activeCount > 0 && !busy &&
        !(requestBusyToken !== null && requestBusyRef.current?.isCurrent() === true),
    }],
    onError: setRequestError,
    run: (request, isCurrent) => {
      if (request.action !== 'stop-all') throw new Error('Unknown PR Sitter safety action.')
      controlValue(request, [])
      const existingBusy = requestBusyRef.current
      if (!isCurrent() || !sitterState.available || sitterState.activeCount <= 0 ||
        busy || (existingBusy !== null && existingBusy.isCurrent())) return

      const token = ++requestTokenRef.current
      requestBusyRef.current = { token, isCurrent }
      setRequestError(null)
      setRequestBusyToken(token)
      void (async () => {
        let nextError: string | null = null
        try {
          try {
            await context.executeCommand('command:quirky.reviews/stop-all-sitters', {})
          } catch (cause) {
            nextError = messageOf(cause, 'PR Sitters could not be stopped.')
          }
          if (isCurrent() && requestBusyRef.current?.token === token) {
            try {
              await onStoppedAll()
            } catch (cause) {
              if (nextError === null) nextError = messageOf(cause, 'PR Sitter status could not be refreshed.')
            }
          }
          if (isCurrent() && requestBusyRef.current?.token === token) setRequestError(nextError)
        } finally {
          if (isCurrent() && requestBusyRef.current?.token === token) {
            requestBusyRef.current = null
            setRequestBusyToken(null)
          }
        }
      })()
    },
  })

  return (
    <section
      className="ui-stack"
      aria-label="PR Sitter safety"
      data-review-control-target={control.target}
      data-review-control-generation={control.generation}
    >
      <SectionHeader title="PR Sitter safety" />
      <div className="ui-cluster">
        <Button
          variant="destructive"
          disabled={!stopAllEnabled}
          onClick={() => { void control.request('stop-all') }}
        >
          Stop all PR Sitters
        </Button>
        <NoticeLine>{STOPPING_HELP}</NoticeLine>
      </div>
      {(error ?? requestError) && <InlineError message={error ?? requestError ?? ''} />}
    </section>
  )
}

type SitterDialogSession = { generation: number; worktree: string | null; identity: string }


export function SitterRow({
  context,
  activeWorktree,
  review,
  lookup,
  sitterState,
  loadingDetail,
  onRefreshSitter,
}: {
  context: UiPluginContext
  activeWorktree: string | null
  review: ReviewData | null
  lookup: JsonRecord | null
  sitterState: ChecksSitterState
  loadingDetail: boolean
  onRefreshSitter(includeDetail: boolean): Promise<void>
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogSessionGeneration, setDialogSessionGeneration] = useState(0)
  const [capabilities, setCapabilities] = useState<SitterCapabilities>(emptyCapabilities)
  const [branchUpdateMode, setBranchUpdateMode] = useState<SitterBranchUpdateMode>('merge-base-update')
  const [mergeMethod, setMergeMethod] = useState<'' | Exclude<SitterMergeMethod, null>>('')
  const [mergeCheckScope, setMergeCheckScope] = useState<SitterMergeCheckScope>('all')
  const [budgetHours, setBudgetHours] = useState('4')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [debugCopied, setDebugCopied] = useState(false)
  const [rowActionToken, setRowActionToken] = useState<number | null>(null)
  const activeWorktreeRef = useRef(activeWorktree)
  activeWorktreeRef.current = activeWorktree
  const dialogIdentityRef = useRef('')
  const currentSitterRef = useRef<ChecksSitterState['sitter']>(null)
  const approvalEscalationsRef = useRef<SitterOpenEscalation[]>([])
  const dialogWorktreeRef = useRef(activeWorktree)
  const dialogOpenRef = useRef(false)
  const dialogGenerationRef = useRef(0)
  const dialogSessionRef = useRef<SitterDialogSession | null>(null)
  const rowActionGenerationRef = useRef(0)
  const rowActionLeaseRef = useRef<{ token: number; isCurrent(): boolean } | null>(null)
  const actionGenerationRef = useRef(0)
  const busyActionGenerationRef = useRef<number | null>(null)
  const busyLeaseRef = useRef<{ session: SitterDialogSession; token: number } | null>(null)
  const debugFeedbackGenerationRef = useRef(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const isCurrentDialogSession = (session: SitterDialogSession | null): session is SitterDialogSession =>
    session !== null &&
    mountedRef.current &&
    dialogOpenRef.current &&
    dialogSessionRef.current === session &&
    session.generation === dialogGenerationRef.current &&
    session.identity === dialogIdentityRef.current &&
    session.worktree === dialogWorktreeRef.current &&
    session.worktree === activeWorktreeRef.current
  const clearDebugFeedback = useCallback(() => {
    debugFeedbackGenerationRef.current += 1
    if (copyTimer.current !== null) {
      clearTimeout(copyTimer.current)
      copyTimer.current = null
    }
    setDebugCopied(false)
  }, [])
  const invalidateDialog = useCallback((publishGeneration = true) => {
    const generation = dialogGenerationRef.current + 1
    dialogGenerationRef.current = generation
    dialogSessionRef.current = null
    dialogOpenRef.current = false
    busyActionGenerationRef.current = null
    busyLeaseRef.current = null
    if (publishGeneration) setDialogSessionGeneration(generation)
  }, [])
  const openDialog = useCallback((worktree: string | null) => {
    const currentSession = dialogSessionRef.current
    if (dialogOpenRef.current && currentSession?.worktree === worktree &&
      currentSession.identity === dialogIdentityRef.current && worktree === activeWorktreeRef.current) {
      void onRefreshSitter(true)
      return
    }
    const generation = dialogGenerationRef.current + 1
    dialogGenerationRef.current = generation
    setDialogSessionGeneration(generation)
    dialogSessionRef.current = { generation, worktree, identity: dialogIdentityRef.current }
    dialogWorktreeRef.current = worktree
    dialogOpenRef.current = true
    busyActionGenerationRef.current = null
    busyLeaseRef.current = null
    setBusyAction(null)
    clearDebugFeedback()
    setActionError(null)
    setDialogOpen(true)
    void onRefreshSitter(true)
  }, [clearDebugFeedback, onRefreshSitter])
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
    openDialog(worktree)
  }, [openDialog])

  const dismissDialog = useCallback(() => {
    invalidateDialog()
    clearDebugFeedback()
    setDialogOpen(false)
    setActionError(null)
    setBusyAction(null)
    void onRefreshSitter(false)
  }, [clearDebugFeedback, invalidateDialog, onRefreshSitter])

  useEffect(() => {
    const unsubscribe = subscribeOpenSitter(openForWorktree)
    if (consumePendingSitterOpen(activeWorktree)) openDialog(activeWorktree)
    return unsubscribe
  }, [activeWorktree, openDialog, openForWorktree])

  useEffect(() => {
    if (!dialogOpenRef.current || dialogWorktreeRef.current === activeWorktree) return
    dismissDialog()
  }, [activeWorktree, dialogOpen, dismissDialog])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invalidateDialog(false)
      debugFeedbackGenerationRef.current += 1
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current)
        copyTimer.current = null
      }
    }
  }, [invalidateDialog])

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
  const repoIdentity = review === null
    ? null
    : parseRepoIdentity(review.prRepo) ?? repoFromReviewUrl(review.url, review.number)
  const repoOrNull = repoIdentity ? `${repoIdentity.host}/${repoIdentity.owner}/${repoIdentity.repo}` : null
  const headRefOidOrNull = typeof review?.headRefOid === 'string' && review.headRefOid.length > 0 ? review.headRefOid : null
  const rowControlTarget = JSON.stringify([
    'panel:quirky.reviews/checks', 'sitter-row', activeWorktree ?? null, repoOrNull,
    review?.number ?? null, headRefOidOrNull, null,
  ])
  const dialogControlTarget = JSON.stringify([
    'panel:quirky.reviews/checks', 'sitter-dialog', activeWorktree ?? null, repoOrNull,
    review?.number ?? null, headRefOidOrNull, 'sitter',
  ])
  const dialogIdentity = JSON.stringify([
    dialogControlTarget,
    currentSitter?.target.watcherId ?? null,
    currentSitter?.enrollment.commandRevision ?? null,
    approvalEscalations.map((escalation) => [
      escalation.escalationId,
      escalation.approvalScope?.actionKind ?? null,
      escalation.approvalScope?.contentIdentity ?? null,
      escalation.approvalScope?.evidenceKey ?? null,
      escalation.approvalScope?.preparedCommitSha ?? '',
    ]),
  ])
  dialogIdentityRef.current = dialogIdentity
  currentSitterRef.current = currentSitter
  approvalEscalationsRef.current = approvalEscalations
  const registrationSessionGeneration = dialogOpenRef.current && dialogSessionRef.current !== null &&
    dialogSessionRef.current.identity !== dialogIdentity
    ? dialogGenerationRef.current + 1
    : dialogSessionGeneration
  const dialogRegistrationIdentity = JSON.stringify([dialogIdentity, registrationSessionGeneration])

  useLayoutEffect(() => {
    const session = dialogSessionRef.current
    if (!dialogOpenRef.current || session === null || session.identity === dialogIdentity) return
    const replacement = {
      generation: dialogGenerationRef.current + 1,
      worktree: session.worktree,
      identity: dialogIdentity,
    }
    dialogGenerationRef.current = replacement.generation
    dialogSessionRef.current = replacement
    setDialogSessionGeneration(replacement.generation)
    busyActionGenerationRef.current = null
    busyLeaseRef.current = null
    setBusyAction(null)
    clearDebugFeedback()
    setActionError(null)
  }, [clearDebugFeedback, dialogIdentity])

  const isCurrentApproval = (capture: {
    watcherId: string
    escalationId: string
    expectedScope: SitterApprovalScope
  }) => currentSitterRef.current?.target.watcherId === capture.watcherId &&
    approvalEscalationsRef.current.some((escalation) =>
      escalation.escalationId === capture.escalationId &&
      escalation.approvalScope !== undefined &&
      sameApprovalScope(escalation.approvalScope, capture.expectedScope))

  const runAction = async (
    key: string,
    command: string,
    args: JsonRecord,
    session: SitterDialogSession,
    isCurrent: () => boolean,
    refresh = true,
    approval?: { watcherId: string; escalationId: string; expectedScope: SitterApprovalScope },
  ) => {
    const current = () => isCurrent() && isCurrentDialogSession(session)
    if (!current() || busyLeaseRef.current !== null) return false
    const token = ++actionGenerationRef.current
    busyActionGenerationRef.current = token
    busyLeaseRef.current = { session, token }
    setActionError(null)
    setBusyAction(key)
    try {
      await context.executeCommand(command, args)
      if (!current() || (approval !== undefined && !isCurrentApproval(approval))) return false
      if (refresh) {
        await onRefreshSitter(true)
        if (!current()) return false
      }
      return true
    } catch (cause) {
      if (current()) setActionError(messageOf(cause, 'The PR Sitter action failed.'))
      return false
    } finally {
      if (current() && busyLeaseRef.current?.token === token && busyActionGenerationRef.current === token) {
        busyActionGenerationRef.current = null
        busyLeaseRef.current = null
        setBusyAction(null)
      }
    }
  }

  const dialogControl = useSitterUiControl({
    context,
    surface: 'panel:quirky.reviews/checks',
    slot: 'sitter-dialog',
    target: dialogControlTarget,
    active: dialogOpen,
    identity: dialogRegistrationIdentity,
    actions: () => [
      { action: 'close-dialog', enabled: true },
      { action: 'arm', enabled: (!row || showRearm) && canSubmit },
      { action: 'approve', enabled: !unavailableOwner && busyAction === null && approvalEscalations.length > 0 },
      { action: 'stop', enabled: showStop && !unavailableOwner && busyAction === null },
      { action: 'copy-debug', enabled: row !== null && busyAction === null },
    ],
    onError: setActionError,
    run: (request, isCurrent) => {
      const session = dialogSessionRef.current
      const current = () => isCurrent() && isCurrentDialogSession(session)
      if (request.action === 'close-dialog') {
        controlValue(request, [])
        if (current()) dismissDialog()
        return
      }
      if (request.action === 'arm') {
        const value = controlValue(request, ['capabilities', 'branchUpdateMode', 'mergeMethod', 'mergeCheckScope', 'budgetHours'])
        if (!current() || (row !== null && !showRearm) || !canSubmit || busyLeaseRef.current !== null) return
        if (!activeWorktree || !review) return
        let nextCapabilities = capabilities
        if (Object.hasOwn(value, 'capabilities')) {
          const candidate = value.capabilities
          if (!isRecord(candidate) || Object.keys(candidate).length !== CAPABILITY_KEYS.length ||
            CAPABILITY_KEYS.some((capability) => !Object.hasOwn(candidate, capability) ||
              (candidate[capability] !== 'off' && candidate[capability] !== 'gated' && candidate[capability] !== 'on'))) {
            throw new Error('Invalid PR Sitter capabilities.')
          }
          nextCapabilities = {
            updateBranch: candidate.updateBranch as SitterCapabilityMode,
            resolveConflicts: candidate.resolveConflicts as SitterCapabilityMode,
            fixChecks: candidate.fixChecks as SitterCapabilityMode,
            merge: candidate.merge as SitterCapabilityMode,
          }
        }
        const branchValue = Object.hasOwn(value, 'branchUpdateMode') ? value.branchUpdateMode : branchUpdateMode
        if (branchValue !== 'merge-base-update' && branchValue !== 'rebase') throw new Error('Invalid PR Sitter branch update mode.')
        const mergeValue = Object.hasOwn(value, 'mergeMethod') ? value.mergeMethod : mergeMethod === '' ? null : mergeMethod
        if (mergeValue !== null && mergeValue !== 'merge' && mergeValue !== 'squash' && mergeValue !== 'rebase') {
          throw new Error('Invalid PR Sitter merge method.')
        }
        const scopeValue = Object.hasOwn(value, 'mergeCheckScope') ? value.mergeCheckScope : mergeCheckScope
        if (scopeValue !== 'all' && scopeValue !== 'required') throw new Error('Invalid PR Sitter merge check scope.')
        const budgetValue = Object.hasOwn(value, 'budgetHours') ? value.budgetHours : Number(budgetHours)
        if (typeof budgetValue !== 'number' || !Number.isFinite(budgetValue) || budgetValue <= 0) {
          throw new Error('Enter a positive, finite active-time budget.')
        }
        void runAction('arm', 'command:quirky.reviews/arm-sitter', {
          worktree: activeWorktree,
          capabilities: nextCapabilities,
          branchUpdateMode: branchValue,
          mergeMethod: mergeValue,
          mergeCheckScope: scopeValue,
          budgetHours: budgetValue,
        }, session!, isCurrent)
        return
      }
      if (request.action === 'approve') {
        const value = controlValue(request, ['escalationId'])
        if (!current() || unavailableOwner || busyAction !== null ||
          approvalEscalations.length === 0 || busyLeaseRef.current !== null) return
        let escalation: SitterOpenEscalation | undefined
        if (Object.hasOwn(value, 'escalationId')) {
          if (typeof value.escalationId !== 'string' || value.escalationId.length === 0) {
            throw new Error('Select a current PR Sitter escalation.')
          }
          escalation = approvalEscalations.find((candidate) => candidate.escalationId === value.escalationId)
        } else if (approvalEscalations.length === 1) {
          escalation = approvalEscalations[0]
        } else {
          throw new Error('Select the escalation to approve.')
        }
        if (!activeWorktree || !currentSitter || !escalation?.approvalScope) {
          throw new Error('The selected PR Sitter escalation is no longer available.')
        }
        const expectedScope = { ...escalation.approvalScope }
        const capture = { watcherId: currentSitter.target.watcherId, escalationId: escalation.escalationId, expectedScope }
        void runAction(`approve:${escalation.escalationId}`, 'command:quirky.reviews/approve-sitter', {
          worktree: activeWorktree,
          watcherId: capture.watcherId,
          escalationId: capture.escalationId,
          expectedScope: capture.expectedScope,
        }, session!, isCurrent, true, capture)
        return
      }
      if (request.action === 'stop') {
        controlValue(request, [])
        if (!current() || !showStop || unavailableOwner || busyAction !== null ||
          busyLeaseRef.current !== null || !activeWorktree || !currentSitter) return
        void runAction('stop', 'command:quirky.reviews/stop-sitter', {
          worktree: activeWorktree,
          watcherId: currentSitter.target.watcherId,
        }, session!, isCurrent)
        return
      }
      if (request.action === 'copy-debug') {
        controlValue(request, [])
        if (!current() || row === null || busyAction !== null || busyLeaseRef.current !== null || !activeWorktree) return
        clearDebugFeedback()
        void runAction('debug', 'command:quirky.reviews/copy-sitter-debug', {
          worktree: activeWorktree,
          watcherId: row.target.watcherId,
        }, session!, isCurrent, false).then((copied) => {
          if (!copied || !current()) return
          const generation = ++debugFeedbackGenerationRef.current
          setDebugCopied(true)
          copyTimer.current = setTimeout(() => {
            if (debugFeedbackGenerationRef.current !== generation || !isCurrentDialogSession(session)) return
            copyTimer.current = null
            setDebugCopied(false)
          }, 2_000)
        })
        return
      }
      throw new Error('Unknown PR Sitter dialog action.')
    },
  })

  const rowControl = useSitterUiControl({
    context,
    surface: 'panel:quirky.reviews/checks',
    slot: 'sitter-row',
    target: rowControlTarget,
    active: supportedReview,
    actions: () => [{ action: 'open-dialog', enabled: supportedReview }],
    onError: setActionError,
    run: (request, isCurrent) => {
      if (request.action !== 'open-dialog') throw new Error('Unknown PR Sitter row action.')
      controlValue(request, [])
      const previous = rowActionLeaseRef.current
      if (!isCurrent() || !supportedReview || (previous !== null && previous.isCurrent())) return
      const worktree = activeWorktree
      const generation = dialogGenerationRef.current
      const token = ++rowActionGenerationRef.current
      rowActionLeaseRef.current = { token, isCurrent }
      setRowActionToken(token)
      void (async () => {
        try {
          await context.executeCommand('command:quirky.reviews/open-sitter', worktree ? { worktree } : {})
        } catch (cause) {
          if (!isCurrent() || !mountedRef.current || activeWorktreeRef.current !== worktree ||
            dialogGenerationRef.current !== generation || rowActionLeaseRef.current?.token !== token) return
          setActionError(messageOf(cause, 'The PR Sitter dialog could not be opened.'))
        } finally {
          if (isCurrent() && rowActionLeaseRef.current?.token === token) {
            rowActionLeaseRef.current = null
            setRowActionToken(null)
          }
        }
      })()
    },
  })

  const armSitter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeWorktree || !review || !canSubmit || busyLeaseRef.current !== null) return
    const session = dialogSessionRef.current
    void dialogControl.request('arm', {
      capabilities,
      branchUpdateMode,
      mergeMethod: mergeMethod === '' ? null : mergeMethod,
      mergeCheckScope,
      budgetHours: Number(budgetHours),
    }, () => isCurrentDialogSession(session))
  }

  const requestDialogAction = (action: string, value?: Record<string, unknown>) => {
    const session = dialogSessionRef.current
    void dialogControl.request(action, value, () => isCurrentDialogSession(session))
  }

  const requestDialogClose = () => requestDialogAction('close-dialog')

  const requestOpenDialog = () => {
    const generation = dialogGenerationRef.current
    void rowControl.request('open-dialog', undefined, () => dialogGenerationRef.current === generation)
  }

  return (
    <>
      {supportedReview && <div
        data-review-control-target={rowControl.target}
        aria-busy={rowActionToken !== null && rowActionLeaseRef.current?.isCurrent() === true}
        data-review-control-generation={rowControl.generation}
      >
        <ListRow
          title={<span className="ui-cluster"><ToolIcon name="robot" hue="blue" /> PR Sitter</span>}
          mainLabel="PR Sitter"
          status={row && statusPresentation ? statusPresentation.dot : undefined}
          statusLabel={row && statusPresentation ? statusPresentation.label : undefined}
          trailing={<span className="ui-cluster">
            {row && statusPresentation && <Badge tone={statusPresentation.tone}>{statusPresentation.label}</Badge>}
            <ControlIcon name="caret-right" />
          </span>}
          onClick={requestOpenDialog}
        />
      </div>}
      {!dialogOpen && actionError && <InlineError message={actionError} />}

      <Dialog open={dialogOpen} title="PR Sitter" size="wide" scrollBody onClose={requestDialogClose} actions={<Button onClick={requestDialogClose}>Close</Button>}>
        <section
          className="ui-stack"
          data-review-control-target={dialogControl.target}
          data-review-control-generation={dialogControl.generation}
        >
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
              {loadingDetail && !detail && <div role="status"><NoticeLine>Loading sitter details…</NoticeLine></div>}
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
                    onClick={() => requestDialogAction('approve', { escalationId: escalation.escalationId })}
                  >
                    {busyAction === `approve:${escalation.escalationId}` ? 'Approving…' : 'Approve this action'}
                  </Button>
                </section>
              })}
              <details className="ui-stack">
                <summary>Activity ledger</summary>
                {detail !== null
                  ? activity.length > 0
                    ? <ol className="ui-stack">{activity.map((entry) => {
                      const formatted = formatLedgerEntry(entry)
                      return <li key={entry.eventId}><span>{formatted.title}</span> · <time>{formatted.timestamp}</time></li>
                    })}</ol>
                    : <EmptyState message="No activity has been recorded." />
                  : loadingDetail
                    ? <div role="status"><NoticeLine>Loading activity ledger…</NoticeLine></div>
                    : <EmptyState message="Open sitter details to load the activity ledger." />}
              </details>
              {showStop && <div className="ui-stack">
                <div className="ui-cluster">
                  <Button
                    variant="destructive"
                    disabled={unavailableOwner || busyAction !== null}
                    onClick={() => requestDialogAction('stop')}
                  >
                    {busyAction === 'stop' ? 'Stopping…' : 'Stop this sitter'}
                  </Button>
                  <NoticeLine>{STOPPING_HELP}</NoticeLine>
                </div>
                {unavailableOwner && <NoticeLine>Stopping is disabled while the owner cannot be reached.</NoticeLine>}
              </div>}
              <Button
                disabled={busyAction !== null}
                onClick={() => requestDialogAction('copy-debug')}
              >
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
