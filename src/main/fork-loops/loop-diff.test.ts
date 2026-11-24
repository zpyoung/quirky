import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffSnapshots, snapshotWorkingTree, type LoopGitTarget } from './loop-diff'
import { createLocalLoopFilesystem } from './loop-notes-file'

const execFileAsync = promisify(execFile)

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      env[key] = value
    }
  }
  return env
}

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('git', args, { cwd, env: { ...cleanGitEnv(), ...env } })
}

describe('working tree snapshots', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quirky-loop-diff-'))
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.email', 'loop@example.com'])
    await git(root, ['config', 'user.name', 'Loop'])
    await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n')
    await git(root, ['add', '-A'])
    await git(root, ['commit', '-q', '-m', 'initial'])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function target(): LoopGitTarget {
    return {
      kind: 'git',
      workspacePath: root,
      pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
      fs: createLocalLoopFilesystem(),
      runGit: (args, options) => git(root, args, options?.env)
    }
  }

  // status is read last because it can rewrite the index on its own, which would mask the index mtime
  async function observableGitState(): Promise<{
    indexMtimeMs: number
    stashList: string
    refs: string
    status: string
  }> {
    return {
      indexMtimeMs: (await stat(join(root, '.git', 'index'))).mtimeMs,
      stashList: (await git(root, ['stash', 'list'])).stdout,
      refs: (await git(root, ['for-each-ref'])).stdout,
      status: (await git(root, ['status', '--porcelain'])).stdout
    }
  }

  it('captures tracked edits and untracked files without touching the user index, refs, or stash', async () => {
    await writeFile(join(root, 'tracked.txt'), 'one\nTWO\nthree\n')
    await writeFile(join(root, 'untracked.txt'), 'brand new\n')
    // freshly written files keep git rewriting the index on each status until its timestamp passes theirs
    let before = await observableGitState()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await observableGitState()
      const settled = next.indexMtimeMs === before.indexMtimeMs
      before = next
      if (settled) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const snapshot = await snapshotWorkingTree(target())

    expect(await observableGitState()).toEqual(before)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.headSha).toMatch(/^[0-9a-f]{40,64}$/)
    const listing = await git(root, ['ls-tree', '-r', '--name-only', snapshot!.treeId])
    expect(listing.stdout.split('\n').filter(Boolean).sort()).toEqual([
      'tracked.txt',
      'untracked.txt'
    ])
    expect((await git(root, ['show', `${snapshot!.treeId}:tracked.txt`])).stdout).toBe(
      'one\nTWO\nthree\n'
    )
  })

  it('leaves no temporary index behind inside the git directory', async () => {
    const before = (await readdir(join(root, '.git'))).sort()
    await snapshotWorkingTree(target())
    expect((await readdir(join(root, '.git'))).sort()).toEqual(before)
  })

  it('omits ignored files and records deletions', async () => {
    await writeFile(join(root, '.gitignore'), 'ignored.log\n')
    await writeFile(join(root, 'ignored.log'), 'noise\n')
    await rm(join(root, 'tracked.txt'))

    const snapshot = await snapshotWorkingTree(target())

    const listing = await git(root, ['ls-tree', '-r', '--name-only', snapshot!.treeId])
    expect(listing.stdout.split('\n').filter(Boolean)).toEqual(['.gitignore'])
  })

  it('snapshots an unborn repository with a null head', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'quirky-loop-diff-unborn-'))
    try {
      await git(empty, ['init', '-q'])
      await writeFile(join(empty, 'a.txt'), 'a\n')
      const snapshot = await snapshotWorkingTree({
        ...target(),
        workspacePath: empty,
        runGit: (args, options) => git(empty, args, options?.env)
      })
      expect(snapshot?.headSha).toBeNull()
      expect(snapshot?.treeId).toMatch(/^[0-9a-f]{40,64}$/)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('returns null for a folder workspace', async () => {
    expect(await snapshotWorkingTree({ ...target(), kind: 'folder', runGit: null })).toBeNull()
  })

  it('returns null instead of throwing when git fails', async () => {
    const failing = {
      ...target(),
      runGit: async () => {
        throw new Error('git exploded')
      }
    }
    expect(await snapshotWorkingTree(failing)).toBeNull()
  })

  it('reports a zero diff for equal snapshots', async () => {
    const a = await snapshotWorkingTree(target())
    const b = await snapshotWorkingTree(target())
    expect(a?.treeId).toBe(b?.treeId)
    expect(await diffSnapshots(a!, b!, target())).toEqual({ added: 0, removed: 0, files: [] })
  })

  it('counts added and removed lines and lists changed files', async () => {
    const before = await snapshotWorkingTree(target())
    await writeFile(join(root, 'tracked.txt'), 'one\nthree\nfour\n')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'new file.txt'), 'x\ny\n')

    const after = await snapshotWorkingTree(target())
    const diff = await diffSnapshots(before!, after!, target())

    expect(diff?.added).toBe(4)
    expect(diff?.removed).toBe(1)
    expect([...(diff?.files ?? [])].sort()).toEqual(['sub/new file.txt', 'tracked.txt'])
  })

  it('treats binary changes as zero counted lines but still lists the file', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    const before = await snapshotWorkingTree(target())
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 9, 9, 9, 0, 255, 0]))
    const after = await snapshotWorkingTree(target())

    const diff = await diffSnapshots(before!, after!, target())

    expect(diff).toEqual({ added: 0, removed: 0, files: ['blob.bin'] })
  })

  it('returns null, not an empty diff, when git cannot compute the diff', async () => {
    const failing: LoopGitTarget = {
      ...target(),
      runGit: async () => {
        throw new Error('git diff failed')
      }
    }

    expect(
      await diffSnapshots(
        { treeId: 'before', headSha: null },
        { treeId: 'after', headSha: null },
        failing
      )
    ).toBeNull()
  })

  it('returns a zero diff for a folder workspace', async () => {
    const snapshot = { treeId: 'a', headSha: null }
    expect(
      await diffSnapshots(
        snapshot,
        { treeId: 'b', headSha: null },
        {
          ...target(),
          kind: 'folder',
          runGit: null
        }
      )
    ).toEqual({ added: 0, removed: 0, files: [] })
  })
})
