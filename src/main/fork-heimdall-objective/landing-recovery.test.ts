import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { AttemptEntry } from '../../shared/fork-heimdall/ledger-types'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type {
  CommitLocalBranchAction,
  OpenHostedReviewAction,
  PushRefAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import {
  OBJECTIVE_ABSENT_REMOTE_REF_STATE,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import type { ForgeProvider } from '../source-control/forge-provider'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { ObjectiveDatabase } from './objective-database'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import {
  probeCommittedLocalBranch,
  probeHostedReview,
  probePushedRef,
  resolveLandingOutcome
} from './landing-recovery'
import { createLandingRepositoryFixture, git, gitText } from './objective-git-test-fixtures'
import { cleanupTemporaryDirectories } from './objective-temp-workspace-test-fixtures'
import { ObjectiveStore } from './objective-store'
import { oneRow } from './objective-store-queries'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'

const WATCHER_ID = 'objective-landing-recovery'
const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'recover-landing',
      title: 'Recover landing evidence',
      spec: 'Recover only authoritative effects.',
      deps: [],
      criteria: [
        { body: 'The effect is authoritative.', shellCheckable: false, checkCommand: null }
      ],
      declaresDependencyChange: false,
      declaredPaths: ['src/result.txt']
    }
  ]
}
const temporaryDirectories: string[] = []
const databases: ObjectiveDatabase[] = []

type RecoveryFixture = {
  parent: string
  root: string
  remote: string
  target: ObjectiveWorkspaceTarget
  binding: ObjectiveSnapshotBinding
  store: ObjectiveStore
  database: ObjectiveDatabase
  revisionId: string
}

async function recoveryFixture(): Promise<RecoveryFixture> {
  const { parent, root, remote, target } = await createLandingRepositoryFixture(
    temporaryDirectories,
    {
      tempPrefix: 'quirky-objective-recovery-',
      userName: 'Objective Recovery Test',
      userEmail: 'objective@example.test'
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
  const kindPayload: ObjectiveEnrollmentPayload = {
    objectiveText: 'Recover the objective landing effect.',
    tier: 'standard',
    landingBar: 'hosted-review',
    maxConcurrency: 1,
    workspaceKind: 'git',
    writeTerritory: ['src/**'],
    roleAgents: {},
    sitterOverrides: {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large WatcherEnrollment type; only watcherId and kindPayload are read by the landing recovery probes.
  const binding = {
    enrollment: { watcherId: WATCHER_ID, kindPayload },
    contract: kindPayload,
    target
  } as ObjectiveSnapshotBinding
  return {
    parent,
    root,
    remote,
    target,
    binding,
    database,
    store,
    revisionId: revision.revisionId
  }
}

const noForge = {
  detectProvider: vi.fn(async () => 'unsupported' as const),
  getProvider: vi.fn(async () => null),
  getDefaultBranch: vi.fn(async () => null),
  isAuthenticated: vi.fn(async () => false),
  invalidate: vi.fn()
} satisfies ObjectiveForgeAccess

function lease(assertHeld = vi.fn(async () => undefined), epoch = 23): LeaseGuard {
  return {
    epoch,
    holder: 'test-holder',
    assertHeld,
    renewLoop: () => ({ dispose: () => undefined })
  }
}

async function committedRecoveryFixture() {
  const fixture = await recoveryFixture()
  await writeFile(join(fixture.root, 'src', 'result.txt'), 'committed effect\n')
  const beforeIdentity = await computeWorkspaceContentIdentity(fixture.target)
  const beforeHead = await gitText(fixture.root, ['rev-parse', 'HEAD'])
  const evidenceKey = `commit:${beforeIdentity}`
  const action: CommitLocalBranchAction = {
    kind: 'commit-local-branch',
    capability: 'land',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: beforeIdentity,
    evidenceKey,
    rung: 'committed-local-branch',
    revisionId: fixture.revisionId,
    branch: 'main',
    headSha: beforeHead,
    worktreeContentDigest: await computeObjectiveWorktreeContentDigest(fixture.target),
    fromContentIdentity: beforeIdentity,
    attemptTrailer: evidenceKey
  }
  await git(fixture.root, ['add', 'src/result.txt'])
  await git(fixture.root, [
    'commit',
    '-m',
    `Recoverable commit\n\nQuirky-Heimdall-Attempt: ${evidenceKey}`
  ])
  const postCommitIdentity = await computeWorkspaceContentIdentity(fixture.target)
  return { fixture, action, beforeIdentity, postCommitIdentity }
}

function attempt(
  action: CommitLocalBranchAction | PushRefAction | OpenHostedReviewAction
): AttemptEntry {
  return {
    eventId: `event:${action.evidenceKey}`,
    watcherId: WATCHER_ID,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: `attempt:${action.evidenceKey}`,
    fingerprint: makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey),
    action,
    state: 'running'
  }
}

function hostedReview(
  headSha: string,
  overrides: Partial<HostedReviewInfo> = {}
): HostedReviewInfo {
  return {
    provider: 'github',
    number: 73,
    title: 'Recover landing evidence',
    state: 'open',
    url: 'https://github.test/acme/repo/pull/73',
    status: 'success',
    updatedAt: '2026-09-15T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha,
    ...overrides
  }
}

function forgeReturning(getReview: () => Promise<HostedReviewInfo | null>): ObjectiveForgeAccess {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large ForgeProvider interface; only the methods below are exercised.
  const provider = {
    id: 'github',
    supportsReviewCreation: true,
    resolveRepository: vi.fn(async () => ({ owner: 'acme', name: 'repo' })),
    getReviewForBranch: getReview,
    getReviewByNumber: vi.fn(async () => null),
    createReview: vi.fn()
  } as unknown as ForgeProvider
  return {
    detectProvider: vi.fn(async () => 'github' as const),
    getProvider: vi.fn(async () => provider),
    getDefaultBranch: vi.fn(async () => 'main'),
    isAuthenticated: vi.fn(async () => true),
    invalidate: vi.fn()
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('landing recovery probes', () => {
  it('recovers a committed HEAD by its exact trailer and backfills the missing rung row', async () => {
    const { fixture, action, beforeIdentity, postCommitIdentity } = await committedRecoveryFixture()
    expect(fixture.store.hasLanding(WATCHER_ID, 'committed-local-branch', postCommitIdentity)).toBe(
      false
    )
    const recoveryLease = lease()

    await expect(
      probeCommittedLocalBranch({
        action,
        attempt: attempt(action),
        binding: fixture.binding,
        lease: recoveryLease,
        objectiveStore: fixture.store,
        forge: noForge
      })
    ).resolves.toBe('landed')
    expect(
      fixture.store.landingRow(WATCHER_ID, 'committed-local-branch', postCommitIdentity)
    ).toMatchObject({
      revisionId: fixture.revisionId,
      fromContentIdentity: beforeIdentity,
      commitSha: await gitText(fixture.root, ['rev-parse', 'HEAD']),
      branch: 'main'
    })
    const persisted = oneRow<{ epoch: number }>(
      fixture.database
        .connection()
        .prepare(
          'SELECT epoch FROM landing_evidence WHERE watcher_id = ? AND rung = ? AND content_identity = ?'
        ),
      WATCHER_ID,
      'committed-local-branch',
      postCommitIdentity
    )
    expect(persisted?.epoch).toBe(recoveryLease.epoch)
  })

  it.each([
    ['outside territory', 'outside.txt'],
    ['inside territory', 'src/result.txt']
  ] as const)(
    'recognizes the exact commit after an %s edit without attributing the changed worktree',
    async (_label, editedPath) => {
      const { fixture, action } = await committedRecoveryFixture()
      await writeFile(join(fixture.root, editedPath), 'changed after the commit\n')
      const changedIdentity = await computeWorkspaceContentIdentity(fixture.target)

      await expect(
        probeCommittedLocalBranch({
          action,
          attempt: attempt(action),
          binding: fixture.binding,
          lease: lease(),
          objectiveStore: fixture.store,
          forge: noForge
        })
      ).resolves.toBe('landed')
      expect(fixture.store.hasLanding(WATCHER_ID, 'committed-local-branch', changedIdentity)).toBe(
        false
      )
      expect(fixture.store.project(WATCHER_ID).landing).toEqual([])
    }
  )

  it('does not claim an unchanged HEAD whose message lacks the attempt trailer', async () => {
    const fixture = await recoveryFixture()
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const headSha = await gitText(fixture.root, ['rev-parse', 'HEAD'])
    const action: CommitLocalBranchAction = {
      kind: 'commit-local-branch',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity,
      evidenceKey: `commit:${contentIdentity}`,
      rung: 'committed-local-branch',
      revisionId: fixture.revisionId,
      branch: 'main',
      headSha,
      worktreeContentDigest: await computeObjectiveWorktreeContentDigest(fixture.target),
      fromContentIdentity: contentIdentity,
      attemptTrailer: `commit:${contentIdentity}`
    }

    await expect(
      probeCommittedLocalBranch({
        action,
        attempt: attempt(action),
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge: noForge
      })
    ).resolves.toBe('not-landed')
  })

  it('distinguishes absent, landed, and independently moved remote refs and recovers the row', async () => {
    const fixture = await recoveryFixture()
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const commitSha = await gitText(fixture.root, ['rev-parse', 'HEAD'])
    const action: PushRefAction = {
      kind: 'push-ref',
      capability: 'land',
      visibility: 'external',
      contentIdentity,
      evidenceKey: `push:${contentIdentity}`,
      rung: 'pushed-ref',
      revisionId: fixture.revisionId,
      branch: 'main',
      remote: 'origin',
      commitSha,
      expectedState: {
        target: 'origin:refs/heads/main',
        before: OBJECTIVE_ABSENT_REMOTE_REF_STATE
      }
    }
    const unresolvedAttempt = attempt(action)

    await expect(
      probePushedRef({
        action,
        attempt: unresolvedAttempt,
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge: noForge
      })
    ).resolves.toBe('not-landed')

    await git(fixture.root, ['push', 'origin', 'main'])
    await expect(
      resolveLandingOutcome({
        action,
        attempt: unresolvedAttempt,
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge: noForge
      })
    ).resolves.toBe('landed')
    expect(fixture.store.landingRow(WATCHER_ID, 'pushed-ref', contentIdentity)).toMatchObject({
      revisionId: fixture.revisionId,
      remote: 'origin',
      branch: 'main',
      commitSha,
      remoteSha: commitSha
    })

    await writeFile(join(fixture.root, 'src', 'result.txt'), 'independent move\n')
    await git(fixture.root, ['add', 'src/result.txt'])
    await git(fixture.root, ['commit', '-m', 'independent move'])
    const movedSha = await gitText(fixture.root, ['rev-parse', 'HEAD'])
    await git(fixture.root, ['push', 'origin', 'main'])
    expect(movedSha).not.toBe(commitSha)
    await expect(
      probePushedRef({
        action,
        attempt: unresolvedAttempt,
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge: noForge
      })
    ).resolves.toBe('indeterminate')
  })

  it('requires an open or draft review at the exact head before recording recovery', async () => {
    const fixture = await recoveryFixture()
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const headSha = await gitText(fixture.root, ['rev-parse', 'HEAD'])
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
    const unresolvedAttempt = attempt(action)
    let observed: HostedReviewInfo | null = null
    const forge = forgeReturning(async () => observed)

    await expect(
      probeHostedReview({
        action,
        attempt: unresolvedAttempt,
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge
      })
    ).resolves.toBe('not-landed')
    for (const state of ['closed', 'merged'] as const) {
      observed = hostedReview(headSha, { state })
      await expect(
        probeHostedReview({
          action,
          attempt: unresolvedAttempt,
          binding: fixture.binding,
          objectiveStore: fixture.store,
          lease: lease(),
          forge
        })
      ).resolves.toBe('not-landed')
      expect(fixture.store.hasLanding(WATCHER_ID, 'hosted-review', contentIdentity)).toBe(false)
    }
    observed = hostedReview('f'.repeat(40))
    await expect(
      probeHostedReview({
        action,
        attempt: unresolvedAttempt,
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge
      })
    ).resolves.toBe('indeterminate')
    observed = hostedReview(headSha, { state: 'draft' })
    await expect(
      probeHostedReview({
        action,
        attempt: unresolvedAttempt,
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge
      })
    ).resolves.toBe('landed')
    expect(fixture.store.landingRow(WATCHER_ID, 'hosted-review', contentIdentity)).toMatchObject({
      provider: 'github',
      reviewNumber: 73,
      reviewUrl: 'https://github.test/acme/repo/pull/73',
      branch: 'main',
      headSha,
      base: 'trunk'
    })
  })

  it('turns an unavailable recovery authority into indeterminate certainty', async () => {
    const fixture = await recoveryFixture()
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const headSha = await gitText(fixture.root, ['rev-parse', 'HEAD'])
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

    await expect(
      resolveLandingOutcome({
        action,
        attempt: attempt(action),
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(),
        forge: forgeReturning(async () => {
          throw new Error('forge unavailable')
        })
      })
    ).resolves.toBe('indeterminate')
    expect(fixture.store.hasLanding(WATCHER_ID, 'hosted-review', contentIdentity)).toBe(false)
  })

  it('does not persist a recovered effect after the lease is lost', async () => {
    const fixture = await recoveryFixture()
    const contentIdentity = await computeWorkspaceContentIdentity(fixture.target)
    const headSha = await gitText(fixture.root, ['rev-parse', 'HEAD'])
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
    const getReview = vi.fn(async () => hostedReview(headSha))
    const assertHeld = vi.fn(async () => {
      throw new Error('lease lost after probe')
    })

    await expect(
      resolveLandingOutcome({
        action,
        attempt: attempt(action),
        binding: fixture.binding,
        objectiveStore: fixture.store,
        lease: lease(assertHeld, 31),
        forge: forgeReturning(getReview)
      })
    ).resolves.toBe('indeterminate')
    expect(getReview).toHaveBeenCalledOnce()
    expect(assertHeld).toHaveBeenCalledOnce()
    expect(getReview.mock.invocationCallOrder[0]!).toBeLessThan(
      assertHeld.mock.invocationCallOrder[0]!
    )
    expect(fixture.store.hasLanding(WATCHER_ID, 'hosted-review', contentIdentity)).toBe(false)
  })
})
