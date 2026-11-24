import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  KernelAction,
  OwnerAdapter,
  SubmissionPreflightResult
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import {
  CONTRACT,
  projection,
  snapshot
} from '../../../shared/fork-heimdall-objective/decision-test-harness'
import { createObjectiveOwnerAdapter } from '../../fork-heimdall-objective/owner-adapter'
import type { LeaseWorkspaceTarget } from '../lease-store'
import { ownerDeviationWakeToken, type OwnerDeviationEscalation } from './deviation-ledger'
import { issueOwnerReportPath, MAX_OWNER_REPORT_BYTES } from './owner-report-io'
import { resolveOwnerReportLocation } from './owner-report-location'
import { preflightOwnerInterventionSubmission } from './submission-preflight'

const PENDING: OwnerDeviationEscalation = {
  eventId: 'event-1',
  watcherId: 'watcher-1',
  atMs: 1,
  origin: 'owner',
  class: 'fact',
  kind: 'escalation',
  escalationId: 'owner-deviation:watcher-1:worker-question:dispatch-1',
  escalationKind: 'owner-deviation',
  status: 'open',
  foldCount: 1,
  reason: 'waiting for owner'
}
const LEDGER: WatcherLedger = { watcherId: 'watcher-1', entries: [PENDING] }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the 18-field WatcherEnrollment; only kind/kindPayload are read by the preflight paths under test.
const ENROLLMENT = {
  kind: 'objective',
  kindPayload: CONTRACT
} as unknown as WatcherEnrollment
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bridges the concrete ObjectiveWorld/ObjectiveAction generics to the OwnerAdapter<unknown, KernelAction> shape preflightOwnerInterventionSubmission expects; the adapter's methods are structurally compatible but TS cannot verify it through the generic parameter.
const OWNER = createObjectiveOwnerAdapter() as unknown as OwnerAdapter<unknown, KernelAction>
const SNAPSHOT: Snapshot<unknown> = snapshot(projection())

function expectActionableRejection(
  result: SubmissionPreflightResult,
  expectedDetail: string
): void {
  expect(result).toMatchObject({
    status: 'rejected',
    code: 'heimdall_owner_intervention_invalid'
  })
  if (result.status !== 'rejected') {
    throw new Error('expected owner intervention rejection')
  }
  expect(result.reason).toContain(expectedDetail)
  expect(result.reason).toContain('Correct the issued report file')
  expect(result.reason).toContain('resend the same ready status')
  expect(result.reason).toContain('retry budget remain available')
}

describe('owner intervention submission preflight', () => {
  let workspacePath: string
  let target: LeaseWorkspaceTarget
  let reportPath: string

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'quirky-owner-preflight-'))
    target = {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath,
      watcherId: 'watcher-1'
    }
    const location = await resolveOwnerReportLocation(target)
    reportPath = await issueOwnerReportPath(location, ownerDeviationWakeToken(PENDING))
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  it('rejects report and field caps actionably, then accepts the corrected same report', async () => {
    const args = {
      target,
      pending: PENDING,
      owner: OWNER,
      snapshot: SNAPSHOT,
      ledger: LEDGER,
      enrollment: ENROLLMENT
    }

    await writeFile(reportPath, 'x'.repeat(MAX_OWNER_REPORT_BYTES + 1))
    expectActionableRejection(
      await preflightOwnerInterventionSubmission(args),
      `reportPath exceeds the ${MAX_OWNER_REPORT_BYTES}-byte limit`
    )

    await writeFile(
      reportPath,
      JSON.stringify({
        kind: 'dispatch-planner',
        guidance: 'g'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH + 1)
      })
    )
    expectActionableRejection(await preflightOwnerInterventionSubmission(args), 'guidance')

    await writeFile(
      reportPath,
      JSON.stringify({ kind: 'dispatch-planner', guidance: 'Use the existing objective plan.' })
    )
    await expect(preflightOwnerInterventionSubmission(args)).resolves.toEqual({
      status: 'accepted'
    })
  })
})
