import { expect, it, vi } from 'vitest'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import {
  cleanupAppliedObjectiveDispatch,
  cleanupAppliedObjectiveDispatches,
  reconcileObjectiveDispatchWorktrees,
  type ObjectiveDispatchWorkspaceState
} from './dispatch-worktree-lifecycle'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

const lease: LeaseGuard = {
  epoch: 1,
  holder: 'test-holder',
  assertHeld: vi.fn(async () => undefined),
  renewLoop: () => ({ dispose: () => undefined })
}

const workerSessionNotExited = async (): Promise<boolean> => false
const workspaceUnmodified = async (): Promise<ObjectiveDispatchWorkspaceState> => 'unmodified'

function bindingWithEnrollment(enrollment: Partial<WatcherEnrollment>): ObjectiveSnapshotBinding {
  return {
    enrollment: {
      watcherId: 'watcher-1',
      kind: 'objective',
      workspaceKey: 'local::/workspace',
      executionHostId: 'local',
      repoId: 'repo-1',
      worktreeId: null,
      workspacePath: '/workspace',
      schedulerOwner: 'local_host_service',
      capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
      budget: { wallClockActiveMs: 60_000, turns: 10 },
      kindPayload: {},
      enabled: true,
      paused: false,
      commandRevision: 0,
      coordinatorIdentity: { handle: 'watcher-1', paneKey: 'pane-1' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null,
      ...enrollment
    },
    contract: {
      objectiveText: 'Implement the objective.',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'folder',
      writeTerritory: ['src/**'],
      roleAgents: {},
      sitterOverrides: {}
    },
    target: {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/workspace'
    }
  }
}

function removeWorktreeRuntime(
  removeManagedWorktree: QuirkyRuntimeService['removeManagedWorktree']
): QuirkyRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only removeManagedWorktree is exercised.
  return { removeManagedWorktree } as unknown as QuirkyRuntimeService
}

function recordStore(
  records: Map<string, ObjectiveDispatchRecord>,
  overrides: Partial<ObjectiveStore> = {}
): ObjectiveStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  return {
    getDispatch: (fingerprint: string) => records.get(fingerprint) ?? null,
    listDispatches: () => [...records.values()],
    saveDispatch: (record: ObjectiveDispatchRecord) => {
      records.set(record.attemptFingerprint, record)
      return record
    },
    ...overrides
  } as unknown as ObjectiveStore
}

function appliedDispatch(taskKey: string, workspaceId: string): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: `attempt-${taskKey}`,
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey,
    dispatchId: `dispatch-${taskKey}`,
    workspaceId,
    workspacePath: `/workspace/${workspaceId}`,
    baseCommit: 'base-commit',
    laneTaskKeys: [taskKey],
    sessionNodeCount: 1,
    state: 'applied',
    commitSha: `commit-${taskKey}`,
    appliedCommitSha: `applied-${taskKey}`,
    reportDigest: `digest-${taskKey}`,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: `plan-digest-${taskKey}`,
    createdAtMs: 1,
    completedAtMs: 2,
    terminalHandle: `terminal-${taskKey}`,
    setupState: 'ready',
    reportPath: `/reports/${taskKey}.json`,
    report: {
      taskKey,
      summary: `Implemented ${taskKey}`,
      filesModified: [`src/${taskKey}.ts`],
      criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
    },
    task: {
      taskKey,
      title: taskKey,
      spec: `Implement ${taskKey}`,
      deps: [],
      criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  }
}

it('retains an unreleased dispatch worktree while cleaning a released sibling worktree', async () => {
  const unsafe = appliedDispatch('unsafe', 'workspace-unsafe')
  const released = appliedDispatch('released', 'workspace-released')
  const records = new Map<string, ObjectiveDispatchRecord>([
    [unsafe.attemptFingerprint, unsafe],
    [released.attemptFingerprint, released]
  ])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))
  const runtime = removeWorktreeRuntime(removeManagedWorktree)
  const workerReleaseConfirmed = (dispatchId: string): boolean => dispatchId === released.dispatchId

  await cleanupAppliedObjectiveDispatch({
    runtime,
    objectiveStore,
    record: unsafe,
    lease,
    workerReleaseConfirmed,
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: workspaceUnmodified
  })
  await cleanupAppliedObjectiveDispatch({
    runtime,
    objectiveStore,
    record: released,
    lease,
    workerReleaseConfirmed,
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: workspaceUnmodified
  })

  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(removeManagedWorktree).toHaveBeenCalledWith(`id:${released.workspaceId}`, {
    force: true,
    hostId: 'local'
  })
  expect(records.get(unsafe.attemptFingerprint)?.setupState).toBe('ready')
  expect(records.get(released.attemptFingerprint)?.setupState).toBe('cleaned')
})

it('marks an absent cleanup-pending child cleaned after its worker session exits', async () => {
  const pending = {
    ...appliedDispatch('pending', 'workspace-pending'),
    setupState: 'cleanup-pending' as const
  }
  const records = new Map<string, ObjectiveDispatchRecord>([[pending.attemptFingerprint, pending]])
  const objectiveStore = recordStore(records, { setParallelNote: vi.fn() })
  const removeManagedWorktree = vi.fn(async () => ({}))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  const runtime = {
    listManagedWorktrees: vi.fn(async () => ({ worktrees: [] })),
    removeManagedWorktree
  } as unknown as QuirkyRuntimeService

  const workerSessionExited = vi.fn(async (owner: ObjectiveDispatchRecord) => owner === pending)

  await reconcileObjectiveDispatchWorktrees({
    runtime,
    binding: bindingWithEnrollment({ watcherId: 'watcher-1', repoId: 'repo-1' }),
    objectiveStore,
    lease,
    workerReleaseConfirmed: () => false,
    workerSessionExited,
    inspectWorkspace: workspaceUnmodified
  })

  expect(workerSessionExited).toHaveBeenCalledWith(pending)

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(pending.attemptFingerprint)).toMatchObject({
    state: 'applied',
    setupState: 'cleaned'
  })
})

it('retains a whole lane workspace when an earlier sibling failed', async () => {
  const current = appliedDispatch('current', 'workspace-lane')
  const failed = {
    ...appliedDispatch('failed', 'workspace-lane'),
    state: 'failed' as const,
    setupState: 'retained' as const
  }
  const records = new Map<string, ObjectiveDispatchRecord>([
    [current.attemptFingerprint, current],
    [failed.attemptFingerprint, failed]
  ])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))

  await cleanupAppliedObjectiveDispatch({
    runtime: removeWorktreeRuntime(removeManagedWorktree),
    objectiveStore,
    record: current,
    lease,
    workerReleaseConfirmed: () => true,
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: workspaceUnmodified
  })

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(current.attemptFingerprint)?.setupState).toBe('ready')
})

it('requires release only from the latest owner of one warm terminal incarnation', async () => {
  const older = {
    ...appliedDispatch('older', 'workspace-warm'),
    terminalHandle: 'terminal-warm',
    sessionNodeCount: 1
  }
  const latest = {
    ...appliedDispatch('latest', 'workspace-warm'),
    terminalHandle: 'terminal-warm',
    sessionNodeCount: 2
  }
  const records = new Map<string, ObjectiveDispatchRecord>([
    [older.attemptFingerprint, older],
    [latest.attemptFingerprint, latest]
  ])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))

  await cleanupAppliedObjectiveDispatch({
    runtime: removeWorktreeRuntime(removeManagedWorktree),
    objectiveStore,
    record: latest,
    lease,
    workerReleaseConfirmed: (dispatchId) => dispatchId === latest.dispatchId,
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: workspaceUnmodified
  })

  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(records.get(older.attemptFingerprint)?.setupState).toBe('cleaned')
  expect(records.get(latest.attemptFingerprint)?.setupState).toBe('cleaned')
})

it('waits for release of an older distinct terminal before cleaning its successor workspace', async () => {
  const older = appliedDispatch('older-terminal', 'workspace-fresh-session')
  const latest = appliedDispatch('latest-terminal', 'workspace-fresh-session')
  const records = new Map<string, ObjectiveDispatchRecord>([
    [older.attemptFingerprint, older],
    [latest.attemptFingerprint, latest]
  ])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))
  const released = new Set([latest.dispatchId])
  const args = {
    runtime: removeWorktreeRuntime(removeManagedWorktree),
    objectiveStore,
    record: latest,
    lease,
    workerReleaseConfirmed: (dispatchId: string) => released.has(dispatchId),
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: workspaceUnmodified
  }

  await cleanupAppliedObjectiveDispatch(args)
  expect(removeManagedWorktree).not.toHaveBeenCalled()
  released.add(older.dispatchId)
  await cleanupAppliedObjectiveDispatch(args)

  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(records.get(latest.attemptFingerprint)?.setupState).toBe('cleaned')
})

it('never treats a same-id child on another execution host as the recorded workspace', async () => {
  const record = appliedDispatch('host-bound', 'workspace-shared-id')
  const records = new Map<string, ObjectiveDispatchRecord>([[record.attemptFingerprint, record]])
  const objectiveStore = recordStore(records, { setParallelNote: vi.fn() })
  const removeManagedWorktree = vi.fn(async () => ({}))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  const runtime = {
    listManagedWorktrees: vi.fn(async () => ({
      worktrees: [
        {
          id: record.workspaceId,
          hostId: 'ssh:other',
          comment: `heimdall-objective-dispatch:${record.watcherId}:${record.attemptFingerprint}`,
          displayName: 'Wrong-host child',
          head: record.baseCommit,
          path: '/remote/wrong-host'
        }
      ]
    })),
    removeManagedWorktree
  } as unknown as QuirkyRuntimeService

  await reconcileObjectiveDispatchWorktrees({
    runtime,
    binding: bindingWithEnrollment({
      watcherId: record.watcherId,
      repoId: 'repo-1',
      executionHostId: 'local'
    }),
    objectiveStore,
    lease,
    workerReleaseConfirmed: () => true,
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: workspaceUnmodified
  })

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(record.attemptFingerprint)).toMatchObject({
    state: 'failed',
    setupState: 'retained'
  })
})

it('removes an applied worktree when its unreleased worker session is proven exited', async () => {
  const record = appliedDispatch('exited', 'workspace-exited')
  const records = new Map<string, ObjectiveDispatchRecord>([[record.attemptFingerprint, record]])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))
  const workerSessionExited = vi.fn(async (owner: ObjectiveDispatchRecord) => owner === record)

  const removed = await cleanupAppliedObjectiveDispatch({
    runtime: removeWorktreeRuntime(removeManagedWorktree),
    objectiveStore,
    record,
    lease,
    workerReleaseConfirmed: () => false,
    workerSessionExited,
    inspectWorkspace: workspaceUnmodified
  })

  expect(removed).toBe(true)
  expect(workerSessionExited).toHaveBeenCalledOnce()
  expect(workerSessionExited).toHaveBeenCalledWith(record)
  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(records.get(record.attemptFingerprint)?.setupState).toBe('cleaned')
})

it('keeps an applied worktree while its unreleased worker session is live', async () => {
  const record = appliedDispatch('live', 'workspace-live')
  const records = new Map<string, ObjectiveDispatchRecord>([[record.attemptFingerprint, record]])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))

  await cleanupAppliedObjectiveDispatch({
    runtime: removeWorktreeRuntime(removeManagedWorktree),
    objectiveStore,
    record,
    lease,
    workerReleaseConfirmed: () => false,
    workerSessionExited: async () => false,
    inspectWorkspace: workspaceUnmodified
  })

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(record.attemptFingerprint)?.setupState).toBe('ready')
})

it('keeps an applied worktree when its worker session exit probe throws', async () => {
  const record = appliedDispatch('unverifiable', 'workspace-unverifiable')
  const records = new Map<string, ObjectiveDispatchRecord>([[record.attemptFingerprint, record]])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))

  await expect(
    cleanupAppliedObjectiveDispatch({
      runtime: removeWorktreeRuntime(removeManagedWorktree),
      objectiveStore,
      record,
      lease,
      workerReleaseConfirmed: () => false,
      workerSessionExited: async () => {
        throw new Error('inspection unavailable')
      },
      inspectWorkspace: workspaceUnmodified
    })
  ).resolves.toBe(false)

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(record.attemptFingerprint)?.setupState).toBe('ready')
})

it('selects only applied ready records and cleans only at lane end', async () => {
  const midLane = {
    ...appliedDispatch('lane-first', 'workspace-mid-lane'),
    laneTaskKeys: ['lane-first', 'lane-last']
  }
  const laneEnd = {
    ...appliedDispatch('lane-last', 'workspace-lane-end'),
    laneTaskKeys: ['lane-first', 'lane-last']
  }
  const pending = {
    ...appliedDispatch('pending', 'workspace-pending-ready'),
    setupState: 'pending' as const
  }
  const failed = {
    ...appliedDispatch('failed', 'workspace-failed'),
    state: 'failed' as const
  }
  const records = new Map<string, ObjectiveDispatchRecord>([
    [midLane.attemptFingerprint, midLane],
    [laneEnd.attemptFingerprint, laneEnd],
    [pending.attemptFingerprint, pending],
    [failed.attemptFingerprint, failed]
  ])
  const objectiveStore = recordStore(records)
  const removeManagedWorktree = vi.fn(async () => ({}))

  const removed = await cleanupAppliedObjectiveDispatches({
    runtime: removeWorktreeRuntime(removeManagedWorktree),
    objectiveStore,
    watcherId: 'watcher-1',
    lease,
    workerReleaseConfirmed: () => true,
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: workspaceUnmodified
  })

  expect(removed).toBe(true)
  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(removeManagedWorktree).toHaveBeenCalledWith('id:workspace-lane-end', {
    force: true,
    hostId: 'local'
  })
  expect(records.get(midLane.attemptFingerprint)?.setupState).toBe('ready')
  expect(records.get(laneEnd.attemptFingerprint)?.setupState).toBe('cleaned')
  expect(records.get(pending.attemptFingerprint)?.setupState).toBe('pending')
  expect(records.get(failed.attemptFingerprint)?.setupState).toBe('ready')
})

it.each(['missing', 'modified'] as const)(
  'keeps an applied dispatch whose worktree is %s',
  async (state) => {
    const record = appliedDispatch('kept', 'workspace-kept')
    const records = new Map<string, ObjectiveDispatchRecord>([[record.attemptFingerprint, record]])
    const setParallelNote = vi.fn()
    const removeManagedWorktree = vi.fn(async () => ({}))

    const removed = await cleanupAppliedObjectiveDispatches({
      runtime: removeWorktreeRuntime(removeManagedWorktree),
      objectiveStore: recordStore(records, { setParallelNote }),
      watcherId: 'watcher-1',
      lease,
      workerReleaseConfirmed: () => true,
      workerSessionExited: workerSessionNotExited,
      inspectWorkspace: async () => state
    })

    expect(removed).toBe(false)
    expect(removeManagedWorktree).not.toHaveBeenCalled()
    expect(records.get(record.attemptFingerprint)?.setupState).toBe('ready')
    expect(setParallelNote).toHaveBeenCalledTimes(state === 'modified' ? 1 : 0)
  }
)

it('keeps an applied dispatch when its worktree cannot be inspected', async () => {
  const record = appliedDispatch('unreadable', 'workspace-unreadable')
  const records = new Map<string, ObjectiveDispatchRecord>([[record.attemptFingerprint, record]])
  const removeManagedWorktree = vi.fn(async () => ({}))

  const removed = await cleanupAppliedObjectiveDispatches({
    runtime: removeWorktreeRuntime(removeManagedWorktree),
    objectiveStore: recordStore(records),
    watcherId: 'watcher-1',
    lease,
    workerReleaseConfirmed: () => true,
    workerSessionExited: workerSessionNotExited,
    inspectWorkspace: async () => {
      throw new Error('ssh connection lost')
    }
  })

  expect(removed).toBe(false)
  expect(removeManagedWorktree).not.toHaveBeenCalled()
})
