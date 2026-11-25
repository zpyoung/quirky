import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listTreeChanges, snapshotWorkspaceTree } from './turn-tree-snapshot'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

describe('turn tree snapshots (real git)', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function tempDir(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix))
    tempPaths.push(path)
    return path
  }

  function repo(): { dir: string; git: (...args: string[]) => string } {
    const dir = tempDir('quirky-turn-tree-repo-')
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '--quiet')
    git('config', 'user.name', 'Quirky Test')
    git('config', 'user.email', 'quirky@example.test')
    git('config', 'commit.gpgSign', 'false')
    return { dir, git }
  }

  function commitFile(context: ReturnType<typeof repo>, name: string, content: string): void {
    writeFileSync(join(context.dir, name), content)
    context.git('add', name)
    context.git('commit', '--quiet', '-m', `add ${name}`)
  }

  async function treeOf(cwd: string): Promise<string> {
    const snapshot = await snapshotWorkspaceTree(cwd)
    if (!('tree' in snapshot)) {
      throw new Error(`expected a tree, got ${JSON.stringify(snapshot)}`)
    }
    return snapshot.tree
  }

  it('snapshots a branch checkout, untracked files included, without touching the real index', async () => {
    const context = repo()
    commitFile(context, 'tracked.txt', 'one\n')
    writeFileSync(join(context.dir, 'untracked.txt'), 'new\n')
    writeFileSync(join(context.dir, 'tracked.txt'), 'one\ntwo\n')
    writeFileSync(join(context.dir, '.gitignore'), 'ignored.log\n')
    writeFileSync(join(context.dir, 'ignored.log'), 'noise\n')
    const indexPath = join(context.dir, '.git', 'index')
    const indexBefore = statSync(indexPath).mtimeMs
    const statusBefore = context.git('--no-optional-locks', 'status', '--porcelain')
    const headBefore = context.git('rev-parse', 'HEAD')

    const tree = await treeOf(context.dir)

    expect(context.git('ls-tree', '-r', '--name-only', tree).split('\n').filter(Boolean)).toEqual([
      '.gitignore',
      'tracked.txt',
      'untracked.txt'
    ])
    expect(context.git('diff', '--cached')).toBe('')
    expect(context.git('--no-optional-locks', 'status', '--porcelain')).toBe(statusBefore)
    expect(statSync(indexPath).mtimeMs).toBe(indexBefore)
    expect(context.git('rev-parse', 'HEAD')).toBe(headBefore)
  })

  it('snapshots a detached HEAD', async () => {
    const context = repo()
    commitFile(context, 'a.txt', 'a\n')
    context.git('checkout', '--quiet', '--detach')
    writeFileSync(join(context.dir, 'b.txt'), 'b\n')

    const tree = await treeOf(context.dir)

    expect(context.git('ls-tree', '--name-only', tree).split('\n').filter(Boolean)).toEqual([
      'a.txt',
      'b.txt'
    ])
  })

  it('snapshots a repository with no commits yet', async () => {
    const context = repo()
    expect(await snapshotWorkspaceTree(context.dir)).toEqual({ tree: EMPTY_TREE })
    writeFileSync(join(context.dir, 'first.txt'), 'first\n')

    const tree = await treeOf(context.dir)

    expect(tree).not.toBe(EMPTY_TREE)
    expect(context.git('ls-tree', '--name-only', tree).trim()).toBe('first.txt')
    expect(context.git('--no-optional-locks', 'status', '--porcelain').trim()).toBe('?? first.txt')
  })

  it('reports a directory outside any repository as notGit', async () => {
    expect(await snapshotWorkspaceTree(tempDir('quirky-turn-tree-plain-'))).toEqual({
      notGit: true
    })
  })

  it('reports a subdirectory of a repository as notGit so paths stay relative to the workspace', async () => {
    const context = repo()
    commitFile(context, 'a.txt', 'a\n')
    mkdirSync(join(context.dir, 'nested'))

    expect(await snapshotWorkspaceTree(join(context.dir, 'nested'))).toEqual({ notGit: true })
  })

  it('removes its scratch index directory and leaves no lock behind', async () => {
    const context = repo()
    commitFile(context, 'a.txt', 'a\n')
    const scratchBefore = readdirSync(tmpdir()).filter((name) =>
      name.startsWith('quirky-turn-tree-')
    )

    await treeOf(context.dir)

    const scratchAfter = readdirSync(tmpdir()).filter((name) =>
      name.startsWith('quirky-turn-tree-')
    )
    expect(scratchAfter.filter((name) => !scratchBefore.includes(name))).toEqual([])
    expect(existsSync(join(context.dir, '.git', 'index.lock'))).toBe(false)
  })

  it('lists added, modified, deleted and renamed files with line counts', async () => {
    const context = repo()
    commitFile(context, 'edit.txt', 'one\ntwo\n')
    commitFile(context, 'remove.txt', 'bye\n')
    commitFile(
      context,
      'before.txt',
      'a long enough body\nthat survives a rename\nwith lines\nof text\n'
    )
    const from = await treeOf(context.dir)

    writeFileSync(join(context.dir, 'edit.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(context.dir, 'fresh.txt'), 'x\ny\n')
    writeFileSync(join(context.dir, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
    rmSync(join(context.dir, 'remove.txt'))
    renameSync(join(context.dir, 'before.txt'), join(context.dir, 'after.txt'))
    const to = await treeOf(context.dir)

    const files = await listTreeChanges(context.dir, from, to)

    expect(files).toEqual([
      { path: 'after.txt', status: 'renamed', oldPath: 'before.txt', added: 0, removed: 0 },
      { path: 'blob.bin', status: 'added' },
      { path: 'edit.txt', status: 'modified', added: 1, removed: 0 },
      { path: 'fresh.txt', status: 'added', added: 2, removed: 0 },
      { path: 'remove.txt', status: 'deleted', added: 0, removed: 1 }
    ])
  })

  it('lists nothing between identical trees', async () => {
    const context = repo()
    commitFile(context, 'a.txt', 'a\n')
    const tree = await treeOf(context.dir)

    expect(await listTreeChanges(context.dir, tree, tree)).toEqual([])
  })
})
