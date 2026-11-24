import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type {
  AttemptEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { createObjectiveActionExecutor } from '../fork-heimdall-objective/action-executor'
import type { ObjectiveSnapshotBinding } from '../fork-heimdall-objective/execution-context'
import type { ObjectiveForgeAccess } from '../fork-heimdall-objective/objective-forge-access'
import type { ObjectiveStore } from '../fork-heimdall-objective/objective-store'
import { decideObjective } from '../../shared/fork-heimdall-objective/decision'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { WatcherAttemptRecovery } from './runner-attempt-recovery'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

const { readReport, validateChanges } = vi.hoisted(() => ({
  readReport: vi.fn(),
  validateChanges: vi.fn()
}))
vi.mock('../fork-heimdall-objective/report-ingestion', () => ({
  issueObjectiveReportPath: vi.fn(),
  readObjectiveRoleReport: readReport
}))
vi.mock('../fork-heimdall-objective/observed-workspace-changes', () => ({
  captureObjectiveWorkspaceBaseline: vi.fn(),
  validateObjectiveWorkspaceChanges: validateChanges
}))

const enrollment: WatcherEnrollment = {
  watcherId: 'watcher-1',
  kind: 'objective',
  workspaceKey: 'local::/workspace',
  executionHostId: 'local',
  repoId: 'repo-1',
  worktreeId: null,
  workspacePath: '/workspace',
  schedulerOwner: 'local_host_service',
  enabled: true,
  paused: false,
  commandRevision: 0,
  capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
  budget: { wallClockActiveMs: 60_000, turns: 10 },
  kindPayload: {},
  coordinatorIdentity: { handle: 'coordinator-1', paneKey: 'pane-1' },
  orchestrationRunId: null,
  createdAtMs: 1,
  terminalAtMs: null
}

const contract = {
  objectiveText: 'Implement the objective.',
  tier: 'standard' as const,
  landingBar: 'files-on-disk' as const,
  maxConcurrency: 1,
  workspaceKind: 'folder' as const,
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

function fakeLedgerStore(entries: LedgerEntry[]): RunnerLedgerStore {
  return {
    read: (): WatcherLedger => ({ watcherId: 'watcher-1', entries }),
    append: (_watcherId: string, entry: LedgerEntry) => {
      entries.push(entry)
    },
    appendTickTrace: () => undefined,
    readTickTraces: () => [],
    releaseTickTracePin: () => undefined,
    readTerminalSummary: () => null
  }
}

function fakeLease(): LeaseGuard {
  return {
    epoch: 1,
    holder: 'test-holder',
    assertHeld: vi.fn(async () => undefined),
    renewLoop: () => ({ dispose: () => undefined })
  }
}

const dispatchNode: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:node-a',
  revisionId: 'revision-1',
  taskKey: 'node-a',
  depsOrchestrationIds: []
}

function unresolvedFailedAttempt(): AttemptEntry {
  return {
    eventId: 'event-1',
    watcherId: 'watcher-1',
    atMs: 2,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: makeAttemptFingerprint(
      dispatchNode.contentIdentity,
      dispatchNode.kind,
      dispatchNode.evidenceKey
    ),
    action: dispatchNode,
    state: 'settled',
    effect: 'indeterminate',
    reason: 'failed',
    dispatch: {
      spec: 'Execute the objective role.',
      taskKey: 'node-a',
      deps: [],
      dispatchKind: 'child'
    },
    dispatchId: 'dispatch-1'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMailboxWorkerDonePayload(value: unknown): value is { payload: Record<string, unknown> } {
  return isRecord(value) && isRecord(value.payload)
}

function workerDoneFailed(): LedgerEntry {
  return {
    eventId: 'mailbox-1',
    watcherId: 'watcher-1',
    atMs: 5,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId: 'dispatch-1',
        outcome: 'failed',
        reportPath: '/workspace/report.json',
        filesModified: ['src/a.ts']
      }
    }
  }
}

function buildHarness(): {
  recovery: WatcherAttemptRecovery
  runner: WatcherRunner
  snapshot: LiveSnapshot<ObjectiveWorld>
  ledgerStore: RunnerLedgerStore
  entries: LedgerEntry[]
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only getPlan/getDispatch/getTask are reached while resolving a dispatch-node outcome; ObjectiveStore's other ~30 persistence methods are unused here.
  const objectiveStore = {
    getPlan: () => [
      {
        taskKey: 'node-a',
        title: 'Node A',
        spec: 'Implement A',
        deps: [],
        criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
        declaresDependencyChange: false,
        declaredPaths: ['src/a.ts']
      }
    ],
    getDispatch: () => null,
    getTask: () => ({
      taskKey: 'node-a',
      title: 'Node A',
      spec: 'Implement A',
      deps: [],
      criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false,
      declaredPaths: ['src/a.ts']
    })
  } as unknown as ObjectiveStore

  const snapshotBindings = new WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>()
  const snapshot: LiveSnapshot<ObjectiveWorld> = {
    freshness: 'live',
    contentIdentity: 'content-current',
    observedAtMs: 10,
    world: {
      contract,
      workspaceKind: 'folder',
      plan: {
        revisions: [
          {
            id: 'revision-1',
            number: 1,
            status: 'approved',
            digest: 'plan-digest',
            createdByDispatchId: 'planner-dispatch',
            createdAtMs: 10,
            approvedAtMs: 20
          }
        ],
        nodes: [
          {
            revisionId: 'revision-1',
            taskKey: 'node-a',
            deps: [],
            orchestrationTaskId: null,
            dispatchId: null,
            state: 'pending',
            criteria: []
          }
        ],
        verdicts: [],
        landing: []
      },
      reports: [],
      budget: enrollment.budget,
      landingContext: {
        branch: null,
        headSha: null,
        worktreeContentDigest: null,
        pushTarget: null,
        hostedReview: null
      }
    }
  }
  snapshotBindings.set(snapshot, {
    enrollment,
    contract,
    target: {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/workspace'
    }
  })

  const executor = createObjectiveActionExecutor({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatchRecord stays null in this fixture, so resolveObjectiveDispatchOutcome's only runtime access (resolveObjectiveDispatchTarget) is never reached.
    runtime: {} as QuirkyRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test only calls resolveOutcome(), which never reads dependencies.store (only execute() does).
    store: {} as Store,
    objectiveStore,
    snapshotBindings,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forge is only reached by execute()'s landing paths, which this test never calls.
    forge: {} as ObjectiveForgeAccess
  })

  const entries = [unresolvedFailedAttempt(), workerDoneFailed()]
  const ledgerStore = fakeLedgerStore(entries)
  const recovery = new WatcherAttemptRecovery({
    ledgerStore,
    now: () => 100,
    createId: () => 'resolution-event',
    replay: vi.fn(async () => false)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherAttemptRecovery.recover only reads enrollment, kind.resolveOutcome/describeSnapshot, leaseGuard, and traces off a runner; the rest of WatcherRunner's scheduler-loop state is unused here.
  const runner = {
    enrollment,
    kind: {
      resolveOutcome: executor.resolveOutcome,
      describeSnapshot: () => ({ contentIdentity: 'content-current', summary: 'objective' })
    },
    leaseGuard: fakeLease(),
    traces: []
  } as unknown as WatcherRunner

  return { recovery, runner, snapshot, ledgerStore, entries }
}

describe('WatcherAttemptRecovery / objective classifier integration', () => {
  beforeEach(() => {
    readReport.mockReset()
    validateChanges.mockReset()
    validateChanges.mockResolvedValue({ ok: true, changedPaths: ['src/a.ts'] })
    readReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      reportDigest: 'digest-1',
      report: {
        taskKey: 'node-a',
        summary: 'Wrote and verified both files',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [
          { criterionIndex: 0, result: 'unknown', note: 'Sandbox unavailable to re-run' }
        ]
      }
    })
  })

  it('classifies a failed worker_done as environment through the real objective classifier, not a mock', async () => {
    const { recovery, runner, snapshot, ledgerStore, entries } = buildHarness()

    await recovery.recover(runner, snapshot, ledgerStore.read('watcher-1'))

    const resolved = entries.find((entry) => entry.kind === 'attempt-resolved')
    expect(resolved).toMatchObject({
      kind: 'attempt-resolved',
      attemptId: 'attempt-1',
      effect: 'not-landed',
      failureClass: 'environment'
    })
  })

  it('retains a remote report-read unverifiable cause without turning diagnostic loss into a task retry', async () => {
    readReport.mockRejectedValue(
      Object.assign(new Error('remote transport detail'), { code: 'ECONNRESET' })
    )
    const { recovery, runner, snapshot, ledgerStore, entries } = buildHarness()

    await recovery.recover(runner, snapshot, ledgerStore.read('watcher-1'))

    const resolved = entries.find((entry) => entry.kind === 'attempt-resolved')
    expect(resolved).toMatchObject({
      kind: 'attempt-resolved',
      attemptId: 'attempt-1',
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'unverifiable',
        code: 'read-unverifiable',
        role: 'implementer',
        dispatchId: 'dispatch-1',
        taskKey: 'node-a',
        detail: 'Report authority could not be read (ECONNRESET)',
        hostVerifiable: false
      }
    })

    const decision = decideObjective(snapshot, ledgerStore.read('watcher-1'))
    expect(decision.action?.kind).not.toBe('dispatch-node')
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      reason: 'replan-after-failure'
    })
  })

  it('carries a normalized legacy terminal rejection through recovery into report-rejected', async () => {
    const { recovery, runner, snapshot, ledgerStore, entries } = buildHarness()
    const completion = entries.find(
      (entry) => entry.kind === 'evidence' && entry.evidenceKind === 'orchestration-mailbox'
    )
    if (!completion || completion.kind !== 'evidence') {
      throw new Error('expected worker completion evidence')
    }
    if (!isMailboxWorkerDonePayload(completion.payload)) {
      throw new Error('expected mailbox worker_done payload')
    }
    const message = completion.payload
    message.payload.reportRejection = {
      code: 'sender_not_assignee',
      reason: 'The submitting worker is not the authoritative assignee.'
    }

    await recovery.recover(runner, snapshot, ledgerStore.read('watcher-1'))

    expect(entries.find((entry) => entry.kind === 'attempt-resolved')).toMatchObject({
      kind: 'attempt-resolved',
      attemptId: 'attempt-1',
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'rejected',
        code: 'semantic-invalid',
        sourceCode: 'sender_not_assignee',
        detail: 'The submitting worker is not the authoritative assignee.'
      }
    })
    expect(readReport).not.toHaveBeenCalled()
    expect(validateChanges).not.toHaveBeenCalled()
    expect(decideObjective(snapshot, ledgerStore.read('watcher-1'), true)).toMatchObject({
      action: null,
      deviation: {
        kind: 'report-rejected',
        dispatchId: 'dispatch-1',
        taskKey: 'node-a',
        rejectionReason: 'sender_not_assignee',
        detail: expect.stringContaining('The submitting worker is not the authoritative assignee.')
      }
    })
  })

  it('reaches the environment retry through decideObjective, not by calling the classifier directly', async () => {
    const { recovery, runner, snapshot, ledgerStore } = buildHarness()

    await recovery.recover(runner, snapshot, ledgerStore.read('watcher-1'))

    const decision = decideObjective(snapshot, ledgerStore.read('watcher-1'))
    expect(decision.action).toEqual({
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:node-a:r0',
      revisionId: 'revision-1',
      taskKey: 'node-a',
      depsOrchestrationIds: [],
      retryOf: 'revision-1:node-a'
    })
  })
})
