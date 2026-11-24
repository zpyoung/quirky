import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'
import {
  folderTarget,
  gitTarget as sharedGitTarget
} from './objective-workspace-target-test-fixtures'
import { cleanupTemporaryDirectories } from './objective-temp-workspace-test-fixtures'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitExecFileAsync(args, { cwd, admissionTier: 'background' })
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '--all'])
  await git(cwd, [
    '-c',
    'user.name=Objective Test',
    '-c',
    'user.email=objective@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    message
  ])
}

function gitTarget(workspacePath: string): ObjectiveWorkspaceTarget {
  return sharedGitTarget(workspacePath, { id: 'objective-test', repoId: 'objective-test-repo' })
}

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('computeWorkspaceContentIdentity', () => {
  it('tracks Git tree, dirty file hashes and deletions while ignoring reports in the git directory', async () => {
    const root = await temporaryDirectory('quirky-objective-git-')
    await git(root, ['init'])
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await commitAll(root, 'initial')
    const target = gitTarget(root)
    const cleanIdentity = await computeWorkspaceContentIdentity(target)

    await mkdir(join(root, '.git', 'quirky-heimdall', 'objective', 'reports'), { recursive: true })
    await writeFile(
      join(root, '.git', 'quirky-heimdall', 'objective', 'reports', 'attempt.json'),
      '{"plan":[]}'
    )
    await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(cleanIdentity)

    await writeFile(join(root, 'untracked.txt'), 'one\n')
    const untrackedIdentity = await computeWorkspaceContentIdentity(target)
    expect(untrackedIdentity).not.toBe(cleanIdentity)
    await writeFile(join(root, 'untracked.txt'), 'two\n')
    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(untrackedIdentity)

    await rm(join(root, 'tracked.txt'))
    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(untrackedIdentity)
  })

  it.skipIf(process.platform === 'win32')(
    'ignores index-only staging while tracking worktree, HEAD, rename, deletion, and mode changes',
    async () => {
      const root = await temporaryDirectory('quirky-objective-git-index-')
      await git(root, ['init'])
      const trackedPath = join(root, 'tracked.txt')
      await writeFile(trackedPath, 'initial\n')
      await commitAll(root, 'initial')
      const target = gitTarget(root)
      const cleanIdentity = await computeWorkspaceContentIdentity(target)

      await writeFile(trackedPath, 'staged content\n')
      const dirtyIdentity = await computeWorkspaceContentIdentity(target)
      expect(dirtyIdentity).not.toBe(cleanIdentity)
      await git(root, ['add', '--', 'tracked.txt'])
      await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(dirtyIdentity)

      await writeFile(trackedPath, 'worktree content\n')
      const worktreeIdentity = await computeWorkspaceContentIdentity(target)
      expect(worktreeIdentity).not.toBe(dirtyIdentity)
      await git(root, ['add', '--', 'tracked.txt'])
      const stagedWorktreeIdentity = await computeWorkspaceContentIdentity(target)
      expect(stagedWorktreeIdentity).toBe(worktreeIdentity)
      await commitAll(root, 'move HEAD tree')
      const movedHeadIdentity = await computeWorkspaceContentIdentity(target)
      expect(movedHeadIdentity).not.toBe(stagedWorktreeIdentity)

      await git(root, ['mv', 'tracked.txt', 'renamed.txt'])
      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(movedHeadIdentity)
      await git(root, ['reset', '--hard', 'HEAD'])

      await rm(trackedPath)
      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(movedHeadIdentity)
      await git(root, ['reset', '--hard', 'HEAD'])

      await chmod(trackedPath, 0o755)
      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(movedHeadIdentity)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'tracks executable mode changes for an untracked Git path',
    async () => {
      const root = await temporaryDirectory('quirky-objective-git-mode-')
      await git(root, ['init'])
      await writeFile(join(root, 'tracked.txt'), 'committed\n')
      await commitAll(root, 'initial')
      const scriptPath = join(root, 'run.sh')
      await writeFile(scriptPath, '#!/bin/sh\nexit 0\n')
      await chmod(scriptPath, 0o644)
      const target = gitTarget(root)
      const nonExecutableIdentity = await computeWorkspaceContentIdentity(target)

      await chmod(scriptPath, 0o755)

      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(nonExecutableIdentity)
    }
  )

  it('computes identity for an unborn Git HEAD and remains sensitive to its dirty files', async () => {
    const root = await temporaryDirectory('quirky-objective-git-unborn-')
    await git(root, ['init'])
    const target = gitTarget(root)
    const emptyIdentity = await computeWorkspaceContentIdentity(target)

    await writeFile(join(root, 'first.txt'), 'first\n')

    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(emptyIdentity)
  })

  it('fingerprints a dirty submodule without hashing its directory as a blob', async () => {
    const submoduleSource = await temporaryDirectory('quirky-objective-submodule-source-')
    await git(submoduleSource, ['init'])
    await writeFile(join(submoduleSource, 'tracked.txt'), 'committed\n')
    await commitAll(submoduleSource, 'submodule initial')

    const root = await temporaryDirectory('quirky-objective-submodule-parent-')
    await git(root, ['init'])
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await commitAll(root, 'parent initial')
    await git(root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submoduleSource,
      'vendor/submodule'
    ])
    await commitAll(root, 'add submodule')
    const target = gitTarget(root)
    const cleanIdentity = await computeWorkspaceContentIdentity(target)
    const submoduleFile = join(root, 'vendor', 'submodule', 'tracked.txt')

    await writeFile(submoduleFile, 'dirty-one\n')
    const firstDirtyIdentity = await computeWorkspaceContentIdentity(target)
    expect(firstDirtyIdentity).not.toBe(cleanIdentity)
    await writeFile(submoduleFile, 'dirty-two\n')

    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(firstDirtyIdentity)
  })

  it('hashes folder file contents, ignores mtimes, and excludes the complete .quirky subtree', async () => {
    const root = await temporaryDirectory('quirky-objective-folder-')
    await writeFile(join(root, 'a.txt'), 'a')
    const fixedTime = new Date('2026-09-15T00:00:00.000Z')
    await utimes(join(root, 'a.txt'), fixedTime, fixedTime)
    const target = folderTarget(root)
    const initialIdentity = await computeWorkspaceContentIdentity(target)

    const reportDirectory = join(root, '.quirky', 'heimdall', 'objective', 'reports')
    await mkdir(reportDirectory, { recursive: true })
    await writeFile(join(reportDirectory, 'attempt.json'), 'ignored report content')
    await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(initialIdentity)

    await writeFile(join(root, 'b.txt'), 'new file')
    const addedIdentity = await computeWorkspaceContentIdentity(target)
    expect(addedIdentity).not.toBe(initialIdentity)
    await utimes(
      join(root, 'b.txt'),
      new Date(fixedTime.getTime() + 60_000),
      new Date(fixedTime.getTime() + 60_000)
    )
    await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(addedIdentity)

    await writeFile(join(root, 'a.txt'), 'b')
    await utimes(join(root, 'a.txt'), fixedTime, fixedTime)
    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(addedIdentity)
  })
})

describe('computeObjectiveWorktreeContentDigest', () => {
  it.skipIf(process.platform === 'win32')(
    'tracks a symlink target even when target contents match and tolerates a broken link',
    async () => {
      const root = await temporaryDirectory('quirky-objective-worktree-digest-')
      await git(root, ['init'])
      await writeFile(join(root, 'target-a.txt'), 'identical\n')
      await writeFile(join(root, 'target-b.txt'), 'identical\n')
      const link = join(root, 'current.txt')
      await symlink('target-a.txt', link)
      await commitAll(root, 'initial symlink')
      const target = gitTarget(root)
      const firstDigest = await computeObjectiveWorktreeContentDigest(target)

      await rm(link)
      await symlink('target-b.txt', link)
      const retargetedDigest = await computeObjectiveWorktreeContentDigest(target)
      expect(retargetedDigest).not.toBe(firstDigest)

      await rm(link)
      await symlink('missing.txt', link)
      await expect(computeObjectiveWorktreeContentDigest(target)).resolves.toMatch(
        /^[0-9a-f]{64}$/u
      )
    }
  )
  it('is unchanged when dirty content is committed unmodified, and changes when it is edited', async () => {
    const root = await temporaryDirectory('quirky-objective-worktree-digest-commit-')
    await git(root, ['init'])
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await commitAll(root, 'initial')
    await writeFile(join(root, 'tracked.txt'), 'worker edit\n')
    const target = gitTarget(root)
    const dirtyDigest = await computeObjectiveWorktreeContentDigest(target)

    await commitAll(root, 'worker commit')

    // The landing path compares this digest across the commit, so committing unmodified content
    // has to leave it alone; only the bytes on disk may move it.
    expect(await computeObjectiveWorktreeContentDigest(target)).toBe(dirtyDigest)

    await writeFile(join(root, 'tracked.txt'), 'edited after commit\n')
    expect(await computeObjectiveWorktreeContentDigest(target)).not.toBe(dirtyDigest)
  })
})
