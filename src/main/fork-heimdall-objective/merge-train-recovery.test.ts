import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { createObjectiveNodeCommit, recoverObjectiveNodeApply } from './merge-train-git'
import { cleanupTemporaryDirectories } from './objective-temp-workspace-test-fixtures'
import {
  commitAll,
  createMergeTrainRepositoryFixture,
  git,
  gitText
} from './objective-git-test-fixtures'

vi.mock('./check-runner', () => ({ runCriterionCheck: vi.fn() }))

const temporaryDirectories: string[] = []
const leaseGuard: LeaseGuard = {
  epoch: 1,
  holder: 'merge-train-recovery-test',
  assertHeld: vi.fn(async () => {}),
  renewLoop: () => ({ dispose() {} })
}

type RepositoryFixture = {
  source: string
  enrolled: string
  sourceTarget: ObjectiveWorkspaceTarget
  enrolledTarget: ObjectiveWorkspaceTarget
  baseCommit: string
}

async function repositoryFixture(): Promise<RepositoryFixture> {
  return createMergeTrainRepositoryFixture(temporaryDirectories, {
    tempPrefix: 'quirky-objective-recovery-',
    repoId: 'merge-train-recovery-test-repo',
    userName: 'Merge Train Recovery Test',
    userEmail: 'merge-train-recovery@example.test'
  })
}

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('objective merge train recovery', () => {
  it('finds the actual rewritten commit behind later clean operator commits', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'node.txt'), 'node result\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'recover-node',
        title: 'Recover node',
        reportedPaths: []
      },
      leaseGuard
    )
    await writeFile(join(fixture.enrolled, 'prior.txt'), 'prior train node\n')
    await commitAll(fixture.enrolled, 'prior train node')
    await git(fixture.enrolled, ['cherry-pick', '--keep-redundant-commits', normalized.commitSha])
    const integratedHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    expect(integratedHead).not.toBe(normalized.commitSha)
    await writeFile(join(fixture.enrolled, 'operator-one.txt'), 'one\n')
    await commitAll(fixture.enrolled, 'later clean operator commit one')
    await writeFile(join(fixture.enrolled, 'operator-two.txt'), 'two\n')
    await commitAll(fixture.enrolled, 'later clean operator commit two')
    const laterHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    const beforeCount = await gitText(fixture.enrolled, ['rev-list', '--count', 'HEAD'])

    const result = await recoverObjectiveNodeApply(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard,
      { retry: false }
    )

    expect(result).toEqual({ kind: 'applied', appliedCommitSha: integratedHead })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(laterHead)
    expect(await gitText(fixture.enrolled, ['rev-list', '--count', 'HEAD'])).toBe(beforeCount)
  })

  it('reports an absent commit without starting a fresh cherry-pick when retry is disabled', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'node.txt'), 'not applied\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'removed-node',
        title: 'Removed node result',
        reportedPaths: []
      },
      leaseGuard
    )
    const beforeHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])

    const result = await recoverObjectiveNodeApply(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard,
      { retry: false }
    )

    expect(result).toEqual({ kind: 'not-applied' })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(beforeHead)
    await expect(readFile(join(fixture.enrolled, 'node.txt'), 'utf8')).rejects.toBeDefined()
  })

  it('aborts its own interrupted conflict before reporting not applied in proof-only mode', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'shared.txt'), 'owned node\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'interrupted-node',
        title: 'Interrupted node',
        reportedPaths: []
      },
      leaseGuard
    )
    await writeFile(join(fixture.enrolled, 'shared.txt'), 'enrolled change\n')
    const enrolledHead = await commitAll(fixture.enrolled, 'enrolled change')
    await expect(git(fixture.enrolled, ['cherry-pick', normalized.commitSha])).rejects.toBeDefined()
    expect(await gitText(fixture.enrolled, ['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(
      normalized.commitSha
    )

    const result = await recoverObjectiveNodeApply(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard,
      { retry: false }
    )

    expect(result).toEqual({ kind: 'not-applied' })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(enrolledHead)
    expect(await readFile(join(fixture.enrolled, 'shared.txt'), 'utf8')).toBe('enrolled change\n')
    expect((await git(fixture.enrolled, ['ls-files', '--unmerged'])).stdout).toBe('')
    await expect(
      git(fixture.enrolled, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'])
    ).rejects.toBeDefined()
  })

  it('does not abort an unrelated cherry-pick', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'node.txt'), 'owned node\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'owned-node',
        title: 'Owned node',
        reportedPaths: []
      },
      leaseGuard
    )
    await git(fixture.source, ['reset', '--hard', fixture.baseCommit])
    await writeFile(join(fixture.source, 'shared.txt'), 'unrelated cherry-pick\n')
    const unrelatedCommit = await commitAll(fixture.source, 'unrelated node')
    await writeFile(join(fixture.enrolled, 'shared.txt'), 'enrolled change\n')
    await commitAll(fixture.enrolled, 'enrolled change')
    await expect(git(fixture.enrolled, ['cherry-pick', unrelatedCommit])).rejects.toBeDefined()
    expect(await gitText(fixture.enrolled, ['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(unrelatedCommit)

    await expect(
      recoverObjectiveNodeApply(fixture.enrolledTarget, normalized.commitSha, leaseGuard)
    ).rejects.toThrow('different objective node commit')
    expect(await gitText(fixture.enrolled, ['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(unrelatedCommit)
  })
})
