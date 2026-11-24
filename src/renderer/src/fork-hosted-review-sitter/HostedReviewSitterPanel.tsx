import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import { HeimdallTonePill } from '@/fork-heimdall/heimdall-tone-pill'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type { EnrollInput } from '../../../shared/fork-heimdall/watcher-types'
import type {
  HostedReviewBranchUpdateMode,
  HostedReviewEnrollmentPayload,
  HostedReviewMergeCheckScope,
  HostedReviewMergeMethod,
  HostedReviewSitterCapabilities
} from '../../../shared/fork-hosted-review-sitter/types'
import { isActiveHostedReviewSitter } from './active-sitter-registry'
import { HostedReviewSitterEnrollmentForm } from './HostedReviewSitterEnrollmentForm'
import { assertClipboardTextWriteWithinLimit } from '../../../shared/clipboard-text'
import { HostedReviewSitterStatusContent } from './HostedReviewSitterStatusContent'
import { hostedReviewSitterStatusLabel } from './hosted-review-sitter-format'
import { formatHeimdallAge } from '@/fork-heimdall/fleet-format'
import { isHeimdallAttentionRow } from '@/fork-heimdall/fleet-selectors'
import {
  awaitingApprovalScope,
  describeError,
  getHeimdallApi,
  hostedReviewPayload,
  isSupportedProvider,
  sameHostedReview
} from './hosted-review-sitter-panel-state'

const DEFAULT_ACTIVE_BUDGET_HOURS = 4
const DEFAULT_CAPABILITIES: HostedReviewSitterCapabilities = {
  updateBranch: 'off',
  resolveConflicts: 'off',
  fixChecks: 'off',
  merge: 'off'
}
const HOSTED_REVIEW_CAPABILITIES = [
  'updateBranch',
  'resolveConflicts',
  'fixChecks',
  'merge'
] as const

export type HostedReviewSitterReviewPanelProps = {
  repoId: string
  worktreeId: string
  repoPath: string
  branch: string
  reviewProvider: string
  reviewNumber: number
  reviewUrl: string
  reviewState: string
}

type HostedReviewSitterPanelContentProps = {
  runtimeEnvironmentId: string | null
} & HostedReviewSitterReviewPanelProps

function HostedReviewSitterPanelContent({
  repoId,
  worktreeId,
  repoPath,
  branch,
  reviewProvider,
  reviewNumber,
  reviewUrl,
  reviewState,
  runtimeEnvironmentId
}: HostedReviewSitterPanelContentProps): React.JSX.Element | null {
  const api = getHeimdallApi()
  const supportedProvider = isSupportedProvider(reviewProvider)
  const fleet = useAppStore((state) => state.heimdallFleet)
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const runtimeEnvironment = useAppStore((state) =>
    runtimeEnvironmentId
      ? (state.runtimeEnvironments.find((environment) => environment.id === runtimeEnvironmentId) ??
        null)
      : null
  )
  const entries = useMemo(() => fleet?.entries.map((row) => row.entry) ?? null, [fleet])
  const currentFleetRow = useMemo(() => {
    if (runtimeEnvironmentId && !runtimeEnvironment) {
      return null
    }
    const owner = runtimeEnvironment
      ? {
          connectionId: runtimeEnvironment.id,
          pairingRevision: runtimeEnvironment.pairingRevision ?? runtimeEnvironment.createdAt
        }
      : { connectionId: null, pairingRevision: null }
    return (
      fleet?.entries.find((row) =>
        sameHostedReview(row, {
          repoId,
          worktreeId,
          reviewProvider,
          reviewNumber,
          owner
        })
      ) ?? null
    )
  }, [
    fleet,
    repoId,
    reviewNumber,
    reviewProvider,
    runtimeEnvironment,
    runtimeEnvironmentId,
    worktreeId
  ])
  const currentEntry = currentFleetRow?.entry ?? null
  const currentPayload = currentEntry ? hostedReviewPayload(currentEntry) : null
  const ownerCapabilities: HostedReviewSitterCapabilities = {
    updateBranch:
      currentEntry?.enrollment.capabilities.updateBranch ?? DEFAULT_CAPABILITIES.updateBranch,
    resolveConflicts:
      currentEntry?.enrollment.capabilities.resolveConflicts ??
      DEFAULT_CAPABILITIES.resolveConflicts,
    fixChecks: currentEntry?.enrollment.capabilities.fixChecks ?? DEFAULT_CAPABILITIES.fixChecks,
    merge: currentEntry?.enrollment.capabilities.merge ?? DEFAULT_CAPABILITIES.merge
  }
  const ownerBranchUpdateMode = currentPayload?.branchUpdateMode ?? 'merge-base-update'
  const ownerMergeMethod: 'default' | HostedReviewMergeMethod =
    currentPayload?.mergeMethod ?? 'default'
  const ownerMergeCheckScope = currentPayload?.mergeCheckScope ?? 'all'
  const ownerActiveBudgetMs = currentEntry?.enrollment.budget.wallClockActiveMs
  const ownerActiveBudgetHours =
    ownerActiveBudgetMs === null
      ? Number.NaN
      : ownerActiveBudgetMs === undefined
        ? DEFAULT_ACTIVE_BUDGET_HOURS
        : ownerActiveBudgetMs / (60 * 60 * 1_000)
  const lostContact =
    currentFleetRow?.contact === 'unverifiable' || currentEntry?.status.state === 'unreachable'
  const commandReadOnlyReason = currentFleetRow?.readOnlyReason ?? null
  const controlsReadOnly = lostContact || commandReadOnlyReason !== null
  const [ledger, setLedger] = useState<WatcherLedger | null>(null)
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [mutationTone, setMutationTone] = useState<'error' | 'refused' | 'indeterminate'>('error')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [debugReportCopied, setDebugReportCopied] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [capabilityOverrides, setCapabilityOverrides] = useState<
    Partial<HostedReviewSitterCapabilities>
  >({})
  const [branchUpdateModeOverride, setBranchUpdateModeOverride] =
    useState<HostedReviewBranchUpdateMode | null>(null)
  const [mergeMethodOverride, setMergeMethodOverride] = useState<
    'default' | HostedReviewMergeMethod | null
  >(null)
  const [mergeCheckScopeOverride, setMergeCheckScopeOverride] =
    useState<HostedReviewMergeCheckScope | null>(null)
  const [activeBudgetHoursOverride, setActiveBudgetHoursOverride] = useState<number | null>(null)
  const capabilities: HostedReviewSitterCapabilities = {
    updateBranch: capabilityOverrides.updateBranch ?? ownerCapabilities.updateBranch,
    resolveConflicts: capabilityOverrides.resolveConflicts ?? ownerCapabilities.resolveConflicts,
    fixChecks: capabilityOverrides.fixChecks ?? ownerCapabilities.fixChecks,
    merge: capabilityOverrides.merge ?? ownerCapabilities.merge
  }
  const branchUpdateMode = branchUpdateModeOverride ?? ownerBranchUpdateMode
  const mergeMethod = mergeMethodOverride ?? ownerMergeMethod
  const activeBudgetHours = activeBudgetHoursOverride ?? ownerActiveBudgetHours
  const mergeCheckScope = mergeCheckScopeOverride ?? ownerMergeCheckScope
  const requestSerialRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!api || !supportedProvider || !currentFleetRow || !configOpen) {
      setLedger(null)
      return
    }
    const requestSerial = ++requestSerialRef.current
    try {
      const detail = await api.detail(currentFleetRow.target)
      if (requestSerial === requestSerialRef.current) {
        setLedger(detail.ledger)
        setServiceError(null)
      }
    } catch (error) {
      if (requestSerial === requestSerialRef.current) {
        setServiceError(
          currentFleetRow.contact === 'unverifiable'
            ? null
            : translate(
                'fork.hostedReviewSitter.error.activityUnavailable',
                'Activity unavailable: {{error}}',
                { error: describeError(error) }
              )
        )
      }
    }
  }, [api, configOpen, currentFleetRow, supportedProvider])

  useEffect(() => {
    if (api && supportedProvider) {
      void hydrateFleet()
    }
  }, [api, hydrateFleet, supportedProvider])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const currentEntryIsActive = currentEntry !== null && isActiveHostedReviewSitter(currentEntry)
  const approvalScope = useMemo(() => awaitingApprovalScope(ledger), [ledger])

  useEffect(() => {
    if (!debugReportCopied) {
      return
    }
    const timer = window.setTimeout(() => setDebugReportCopied(false), 2_000)
    return () => window.clearTimeout(timer)
  }, [debugReportCopied])

  const activeEntries = useMemo(() => entries?.filter(isActiveHostedReviewSitter) ?? [], [entries])

  if (!supportedProvider) {
    return null
  }

  const runMutation = async (
    name: string,
    operation: () => Promise<WatcherCommandResult | void>
  ): Promise<void> => {
    if (!api || busyAction) {
      return
    }
    setBusyAction(name)
    setMutationError(null)
    try {
      const result = await operation()
      if (result && result.status !== 'applied') {
        setMutationTone(result.status)
        setMutationError(
          result.status === 'indeterminate'
            ? translate(
                'fork.heimdall.command.indeterminate',
                'The command may or may not have applied. Re-reading owner state… {{detail}}',
                { detail: result.detail ?? '' }
              )
            : translate(
                'fork.heimdall.command.refused',
                'Owner refused the command ({{reason}}): {{detail}}',
                { reason: result.reason ?? 'unknown', detail: result.detail ?? '' }
              )
        )
      }
    } catch (error) {
      setMutationTone('error')
      setMutationError(describeError(error))
    } finally {
      await Promise.allSettled([hydrateFleet(), refresh()])
      setBusyAction(null)
    }
  }

  const enroll = (): void => {
    if (!api || !isSupportedProvider(reviewProvider)) {
      return
    }
    if (runtimeEnvironmentId && !runtimeEnvironment) {
      setMutationTone('error')
      setMutationError(
        translate(
          'fork.heimdall.error.ownerUnavailable',
          'The owning runtime is unavailable; no enrollment was sent.'
        )
      )
      return
    }
    const input: EnrollInput = {
      kind: 'hosted-review',
      repoId,
      worktreeId,
      capabilities,
      budget: {
        wallClockActiveMs: Math.round(activeBudgetHours * 60 * 60 * 1_000),
        turns: null
      },
      kindPayload: {
        branch,
        provider: reviewProvider,
        reviewNumber,
        reviewUrl,
        branchUpdateMode,
        mergeMethod: mergeMethod === 'default' ? null : mergeMethod,
        mergeCheckScope
      } satisfies HostedReviewEnrollmentPayload
    }
    void runMutation('enroll', async () => {
      const owner = runtimeEnvironment
        ? {
            connectionId: runtimeEnvironment.id,
            pairingRevision: runtimeEnvironment.pairingRevision ?? runtimeEnvironment.createdAt
          }
        : undefined
      await api.enroll(input, owner)
      setCapabilityOverrides({})
      setBranchUpdateModeOverride(null)
      setMergeMethodOverride(null)
      setMergeCheckScopeOverride(null)
      setActiveBudgetHoursOverride(null)
    })
  }

  const copyDebugReport = (): void => {
    if (!api || !currentFleetRow || busyAction) {
      return
    }
    setBusyAction('debugReport')
    setMutationError(null)
    void (async () => {
      try {
        const report = await api.debugReport(currentFleetRow.target)
        const serialized = JSON.stringify(report, null, 2)
        const text = assertClipboardTextWriteWithinLimit(serialized ?? String(report))
        await window.api.ui.writeClipboardText(text)
        setDebugReportCopied(true)
      } catch (error) {
        setMutationTone('error')
        setMutationError(describeError(error))
      } finally {
        setBusyAction(null)
      }
    })()
  }

  const disarmCurrent = (): void => {
    if (!api || !currentFleetRow || !currentEntryIsActive || controlsReadOnly) {
      return
    }
    void runMutation('disarm', () =>
      api.command({
        target: currentFleetRow.target,
        expectedOwner: currentFleetRow.ownerFence,
        command: { kind: 'disarm' }
      })
    )
  }

  const approveCurrentAction = (): void => {
    if (!api || !currentFleetRow || !approvalScope || controlsReadOnly) {
      return
    }
    void runMutation('approve', () =>
      api.command({
        target: currentFleetRow.target,
        expectedOwner: currentFleetRow.ownerFence,
        command: { kind: 'approve', scope: approvalScope }
      })
    )
  }

  const unavailableReason = !api
    ? translate(
        'fork.hostedReviewSitter.unavailable.missingApi',
        'This Quirky host does not provide the PR Sitter service.'
      )
    : entries === null
      ? serviceError
      : null
  const enrollBlockedReason =
    reviewState !== 'open' && reviewState !== 'draft'
      ? translate(
          'fork.hostedReviewSitter.enrollment.reviewNotOpen',
          'Only an open review can be armed.'
        )
      : !branch.trim()
        ? translate(
            'fork.hostedReviewSitter.enrollment.branchRequired',
            'A checked-out branch is required to arm PR Sitter.'
          )
        : !repoPath.trim()
          ? translate(
              'fork.hostedReviewSitter.enrollment.worktreeUnavailable',
              'The worktree path is unavailable.'
            )
          : null
  const statusNeedsAttention = currentFleetRow ? isHeimdallAttentionRow(currentFleetRow) : false

  return (
    <section
      className="border-b border-border bg-muted/10 px-3 py-2"
      aria-label={translate('fork.hostedReviewSitter.title', 'PR Sitter')}
    >
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-xs font-medium text-foreground">
              {translate('fork.hostedReviewSitter.title', 'PR Sitter')}
            </span>
            {currentEntry ? (
              <HeimdallTonePill tone={statusNeedsAttention || lostContact ? 'warning' : 'neutral'}>
                <span className="text-[10px]">
                  {hostedReviewSitterStatusLabel(
                    lostContact ? 'unreachable' : currentEntry.status.state
                  )}
                </span>
              </HeimdallTonePill>
            ) : null}
            {entries === null && !unavailableReason ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : null}
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{translate('fork.hostedReviewSitter.title', 'PR Sitter')}</DialogTitle>
            <DialogDescription>
              {reviewProvider === 'gitlab'
                ? translate(
                    'fork.hostedReviewSitter.enrollment.descriptionGitLab',
                    'Watch this merge request and choose which actions Quirky may take.'
                  )
                : translate(
                    'fork.hostedReviewSitter.enrollment.descriptionGitHub',
                    'Watch this pull request and choose which actions Quirky may take.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <div className="scrollbar-sleek max-h-[60vh] overflow-y-auto">
            {unavailableReason ? (
              <div
                className="mt-2 rounded-md border border-border bg-background/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
                role="status"
              >
                <span className="font-medium text-foreground">
                  {translate('fork.hostedReviewSitter.unavailable.title', 'Unavailable.')}
                </span>{' '}
                {unavailableReason}
              </div>
            ) : entries === null ? (
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {translate('fork.hostedReviewSitter.loading', 'Loading sitter status…')}
              </div>
            ) : (
              <>
                {lostContact && currentFleetRow ? (
                  <p
                    className="mb-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
                    role="status"
                  >
                    {translate(
                      'fork.heimdall.detail.lostContact',
                      'Last confirmed {{age}}; the owner cannot currently be reached. The watcher may still be running.',
                      { age: formatHeimdallAge(currentFleetRow.observedAtMs) }
                    )}
                  </p>
                ) : null}
                {currentEntry ? (
                  <HostedReviewSitterStatusContent
                    entry={currentEntry}
                    ledger={ledger}
                    approvalScope={approvalScope}
                    ledgerOpen={ledgerOpen}
                    readOnly={controlsReadOnly}
                    readOnlyReason={commandReadOnlyReason}
                    busy={busyAction !== null}
                    stopping={busyAction === 'disarm'}
                    approving={busyAction === 'approve'}
                    active={currentEntryIsActive}
                    copyingDebugReport={busyAction === 'debugReport'}
                    debugReportCopied={debugReportCopied}
                    onLedgerOpenChange={setLedgerOpen}
                    onStop={disarmCurrent}
                    onApprove={approveCurrentAction}
                    onCopyDebugReport={copyDebugReport}
                  />
                ) : null}
                {!currentEntryIsActive ? (
                  <HostedReviewSitterEnrollmentForm
                    capabilities={capabilities}
                    branchUpdateMode={branchUpdateMode}
                    mergeMethod={mergeMethod}
                    mergeCheckScope={mergeCheckScope}
                    activeBudgetHours={activeBudgetHours}
                    activeElsewhereCount={activeEntries.length}
                    blockedReason={enrollBlockedReason}
                    busy={busyAction !== null}
                    arming={busyAction === 'enroll'}
                    rearming={currentEntry !== null}
                    onCapabilitiesChange={(nextCapabilities) => {
                      const changedCapability = HOSTED_REVIEW_CAPABILITIES.find(
                        (capability) => nextCapabilities[capability] !== capabilities[capability]
                      )
                      if (changedCapability) {
                        setCapabilityOverrides((current) => ({
                          ...current,
                          [changedCapability]: nextCapabilities[changedCapability]
                        }))
                      }
                    }}
                    onBranchUpdateModeChange={setBranchUpdateModeOverride}
                    onMergeMethodChange={setMergeMethodOverride}
                    onMergeCheckScopeChange={setMergeCheckScopeOverride}
                    onActiveBudgetHoursChange={setActiveBudgetHoursOverride}
                    onArm={enroll}
                  />
                ) : null}
              </>
            )}

            {mutationError ? (
              <div
                className={
                  mutationTone === 'refused'
                    ? 'mt-2 rounded-md border border-status-warning-border bg-status-warning-background px-2.5 py-2 text-[10px] leading-relaxed text-status-warning-foreground'
                    : mutationTone === 'indeterminate'
                      ? 'mt-2 rounded-md border border-border bg-muted px-2.5 py-2 text-[10px] leading-relaxed text-foreground'
                      : 'mt-2 text-[10px] leading-relaxed text-destructive'
                }
                role={mutationTone === 'error' ? 'alert' : 'status'}
              >
                {mutationError}
              </div>
            ) : null}
            {serviceError && entries !== null ? (
              <div className="mt-2 text-[10px] leading-relaxed text-destructive" role="alert">
                {serviceError}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export function HostedReviewSitterReviewPanel(
  props: HostedReviewSitterReviewPanelProps
): React.JSX.Element | null {
  // Why: null is a twin-published workspace and '' is this app, so the selector stays primitive.
  const ownerEnvironmentKey = useAppStore((state) => {
    const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: props.worktreeId })
    return owner.kind === 'resolved' ? (owner.environmentId ?? '') : null
  })
  const runtimeEnvironmentId = ownerEnvironmentKey || null
  const runtimeEnvironmentPairingRevision = useAppStore((state) => {
    if (!runtimeEnvironmentId) {
      return null
    }
    const runtimeEnvironment = state.runtimeEnvironments.find(
      (environment) => environment.id === runtimeEnvironmentId
    )
    return runtimeEnvironment
      ? (runtimeEnvironment.pairingRevision ?? runtimeEnvironment.createdAt)
      : null
  })
  const identityKey = JSON.stringify([
    props.repoId,
    props.worktreeId,
    props.reviewProvider,
    props.reviewNumber,
    runtimeEnvironmentId,
    runtimeEnvironmentPairingRevision
  ])
  // Why: a watcher armed on a guessed host would watch a different machine's checkout.
  if (ownerEnvironmentKey === null) {
    return null
  }
  return (
    <HostedReviewSitterPanelContent
      key={identityKey}
      {...props}
      runtimeEnvironmentId={runtimeEnvironmentId}
    />
  )
}

export type HostedReviewSitterPanelModel = {
  activeReview: HostedReviewInfo | null
  activeWorktree: Worktree | null
  activeWorktreeId: string | null
  detachedHeadDisplay: unknown
  repo: Repo | null
}

export function HostedReviewSitterPanel({
  model
}: {
  model: HostedReviewSitterPanelModel
}): React.JSX.Element | null {
  const { activeReview, activeWorktree, activeWorktreeId, repo } = model
  if (!activeReview || !activeWorktree || !activeWorktreeId || !repo) {
    return null
  }
  return (
    <HostedReviewSitterReviewPanel
      repoId={repo.id}
      worktreeId={activeWorktreeId}
      repoPath={activeWorktree.path}
      branch={model.detachedHeadDisplay ? '' : activeWorktree.branch}
      reviewProvider={activeReview.provider}
      reviewNumber={activeReview.number}
      reviewUrl={activeReview.url}
      reviewState={activeReview.state}
    />
  )
}
