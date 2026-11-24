import { chmod, mkdir, mkdtemp, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { observeObjectiveWorkspaceManifest } from './objective-workspace-manifest'
import {
  captureObjectiveWorkspaceBaseline,
  validateObjectiveWorkspaceChanges
} from './observed-workspace-changes'
import { folderTarget, gitTarget } from './objective-workspace-target-test-fixtures'
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

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A'])
  await git(root, [
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

async function gitRepository(prefix: string): Promise<string> {
  const root = await temporaryDirectory(prefix)
  await git(root, ['init'])
  await mkdir(join(root, 'src'))
  return root
}

async function gitRepositoryWithIgnore(prefix: string, pattern: string): Promise<string> {
  const root = await gitRepository(prefix)
  await writeFile(join(root, '.gitignore'), `${pattern}\n`)
  await writeFile(join(root, 'src', 'tracked.ts'), 'before\n')
  await commitAll(root, 'initial')
  return root
}

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('objective observed workspace changes', () => {
  it('does not blame preexisting Git dirt and accepts the reported in-territory change', async () => {
    const root = await temporaryDirectory('quirky-objective-observed-git-')
    await git(root, ['init'])
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'preexisting.ts'), 'clean\n')
    await writeFile(join(root, 'src', 'changed.ts'), 'before\n')
    await git(root, ['add', 'src'])
    await git(root, [
      '-c',
      'user.name=Objective Test',
      '-c',
      'user.email=objective@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'initial'
    ])
    await writeFile(join(root, 'src', 'preexisting.ts'), 'dirty before dispatch\n')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'git-attempt')

    await writeFile(join(root, 'src', 'changed.ts'), 'after\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'git-attempt',
        reportedFiles: ['src/changed.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/changed.ts'] })
  })

  it('accepts an existing ignored report without allowing an observed tracked change to be omitted', async () => {
    const root = await gitRepositoryWithIgnore(
      'quirky-objective-observed-ignored-',
      'generated/*.json'
    )
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'ignored-attempt')

    await writeFile(join(root, 'src', 'tracked.ts'), 'after\n')
    await mkdir(join(root, 'generated'))
    await writeFile(join(root, 'generated', 'cache.json'), '{"generated":true}\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'ignored-attempt',
        reportedFiles: ['src/tracked.ts', 'generated/cache.json'],
        writeTerritory: ['src/**', 'generated/**']
      })
    ).resolves.toEqual({
      ok: true,
      changedPaths: ['generated/cache.json', 'src/tracked.ts']
    })
    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'ignored-attempt',
        reportedFiles: ['generated/cache.json'],
        writeTerritory: ['src/**', 'generated/**']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes',
      observedFiles: ['src/tracked.ts']
    })
  })

  it('rejects a reported ignored path that does not exist', async () => {
    const root = await gitRepositoryWithIgnore(
      'quirky-objective-observed-missing-ignored-',
      'generated/*.json'
    )
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'missing-ignored-attempt')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'missing-ignored-attempt',
        reportedFiles: ['generated/missing.json'],
        writeTerritory: ['generated/**']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes',
      observedFiles: []
    })
  })

  it('rejects an existing ignored report outside write territory', async () => {
    const root = await gitRepositoryWithIgnore(
      'quirky-objective-observed-ignored-territory-',
      'docs/*.cache'
    )
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'ignored-territory-attempt')
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'generated.cache'), 'outside\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'ignored-territory-attempt',
        reportedFiles: ['docs/generated.cache'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'reported-files-invalid',
      observedFiles: []
    })
  })

  it('rejects an unsafe reported path before checking whether it is ignored', async () => {
    const root = await gitRepositoryWithIgnore(
      'quirky-objective-observed-unsafe-ignored-',
      '*.cache'
    )
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'unsafe-ignored-attempt')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'unsafe-ignored-attempt',
        reportedFiles: ['../escape.cache'],
        writeTerritory: ['**']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'reported-files-invalid',
      observedFiles: []
    })
  })

  it.skipIf(process.platform === 'win32')(
    'rejects an ignored symlink that resolves outside the workspace',
    async () => {
      const root = await gitRepositoryWithIgnore(
        'quirky-objective-observed-ignored-symlink-',
        'generated/*.json'
      )
      const outside = await temporaryDirectory('quirky-objective-observed-ignored-outside-')
      await writeFile(join(outside, 'outside.json'), '{"outside":true}\n')
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'ignored-symlink-attempt')
      await mkdir(join(root, 'generated'))
      await symlink(join(outside, 'outside.json'), join(root, 'generated', 'link.json'))

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'ignored-symlink-attempt',
          reportedFiles: ['generated/link.json'],
          writeTerritory: ['generated/**']
        })
      ).resolves.toEqual({
        ok: false,
        reason: 'reported-files-do-not-match-observed-changes',
        observedFiles: []
      })
    }
  )

  it('does not accept an unchanged tracked path merely because it matches an ignore rule', async () => {
    const root = await gitRepository('quirky-objective-observed-tracked-ignore-')
    await writeFile(join(root, '.gitignore'), 'src/*.log\n')
    await writeFile(join(root, 'src', 'tracked.log'), 'tracked\n')
    await git(root, ['add', '-f', '.gitignore', 'src/tracked.log'])
    await commitAll(root, 'initial')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'tracked-ignore-attempt')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'tracked-ignore-attempt',
        reportedFiles: ['src/tracked.log'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes',
      observedFiles: []
    })
  })

  it.skipIf(process.platform === 'win32')(
    'reports a Git executable-mode-only change even when file content is unchanged',
    async () => {
      const root = await temporaryDirectory('quirky-objective-observed-mode-')
      await git(root, ['init'])
      await mkdir(join(root, 'src'))
      const script = join(root, 'src', 'script.sh')
      await writeFile(script, '#!/bin/sh\nexit 0\n')
      await chmod(script, 0o644)
      await git(root, ['add', 'src/script.sh'])
      await git(root, [
        '-c',
        'user.name=Objective Test',
        '-c',
        'user.email=objective@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'initial'
      ])
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'mode-attempt')

      await chmod(script, 0o755)

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'mode-attempt',
          reportedFiles: ['src/script.sh'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/script.sh'] })

      const untracked = join(root, 'src', 'untracked.sh')
      await writeFile(untracked, '#!/bin/sh\nexit 0\n')
      await chmod(untracked, 0o644)
      await captureObjectiveWorkspaceBaseline(target, 'untracked-mode-attempt')
      await chmod(untracked, 0o755)

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'untracked-mode-attempt',
          reportedFiles: ['src/untracked.sh'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/untracked.sh'] })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a tracked file-to-symlink type change even when the Git object content is unchanged',
    async () => {
      const root = await temporaryDirectory('quirky-objective-observed-type-')
      await git(root, ['init'])
      await mkdir(join(root, 'src'))
      const changedPath = join(root, 'src', 'linkish')
      await writeFile(changedPath, 'target.txt')
      await writeFile(join(root, 'src', 'target.txt'), 'target contents')
      await git(root, ['add', 'src'])
      await git(root, [
        '-c',
        'user.name=Objective Test',
        '-c',
        'user.email=objective@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'initial'
      ])
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'type-attempt')

      await unlink(changedPath)
      await symlink('target.txt', changedPath)

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'type-attempt',
          reportedFiles: ['src/linkish'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/linkish'] })
    }
  )

  it('fingerprints a dirty submodule from superproject metadata without hashing its directory', async () => {
    const child = await temporaryDirectory('quirky-objective-observed-submodule-child-')
    await git(child, ['init'])
    await writeFile(join(child, 'child.txt'), 'before\n')
    await git(child, ['add', 'child.txt'])
    await git(child, [
      '-c',
      'user.name=Objective Test',
      '-c',
      'user.email=objective@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'child'
    ])
    const root = await temporaryDirectory('quirky-objective-observed-submodule-parent-')
    await git(root, ['init'])
    await git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor/child'])
    await git(root, ['add', '.'])
    await git(root, [
      '-c',
      'user.name=Objective Test',
      '-c',
      'user.email=objective@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'parent'
    ])
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'submodule-attempt')

    await writeFile(join(root, 'vendor', 'child', 'child.txt'), 'after\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'submodule-attempt',
        reportedFiles: ['vendor/child'],
        writeTerritory: ['vendor/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['vendor/child'] })
  })

  it('detects both additions and deletions in a folder workspace', async () => {
    const root = await temporaryDirectory('quirky-objective-observed-folder-')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'deleted.ts'), 'delete me\n')
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'folder-attempt')

    await unlink(join(root, 'src', 'deleted.ts'))
    await writeFile(join(root, 'src', 'added.ts'), 'added\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'folder-attempt',
        reportedFiles: ['src/added.ts', 'src/deleted.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/added.ts', 'src/deleted.ts'] })
  })

  it('rejects a host-observed change outside write territory', async () => {
    const root = await temporaryDirectory('quirky-objective-observed-territory-')
    await mkdir(join(root, 'docs'))
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'outside-attempt')
    await writeFile(join(root, 'docs', 'escape.md'), 'outside\n')

    const result = await validateObjectiveWorkspaceChanges({
      target,
      attemptFingerprint: 'outside-attempt',
      reportedFiles: [],
      writeTerritory: ['src/**']
    })

    expect(result).toEqual({
      ok: false,
      reason: 'observed-change-outside-write-territory:docs/escape.md',
      observedFiles: ['docs/escape.md']
    })
  })

  it('rejects an in-territory host change omitted from reported files', async () => {
    const root = await temporaryDirectory('quirky-objective-observed-unreported-')
    await mkdir(join(root, 'src'))
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'unreported-attempt')
    await writeFile(join(root, 'src', 'hidden.ts'), 'hidden\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'unreported-attempt',
        reportedFiles: [],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes',
      observedFiles: ['src/hidden.ts']
    })
  })

  it('fails closed when the originating baseline is missing', async () => {
    const root = await temporaryDirectory('quirky-objective-observed-missing-')
    await expect(
      validateObjectiveWorkspaceChanges({
        target: folderTarget(root),
        attemptFingerprint: 'never-captured',
        reportedFiles: [],
        writeTerritory: ['**']
      })
    ).resolves.toEqual({ ok: false, reason: 'objective-workspace-baseline-missing' })
  })

  it('fails closed when the stored baseline is malformed', async () => {
    const root = await temporaryDirectory('quirky-objective-observed-malformed-')
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'malformed-attempt')
    const baselineDirectory = join(
      root,
      '.quirky',
      'heimdall',
      'objective',
      'reports',
      'workspace-baselines'
    )
    const [baselineFile] = await readdir(baselineDirectory)
    await writeFile(join(baselineDirectory, baselineFile!), '{"version":1}')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'malformed-attempt',
        reportedFiles: [],
        writeTerritory: ['**']
      })
    ).resolves.toEqual({ ok: false, reason: 'objective-workspace-baseline-malformed' })
  })

  it('does not report a path that was dirty at capture and is then committed unchanged', async () => {
    const root = await gitRepository('quirky-objective-observed-commit-')
    await writeFile(join(root, 'src', 'staged.ts'), 'before\n')
    await commitAll(root, 'initial')
    await writeFile(join(root, 'src', 'staged.ts'), 'worker edit\n')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'commit-attempt')

    await commitAll(root, 'worker commit')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'commit-attempt',
        reportedFiles: [],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: [] })
  })

  it('reports a path that was dirty at capture and is then restored to HEAD', async () => {
    const root = await gitRepository('quirky-objective-observed-revert-')
    await writeFile(join(root, 'src', 'reverted.ts'), 'committed\n')
    await commitAll(root, 'initial')
    await writeFile(join(root, 'src', 'reverted.ts'), 'dirty at capture\n')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'revert-attempt')

    await git(root, ['checkout', '--', 'src/reverted.ts'])

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'revert-attempt',
        reportedFiles: ['src/reverted.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/reverted.ts'] })
  })

  it('reports a file created and committed without being dirty at either observation', async () => {
    const root = await gitRepository('quirky-objective-observed-added-')
    await writeFile(join(root, 'src', 'existing.ts'), 'existing\n')
    await commitAll(root, 'initial')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'added-attempt')

    await writeFile(join(root, 'src', 'added.ts'), 'added\n')
    await commitAll(root, 'worker commit')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'added-attempt',
        reportedFiles: ['src/added.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/added.ts'] })
  })

  it.skipIf(process.platform === 'win32')(
    'observes a dirty symlink that points at a missing file instead of failing on it',
    async () => {
      const root = await gitRepository('quirky-objective-observed-broken-link-')
      await writeFile(join(root, 'src', 'kept.ts'), 'kept\n')
      await commitAll(root, 'initial')
      await symlink('does-not-exist.ts', join(root, 'src', 'dangling.ts'))
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'broken-link-attempt')

      await writeFile(join(root, 'src', 'kept.ts'), 'changed\n')

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'broken-link-attempt',
          reportedFiles: ['src/kept.ts'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/kept.ts'] })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a retargeted symlink whose old and new targets hold identical content',
    async () => {
      const root = await gitRepository('quirky-objective-observed-retarget-')
      await writeFile(join(root, 'src', 'first.ts'), 'same\n')
      await writeFile(join(root, 'src', 'second.ts'), 'same\n')
      await symlink('first.ts', join(root, 'src', 'link.ts'))
      await commitAll(root, 'initial')
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'retarget-attempt')

      await unlink(join(root, 'src', 'link.ts'))
      await symlink('second.ts', join(root, 'src', 'link.ts'))

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'retarget-attempt',
          reportedFiles: ['src/link.ts'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/link.ts'] })
    }
  )

  it('validates a baseline captured in the legacy whole-manifest format', async () => {
    const root = await gitRepository('quirky-objective-observed-legacy-')
    await writeFile(join(root, 'src', 'legacy.ts'), 'before\n')
    await commitAll(root, 'initial')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'legacy-attempt')

    const baselineDirectory = join(
      root,
      '.git',
      'quirky-heimdall',
      'objective',
      'reports',
      'workspace-baselines'
    )
    const [baselineName] = await readdir(baselineDirectory)
    await writeFile(
      join(baselineDirectory, baselineName!),
      JSON.stringify({
        version: 1,
        attemptFingerprint: 'legacy-attempt',
        target: {
          kind: 'git',
          executionHostId: 'local',
          workspacePath: root,
          gitWorktreeId: `objective-repo::${root}`
        },
        entries: await observeObjectiveWorkspaceManifest(target)
      })
    )

    await writeFile(join(root, 'src', 'legacy.ts'), 'after\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'legacy-attempt',
        reportedFiles: ['src/legacy.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/legacy.ts'] })
  })
})
