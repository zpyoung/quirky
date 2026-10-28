import type { ApprovalScope, GateVerdict, JournalEntry, KernelAction } from '../contracts'
import type { OwnerEnrollment } from './contracts'

export function ownerApprovalScope(action: KernelAction): ApprovalScope {
  return {
    actionKind: `owner-intervention:${action.kind}`,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey,
    ...(typeof action.preparedCommitSha === 'string' ? { preparedCommitSha: action.preparedCommitSha } : {}),
  }
}

/** Additional authority only: the ordinary native gate and preflight must still allow. */
export function gateOwnerAction(enrollment: OwnerEnrollment, action: KernelAction, journal: JournalEntry[]): GateVerdict {
  if (typeof action.ownerReportKey !== 'string') return { verdict: 'allow' }
  const mode = enrollment.ownerInterventionCapability ?? 'off'
  if (mode === 'off') return { verdict: 'hold', reason: 'owner-intervention-off' }
  if (mode === 'on') return { verdict: 'allow' }
  const expected = ownerApprovalScope(action)
  let latest: JournalEntry | undefined
  for (const entry of journal) {
    if (entry.kind !== 'approval') continue
    const scope = (entry.approvalScope ?? entry.scope ?? entry) as Partial<ApprovalScope> | null
    if (!scope || scope.actionKind !== expected.actionKind || scope.contentIdentity !== expected.contentIdentity || scope.evidenceKey !== expected.evidenceKey || scope.preparedCommitSha !== expected.preparedCommitSha) continue
    if (!latest || entry.seq > latest.seq) latest = entry
  }
  return latest?.status === 'approved' ? { verdict: 'allow' } : { verdict: 'hold', reason: 'awaiting-owner-approval' }
}
