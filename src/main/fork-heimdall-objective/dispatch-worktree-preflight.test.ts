import { expect, it, vi } from 'vitest'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import {
  ObjectiveEnrolledWorkspaceDirtyError,
  prepareObjectiveDispatchWorkspace
} from './dispatch-worktree'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

const { runGit, classifyDirtyPaths } = vi.hoisted(() => ({
  runGit: vi.fn(),
  classifyDirtyPaths: vi.fn()
}))

vi.mock('./content-identity', () => ({
  objectiveGitCommandForTarget: () => runGit
}))
vi.mock('./landing-territory', () => ({
  objectiveDirtyPathsByTerritory: classifyDirtyPaths
}))
vi.mock('./merge-train-git', () => ({
  OBJECTIVE_MERGE_TRAIN_MAX_PATHS: 256
}))

it('pauses before creating a child when serial output is still dirty in the enrolled worktree', async () => {
  runGit.mockResolvedValue({ stdout: 'dirty', stderr: '' })
  classifyDirtyPaths.mockReturnValue({ inside: ['src/serial-output.ts'], outside: [] })
  const createManagedWorktree = vi.fn()
  const setParallelNote = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  const objectiveStore = {
    getDispatch: () => null,
    setParallelNote,
    clearParallelNoteWithPrefix: vi.fn()
  } as unknown as ObjectiveStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large WatcherEnrollment/ObjectiveEnrollmentPayload types; only the fields below are read by workspace preflight.
  const binding = {
    enrollment: {
      watcherId: 'watcher-1',
      executionHostId: 'local',
      repoId: 'repo-1',
      worktreeId: 'enrolled-worktree'
    },
    contract: { writeTerritory: ['src/**'] },
    target: {
      kind: 'git',
      executionHostId: 'local',
      workspacePath: '/workspace',
      gitTarget: {
        executionHostId: 'local',
        worktree: { id: 'enrolled-worktree', repoId: 'repo-1', path: '/workspace' }
      }
    }
  } as unknown as ObjectiveSnapshotBinding
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ExecuteContext; only the fields below are read by workspace preflight.
  const context = {
    snapshot: {
      world: {
        parallel: { effectiveMaxConcurrency: 3, runningCount: 0, dispatches: [] }
      }
    },
    ledger: { watcherId: 'watcher-1', entries: [] },
    lease: { assertHeld: vi.fn(async () => undefined) }
  } as unknown as ExecuteContext<ObjectiveWorld>

  const preparation = prepareObjectiveDispatchWorkspace({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only createManagedWorktree is exercised.
    runtime: { createManagedWorktree } as unknown as QuirkyRuntimeService,
    binding,
    context,
    objectiveStore,
    action: {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: 'revision-1:node-a',
      revisionId: 'revision-1',
      taskKey: 'node-a',
      depsOrchestrationIds: []
    },
    attemptFingerprint: 'attempt-node-a',
    task: {
      taskKey: 'node-a',
      title: 'Node A',
      spec: 'Build on serial output',
      deps: [],
      criteria: [{ body: 'Node A works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    },
    planTaskDigest: 'plan-task-digest'
  })

  await expect(preparation).rejects.toMatchObject({
    name: ObjectiveEnrolledWorkspaceDirtyError.name,
    result: {
      kind: 'paused-dirty',
      paths: ['src/serial-output.ts'],
      pathCount: 1,
      pathsTruncated: false
    }
  })
  expect(createManagedWorktree).not.toHaveBeenCalled()
  expect(setParallelNote).toHaveBeenCalledWith(
    'watcher-1',
    'Merge train paused by operator edits: src/serial-output.ts'
  )
})
