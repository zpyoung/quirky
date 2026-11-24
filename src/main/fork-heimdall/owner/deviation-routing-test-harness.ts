import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { OwnerAdapter } from '../../../shared/fork-heimdall/kind-contract'
import type {
  KernelAction,
  LedgerEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { RegisteredWatcherKind } from '../registry'
import { WatcherRunnerActions } from '../runner-actions'
import type { WatcherRunner } from '../runner-state'
import {
  findOldestOpenOwnerDeviation,
  ownerInterventionSubmissionSubject,
  type OwnerDeviationEscalation
} from './deviation-ledger'
import type { DeviationRoutingDependencies } from './deviation-routing'

export type World = { revision: string }

export type MemoryLedgerStore = {
  read(watcherId: string): WatcherLedger
  append(watcherId: string, entry: LedgerEntry): void
}

export function memoryLedgerStore(): MemoryLedgerStore {
  const byWatcher = new Map<string, LedgerEntry[]>()
  return {
    read: (watcherId) => ({ watcherId, entries: byWatcher.get(watcherId) ?? [] }),
    append: (watcherId, entry) => {
      const list = byWatcher.get(watcherId) ?? []
      list.push(entry)
      byWatcher.set(watcherId, list)
    }
  }
}

export function fakeOwner(
  rejection: {
    gate: 'write-territory' | 'landing-bar' | 'sitter-overrides'
    reason: string
  } | null,
  capability = 'write'
): OwnerAdapter<World, KernelAction> {
  return {
    describeState: () => ({ text: 'state', truncated: false }),
    describeInterventions: () => 'accept-report',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the ZodType class; only safeParse is called by the code under test.
    interventionSchema: {
      safeParse: (input: unknown) => ({ success: true, data: input })
    } as never,
    rejectIntervention: () => rejection,
    actionForIntervention: (_intervention, currentSnapshot) => ({
      kind: 'apply-fix',
      capability,
      visibility: 'local',
      contentIdentity: currentSnapshot.contentIdentity,
      evidenceKey: `apply-fix:${currentSnapshot.contentIdentity}`
    })
  }
}

export function kindWithOwner(owner: OwnerAdapter<World, KernelAction>): RegisteredWatcherKind {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the WatcherKind contract (KindIdentity & SnapshotSource & Decision & ActionExecutor); these tests only ever read runner.kind.owner.
  return { owner } as unknown as RegisteredWatcherKind
}

export function buildRunner(args: {
  paused: boolean
  owner?: { agent: 'claude' }
  enabled?: boolean
  capabilities?: Record<string, 'off' | 'gated' | 'on'>
}): WatcherRunner {
  const enrollment: WatcherEnrollment = {
    watcherId: 'watcher-1',
    kind: 'objective',
    workspaceKey: 'local::/workspace',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/workspace',
    schedulerOwner: 'local_host_service',
    enabled: args.enabled ?? true,
    paused: args.paused,
    commandRevision: 0,
    capabilities: args.capabilities ?? {
      plan: 'on',
      write: 'on',
      'owner-intervention': 'on'
    },
    budget: { wallClockActiveMs: 100_000, turns: 10 },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: 'run-1',
    createdAtMs: 0,
    terminalAtMs: null,
    ...(args.owner ? { owner: args.owner } : {})
  }
  return {
    enrollment,
    kind: kindWithOwner(fakeOwner(null)),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherStatus is never read by driveOwnerDeviation or these tests; only its presence on WatcherRunner matters.
    status: {} as WatcherRunner['status'],
    timer: null,
    operationTail: Promise.resolve(),
    tickQueued: false,
    reconcileAgain: false,
    stopped: false,
    suspended: false,
    controlPending: null,
    recovered: false,
    forceFresh: false,
    consecutiveErrors: 0,
    consecutiveGateHolds: 0,
    lastFullResyncAtMs: null,
    lastSnapshot: null,
    traceSequence: 0,
    traces: [],
    leaseGuard: null,
    leaseRenewal: null,
    ownerBudgetInterval: null
  }
}

export const snapshot: Snapshot<World> = {
  freshness: 'live',
  contentIdentity: 'revision-1',
  observedAtMs: 1,
  world: { revision: 'revision-1' }
}

export type TestRoutingDependencies = DeviationRoutingDependencies & {
  answerWorkerQuestion: Mock<DeviationRoutingDependencies['answerWorkerQuestion']>
  readWorkerQuestion: Mock<DeviationRoutingDependencies['readWorkerQuestion']>
  notifyApproval: Mock<(enrollment: WatcherEnrollment, action: KernelAction) => void>
}

export function baseDeps(ledgerStore: MemoryLedgerStore): TestRoutingDependencies {
  let clock = 0
  let ids = 0
  let openInterval: { watcherId: string; intervalId: string } | null = null
  const notifyApproval = vi.fn<(enrollment: WatcherEnrollment, action: KernelAction) => void>()
  const actions = new WatcherRunnerActions({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: MemoryLedgerStore only implements read/append; actions.execute is mocked below so RunnerLedgerStore's other members are never called.
    ledgerStore: ledgerStore as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RunnerBudgetClock is unused — actions.execute is mocked below, so the constructor never calls into it.
    budgetClock: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: HeimdallOrchestrationAdapter is unused — actions.execute is mocked below, so the constructor never calls into it.
    orchestration: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherLedgerLifecycle is unused — actions.execute is mocked below, so the constructor never calls into it.
    dispatchLifecycle: {} as never,
    notifyApproval,
    now: () => ++clock,
    createId: () => `action-event-${++ids}`
  })
  vi.spyOn(actions, 'execute').mockResolvedValue(true)
  return {
    owner: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: QuirkyRuntimeService is a large class; ensureOwnerSession/sendOwnerTurn are mocked via vi.mock, so this runtime handle is never dereferenced.
      runtime: {} as never,
      resolveWorkspaceTarget: async () => ({
        kind: 'folder',
        executionHostId: 'local',
        workspacePath: '/workspace',
        watcherId: 'watcher-1'
      }),
      ensureRun: async () => ({ runId: 'run-1' })
    },
    actions,
    budgetClock: {
      open: (watcherId, cause) => {
        openInterval = { watcherId, intervalId: `interval-${cause}` }
        return openInterval
      },
      close: () => {
        openInterval = null
      },
      current: () => openInterval
    },
    ledgerRecord: { ledgerStore, now: () => ++clock, createId: () => `event-${++ids}` },
    answerWorkerQuestion: vi.fn<DeviationRoutingDependencies['answerWorkerQuestion']>(
      async () => {}
    ),
    readWorkerQuestion: vi.fn<DeviationRoutingDependencies['readWorkerQuestion']>(async () => ({
      status: 'pending'
    })),
    stopWorker: vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: ++clock })),
    messageWorker: vi.fn(async () => {}),
    park: vi.fn(),
    notifyApproval
  }
}

export function appendAcceptedOwnerReady(
  ledgerStore: MemoryLedgerStore,
  pending: OwnerDeviationEscalation
): void {
  const sequence = ledgerStore.read('watcher-1').entries.length
  ledgerStore.append('watcher-1', {
    eventId: `owner-ready-${sequence}`,
    watcherId: 'watcher-1',
    atMs: 10_000 + sequence,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: {
      kind: 'orchestration',
      sequence,
      messageId: `owner-ready-${sequence}`
    },
    payload: {
      type: 'status',
      subject: ownerInterventionSubmissionSubject('watcher-1', pending),
      body: 'ready',
      payload: {}
    }
  })
}
export function requireOpenOwnerDeviation(
  ledgerStore: MemoryLedgerStore
): OwnerDeviationEscalation {
  const pending = findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))
  if (!pending) {
    throw new Error('Expected an open owner deviation')
  }
  return pending
}
