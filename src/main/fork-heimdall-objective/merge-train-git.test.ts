import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from '../../shared/fork-heimdall-objective/contract-types'
import type { CriterionCheckResult } from './check-runner'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import {
  applyObjectiveNodeCommit,
  createObjectiveNodeCommit,
  OBJECTIVE_MERGE_TRAIN_MAX_PATHS,
  ObjectiveNodeIngestRejectedError,
  runObjectiveConflictChecks
} from './merge-train-git'
import { cleanupTemporaryDirectories } from './objective-temp-workspace-test-fixtures'
import {
  commitAll,
  createMergeTrainRepositoryFixture,
  git,
  gitText
} from './objective-git-test-fixtures'

const checkState = vi.hoisted(() => ({
  run: vi.fn()
}))

const assertLeaseHeld = vi.fn(async () => {})
const leaseGuard: LeaseGuard = {
  epoch: 1,
  holder: 'merge-train-test',
  assertHeld: assertLeaseHeld,
  renewLoop: () => ({ dispose() {} })
}

vi.mock('./check-runner', () => ({
  runCriterionCheck: checkState.run
}))

const temporaryDirectories: string[] = []

type RepositoryFixture = {
  source: string
  enrolled: string
  sourceTarget: ObjectiveWorkspaceTarget
  enrolledTarget: ObjectiveWorkspaceTarget
  baseCommit: string
}

async function repositoryFixture(): Promise<RepositoryFixture> {
  return createMergeTrainRepositoryFixture(temporaryDirectories, {
    tempPrefix: 'quirky-objective-merge-train-',
    repoId: 'merge-train-test-repo',
    userName: 'Merge Train Test',
    userEmail: 'merge-train@example.test'
  })
}

function checkResult(
  command: string,
  pass: boolean,
  exitCode = pass ? 0 : 1
): CriterionCheckResult {
  return {
    command,
    pass,
    exitCode,
    timedOut: false,
    stdoutTail: pass ? `${command} passed` : '',
    stderrTail: pass ? '' : `${command} failed`,
    error: null,
    startedAtMs: 10,
    completedAtMs: 20,
    durationMs: 10
  }
}

beforeEach(() => {
  checkState.run.mockReset()
  assertLeaseHeld.mockClear()
})

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('objective merge train Git mechanics', () => {
  it('normalizes staged, dirty, and multi-commit dispatch history into one attributed commit', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'history.txt'), 'first\n')
    await commitAll(fixture.source, 'worker commit one')
    await writeFile(join(fixture.source, 'history.txt'), 'second\n')
    await writeFile(join(fixture.source, 'committed.txt'), 'worker commit\n')
    await commitAll(fixture.source, 'worker commit two')
    await writeFile(join(fixture.source, 'shared.txt'), 'staged\n')
    await git(fixture.source, ['add', '--', 'shared.txt'])
    await writeFile(join(fixture.source, 'shared.txt'), 'final worktree\n')
    await writeFile(join(fixture.source, 'untracked.txt'), 'untracked\n')
    await mkdir(join(fixture.source, '.quirky'), { recursive: true })
    await writeFile(join(fixture.source, '.quirky', 'watcher.json'), '{"state":"owned"}\n')

    const result = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'implement-node',
        title: 'Implement the node',
        reportedPaths: []
      },
      leaseGuard
    )
    expect(assertLeaseHeld).toHaveBeenCalledTimes(3)

    expect(
      await gitText(fixture.source, ['rev-list', '--count', `${fixture.baseCommit}..HEAD`])
    ).toBe('1')
    expect(result.commitSha).toBe(await gitText(fixture.source, ['rev-parse', 'HEAD']))
    expect(await readFile(join(fixture.source, 'history.txt'), 'utf8')).toBe('second\n')
    expect(await readFile(join(fixture.source, 'shared.txt'), 'utf8')).toBe('final worktree\n')
    expect(await gitText(fixture.source, ['show', 'HEAD:untracked.txt'])).toBe('untracked')
    expect(await gitText(fixture.source, ['show', '--format=%B', '--no-patch', 'HEAD'])).toBe(
      'Implement the node\n\nworker commit two\n\nworker commit one\n\nQuirky-Heimdall-Task: implement-node'
    )
    expect(
      (await git(fixture.source, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.quirky'])).stdout
    ).toBe('')
    expect(
      (await git(fixture.source, ['status', '--porcelain', '--untracked-files=all'])).stdout
    ).toBe('?? .quirky/watcher.json\n')
  })

  it('commits only explicitly reported ignored output files', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, '.gitignore'), 'dist/*.bin\n')
    await mkdir(join(fixture.source, 'dist'))
    await writeFile(join(fixture.source, 'dist', 'reported.bin'), 'reported output\n')
    await writeFile(join(fixture.source, 'dist', 'unreported.bin'), 'unreported output\n')

    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'ignored-output',
        title: 'Retain reported ignored output',
        reportedPaths: ['dist/reported.bin']
      },
      leaseGuard
    )

    expect(
      await gitText(fixture.source, ['show', `${normalized.commitSha}:dist/reported.bin`])
    ).toBe('reported output')
    await expect(
      git(fixture.source, ['cat-file', '-e', `${normalized.commitSha}:dist/unreported.bin`])
    ).rejects.toBeDefined()
    expect(await readFile(join(fixture.source, 'dist', 'unreported.bin'), 'utf8')).toBe(
      'unreported output\n'
    )
    expect(
      (await git(fixture.source, ['status', '--ignored', '--short', '--', 'dist/unreported.bin']))
        .stdout
    ).toBe('!! dist/unreported.bin\n')
  })

  it('rejects a node commit with a typed error when HEAD does not descend from the dispatch baseline', async () => {
    const fixture = await repositoryFixture()
    // simulates a worker that amended away its original commit, leaving HEAD on unrelated history
    await git(fixture.source, ['checkout', '--orphan', 'rewritten'])
    await writeFile(join(fixture.source, 'shared.txt'), 'rewritten\n')
    await git(fixture.source, ['add', '--all'])
    await git(fixture.source, ['commit', '-m', 'amended worker commit'])

    await expect(
      createObjectiveNodeCommit(
        fixture.sourceTarget,
        {
          baseCommit: fixture.baseCommit,
          taskKey: 'amended-node',
          title: 'Amended node',
          reportedPaths: []
        },
        leaseGuard
      )
    ).rejects.toThrow(ObjectiveNodeIngestRejectedError)
    await expect(
      createObjectiveNodeCommit(
        fixture.sourceTarget,
        {
          baseCommit: fixture.baseCommit,
          taskKey: 'amended-node',
          title: 'Amended node',
          reportedPaths: []
        },
        leaseGuard
      )
    ).rejects.toThrow('Objective node HEAD does not descend from its dispatch baseline')
  })

  it('normalizes the commit past a failing repository pre-commit hook', async () => {
    const fixture = await repositoryFixture()
    const hookPath = join(fixture.source, '.git', 'hooks', 'pre-commit')
    await writeFile(hookPath, '#!/bin/sh\nexit 1\n')
    await chmod(hookPath, 0o755)
    await writeFile(join(fixture.source, 'hook-guarded.txt'), 'guarded\n')

    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'hook-guarded-node',
        title: 'Normalize past a failing hook',
        reportedPaths: []
      },
      leaseGuard
    )

    expect(normalized.commitSha).toBe(await gitText(fixture.source, ['rev-parse', 'HEAD']))
    expect(await gitText(fixture.source, ['show', 'HEAD:hook-guarded.txt'])).toBe('guarded')
  })

  it('normalizes the commit even when a worker has pre-planted a hook at the old fixed hooksPath', async () => {
    const fixture = await repositoryFixture()
    const staleHooksDir = join(fixture.source, '.git', 'quirky-objective-empty-hooks')
    await mkdir(staleHooksDir, { recursive: true })
    const staleHookPath = join(staleHooksDir, 'pre-commit')
    await writeFile(staleHookPath, '#!/bin/sh\nexit 1\n')
    await chmod(staleHookPath, 0o755)
    const repoHookPath = join(fixture.source, '.git', 'hooks', 'pre-commit')
    await writeFile(repoHookPath, '#!/bin/sh\nexit 1\n')
    await chmod(repoHookPath, 0o755)
    await writeFile(join(fixture.source, 'planted-hook.txt'), 'planted\n')

    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'planted-hook-node',
        title: 'Normalize past a pre-planted hook',
        reportedPaths: []
      },
      leaseGuard
    )

    expect(normalized.commitSha).toBe(await gitText(fixture.source, ['rev-parse', 'HEAD']))
    expect(await gitText(fixture.source, ['show', 'HEAD:planted-hook.txt'])).toBe('planted')
  })

  it('carries a worker commit body into the normalized commit message', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'notes.txt'), 'notes\n')
    await commitAll(fixture.source, 'worker commit\n\ndetailed work notes')

    await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'worker-notes',
        title: 'Retain worker notes',
        reportedPaths: []
      },
      leaseGuard
    )

    expect(await gitText(fixture.source, ['show', '--format=%B', '--no-patch', 'HEAD'])).toBe(
      'Retain worker notes\n\nworker commit\n\ndetailed work notes\n\nQuirky-Heimdall-Task: worker-notes'
    )
  })

  it('strips a duplicate Quirky-Heimdall-Task trailer already present in a worker commit body', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'notes.txt'), 'notes\n')
    await commitAll(
      fixture.source,
      'worker commit\n\nwith a body line\n\nQuirky-Heimdall-Task: stale-task'
    )

    await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'fresh-task',
        title: 'Strip the stale trailer',
        reportedPaths: []
      },
      leaseGuard
    )

    const finalMessage = await gitText(fixture.source, [
      'show',
      '--format=%B',
      '--no-patch',
      'HEAD'
    ])
    expect(finalMessage).toBe(
      'Strip the stale trailer\n\nworker commit\n\nwith a body line\n\nQuirky-Heimdall-Task: fresh-task'
    )
    expect(finalMessage.match(/Quirky-Heimdall-Task:/gu)).toHaveLength(1)
  })

  it('bounds the carried-over worker body to OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'notes.txt'), 'notes\n')
    const oversizedBody = 'x'.repeat(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH + 1_000)
    await commitAll(fixture.source, `worker commit\n\n${oversizedBody}`)

    await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'bounded-task',
        title: 'Bound the carried body',
        reportedPaths: []
      },
      leaseGuard
    )

    const finalMessage = await gitText(fixture.source, [
      'show',
      '--format=%B',
      '--no-patch',
      'HEAD'
    ])
    const trailer = '\n\nQuirky-Heimdall-Task: bounded-task'
    expect(finalMessage.endsWith(trailer)).toBe(true)
    const body = finalMessage.slice('Bound the carried body\n\n'.length, -trailer.length)
    expect(body.length).toBe(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH)
    expect(body).toBe(
      `worker commit\n\n${oversizedBody}`.slice(0, OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH)
    )
  })

  it('does not reset a node worktree after its lease is lost', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'worker.txt'), 'committed by worker\n')
    const workerHead = await commitAll(fixture.source, 'worker commit before normalization')
    assertLeaseHeld.mockRejectedValueOnce(new Error('lease lost'))

    await expect(
      createObjectiveNodeCommit(
        fixture.sourceTarget,
        {
          baseCommit: fixture.baseCommit,
          taskKey: 'fenced-node',
          title: 'Fence normalization',
          reportedPaths: []
        },
        leaseGuard
      )
    ).rejects.toThrow('lease lost')

    expect(await gitText(fixture.source, ['rev-parse', 'HEAD'])).toBe(workerHead)
  })

  it('creates and applies one commit for a successful node with no file changes', async () => {
    const fixture = await repositoryFixture()
    await mkdir(join(fixture.source, '.quirky'), { recursive: true })
    await writeFile(join(fixture.source, '.quirky', 'report.json'), '{}\n')

    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'no-file-change',
        title: 'Validate existing behavior',
        reportedPaths: []
      },
      leaseGuard
    )
    const sourceTree = await gitText(fixture.source, [
      'rev-parse',
      `${normalized.commitSha}^{tree}`
    ])
    const baseTree = await gitText(fixture.source, ['rev-parse', `${fixture.baseCommit}^{tree}`])
    expect(sourceTree).toBe(baseTree)
    expect(
      await gitText(fixture.source, ['rev-list', '--count', `${fixture.baseCommit}..HEAD`])
    ).toBe('1')

    const applied = await applyObjectiveNodeCommit(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard
    )

    expect(applied).toEqual({
      kind: 'applied',
      appliedCommitSha: await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    })
    expect(
      await gitText(fixture.enrolled, ['rev-list', '--count', `${fixture.baseCommit}..HEAD`])
    ).toBe('1')
  })

  it('pauses before cherry-pick when the enrolled worktree has operator dirtiness', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'node.txt'), 'node\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'dirty-pause',
        title: 'Create node output',
        reportedPaths: []
      },
      leaseGuard
    )
    await writeFile(join(fixture.enrolled, 'operator.txt'), 'do not sweep\n')
    await mkdir(join(fixture.enrolled, '.quirky'), { recursive: true })
    await writeFile(join(fixture.enrolled, '.quirky', 'control.json'), '{}\n')

    const result = await applyObjectiveNodeCommit(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard
    )

    expect(result).toEqual({
      kind: 'paused-dirty',
      paths: ['operator.txt'],
      pathCount: 1,
      pathsTruncated: false
    })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit)
    expect(await readFile(join(fixture.enrolled, 'operator.txt'), 'utf8')).toBe('do not sweep\n')
  })

  it('applies a completed node commit to a clean enrolled worktree', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'completed.txt'), 'completed\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'completed-node',
        title: 'Complete node',
        reportedPaths: []
      },
      leaseGuard
    )

    const result = await applyObjectiveNodeCommit(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard
    )

    expect(result.kind).toBe('applied')
    expect(await readFile(join(fixture.enrolled, 'completed.txt'), 'utf8')).toBe('completed\n')
    expect(
      (await git(fixture.enrolled, ['status', '--porcelain', '--untracked-files=all'])).stdout
    ).toBe('')
  })

  it('captures conflict paths and actively aborts back to a clean enrolled worktree', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'shared.txt'), 'from node\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'conflicting-node',
        title: 'Change shared content',
        reportedPaths: []
      },
      leaseGuard
    )
    await writeFile(join(fixture.enrolled, 'shared.txt'), 'from enrolled\n')
    const enrolledHead = await commitAll(fixture.enrolled, 'enrolled change')
    await mkdir(join(fixture.enrolled, '.quirky'), { recursive: true })
    await writeFile(join(fixture.enrolled, '.quirky', 'control.json'), '{}\n')

    const result = await applyObjectiveNodeCommit(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard
    )

    expect(result).toEqual({
      kind: 'conflict',
      allConflictPaths: ['shared.txt'],
      paths: ['shared.txt'],
      pathCount: 1,
      pathsTruncated: false
    })
    expect(assertLeaseHeld).toHaveBeenCalledTimes(5)
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(enrolledHead)
    expect(await readFile(join(fixture.enrolled, 'shared.txt'), 'utf8')).toBe('from enrolled\n')
    expect(
      (await git(fixture.enrolled, ['diff', '--name-only', '--diff-filter=U', '--'])).stdout
    ).toBe('')
    await expect(
      git(fixture.enrolled, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'])
    ).rejects.toBeDefined()
    expect(
      (await git(fixture.enrolled, ['status', '--porcelain', '--untracked-files=all'])).stdout
    ).toBe('?? .quirky/control.json\n')
  })

  it('retains every raw conflict path while bounding the display report', async () => {
    const fixture = await repositoryFixture()
    const allPaths = Array.from(
      { length: OBJECTIVE_MERGE_TRAIN_MAX_PATHS + 1 },
      (_, index) => `conflict-${String(index).padStart(3, '0')}.txt`
    )
    await Promise.all(
      allPaths.map((filePath) => writeFile(join(fixture.source, filePath), 'from node\n'))
    )
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'large-conflict',
        title: 'Create a large conflict set',
        reportedPaths: []
      },
      leaseGuard
    )
    await Promise.all(
      allPaths.map((filePath) => writeFile(join(fixture.enrolled, filePath), 'from enrolled\n'))
    )
    await commitAll(fixture.enrolled, 'enrolled large conflict set')

    const result = await applyObjectiveNodeCommit(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard
    )

    expect(result.kind).toBe('conflict')
    if (result.kind !== 'conflict') {
      throw new Error('Expected a conflict result')
    }
    expect(result.allConflictPaths).toEqual(allPaths)
    expect(result.paths).toEqual(allPaths.slice(0, OBJECTIVE_MERGE_TRAIN_MAX_PATHS))
    expect(result.pathCount).toBe(OBJECTIVE_MERGE_TRAIN_MAX_PATHS + 1)
    expect(result.pathsTruncated).toBe(true)
  })

  it('runs every conflict check in order and returns first and all failure detail', async () => {
    const fixture = await repositoryFixture()
    checkState.run.mockImplementation(async ({ command }: { command: string }) => {
      if (command === 'check-two') {
        return checkResult(command, true)
      }
      return checkResult(command, false, command === 'check-three' ? 17 : 1)
    })

    const result = await runObjectiveConflictChecks(
      fixture.enrolledTarget,
      ['check-one', 'check-two', 'check-three'],
      leaseGuard
    )
    expect(assertLeaseHeld).toHaveBeenCalledTimes(3)

    expect(checkState.run.mock.calls.map(([args]) => args.command)).toEqual([
      'check-one',
      'check-two',
      'check-three'
    ])
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.checks.map((check) => check.command)).toEqual([
        'check-one',
        'check-two',
        'check-three'
      ])
      expect(result.firstFailure.command).toBe('check-one')
      expect(result.failures.map((failure) => [failure.command, failure.exitCode])).toEqual([
        ['check-one', 1],
        ['check-three', 17]
      ])
    }
  })

  it('does not start a deterministic check after its lease is lost', async () => {
    const fixture = await repositoryFixture()
    assertLeaseHeld.mockRejectedValueOnce(new Error('lease lost'))

    await expect(
      runObjectiveConflictChecks(fixture.enrolledTarget, ['must-not-run'], leaseGuard)
    ).rejects.toThrow('lease lost')

    expect(checkState.run).not.toHaveBeenCalled()
  })
})
