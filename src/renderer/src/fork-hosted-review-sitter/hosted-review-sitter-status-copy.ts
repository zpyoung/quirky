import { translate } from '@/i18n/i18n'

function hostedReviewSitterReadinessBlockerLabel(blocker: string): string {
  switch (blocker) {
    case 'approvals':
      return translate('fork.hostedReviewSitter.blocker.approvals', 'approvals')
    case 'checks':
      return translate('fork.hostedReviewSitter.blocker.checks', 'checks')
    case 'behind':
      return translate('fork.hostedReviewSitter.blocker.behind', 'branch update')
    case 'conflicts':
      return translate('fork.hostedReviewSitter.blocker.conflicts', 'conflicts')
    case 'draft':
      return translate('fork.hostedReviewSitter.blocker.draft', 'draft status')
    case 'discussions':
      return translate('fork.hostedReviewSitter.blocker.discussions', 'open discussions')
    case 'policy':
      return translate('fork.hostedReviewSitter.blocker.policy', 'repository policy')
    default:
      return translate('fork.hostedReviewSitter.blocker.unknown', 'provider readiness')
  }
}

export function hostedReviewSitterStatusReason(reason: string): string {
  if (reason.startsWith('waiting:')) {
    const blockers = reason
      .slice('waiting:'.length)
      .split(',')
      .map(hostedReviewSitterReadinessBlockerLabel)
      .join(', ')
    return translate(
      'fork.hostedReviewSitter.status.waitingForGates',
      'Waiting for {{blockers}}.',
      { blockers }
    )
  }
  const [reasonKind, detail] = reason.split(':', 2)
  if (reasonKind === 'required-check-failed' && detail) {
    return translate(
      'fork.hostedReviewSitter.status.requiredCheckFailed',
      'Required check failed: {{check}}.',
      { check: detail }
    )
  }
  if (reasonKind === 'failure-signature-unavailable' && detail) {
    return translate(
      'fork.hostedReviewSitter.status.failureUnverifiableForCheck',
      'The failure for {{check}} could not be verified.',
      { check: detail }
    )
  }
  if (reasonKind === 'same-failure-after-own-fix' && detail) {
    return translate(
      'fork.hostedReviewSitter.status.fixDidNotResolve',
      'The same failure returned after Quirky fixed {{check}}.',
      { check: detail }
    )
  }
  if (reasonKind === 'action-outcome-indeterminate' && detail) {
    return translate(
      'fork.hostedReviewSitter.status.actionOutcomeIndeterminate',
      'Quirky could not verify the outcome of {{action}}.',
      { action: detail }
    )
  }
  switch (reason) {
    case 'awaiting-approval':
      return translate('fork.hostedReviewSitter.status.awaitingApproval', 'Awaiting approval.')
    case 'local-changes':
      return translate(
        'fork.hostedReviewSitter.status.localChanges',
        'Held: local changes in the worktree.'
      )
    case 'foreign-agent':
      return translate(
        'fork.hostedReviewSitter.status.foreignAgent',
        'Held: another agent is using this worktree.'
      )
    case 'contention-unverifiable':
      return translate(
        'fork.hostedReviewSitter.status.contentionUnverifiable',
        'Held: worktree activity could not be verified.'
      )
    case 'action-in-flight':
      return translate('fork.hostedReviewSitter.status.actionInFlight', 'An action is in progress.')
    case 'stale-evidence':
    case 'refreshing-merge-gates':
      return translate(
        'fork.hostedReviewSitter.status.refreshingMergeGates',
        'Refreshing merge gates on the current head.'
      )
    case 'checks-unverifiable':
      return translate(
        'fork.hostedReviewSitter.status.checksUnverifiable',
        'Waiting for complete check results.'
      )
    case 'readiness-unverifiable':
      return translate(
        'fork.hostedReviewSitter.status.readinessUnverifiable',
        'Waiting for provider readiness.'
      )
    case 'merge-queue':
      return translate(
        'fork.hostedReviewSitter.status.mergeQueue',
        'Watching the review in the merge queue.'
      )
    case 'draft':
      return translate('fork.hostedReviewSitter.status.draft', 'Waiting for draft status to clear.')
    case 'budget-exhausted':
    case 'budget-wall-clock':
      return translate(
        'fork.hostedReviewSitter.status.budgetExhaustedReason',
        'The active-time budget was exhausted.'
      )
    case 'budget-turns':
      return translate(
        'fork.hostedReviewSitter.status.budgetTurnsExhaustedReason',
        'The worker turn budget was exhausted.'
      )
    case 'approval-rejected':
      return translate(
        'fork.hostedReviewSitter.status.approvalRejected',
        'The current action was rejected.'
      )
    case 'abandoned-fix':
      return translate(
        'fork.hostedReviewSitter.status.abandonedFix',
        'A fix session stopped with uncommitted work.'
      )
    case 'unresolved-action':
      return translate(
        'fork.hostedReviewSitter.status.unresolvedAction',
        'A provider action may have completed, but its outcome remains indeterminate.'
      )
    case 'stop-signature-repeated':
      return translate(
        'fork.hostedReviewSitter.status.repeatedFailure',
        'The same failure returned after an Quirky-authored fix.'
      )
    case 'failure-signature-unavailable':
      return translate(
        'fork.hostedReviewSitter.status.failureUnverifiable',
        'The reproduced failure could not be verified safely.'
      )
    case 'discrepancy-escalated':
      return translate(
        'fork.hostedReviewSitter.status.discrepancyEscalated',
        'A review problem needs a person.'
      )
    case 'conflict-resolution-disabled':
      return translate(
        'fork.hostedReviewSitter.status.conflictResolutionDisabled',
        'Merge conflicts need a person because conflict resolution is off.'
      )
    case 'capability-off':
      return translate(
        'fork.hostedReviewSitter.status.capabilityOff',
        'The required action is disabled by this sitter policy.'
      )
    case 'review-identity-mismatch':
      return translate(
        'fork.hostedReviewSitter.status.identityMismatch',
        'The provider review no longer matches this sitter.'
      )
    case 'review-not-open':
    case 'review-closed':
      return translate(
        'fork.hostedReviewSitter.status.reviewClosedReason',
        'The review is no longer open.'
      )
    case 'already-completed':
      return translate(
        'fork.hostedReviewSitter.status.alreadyCompleted',
        'The current action was already completed.'
      )
    case 'merge-conflicts-detected':
      return translate(
        'fork.hostedReviewSitter.status.conflictsDetected',
        'Merge conflicts were detected.'
      )
    case 'merge-queue-ejected':
      return translate(
        'fork.hostedReviewSitter.status.queueEjected',
        'The review was removed from the merge queue.'
      )
    case 'evidence-no-longer-present':
      return translate(
        'fork.hostedReviewSitter.status.resolved',
        'The earlier problem is no longer present.'
      )
    case 'approval-approved':
      return translate('fork.hostedReviewSitter.status.approved', 'Approved.')
    case 'sitter-disabled':
      return translate('fork.hostedReviewSitter.status.stoppedReason', 'PR Sitter is stopped.')
    case 'coordinator-seat-lost':
      return translate(
        'fork.hostedReviewSitter.status.coordinatorSeatLost',
        "The watcher's orchestration coordinator seat was lost."
      )
    default:
      return reason
  }
}
