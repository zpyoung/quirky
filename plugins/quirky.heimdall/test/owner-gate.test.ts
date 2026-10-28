import { expect, test } from 'bun:test'
import type { JournalEntry, KernelAction } from '../src/contracts'
import type { OwnerEnrollment } from '../src/owner/contracts'
import { gateOwnerAction, ownerApprovalScope } from '../src/owner/gate'
const action: KernelAction = { kind: 'merge', capability: 'merge', visibility: 'external', contentIdentity: 'sha1', evidenceKey: 'review1', ownerReportKey: 'report1', preparedCommitSha: 'commit1' }
const approval = (scope: object, status = 'approved', seq = 1): JournalEntry => ({
  kind: 'approval', seq, status, approvalScope: scope, eventId: `approval-${seq}`,
  watcherId: 'owner-gate-watcher', atMs: seq, class: 'fact', origin: 'client', resolved: true
})

test('native approval cannot authorize a separate gated owner intervention', () => {
  const enrollment = { ownerInterventionCapability: 'gated' } as OwnerEnrollment
  const native = approval({ actionKind: 'merge', contentIdentity: 'sha1', evidenceKey: 'review1', preparedCommitSha: 'commit1' })
  expect(gateOwnerAction(enrollment, action, [native])).toEqual({ verdict: 'hold', reason: 'awaiting-owner-approval' })
  const owner = approval(ownerApprovalScope(action), 'approved', 2)
  expect(gateOwnerAction(enrollment, action, [native, owner])).toEqual({ verdict: 'allow' })
  expect(gateOwnerAction(enrollment, { ...action, evidenceKey: 'review2' }, [owner]).verdict).toBe('hold')
})

test('disabled owner authority cannot be revived by a remembered approval', () => {
  const approved = approval(ownerApprovalScope(action))
  for (const mode of [undefined, 'off'] as const) {
    expect(gateOwnerAction({ ownerInterventionCapability: mode } as OwnerEnrollment, action, [approved])).toEqual({ verdict: 'hold', reason: 'owner-intervention-off' })
  }
})

test('a later rejection revokes only the exact owner scope', () => {
  const enrollment = { ownerInterventionCapability: 'gated' } as OwnerEnrollment
  const scope = ownerApprovalScope(action)
  const entries = [approval(scope), approval(scope, 'rejected', 3), approval({ ...scope, evidenceKey: 'other' }, 'approved', 5)]
  expect(gateOwnerAction(enrollment, action, entries).verdict).toBe('hold')
})
