import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi, type Mock } from 'vitest'
import { z } from 'zod'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { EnrollInput, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import { HeimdallEnrollmentStore } from './enrollment-store'
import { HeimdallKernelServiceImpl } from './kernel-service'
import { HeimdallLedgerStore } from './ledger-store'
import type { LeaseResult, LeaseStore } from './lease-store'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

export type World = { revision: string; stopped?: boolean }
export const action = (revision: string): KernelAction => ({
  kind: 'apply-review-fix',
  capability: 'write',
  visibility: 'external',
  contentIdentity: revision,
  evidenceKey: `review:${revision}`,
  expectedState: { target: 'review', before: revision }
})

export const enrollmentInput = (
  budget: EnrollInput['budget'] = { wallClockActiveMs: 100, turns: 2 }
): EnrollInput => ({
  kind: 'hosted-review',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  capabilities: { write: 'on' },
  budget,
  kindPayload: { label: 'Review 1' }
})

export function authorized(
  input: EnrollInput,
  owner: WatcherEnrollment['schedulerOwner'] = 'local_host_service'
) {
  return {
    kind: input.kind,
    workspaceKey: 'local::/workspace/review-1' as const,
    executionHostId: 'local' as const,
    repoId: input.repoId,
    worktreeId: input.worktreeId,
    workspacePath: '/workspace/review-1',
    schedulerOwner: owner,
    capabilities: input.capabilities,
    budget: input.budget,
    kindPayload: input.kindPayload
  }
}

export function kind(overrides: Partial<WatcherKind<World, KernelAction, { label: string }>> = {}) {
  const defaultSnapshot: Snapshot<World> = {
    freshness: 'live',
    contentIdentity: 'revision-1',
    observedAtMs: 1,
    world: { revision: 'revision-1' }
  }
  return {
    id: 'hosted-review',
    displayName: 'Hosted review',
    describeEnrollment: () => 'Review 1',
    enrollmentPayloadSchema: z.object({ label: z.string() }).strict(),
    authorizeEnrollment: async (input: EnrollInput) => authorized(input),
    read: async () => defaultSnapshot,
    describeSnapshot: (snapshot: Snapshot<World>) => ({
      freshness: snapshot.freshness,
      contentIdentity: snapshot.contentIdentity,
      summary: snapshot.world.revision
    }),
    decide: () => ({ action: null, reason: 'quiet', considered: [] }),
    execute: async () => ({ effect: 'landed' as const }),
    resolveOutcome: () => ({ effect: 'not-landed' as const }),
    ...overrides
  } satisfies WatcherKind<World, KernelAction, { label: string }>
}

function heldLease(assertHeld: () => Promise<void>): LeaseResult {
  return {
    status: 'held',
    epoch: 1,
    guard: {
      epoch: 1,
      holder: 'test-holder',
      assertHeld,
      renewLoop: () => ({ dispose: () => {} })
    }
  }
}

export async function harness(
  options: {
    directory?: string
    storageAuthority?: 'desktop' | 'runtime'
    lease?: () => LeaseResult
    mailbox?: (input: Parameters<HeimdallOrchestrationAdapter['drainMailbox']>[0]) => LedgerEntry[]
    recoverDispatch?: HeimdallOrchestrationAdapter['recoverDispatch']
    releaseWorker?: HeimdallOrchestrationAdapter['releaseWorker']
    authoritativeWorkerReport?: HeimdallOrchestrationAdapter['readAuthoritativeWorkerReport']
    dispatchObservation?: (dispatchId: string) => {
      status: 'live' | 'exited' | 'unverifiable'
      reason?: string
    }
    idleObservation?: HeimdallOrchestrationAdapter['observeWorkerIdle']
    now?: () => number
  } = {}
) {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'heimdall-kernel-')))
  if (!options.directory) {
    directories.push(directory)
  }
  const database = new HeimdallDatabase(directory)
  const enrollmentStore = new HeimdallEnrollmentStore(database)
  const ledgerStore = new HeimdallLedgerStore(database)
  const budgetClock = new HeimdallBudgetClock(ledgerStore, { now: () => 100 })
  const schedule: Mock<(callback: () => void, delay: number) => void> = vi.fn()
  const assertHeld = vi.fn(async () => {})
  let identifier = 0
  const leaseStore: LeaseStore = {
    acquireOrRenew: vi.fn(async () => options.lease?.() ?? heldLease(assertHeld)),
    release: vi.fn(async () => {})
  }
  const orchestration: HeimdallOrchestrationAdapter = {
    ensureRun: vi.fn(async () => ({ runId: 'run-1' })),
    dispatchWorker: vi.fn(async () => ({
      status: 'dispatched' as const,
      dispatchId: 'dispatch-1'
    })),
    recoverDispatch: vi.fn(
      options.recoverDispatch ?? (async () => ({ status: 'absent' as const }))
    ),
    readDispatch: vi.fn(
      async (_enrollment, dispatchId) =>
        options.dispatchObservation?.(dispatchId) ?? { status: 'live' as const }
    ),
    readAuthoritativeWorkerReport: vi.fn(options.authoritativeWorkerReport ?? (async () => null)),
    listWorkers: vi.fn(async () => []),
    stopWorker: vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: 100 })),
    releaseWorker: vi.fn(
      options.releaseWorker ??
        (async (_enrollment: WatcherEnrollment, dispatchId: string) => ({
          dispatchId,
          state: 'released' as const,
          processAction: 'closed_agent_terminal' as const,
          archive: null
        }))
    ),
    drainMailbox: vi.fn(async (input) => options.mailbox?.(input) ?? []),
    answerQuestion: vi.fn(async () => {}),
    readQuestion: vi.fn(async () => ({ status: 'pending' as const })),
    observeWorkerIdle: vi.fn(
      options.idleObservation ?? (async () => ({ status: 'active' as const }))
    ),
    sendWorkerPrompt: vi.fn(async () => {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double for Store; this harness only ever reads the four accessors implemented above.
  const store = {
    getProfileStorageDirectory: () => directory,
    getSettings: () => ({ notifications: { enabled: false } }),
    getRepo: () => null,
    getWorktreeMetaForHost: () => null
  } as unknown as Store
  const service = new HeimdallKernelServiceImpl({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double for QuirkyRuntimeService; this harness never calls runtime methods directly.
    runtime: {} as QuirkyRuntimeService,
    store,
    ...(options.storageAuthority ? { storageAuthority: options.storageAuthority } : {}),
    database,
    enrollmentStore,
    ledgerStore,
    budgetClock,
    leaseStore,
    orchestration,
    now: options.now ?? (() => 100),
    createId: () => `id-${++identifier}`,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fake implements only the (callback, delay) call shape this harness needs, not setTimeout's full overload set.
    setTimer: ((callback: () => void, delay: number) => {
      schedule(callback, delay)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double for NodeJS.Timeout; this harness only ever calls unref() on the returned handle.
      return { unref: () => {} } as NodeJS.Timeout
    }) as typeof setTimeout,
    clearTimer: vi.fn<typeof clearTimeout>(),
    holderId: 'test-holder'
  })
  return {
    directory,
    service,
    database,
    enrollmentStore,
    ledgerStore,
    budgetClock,
    leaseStore,
    orchestration,
    schedule,
    assertHeld
  }
}

export function runningDispatch(watcherId: string): LedgerEntry[] {
  const attempted: LedgerEntry = {
    eventId: 'attempt-event',
    watcherId,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: 'fingerprint-1',
    action: action('revision-1'),
    state: 'attempted',
    dispatch: { spec: 'Do the work', dispatchKind: 'child' },
    orchestrationRequestId: 'request-1'
  }
  return [
    attempted,
    {
      ...attempted,
      eventId: 'running-event',
      atMs: 11,
      state: 'running',
      dispatchId: 'dispatch-1'
    }
  ]
}
