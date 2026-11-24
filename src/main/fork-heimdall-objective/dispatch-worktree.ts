import type { AttemptEntry } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import { objectiveLaneForTask } from '../../shared/fork-heimdall-objective/parallel-scheduling'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'
import type { ExecuteContext, LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { requireLocalRuntimeFileRoute } from '../runtime/files/file-target'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { objectiveGitCommandForTarget, type ObjectiveWorkspaceTarget } from './content-identity'
import { inspectObjectiveDispatchSession } from './dispatch-session'
import { objectiveDirtyPathsByTerritory } from './landing-territory'
import { OBJECTIVE_MERGE_TRAIN_MAX_PATHS } from './merge-train-git'
import type { ObjectiveDispatchWorkspaceState } from './dispatch-worktree-lifecycle'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

const DISPATCH_WORKTREE_MARKER_PREFIX = 'heimdall-objective-dispatch:'
const PENDING_WORKSPACE_PREFIX = 'pending:'
const SAFE_NAME_MAX_CHARS = 96
const TRAIN_PAUSED_NOTE_PREFIX = 'Merge train paused by operator edits:'
const TRAIN_NOTE_MAX_CHARS = 2_048

type DispatchNodeAction = Extract<ObjectiveAction, { kind: 'dispatch-node' }>
type RuntimeTargetResolver = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
}

export type PreparedObjectiveDispatchWorkspace = {
  record: ObjectiveDispatchRecord
  target: ObjectiveWorkspaceTarget
  reuseTerminal: string | null
}

function dispatchMarker(watcherId: string, attemptFingerprint: string): string {
  return `${DISPATCH_WORKTREE_MARKER_PREFIX}${watcherId}:${attemptFingerprint}`
}
export class ObjectiveEnrolledWorkspaceDirtyError extends Error {
  readonly result: {
    kind: 'paused-dirty'
    paths: string[]
    pathCount: number
    pathsTruncated: boolean
  }

  constructor(paths: readonly string[]) {
    super('objective-train-paused')
    this.name = 'ObjectiveEnrolledWorkspaceDirtyError'
    this.result = {
      kind: 'paused-dirty',
      paths: paths.slice(0, OBJECTIVE_MERGE_TRAIN_MAX_PATHS),
      pathCount: paths.length,
      pathsTruncated: paths.length > OBJECTIVE_MERGE_TRAIN_MAX_PATHS
    }
  }
}

function pausedDirtyNote(paths: readonly string[]): string {
  const bounded = paths.slice(0, OBJECTIVE_MERGE_TRAIN_MAX_PATHS)
  const suffix = paths.length > bounded.length ? ` and ${paths.length - bounded.length} more` : ''
  const value = `${TRAIN_PAUSED_NOTE_PREFIX} ${bounded.join(', ')}${suffix}`
  return value.length <= TRAIN_NOTE_MAX_CHARS
    ? value
    : `${value.slice(0, TRAIN_NOTE_MAX_CHARS - 1)}…`
}

async function assertEnrolledWorkspaceCleanForParallelDispatch(args: {
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<void> {
  if (args.binding.target.kind !== 'git') {
    return
  }
  const status = await objectiveGitCommandForTarget(args.binding.target)([
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--'
  ])
  const classified = objectiveDirtyPathsByTerritory(status.stdout, args.binding)
  const paths = [...classified.inside, ...classified.outside]
  await args.context.lease.assertHeld()
  if (paths.length === 0) {
    args.objectiveStore.clearParallelNoteWithPrefix(
      args.binding.enrollment.watcherId,
      TRAIN_PAUSED_NOTE_PREFIX
    )
    return
  }
  args.objectiveStore.setParallelNote(args.binding.enrollment.watcherId, pausedDirtyNote(paths))
  throw new ObjectiveEnrolledWorkspaceDirtyError(paths)
}

function safeDispatchWorktreeName(watcherId: string, taskKey: string, fingerprint: string): string {
  const safe = `${watcherId}-${taskKey}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return `heimdall-${safe || 'dispatch'}-${fingerprint.slice(0, 12)}`.slice(0, SAFE_NAME_MAX_CHARS)
}

function pendingWorkspaceIdentity(attemptFingerprint: string): string {
  return `${PENDING_WORKSPACE_PREFIX}${attemptFingerprint}`
}

function isPendingWorkspace(record: ObjectiveDispatchRecord): boolean {
  return (
    record.workspaceId.startsWith(PENDING_WORKSPACE_PREFIX) ||
    record.workspacePath.startsWith(PENDING_WORKSPACE_PREFIX)
  )
}

async function enrolledHead(target: ObjectiveWorkspaceTarget): Promise<string> {
  if (target.kind !== 'git') {
    throw new Error('Parallel objective dispatch requires a Git worktree')
  }
  const head = (
    await objectiveGitCommandForTarget(target)(['rev-parse', '--verify', 'HEAD'])
  ).stdout.trim()
  if (!head) {
    throw new Error('The enrolled objective worktree has no HEAD commit')
  }
  return head
}

/** Resolves an isolated dispatch strictly on the enrolled workspace's execution host. */
export async function resolveObjectiveDispatchTarget(
  runtime: QuirkyRuntimeService,
  binding: { enrollment: Pick<WatcherEnrollment, 'executionHostId' | 'repoId'> },
  record: ObjectiveDispatchRecord
): Promise<ObjectiveWorkspaceTarget> {
  if (isPendingWorkspace(record) || record.setupState === 'pending') {
    throw new Error(`Objective dispatch ${record.attemptFingerprint} worktree setup is incomplete`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeGitTarget is protected on QuirkyRuntimeService; runtime satisfies this narrower resolver shape at runtime.
  const target = await (runtime as unknown as RuntimeTargetResolver).resolveRuntimeGitTarget(
    `id:${record.workspaceId}`
  )
  if (
    record.executionHostId !== binding.enrollment.executionHostId ||
    target.executionHostId !== record.executionHostId ||
    target.worktree.id !== record.workspaceId ||
    target.worktree.repoId !== binding.enrollment.repoId ||
    target.worktree.path !== record.workspacePath
  ) {
    throw new Error('Resolved objective dispatch worktree authority changed after creation')
  }
  requireLocalRuntimeFileRoute(target)
  return {
    kind: 'git',
    executionHostId: target.executionHostId,
    workspacePath: target.worktree.path,
    gitTarget: target
  }
}

/** Reports whether a dispatch worktree is gone, or holds changes that removal would destroy. */
export async function inspectObjectiveDispatchWorkspace(
  runtime: QuirkyRuntimeService,
  enrollment: Pick<WatcherEnrollment, 'executionHostId' | 'repoId'>,
  record: ObjectiveDispatchRecord
): Promise<ObjectiveDispatchWorkspaceState> {
  let target: ObjectiveWorkspaceTarget
  try {
    target = await resolveObjectiveDispatchTarget(runtime, { enrollment }, record)
  } catch (error) {
    if (error instanceof Error && error.message === 'selector_not_found') {
      return 'missing'
    }
    throw error
  }
  const status = await objectiveGitCommandForTarget(target)([
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--'
  ])
  return status.stdout.length > 0 ? 'modified' : 'unmodified'
}

export async function resolveObjectiveAttemptTarget(args: {
  runtime: QuirkyRuntimeService
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  attempt: Pick<AttemptEntry, 'fingerprint'>
}): Promise<ObjectiveWorkspaceTarget> {
  const record = args.objectiveStore.getDispatch(args.attempt.fingerprint)
  return record
    ? await resolveObjectiveDispatchTarget(args.runtime, args.binding, record)
    : args.binding.target
}

function laneTaskKeys(args: {
  action: DispatchNodeAction
  context: ExecuteContext<ObjectiveWorld>
  binding: ObjectiveSnapshotBinding
}): string[] {
  const nodes = args.context.snapshot.world.plan.nodes.filter(
    (node) => node.revisionId === args.action.revisionId
  )
  return (
    objectiveLaneForTask(nodes, args.action.taskKey, {
      enabled: args.binding.contract.lanesEnabled
    })?.taskKeys ?? [args.action.taskKey]
  )
}

function precedingLaneRecord(args: {
  objectiveStore: ObjectiveStore
  watcherId: string
  revisionId: string
  taskKey: string
  laneTaskKeys: readonly string[]
}): ObjectiveDispatchRecord | null {
  const index = args.laneTaskKeys.indexOf(args.taskKey)
  if (index <= 0) {
    return null
  }
  const previousTaskKey = args.laneTaskKeys[index - 1]
  return (
    args.objectiveStore
      .listDispatches(args.watcherId)
      .filter(
        (record) =>
          record.revisionId === args.revisionId &&
          record.taskKey === previousTaskKey &&
          record.state === 'applied' &&
          record.setupState !== 'cleaned' &&
          record.laneTaskKeys.join('\0') === args.laneTaskKeys.join('\0')
      )
      .sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null
  )
}

async function resetOwnedLaneWorktree(args: {
  runtime: QuirkyRuntimeService
  binding: ObjectiveSnapshotBinding
  lease: LeaseGuard
  previous: ObjectiveDispatchRecord
  nextHead: string
}): Promise<ObjectiveWorkspaceTarget> {
  const target = await resolveObjectiveDispatchTarget(args.runtime, args.binding, args.previous)
  const runGit = objectiveGitCommandForTarget(target)
  const status = (await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--']))
    .stdout
  if (status.length > 0) {
    throw new Error('Lane dispatch worktree is not clean after its previous node applied')
  }
  await args.lease.assertHeld()
  await runGit(['reset', '--hard', args.nextHead])
  return target
}

function originalConflictRecord(args: {
  action: DispatchNodeAction
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): ObjectiveDispatchRecord | null {
  if (args.action.retryOf === undefined) {
    return null
  }
  const retryRoot = args.action.retryOf
  const candidates: ObjectiveDispatchRecord[] = []
  for (const attempt of args.context.ledger.entries) {
    if (attempt.kind !== 'attempt') {
      continue
    }
    const action = ObjectiveActionSchema.safeParse(attempt.action)
    if (
      !action.success ||
      action.data.kind !== 'dispatch-node' ||
      action.data.revisionId !== args.action.revisionId ||
      action.data.taskKey !== args.action.taskKey ||
      (action.data.evidenceKey !== retryRoot && action.data.retryOf !== retryRoot)
    ) {
      continue
    }
    const record = args.objectiveStore.getDispatch(attempt.fingerprint)
    if (record?.state === 'resolving-conflict') {
      candidates.push(record)
    }
  }
  return candidates.sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null
}

/**
 * Creates or reuses the host-authoritative child worktree for one implementer node. The pending
 * row is durable before worktree creation, so restart reconciliation can recover the side effect.
 */
export async function prepareObjectiveDispatchWorkspace(args: {
  runtime: QuirkyRuntimeService
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  action: DispatchNodeAction
  attemptFingerprint: string
  task: ObjectivePlanTask
  planTaskDigest: string
}): Promise<PreparedObjectiveDispatchWorkspace | null> {
  const effectiveCap = args.context.snapshot.world.parallel?.effectiveMaxConcurrency ?? 1
  const priorConflict = originalConflictRecord(args)
  if (effectiveCap <= 1 && priorConflict === null) {
    await args.context.lease.assertHeld()
    args.objectiveStore.clearParallelNoteWithPrefix(
      args.binding.enrollment.watcherId,
      TRAIN_PAUSED_NOTE_PREFIX
    )
    return null
  }
  if (args.binding.target.kind !== 'git' || args.binding.enrollment.worktreeId === null) {
    return null
  }

  const existing = args.objectiveStore.getDispatch(args.attemptFingerprint)
  if (
    existing &&
    (existing.executionHostId !== args.binding.enrollment.executionHostId ||
      existing.watcherId !== args.binding.enrollment.watcherId ||
      existing.revisionId !== args.action.revisionId ||
      existing.taskKey !== args.action.taskKey)
  ) {
    throw new Error('Durable dispatch identity does not match the requested objective node')
  }
  await assertEnrolledWorkspaceCleanForParallelDispatch(args)
  if (existing && !isPendingWorkspace(existing) && existing.setupState !== 'pending') {
    const session = await inspectObjectiveDispatchSession(args.runtime, existing)
    if (session.status === 'unverifiable') {
      throw new Error(`Objective dispatch session is unverifiable: ${session.reason}`)
    }
    return {
      record: existing,
      target: await resolveObjectiveDispatchTarget(args.runtime, args.binding, existing),
      reuseTerminal: session.status === 'reusable' ? session.terminalHandle : null
    }
  }

  const tasks = laneTaskKeys(args)
  const baseCommit = await enrolledHead(args.binding.target)
  const continuation =
    priorConflict ??
    precedingLaneRecord({
      objectiveStore: args.objectiveStore,
      watcherId: args.binding.enrollment.watcherId,
      revisionId: args.action.revisionId,
      taskKey: args.action.taskKey,
      laneTaskKeys: tasks
    })
  const session = continuation
    ? await inspectObjectiveDispatchSession(args.runtime, continuation)
    : ({ status: 'gone' } as const)
  if (session.status === 'unverifiable') {
    throw new Error(`Objective dispatch session is unverifiable: ${session.reason}`)
  }
  const reuseTerminal = session.status === 'reusable' ? session.terminalHandle : null
  const now = Date.now()
  const pendingIdentity = pendingWorkspaceIdentity(args.attemptFingerprint)
  const pending: ObjectiveDispatchRecord = {
    attemptFingerprint: args.attemptFingerprint,
    executionHostId: args.binding.enrollment.executionHostId,
    watcherId: args.binding.enrollment.watcherId,
    revisionId: args.action.revisionId,
    taskKey: args.action.taskKey,
    dispatchId: null,
    workspaceId: continuation?.workspaceId ?? pendingIdentity,
    workspacePath: continuation?.workspacePath ?? pendingIdentity,
    baseCommit,
    laneTaskKeys: tasks,
    sessionNodeCount: reuseTerminal ? (continuation?.sessionNodeCount ?? 0) + 1 : 1,
    state: priorConflict ? 'resolving-conflict' : 'running',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: priorConflict?.conflictPaths ?? [],
    conflictingTaskKeys: priorConflict?.conflictingTaskKeys ?? [],
    conflictingDispatchIds: priorConflict?.conflictingDispatchIds ?? [],
    createdAtMs: existing?.createdAtMs ?? now,
    completedAtMs: null,
    terminalHandle: reuseTerminal,
    setupState: continuation ? 'ready' : 'pending',
    reportPath: null,
    report: null,
    planTaskDigest:
      existing?.planTaskDigest ?? priorConflict?.planTaskDigest ?? args.planTaskDigest,
    task: args.task
  }
  await args.context.lease.assertHeld()
  args.objectiveStore.saveDispatch(pending)

  if (continuation) {
    const target = priorConflict
      ? await resolveObjectiveDispatchTarget(args.runtime, args.binding, continuation)
      : await resetOwnedLaneWorktree({
          runtime: args.runtime,
          binding: args.binding,
          lease: args.context.lease,
          previous: continuation,
          nextHead: baseCommit
        })
    return {
      record: pending,
      target,
      reuseTerminal
    }
  }

  const marker = dispatchMarker(args.binding.enrollment.watcherId, args.attemptFingerprint)
  await args.context.lease.assertHeld()
  const created = await args.runtime.createManagedWorktree({
    repoSelector: `id:${args.binding.enrollment.repoId}`,
    name: safeDispatchWorktreeName(
      args.binding.enrollment.watcherId,
      args.action.taskKey,
      args.attemptFingerprint
    ),
    baseBranch: baseCommit,
    comment: marker,
    displayName: `Objective: ${args.action.taskKey}`,
    displayNameKind: 'user',
    runHooks: false,
    setupDecision: 'run',
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    activate: false,
    lineage: {
      parentWorktree: `id:${args.binding.enrollment.worktreeId}`,
      callerTerminalHandle: args.binding.enrollment.coordinatorIdentity.handle,
      comment: marker
    }
  })
  await args.context.lease.assertHeld()
  if (created.worktree.git?.head !== baseCommit && created.worktree.head !== baseCommit) {
    await args.runtime.removeManagedWorktree(`id:${created.worktree.id}`, {
      force: true,
      hostId: args.binding.enrollment.executionHostId
    })
    throw new Error('Dispatch worktree did not start at the enrolled branch HEAD')
  }
  const ready: ObjectiveDispatchRecord = {
    ...pending,
    workspaceId: created.worktree.id,
    workspacePath: created.worktree.path,
    setupState: 'ready'
  }
  args.objectiveStore.saveDispatch(ready)
  return {
    record: ready,
    target: await resolveObjectiveDispatchTarget(args.runtime, args.binding, ready),
    reuseTerminal: null
  }
}
export {
  cleanupAppliedObjectiveDispatches,
  purgeObjectiveDispatchWorktrees,
  reconcileObjectiveDispatchWorktrees
} from './dispatch-worktree-lifecycle'
