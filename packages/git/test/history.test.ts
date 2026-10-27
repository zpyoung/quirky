import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { GitError } from '../src/index'
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, commitFiles, history, listBranches } from '../src/history'

const fixture = isolateGitConfig()

function commitAll(dir: string, files: Record<string, string>, message = 'update'): string {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** A repo with `count` empty commits after the fixture's first one. */
function manyCommits(count: number): string {
  const dir = makeRepo(fixture.scratch())
  const input = Array.from(
    { length: count },
    (_, i) =>
      `commit refs/heads/main\ncommitter T <t@e.com> ${1_800_000_000 + i} +0000\ndata 3\nc${i % 10}\n${i === 0 ? 'from refs/heads/main^0\n' : ''}\n`
  ).join('')
  const result = Bun.spawnSync(['git', 'fast-import', '--quiet'], { cwd: dir, stdin: new TextEncoder().encode(input) })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  git(dir, 'reset', '-q', '--hard', 'main')
  return dir
}

describe('history', () => {
  test('limits are 50 by default and 200 at most', () => {
    expect([HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT]).toEqual([50, 200])
  })

  test('SC-52: defaults to 50 commits with hasMore, a cap of 200 returns everything', async () => {
    const dir = manyCommits(59)
    const first = await history(dir)
    expect(first.commits).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    const all = await history(dir, 500)
    expect(all.commits).toHaveLength(60)
    expect(all.hasMore).toBe(false)
    expect((await history(dir, 0)).commits).toHaveLength(1)
    expect((await history(dir, 3)).hasMore).toBe(true)
  })

  test('commits carry ids, parents, author, times in ms, subject, body and short refs', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    git(dir, 'checkout', '-q', '-b', 'zoe/feat')
    git(dir, 'config', 'user.name', 'Zoe Q')
    git(dir, 'config', 'user.email', 'zoe@example.com')
    writeFileSync(join(dir, 'b.txt'), 'y\n')
    git(dir, 'add', '.')
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'Add b', '-m', 'Body line one.\n\nSecond paragraph.'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2023-11-14T22:13:20Z', GIT_COMMITTER_DATE: '2023-11-14T22:13:21Z' }
    })
    git(dir, 'tag', 'v1')
    git(dir, 'update-ref', 'refs/remotes/origin/zoe/feat', 'HEAD')

    const { commits, hasMore } = await history(dir)
    expect(hasMore).toBe(false)
    const tip = commits[0]!
    expect(tip.oid).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(tip.parents).toEqual([git(dir, 'rev-parse', 'HEAD~1')])
    expect(tip.author).toBe('Zoe Q')
    expect(tip.email).toBe('zoe@example.com')
    expect(tip.authoredAt).toBe(1_700_000_000_000)
    expect(tip.committedAt).toBe(1_700_000_001_000)
    expect(tip.subject).toBe('Add b')
    expect(tip.body).toBe('Body line one.\n\nSecond paragraph.')
    expect([...tip.refs].sort()).toEqual(['HEAD -> zoe/feat', 'origin/zoe/feat', 'tag: v1'].sort())
    expect(commits[1]!.refs).toEqual(['main'])
    expect(commits[1]!.parents).toEqual([])
    expect(commits[1]!.body).toBe('')
  })

  test('a merge lists both parents and commits come newest first in topological order', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    git(dir, 'checkout', '-q', '-b', 'side')
    const side = commitAll(dir, { 's.txt': 's\n' }, 'side work')
    git(dir, 'checkout', '-q', 'main')
    const mainTip = commitAll(dir, { 'm.txt': 'm\n' }, 'main work')
    git(dir, 'merge', '--no-ff', '-q', '-m', 'Merge side', 'side')
    const { commits } = await history(dir)
    expect(commits[0]!.subject).toBe('Merge side')
    expect(commits[0]!.parents).toEqual([mainTip, side])
    expect(commits.map((c) => c.subject)).toHaveLength(4)
    const index = new Map(commits.map((c, i) => [c.oid, i]))
    for (const c of commits) for (const p of c.parents) expect(index.get(p)!).toBeGreaterThan(index.get(c.oid)!)
  })

  test('subjects and bodies containing separators and quotes are intact', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    writeFileSync(join(dir, 'b.txt'), 'y\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'a|b, "c" \t d', '-m', 'x\u001fy ,\n,')
    const [tip] = (await history(dir)).commits
    expect(tip!.subject).toBe('a|b, "c" \t d')
    expect(tip!.body).toBe('x\u001fy ,\n,')
  })

  test('an unborn HEAD has no commits', async () => {
    const dir = fixture.scratch()
    Bun.spawnSync(['mkdir', '-p', dir])
    git(dir, 'init', '-q', '-b', 'main')
    expect(await history(dir)).toEqual({ commits: [], hasMore: false })
  })
})

describe('commitFiles', () => {
  test('SC-53: lists the first parent diff with renames and counts', async () => {
    const dir = makeRepo(fixture.scratch(), { 'math.ts': 'a\nb\n', 'old.ts': 'o1\no2\no3\no4\n' })
    const parent = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'mv', 'old.ts', 'new.ts')
    writeFileSync(join(dir, 'math.ts'), 'a\nb\nc\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'C')
    const c = git(dir, 'rev-parse', 'HEAD')
    const result = await commitFiles(dir, 'HEAD')
    expect(result.commit).toBe(c)
    expect(result.parent).toBe(parent)
    const byPath = Object.fromEntries(result.entries.map((e) => [e.path, e]))
    expect(byPath['math.ts']).toMatchObject({ status: 'modified', added: 1, removed: 0 })
    expect(byPath['new.ts']).toMatchObject({ status: 'renamed', oldPath: 'old.ts' })
  })

  test('a root commit has a null parent and lists its files as added', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'one\n' })
    commitAll(dir, { 'b.txt': 'two\n' })
    const root = git(dir, 'rev-list', '--max-parents=0', 'HEAD')
    const result = await commitFiles(dir, root)
    expect(result.parent).toBeNull()
    expect(result.entries).toEqual([{ path: 'a.txt', status: 'added', added: 1, removed: 0, binary: false }])
  })

  test('an unknown commit throws', async () => {
    const dir = makeRepo(fixture.scratch())
    await expect(commitFiles(dir, 'nope')).rejects.toThrow(new GitError('Unknown commit nope', '', 1).message)
    await expect(commitFiles(dir, '--all')).rejects.toBeInstanceOf(GitError)
    await expect(commitFiles(dir, 'a'.repeat(40))).rejects.toBeInstanceOf(GitError)
  })
})

describe('listBranches', () => {
  function branchRepo(): string {
    const dir = makeRepo(fixture.scratch())
    for (const b of ['zeta', 'Alpha', 'release/1.0']) git(dir, 'branch', b)
    for (const r of ['refs/remotes/origin/main', 'refs/remotes/origin/release/1.0', 'refs/remotes/origin/HEAD']) {
      git(dir, 'update-ref', r, 'HEAD')
    }
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    return dir
  }

  test('locals first then by name, remotes after, */HEAD dropped, current reported', async () => {
    const dir = branchRepo()
    const { refs, current } = await listBranches(dir)
    expect(current).toBe('main')
    expect(refs).toEqual([
      { name: 'Alpha', kind: 'local' },
      { name: 'main', kind: 'local' },
      { name: 'release/1.0', kind: 'local' },
      { name: 'zeta', kind: 'local' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'origin/release/1.0', kind: 'remote' }
    ])
  })

  test('the query is a case-insensitive substring', async () => {
    const dir = branchRepo()
    const { refs } = await listBranches(dir, 'REL')
    expect(refs.map((r) => r.name)).toEqual(['release/1.0', 'origin/release/1.0'])
  })

  test('a detached HEAD has no current branch and results are capped at 200', async () => {
    const dir = makeRepo(fixture.scratch())
    const creates = Array.from({ length: 230 }, (_, i) => `create refs/heads/b${String(i).padStart(3, '0')} HEAD\n`).join('')
    Bun.spawnSync(['git', 'update-ref', '--stdin'], { cwd: dir, stdin: new TextEncoder().encode(creates) })
    git(dir, 'checkout', '-q', '--detach')
    const { refs, current } = await listBranches(dir)
    expect(current).toBeNull()
    expect(refs).toHaveLength(200)
    expect(refs[0]!.name).toBe('b000')
  })
})
