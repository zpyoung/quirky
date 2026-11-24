import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  CommitLocalBranchAction,
  OpenHostedReviewAction,
  PushRefAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import {
  OBJECTIVE_ABSENT_REMOTE_REF_STATE,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { objectiveBarReachedPredicate } from '../../shared/fork-heimdall-objective/stop-policy'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import type { ForgeProvider } from '../source-control/forge-provider'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { ObjectiveDatabase } from './objective-database'
import type { ObjectiveSnapshotBinding } from './execution-context'
import {
  executeCommitLocalBranch,
  executeOpenHostedReview,
  executePushRef
} from './landing-action-executor'
import { createLandingRepositoryFixture, git, gitText } from './objective-git-test-fixtures'
import { cleanupTemporaryDirectories } from './objective-temp-workspace-test-fixtures'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import { objectiveRemoteRefState } from './landing-git-state'
import { ObjectiveStore } from './objective-store'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'

const WATCHER_ID = 'objective-landing-executor'
const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'land-change',
      title: 'Land the change',
      spec: 'Land the tested change.',
      deps: [],
      criteria: [{ body: 'The change is landed.', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false,
      declaredPaths: ['src/result.txt']
    }
  ]
}
const temporaryDirectories: string[] = []
const databases: ObjectiveDatabase[] = []

type RepositoryFixture = {
  parent: string
  root: string
  remote: string
  target: ObjectiveWorkspaceTarget
  store: ObjectiveStore
  revisionId: string
}

async function repositoryFixture(): Promise<RepositoryFixture> {
  const { parent, root, remote, target } = await createLandingRepositoryFixture(
    temporaryDirectories,
    {
      tempPrefix: 'quirky-objective-landing-',
      userName: 'Objective Landing Test',
      userEmail: 'objective@example.test',
      extraFiles: { 'outside.txt': 'outside initial\n' }
    }
  )
  const database = new ObjectiveDatabase(':memory:')
  databases.push(database)
  const store = new ObjectiveStore(database)
  const revision = store.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 1,
    dispatchId: 'planner-dispatch',
    report: PLAN,
    digest: 'plan-digest',
    createdAtMs: 1
  })
  return { parent, root, remote, target, store, revisionId: revision.revisionId }
}

function contract(
  landingBar: ObjectiveEnrollmentPayload['landingBar']
): ObjectiveEnrollmentPayload {
  return {
    objectiveText: 'Land the objective change safely.\nAdditional detail.',
    tier: 'standard',
    landingBar,
    maxConcurrency: 1,
    workspaceKind: 'git',
    writeTerritory: ['src/**'],
    roleAgents: {},
    sitterOverrides: {}
  }
}

function binding(
  fixture: RepositoryFixture,
  landingBar: ObjectiveEnrollmentPayload['landingBar']
): ObjectiveSnapshotBinding {
  const kindPayload = contract(landingBar)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large WatcherEnrollment type; only watcherId and kindPayload are read by the landing action executors.
  return {
    enrollment: { watcherId: WATCHER_ID, kindPayload },
    contract: kindPayload,
    target: fixture.target
  } as ObjectiveSnapshotBinding
}

function context(
  fixture: RepositoryFixture,
  contentIdentity: string,
  landingBar: ObjectiveEnrollmentPayload['landingBar']
): ExecuteContext<ObjectiveWorld> {
  const kindPayload = contract(landingBar)
  return {
    snapshot: {
      freshness: 'live',
      contentIdentity,
      observedAtMs: 10,
      world: {
        contract: kindPayload,
        workspaceKind: 'git',
        plan: fixture.store.project(WATCHER_ID),
        reports: [],
        budget: { wallClockActiveMs: 60_000, turns: 12 },
        landingContext: {
          branch: 'main',
          headSha: null,
          worktreeContentDigest: null,
          pushTarget: null,
          hostedReview: null
        }
      }
    },
    ledger: { watcherId: WATCHER_ID, entries: [] },
    lease: {
      holder: 'test-holder',
      epoch: 7,
      assertHeld: vi.fn(async () => undefined),
      renewLoop: () => ({ dispose: () => undefined })
    },
    dispatchWorker: vi.fn()
  }
}

const noForge = {
  detectProvider: vi.fn(async () => 'unsupported' as const),
  getProvider: vi.fn(async () => null),
  getDefaultBranch: vi.fn(async () => null),
  isAuthenticated: vi.fn(async () => false),
  invalidate: vi.fn()
} satisfies ObjectiveForgeAccess

async function commitAction(
  fixture: RepositoryFixture,
  contentIdentity: string
): Promise<CommitLocalBranchAction> {
  const evidenceKey = `commit:${contentIdentity}`
  return {
    kind: 'commit-local-branch',
    capability: 'land',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity,
    evidenceKey,
    rung: 'committed-local-branch',
    revisionId: fixture.revisionId,
    branch: 'main',
    headSha: await gitText(fixture.root, ['rev-parse', 'HEAD']),
    worktreeContentDigest: await computeObjectiveWorktreeContentDigest(fixture.target),
    fromContentIdentity: contentIdentity,
    attemptTrailer: evidenceKey
  }
}

async function pushAction(
  fixture: RepositoryFixture,
  contentIdentity: string,
  before: string
): Promise<PushRefAction> {
  const beforeState = objectiveRemoteRefState(before)
  return {
    kind: 'push-ref',
    capability: 'land',
    visibility: 'external',
    contentIdentity,
    evidenceKey: `push:${contentIdentity}:${beforeState}`,
    rung: 'pushed-ref',
    revisionId: fixture.revisionId,
    branch: 'main',
    remote: 'origin',
    commitSha: await gitText(fixture.root, ['rev-parse', 'HEAD']),
    expectedState: { target: 'origin:refs/heads/main', before: beforeState }
  }
}

async function preparePushRace(): Promise<{
  fixture: RepositoryFixture
  expectedBefore: string
  remoteMove: string
  contentIdentity: string
}> {
  const fixture = await repositoryFixture()
  await git(fixture.root, ['push', 'origin', 'main'])
  const expectedBefore = await gitText(fixture.root, ['rev-parse', 'HEAD'])
  const producer = join(fixture.parent, 'producer')
  await git(fixture.parent, ['clone', '--branch', 'main', fixture.remote, producer])
  await git(producer, ['config', 'user.name', 'Remote Mover'])
  await git(producer, ['config', 'user.email', 'mover@example.test'])
  await writeFile(join(producer, 'remote.txt'), 'remote move\n')
  await git(producer, ['add', 'remote.txt'])
  await git(producer, ['commit', '-m', 'move remote'])
  const remoteMove = await gitText(producer, ['rev-parse', 'HEAD'])
  await git(producer, ['push', 'origin', 'HEAD:refs/heads/race-object'])
  await writeFile(join(fixture.root, 'src', 'result.txt'), 'local move\n')
  await git(fixture.root, ['add', 'src/result.txt'])
  await git(fixture.root, ['commit', '-m', 'local move'])
  const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
  return { fixture, expectedBefore, remoteMove, contentIdentity }
}

function reviewInfo(headSha: string, overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 42,
    title: 'Land the objective',
    state: 'open',
    url: 'https://github.test/acme/repo/pull/42',
    status: 'success',
    updatedAt: '2026-09-15T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha,
    ...overrides
  }
}

function reviewForge(args: {
  reviews: (HostedReviewInfo | null)[]
  authenticated?: boolean
  createResult?: unknown
  createError?: Error
}) {
  const getReview = vi.fn(async () => args.reviews.shift() ?? null)
  const createReview = vi.fn(async () => {
    if (args.createError) {
      throw args.createError
    }
    return (
      args.createResult ?? { ok: true, number: 42, url: 'https://github.test/acme/repo/pull/42' }
    )
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large ForgeProvider interface; only the methods below are exercised.
  const provider = {
    id: 'github',
    supportsReviewCreation: true,
    resolveRepository: vi.fn(async () => ({ owner: 'acme', name: 'repo' })),
    getReviewForBranch: getReview,
    getReviewByNumber: vi.fn(async () => null),
    createReview
  } as unknown as ForgeProvider
  const invalidate = vi.fn()
  return {
    getReview,
    createReview,
    invalidate,
    forge: {
      detectProvider: vi.fn(async () => 'github' as const),
      getProvider: vi.fn(async () => provider),
      getDefaultBranch: vi.fn(async () => 'main'),
      isAuthenticated: vi.fn(async () => args.authenticated ?? true),
      invalidate
    }
  }
}

async function reviewExecutionFixture(fixture: RepositoryFixture) {
  const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
  const headSha = await gitText(fixture.root, ['rev-parse', 'HEAD'])
  fixture.store.recordLanding({
    watcherId: WATCHER_ID,
    rung: 'pushed-ref',
    contentIdentity,
    attemptFingerprint: 'prior-push-attempt',
    payload: {
      revisionId: fixture.revisionId,
      fromContentIdentity: contentIdentity,
      remote: 'origin',
      branch: 'main',
      commitSha: headSha,
      remoteSha: headSha
    },
    epoch: 1,
    createdAtMs: 2
  })
  const action: OpenHostedReviewAction = {
    kind: 'open-hosted-review',
    capability: 'land',
    visibility: 'external',
    contentIdentity,
    evidenceKey: `review:${contentIdentity}`,
    rung: 'hosted-review',
    revisionId: fixture.revisionId,
    branch: 'main',
    base: 'trunk',
    headSha,
    provider: 'github',
    expectedState: { target: 'github:main', before: 'no-review' }
  }
  return { action, headSha, contentIdentity }
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('landing action executor Git effects', () => {
  it('commits only territory paths, preserves outside staging, and records post-commit identity', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'landed\n')
    await writeFile(join(fixture.root, 'outside.txt'), 'outside staged\n')
    await git(fixture.root, ['add', '--', 'outside.txt'])
    const beforeIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const action = await commitAction(fixture, beforeIdentity)

    const outcome = await executeCommitLocalBranch({
      action,
      binding: binding(fixture, 'committed-local-branch'),
      context: context(fixture, beforeIdentity, 'committed-local-branch'),
      objectiveStore: fixture.store,
      forge: noForge
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      result: { kind: 'commit-recorded', outsideTerritoryPaths: ['outside.txt'] }
    })
    const committedNames = (
      await gitText(fixture.root, ['show', '--format=', '--name-only', 'HEAD'])
    )
      .split('\n')
      .filter(Boolean)
    expect(committedNames).toEqual(['src/result.txt'])
    expect(await gitText(fixture.root, ['diff', '--cached', '--name-only'])).toBe('outside.txt')
    expect(await gitText(fixture.root, ['log', '-1', '--format=%B'])).toContain(
      `Quirky-Heimdall-Attempt: ${action.evidenceKey}`
    )
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    expect(contentIdentity).not.toBe(beforeIdentity)
    expect(
      fixture.store.landingRow(WATCHER_ID, 'committed-local-branch', contentIdentity)
    ).toMatchObject({
      revisionId: fixture.revisionId,
      fromContentIdentity: beforeIdentity,
      commitSha: await gitText(fixture.root, ['rev-parse', 'HEAD']),
      branch: 'main'
    })
    expect(await readFile(join(fixture.root, 'outside.txt'), 'utf8')).toBe('outside staged\n')
  })

  it('reports nothing to commit when only an outside-territory path is dirty', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.root, 'outside.txt'), 'outside only\n')
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)

    await expect(
      executeCommitLocalBranch({
        action: await commitAction(fixture, contentIdentity),
        binding: binding(fixture, 'committed-local-branch'),
        context: context(fixture, contentIdentity, 'committed-local-branch'),
        objectiveStore: fixture.store,
        forge: noForge
      })
    ).resolves.toMatchObject({ effect: 'not-landed', reason: 'nothing-to-commit' })
    expect(await gitText(fixture.root, ['status', '--short'])).toContain('outside.txt')
  })

  it('refuses a detached HEAD without creating a commit', async () => {
    const fixture = await repositoryFixture()
    const originalHead = await gitText(fixture.root, ['rev-parse', 'HEAD'])
    await git(fixture.root, ['switch', '--detach'])
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'detached change\n')
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)

    await expect(
      executeCommitLocalBranch({
        action: { ...(await commitAction(fixture, contentIdentity)), branch: 'main' },
        binding: binding(fixture, 'committed-local-branch'),
        context: context(fixture, contentIdentity, 'committed-local-branch'),
        objectiveStore: fixture.store,
        forge: noForge
      })
    ).resolves.toEqual({ effect: 'not-landed', reason: 'branch-not-attached' })
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(originalHead)
  })

  it('runs commit hooks and returns their stderr without recording a landing', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'hooked change\n')
    const hook = join(fixture.root, '.git', 'hooks', 'pre-commit')
    await writeFile(
      hook,
      '#!/bin/sh\necho "pre-commit hook failed: policy denied this commit" >&2\nexit 17\n'
    )
    await chmod(hook, 0o755)
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const originalHead = await gitText(fixture.root, ['rev-parse', 'HEAD'])

    const outcome = await executeCommitLocalBranch({
      action: await commitAction(fixture, contentIdentity),
      binding: binding(fixture, 'committed-local-branch'),
      context: context(fixture, contentIdentity, 'committed-local-branch'),
      objectiveStore: fixture.store,
      forge: noForge
    })

    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'commit-hook-failed',
      result: { stderr: expect.stringContaining('policy denied this commit') }
    })
    expect(fixture.store.project(WATCHER_ID).landing).toEqual([])
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(originalHead)
  })

  it('recovers a commit that landed before the commit command reported failure', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'landed before transport failure\n')
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const action = await commitAction(fixture, contentIdentity)
    const hook = join(fixture.root, '.git', 'hooks', 'pre-commit')
    const title = 'Land the objective change safely.'
    const trailer = `Quirky-Heimdall-Attempt: ${action.attemptTrailer}`
    await writeFile(
      hook,
      `#!/bin/sh\nset -e\ntree="$(git write-tree)"\nparent="$(git rev-parse HEAD)"\ncommit="$(git commit-tree "$tree" -p "$parent" -m ${JSON.stringify(title)} -m ${JSON.stringify(trailer)})"\ngit update-ref HEAD "$commit" "$parent"\necho "transport closed after commit" >&2\nexit 17\n`
    )
    await chmod(hook, 0o755)

    const outcome = await executeCommitLocalBranch({
      action,
      binding: binding(fixture, 'committed-local-branch'),
      context: context(fixture, contentIdentity, 'committed-local-branch'),
      objectiveStore: fixture.store,
      forge: noForge
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { kind: 'commit-recorded' } })
    expect(await gitText(fixture.root, ['log', '-1', '--format=%B'])).toContain(trailer)
    expect(fixture.store.project(WATCHER_ID).landing).toHaveLength(1)
  })

  it('does not turn an unattributed commit into same-tick terminal proof', async () => {
    const fixture = await repositoryFixture()
    fixture.store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: fixture.revisionId,
      digest: 'plan-digest',
      approvedAtMs: 2
    })
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'committed content\n')
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const action = await commitAction(fixture, contentIdentity)
    const hook = join(fixture.root, '.git', 'hooks', 'post-commit')
    await writeFile(hook, '#!/bin/sh\necho "changed after commit" > outside.txt\n')
    await chmod(hook, 0o755)
    const executionContext = context(fixture, contentIdentity, 'committed-local-branch')

    const outcome = await executeCommitLocalBranch({
      action,
      binding: binding(fixture, 'committed-local-branch'),
      context: executionContext,
      objectiveStore: fixture.store,
      forge: noForge
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      result: {
        kind: 'commit-attribution-skipped',
        reason: 'worktree-content-changed',
        outsideTerritoryPaths: ['outside.txt']
      }
    })
    expect(fixture.store.project(WATCHER_ID).landing).toEqual([])
    const ledger: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          eventId: 'unattributed-commit-event',
          watcherId: WATCHER_ID,
          atMs: 3,
          origin: 'owner',
          class: 'fact',
          kind: 'attempt',
          attemptId: 'unattributed-commit-attempt',
          fingerprint: makeAttemptFingerprint(
            action.contentIdentity,
            action.kind,
            action.evidenceKey
          ),
          action,
          state: 'settled',
          effect: 'landed',
          result: outcome.result
        }
      ]
    }
    expect(objectiveBarReachedPredicate.evaluate(executionContext.snapshot, ledger)).toEqual({
      stop: false
    })
  })

  it('keeps a failed commit indeterminate when its authoritative probe is unavailable', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'unprobeable commit\n')
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const action = await commitAction(fixture, contentIdentity)
    const hook = join(fixture.root, '.git', 'hooks', 'pre-commit')
    await writeFile(
      hook,
      '#!/bin/sh\nmv .git .git-unavailable\necho "transport and repository unavailable" >&2\nexit 17\n'
    )
    await chmod(hook, 0o755)

    await expect(
      executeCommitLocalBranch({
        action,
        binding: binding(fixture, 'committed-local-branch'),
        context: context(fixture, contentIdentity, 'committed-local-branch'),
        objectiveStore: fixture.store,
        forge: noForge
      })
    ).resolves.toMatchObject({ effect: 'indeterminate' })
    expect(fixture.store.project(WATCHER_ID).landing).toEqual([])
  })

  it('publishes an unborn remote branch and verifies the authoritative remote ref', async () => {
    const fixture = await repositoryFixture()
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const action = await pushAction(fixture, contentIdentity, '')

    const outcome = await executePushRef({
      action,
      binding: binding(fixture, 'pushed-ref'),
      context: context(fixture, contentIdentity, 'pushed-ref'),
      objectiveStore: fixture.store,
      forge: noForge
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      expectedBefore: OBJECTIVE_ABSENT_REMOTE_REF_STATE,
      expectedAfter: action.commitSha,
      result: { kind: 'push-recorded', remoteSha: action.commitSha }
    })
    expect(
      await gitText(fixture.root, ['ls-remote', '--heads', 'origin', 'refs/heads/main'])
    ).toContain(action.commitSha)
    expect(fixture.store.landingRow(WATCHER_ID, 'pushed-ref', contentIdentity)).toMatchObject({
      remote: 'origin',
      branch: 'main',
      commitSha: action.commitSha,
      remoteSha: action.commitSha
    })
  })

  it('does not overwrite a remote ref that moves after inspection', async () => {
    const { fixture, expectedBefore, remoteMove, contentIdentity } = await preparePushRace()
    const hook = join(fixture.root, '.git', 'hooks', 'pre-push')
    await writeFile(
      hook,
      `#!/bin/sh\ngit --git-dir=${JSON.stringify(fixture.remote)} update-ref refs/heads/main ${remoteMove}\n`
    )
    await chmod(hook, 0o755)

    await expect(
      executePushRef({
        action: await pushAction(fixture, contentIdentity, expectedBefore),
        binding: binding(fixture, 'pushed-ref'),
        context: context(fixture, contentIdentity, 'pushed-ref'),
        objectiveStore: fixture.store,
        forge: noForge
      })
    ).resolves.toMatchObject({ effect: 'not-landed', reason: 'remote-moved' })
    expect(
      await gitText(fixture.root, ['ls-remote', '--heads', 'origin', 'refs/heads/main'])
    ).toContain(remoteMove)
  })

  it('keeps a generic push failure indeterminate when the remote moved to a third ref', async () => {
    const { fixture, expectedBefore, remoteMove, contentIdentity } = await preparePushRace()
    const hook = join(fixture.root, '.git', 'hooks', 'pre-push')
    await writeFile(
      hook,
      `#!/bin/sh\ngit --git-dir=${JSON.stringify(fixture.remote)} update-ref refs/heads/main ${remoteMove}\necho "transport closed after push; stale info unavailable" >&2\nexit 17\n`
    )
    await chmod(hook, 0o755)

    await expect(
      executePushRef({
        action: await pushAction(fixture, contentIdentity, expectedBefore),
        binding: binding(fixture, 'pushed-ref'),
        context: context(fixture, contentIdentity, 'pushed-ref'),
        objectiveStore: fixture.store,
        forge: noForge
      })
    ).resolves.toMatchObject({ effect: 'indeterminate', reason: 'push-state-indeterminate' })
  })

  it('accepts a ref that landed even when the dispatching push reports failure', async () => {
    const fixture = await repositoryFixture()
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const action = await pushAction(fixture, contentIdentity, '')
    const hook = join(fixture.root, '.git', 'hooks', 'pre-push')
    await writeFile(
      hook,
      `#!/bin/sh\ngit push --no-verify origin ${action.commitSha}:refs/heads/main >/dev/null 2>&1\necho "transport result lost" >&2\nexit 1\n`
    )
    await chmod(hook, 0o755)

    await expect(
      executePushRef({
        action,
        binding: binding(fixture, 'pushed-ref'),
        context: context(fixture, contentIdentity, 'pushed-ref'),
        objectiveStore: fixture.store,
        forge: noForge
      })
    ).resolves.toMatchObject({ effect: 'landed', expectedAfter: action.commitSha })
    expect(
      await gitText(fixture.root, ['ls-remote', '--heads', 'origin', 'refs/heads/main'])
    ).toContain(action.commitSha)
  })
})

describe('landing action executor hosted reviews', () => {
  it('reuses an open review at the exact head without creating or invalidating', async () => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({ reviews: [reviewInfo(prepared.headSha)] })

    await expect(
      executeOpenHostedReview({
        action: prepared.action,
        binding: binding(fixture, 'hosted-review'),
        context: context(fixture, prepared.contentIdentity, 'hosted-review'),
        objectiveStore: fixture.store,
        forge: fake.forge
      })
    ).resolves.toMatchObject({ effect: 'landed', result: { reviewNumber: 42 } })
    expect(fake.createReview).not.toHaveBeenCalled()
    expect(fake.invalidate).not.toHaveBeenCalled()
  })

  it.each([
    ['closed review at a different head', 'closed', false],
    ['merged review', 'merged', false],
    ['closed review at the requested head', 'closed', true]
  ] as const)('creates a new review when it finds a %s', async (_label, state, sameHead) => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const existingHead = sameHead ? prepared.headSha : 'f'.repeat(40)
    const fake = reviewForge({
      reviews: [reviewInfo(existingHead, { state }), reviewInfo(prepared.headSha)]
    })

    const outcome = await executeOpenHostedReview({
      action: prepared.action,
      binding: binding(fixture, 'hosted-review'),
      context: context(fixture, prepared.contentIdentity, 'hosted-review'),
      objectiveStore: fixture.store,
      forge: fake.forge
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { reviewNumber: 42 } })
    expect(fake.createReview).toHaveBeenCalledOnce()
  })

  it.each([
    ['created', { ok: true, number: 42, url: 'https://github.test/acme/repo/pull/42' }],
    [
      'already exists',
      {
        ok: false,
        code: 'already_exists',
        error: 'A review already exists.',
        existingReview: { number: 42, url: 'https://github.test/acme/repo/pull/42' }
      }
    ]
  ] as const)('verifies and records a review that was %s', async (_label, createResult) => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({ reviews: [null, reviewInfo(prepared.headSha)], createResult })

    const outcome = await executeOpenHostedReview({
      action: prepared.action,
      binding: binding(fixture, 'hosted-review'),
      context: context(fixture, prepared.contentIdentity, 'hosted-review'),
      objectiveStore: fixture.store,
      forge: fake.forge
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { reviewNumber: 42 } })
    expect(fake.invalidate).toHaveBeenCalledOnce()
    expect(
      fixture.store.landingRow(WATCHER_ID, 'hosted-review', prepared.contentIdentity)
    ).toMatchObject({
      provider: 'github',
      reviewNumber: 42,
      reviewUrl: 'https://github.test/acme/repo/pull/42',
      headSha: prepared.headSha,
      base: 'trunk'
    })
  })

  it('refuses creation when the provider is not authenticated', async () => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({ reviews: [null], authenticated: false })

    await expect(
      executeOpenHostedReview({
        action: prepared.action,
        binding: binding(fixture, 'hosted-review'),
        context: context(fixture, prepared.contentIdentity, 'hosted-review'),
        objectiveStore: fixture.store,
        forge: fake.forge
      })
    ).resolves.toEqual({ effect: 'not-landed', reason: 'auth_required' })
    expect(fake.createReview).not.toHaveBeenCalled()
    expect(fake.invalidate).not.toHaveBeenCalled()
  })

  it('invalidates and confirms absence before accepting an auth-required create result', async () => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({
      reviews: [null, null],
      createResult: { ok: false, code: 'auth_required', error: 'Sign in to the forge.' }
    })

    await expect(
      executeOpenHostedReview({
        action: prepared.action,
        binding: binding(fixture, 'hosted-review'),
        context: context(fixture, prepared.contentIdentity, 'hosted-review'),
        objectiveStore: fixture.store,
        forge: fake.forge
      })
    ).resolves.toMatchObject({ effect: 'not-landed', reason: 'auth_required' })
    expect(fake.invalidate).toHaveBeenCalledOnce()
    expect(fixture.store.hasLanding(WATCHER_ID, 'hosted-review', prepared.contentIdentity)).toBe(
      false
    )
  })

  it('classifies a thrown create call as indeterminate without recording evidence', async () => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({ reviews: [null], createError: new Error('forge transport failed') })

    await expect(
      executeOpenHostedReview({
        action: prepared.action,
        binding: binding(fixture, 'hosted-review'),
        context: context(fixture, prepared.contentIdentity, 'hosted-review'),
        objectiveStore: fixture.store,
        forge: fake.forge
      })
    ).resolves.toMatchObject({ effect: 'indeterminate' })
    expect(fake.invalidate).toHaveBeenCalledOnce()
    expect(fixture.store.hasLanding(WATCHER_ID, 'hosted-review', prepared.contentIdentity)).toBe(
      false
    )
  })

  it('does not treat a review at a different head as the requested effect', async () => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({ reviews: [reviewInfo('f'.repeat(40))] })

    await expect(
      executeOpenHostedReview({
        action: prepared.action,
        binding: binding(fixture, 'hosted-review'),
        context: context(fixture, prepared.contentIdentity, 'hosted-review'),
        objectiveStore: fixture.store,
        forge: fake.forge
      })
    ).resolves.toEqual({ effect: 'indeterminate', reason: 'hosted-review-state-moved' })
    expect(fake.createReview).not.toHaveBeenCalled()
  })

  it('keeps a draft review at a different head indeterminate', async () => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({ reviews: [reviewInfo('f'.repeat(40), { state: 'draft' })] })

    await expect(
      executeOpenHostedReview({
        action: prepared.action,
        binding: binding(fixture, 'hosted-review'),
        context: context(fixture, prepared.contentIdentity, 'hosted-review'),
        objectiveStore: fixture.store,
        forge: fake.forge
      })
    ).resolves.toEqual({ effect: 'indeterminate', reason: 'hosted-review-state-moved' })
    expect(fake.createReview).not.toHaveBeenCalled()
  })

  it('does not verify a successful create with a closed review', async () => {
    const fixture = await repositoryFixture()
    const prepared = await reviewExecutionFixture(fixture)
    const fake = reviewForge({
      reviews: [null, reviewInfo(prepared.headSha, { state: 'closed' })],
      createResult: {
        ok: true,
        number: 42,
        url: 'https://github.test/acme/repo/pull/42'
      }
    })

    await expect(
      executeOpenHostedReview({
        action: prepared.action,
        binding: binding(fixture, 'hosted-review'),
        context: context(fixture, prepared.contentIdentity, 'hosted-review'),
        objectiveStore: fixture.store,
        forge: fake.forge
      })
    ).resolves.toMatchObject({
      effect: 'indeterminate',
      reason: 'hosted-review-create-unverifiable'
    })
    expect(fake.createReview).toHaveBeenCalledOnce()
    expect(fixture.store.hasLanding(WATCHER_ID, 'hosted-review', prepared.contentIdentity)).toBe(
      false
    )
  })
})
