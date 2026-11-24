import React, { useId } from 'react'
import { Bot, Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { CapabilityMode } from '../../../shared/fork-heimdall/watcher-types'
import type {
  HostedReviewBranchUpdateMode,
  HostedReviewMergeCheckScope,
  HostedReviewMergeMethod,
  HostedReviewSitterCapabilities,
  HostedReviewSitterCapability
} from '../../../shared/fork-hosted-review-sitter/types'
import {
  hostedReviewSitterCapabilityLabel,
  hostedReviewSitterCapabilityModeLabel
} from './hosted-review-sitter-format'

const CAPABILITIES: readonly HostedReviewSitterCapability[] = [
  'updateBranch',
  'resolveConflicts',
  'fixChecks',
  'merge'
]
const CAPABILITY_MODES: readonly CapabilityMode[] = ['off', 'gated', 'on']

function isCapabilityMode(value: string): value is CapabilityMode {
  return value === 'off' || value === 'gated' || value === 'on'
}

function isBranchUpdateMode(value: string): value is HostedReviewBranchUpdateMode {
  return value === 'merge-base-update' || value === 'rebase'
}

function isMergeMethodChoice(value: string): value is 'default' | HostedReviewMergeMethod {
  return value === 'default' || value === 'merge' || value === 'squash' || value === 'rebase'
}

function isMergeCheckScope(value: string): value is HostedReviewMergeCheckScope {
  return value === 'required' || value === 'all'
}

function branchUpdateModeLabel(mode: HostedReviewBranchUpdateMode): string {
  switch (mode) {
    case 'merge-base-update':
      return translate(
        'fork.hostedReviewSitter.enrollment.updateMergeBase',
        'Merge base into branch (recommended)'
      )
    case 'rebase':
      return translate('fork.hostedReviewSitter.enrollment.updateRebase', 'Rebase onto base')
  }
}

function mergeMethodChoiceLabel(method: 'default' | HostedReviewMergeMethod): string {
  switch (method) {
    case 'default':
      return translate('fork.hostedReviewSitter.enrollment.mergeDefault', 'Repository default')
    case 'merge':
      return translate('fork.hostedReviewSitter.enrollment.mergeCommit', 'Merge commit')
    case 'squash':
      return translate('fork.hostedReviewSitter.enrollment.mergeSquash', 'Squash and merge')
    case 'rebase':
      return translate('fork.hostedReviewSitter.enrollment.mergeRebase', 'Rebase and merge')
  }
}

function mergeCheckScopeLabel(scope: HostedReviewMergeCheckScope): string {
  switch (scope) {
    case 'all':
      return translate('fork.hostedReviewSitter.enrollment.checkScopeAll', 'All checks')
    case 'required':
      return translate(
        'fork.hostedReviewSitter.enrollment.checkScopeRequired',
        'Required checks only'
      )
  }
}

function CapabilityControl({
  capability,
  value,
  disabled,
  onChange
}: {
  capability: HostedReviewSitterCapability
  value: CapabilityMode
  disabled: boolean
  onChange: (value: CapabilityMode) => void
}): React.JSX.Element {
  const capabilityLabelId = useId()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_104px] items-center gap-2">
      <label id={capabilityLabelId} className="truncate text-[11px] text-foreground">
        {hostedReviewSitterCapabilityLabel(capability)}
      </label>
      <Select
        value={value}
        onValueChange={(nextValue) => {
          if (isCapabilityMode(nextValue)) {
            onChange(nextValue)
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-labelledby={capabilityLabelId} size="sm" className="h-7 w-full">
          <SelectValue>
            <span className="text-[11px]">{hostedReviewSitterCapabilityModeLabel(value)}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CAPABILITY_MODES.map((mode) => (
            <SelectItem key={mode} value={mode}>
              <span className="text-xs">{hostedReviewSitterCapabilityModeLabel(mode)}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export type HostedReviewSitterEnrollmentFormProps = {
  capabilities: HostedReviewSitterCapabilities
  branchUpdateMode: HostedReviewBranchUpdateMode
  mergeMethod: 'default' | HostedReviewMergeMethod
  mergeCheckScope: HostedReviewMergeCheckScope
  activeBudgetHours: number
  activeElsewhereCount: number
  blockedReason: string | null
  busy: boolean
  arming: boolean
  rearming: boolean
  onCapabilitiesChange: (capabilities: HostedReviewSitterCapabilities) => void
  onBranchUpdateModeChange: (mode: HostedReviewBranchUpdateMode) => void
  onMergeMethodChange: (method: 'default' | HostedReviewMergeMethod) => void
  onMergeCheckScopeChange: (scope: HostedReviewMergeCheckScope) => void
  onActiveBudgetHoursChange: (hours: number) => void
  onArm: () => void
}

export function HostedReviewSitterEnrollmentForm({
  capabilities,
  branchUpdateMode,
  mergeMethod,
  mergeCheckScope,
  activeBudgetHours,
  activeElsewhereCount,
  blockedReason,
  busy,
  arming,
  rearming,
  onCapabilitiesChange,
  onBranchUpdateModeChange,
  onMergeMethodChange,
  onMergeCheckScopeChange,
  onActiveBudgetHoursChange,
  onArm
}: HostedReviewSitterEnrollmentFormProps): React.JSX.Element {
  const validBudget = Number.isFinite(activeBudgetHours) && activeBudgetHours > 0
  const branchUpdateLabelId = useId()
  const mergeMethodLabelId = useId()
  const mergeCheckScopeLabelId = useId()
  const budgetInputId = useId()
  const activeElsewhereCopy =
    activeElsewhereCount === 1
      ? translate(
          'fork.hostedReviewSitter.activeElsewhere.one',
          '{{count}} sitter is active on another review.',
          { count: activeElsewhereCount }
        )
      : translate(
          'fork.hostedReviewSitter.activeElsewhere.many',
          '{{count}} sitters are active on other reviews.',
          { count: activeElsewhereCount }
        )
  return (
    <div className="mt-2 space-y-2.5">
      {activeElsewhereCount > 0 ? (
        <div className="space-y-1 text-[10px] leading-relaxed text-muted-foreground">
          <p>{activeElsewhereCopy}</p>
          <p>
            {translate(
              'fork.hostedReviewSitter.stopEffect',
              'Stopping prevents new actions; an in-flight provider operation may finish.'
            )}
          </p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        {CAPABILITIES.map((capability) => (
          <CapabilityControl
            key={capability}
            capability={capability}
            value={capabilities[capability]}
            disabled={busy}
            onChange={(mode) => onCapabilitiesChange({ ...capabilities, [capability]: mode })}
          />
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {translate(
          'fork.hostedReviewSitter.enrollment.askAuthority',
          'Ask may prepare and commit fixes in this worktree; Quirky waits for approval before publishing them. It also waits before triggering CI, updating the branch, or merging.'
        )}
      </p>

      <div className="space-y-1">
        <label id={branchUpdateLabelId} className="text-[10px] font-medium text-muted-foreground">
          {translate('fork.hostedReviewSitter.enrollment.branchUpdate', 'Branch update')}
        </label>
        <Select
          value={branchUpdateMode}
          onValueChange={(value) => {
            if (isBranchUpdateMode(value)) {
              onBranchUpdateModeChange(value)
            }
          }}
          disabled={busy}
        >
          <SelectTrigger aria-labelledby={branchUpdateLabelId} size="sm" className="h-7 w-full">
            <SelectValue>
              <span className="text-[11px]">{branchUpdateModeLabel(branchUpdateMode)}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge-base-update">
              <span className="text-xs">{branchUpdateModeLabel('merge-base-update')}</span>
            </SelectItem>
            <SelectItem value="rebase">
              <span className="text-xs">{branchUpdateModeLabel('rebase')}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        {branchUpdateMode === 'rebase' ? (
          <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              {translate(
                'fork.hostedReviewSitter.enrollment.rebaseWarning',
                'Rebasing rewrites commit SHAs, may dismiss approvals, and force-pushes the rewritten branch.'
              )}
            </span>
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label id={mergeMethodLabelId} className="text-[10px] font-medium text-muted-foreground">
          {translate('fork.hostedReviewSitter.enrollment.mergeMethod', 'Merge method')}
        </label>
        <Select
          value={mergeMethod}
          onValueChange={(value) => {
            if (isMergeMethodChoice(value)) {
              onMergeMethodChange(value)
            }
          }}
          disabled={busy}
        >
          <SelectTrigger aria-labelledby={mergeMethodLabelId} size="sm" className="h-7 w-full">
            <SelectValue>
              <span className="text-[11px]">{mergeMethodChoiceLabel(mergeMethod)}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">
              <span className="text-xs">{mergeMethodChoiceLabel('default')}</span>
            </SelectItem>
            <SelectItem value="merge">
              <span className="text-xs">{mergeMethodChoiceLabel('merge')}</span>
            </SelectItem>
            <SelectItem value="squash">
              <span className="text-xs">{mergeMethodChoiceLabel('squash')}</span>
            </SelectItem>
            <SelectItem value="rebase">
              <span className="text-xs">{mergeMethodChoiceLabel('rebase')}</span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <label
          id={mergeCheckScopeLabelId}
          className="text-[10px] font-medium text-muted-foreground"
        >
          {translate('fork.hostedReviewSitter.enrollment.mergeCheckScope', 'Merge check scope')}
        </label>
        <Select
          value={mergeCheckScope}
          onValueChange={(value) => {
            if (isMergeCheckScope(value)) {
              onMergeCheckScopeChange(value)
            }
          }}
          disabled={busy}
        >
          <SelectTrigger aria-labelledby={mergeCheckScopeLabelId} size="sm" className="h-7 w-full">
            <SelectValue>
              <span className="text-[11px]">{mergeCheckScopeLabel(mergeCheckScope)}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              <span className="text-xs">{mergeCheckScopeLabel('all')}</span>
            </SelectItem>
            <SelectItem value="required">
              <span className="text-xs">{mergeCheckScopeLabel('required')}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {translate(
            'fork.hostedReviewSitter.enrollment.checkScopeHelp',
            'With All checks, every current-head check must pass (or be skipped if optional). Required checks only waits for checks marked required by repository rules.'
          )}
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor={budgetInputId} className="text-[10px] font-medium text-muted-foreground">
          {translate(
            'fork.hostedReviewSitter.enrollment.activeBudget',
            'Active-time budget (hours)'
          )}
        </label>
        <Input
          id={budgetInputId}
          type="number"
          step={0.25}
          value={Number.isFinite(activeBudgetHours) ? activeBudgetHours : ''}
          disabled={busy}
          aria-invalid={!validBudget}
          onChange={(event) => onActiveBudgetHoursChange(event.currentTarget.valueAsNumber)}
          className="h-7"
        />
        <p className="text-[10px] text-muted-foreground">
          {translate(
            'fork.hostedReviewSitter.enrollment.budgetHelp',
            'Counts only while a worker or action is active. Default: 4 hours.'
          )}
        </p>
      </div>

      {blockedReason ? (
        <div className="flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{blockedReason}</span>
        </div>
      ) : null}
      <Button
        type="button"
        size="xs"
        className="w-full"
        disabled={busy || Boolean(blockedReason) || !validBudget}
        onClick={onArm}
      >
        {arming ? <Loader2 className="animate-spin" /> : <Bot />}
        {rearming
          ? translate('fork.hostedReviewSitter.enrollment.rearm', 'Re-arm PR Sitter')
          : translate('fork.hostedReviewSitter.enrollment.arm', 'Arm PR Sitter')}
      </Button>
    </div>
  )
}
