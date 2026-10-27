import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { GitStatus } from '@quirky/protocol'
import { commitFiles, git } from '../../../quirky.repo/test/git-fixtures'
import { isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

describe('status', () => {
  test('SC-1: status lists every row with its area, status and line counts', async () => {
    s = await startScenario(scratch)
    s.write('README.md', 'one\nTWO\nthree\n')
    s.gitIn('add', 'README.md')
    s.write('math.ts', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n')
    s.gitIn('mv', 'old.ts', 'new.ts')
    s.write('notes.txt', 'x\ny\nz\n')

    const result = await s.cli(['git', 'status', '--json'])
    expect(result.code).toBe(0)
    const status = JSON.parse(result.stdout) as GitStatus
    expect(status).toMatchObject({ branch: 'zoe/feat', ahead: 0, behind: 0, operation: 'none', capped: false, busy: null })
    expect(status.files.map((file) => file.path).sort()).toEqual(['README.md', 'math.ts', 'new.ts', 'notes.txt'])
    const byPath = [...status.entries].sort((a, b) => a.path.localeCompare(b.path, 'en'))
    expect(byPath).toEqual([
      { path: 'math.ts', area: 'unstaged', status: 'modified', added: 5, removed: 0 },
      { path: 'new.ts', oldPath: 'old.ts', area: 'staged', status: 'renamed', added: 0, removed: 0 },
      { path: 'notes.txt', area: 'untracked', status: 'untracked', added: 3, removed: 0 },
      { path: 'README.md', area: 'staged', status: 'modified', added: 2, removed: 1 }
    ])
  })

  test('SC-2: one path can be both staged and changed', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'a\nb\nc\nd\ne\nf\n')
    s.gitIn('add', 'math.ts')
    s.write('math.ts', 'a\nb\nc\nd\ne\nf\ng\nh\n')

    const status: GitStatus = await s.api('status')
    expect(status.entries.filter((entry) => entry.path === 'math.ts')).toMatchObject([
      { area: 'staged', added: 1, removed: 0 },
      { area: 'unstaged', added: 2, removed: 0 }
    ])
    expect(status.files.filter((file) => file.path === 'math.ts')).toEqual([
      { path: 'math.ts', index: 'M', worktree: 'M', untracked: false }
    ])
  })

  test('SC-5: detached and unborn HEADs are reported', async () => {
    s = await startScenario(scratch)
    const head = s.gitIn('rev-parse', 'HEAD')
    s.gitIn('checkout', '-q', '--detach')
    expect(await s.api('status')).toMatchObject({ detached: true, branch: null, head, unborn: false })

    const emptyDir = join(scratch(), 'empty')
    mkdirSync(emptyDir, { recursive: true })
    git(emptyDir, 'init', '-q', '-b', 'trunk')
    const empty = await s.client.callAny('quirky.repo/add', { path: emptyDir })
    const worktrees = (await s.client.callAny('quirky.worktree/list', { repo: (empty as { id: string }).id })) as { id: string }[]
    expect(await s.client.callAny('quirky.git/status', { worktree: worktrees[0]!.id })).toMatchObject({
      unborn: true,
      head: null,
      branch: 'trunk',
      detached: false
    })
  })

  test('SC-6: shared-directory symlinks are hidden from untracked files and not staged by scope all', async () => {
    s = await startScenario(scratch)
    commitFiles(s.repoDir, { 'quirky.yaml': 'worktree:\n  sharedDirectories:\n    - node_modules\n' })
    symlinkSync(join(s.repoDir, 'node_modules'), join(s.feat.path, 'node_modules'))
    s.write('scratch.txt', 'hello\n')

    const status: GitStatus = await s.api('status')
    expect(status.entries.map((entry) => [entry.area, entry.path])).toEqual([['untracked', 'scratch.txt']])

    await s.api('stage', { scope: 'all' })
    expect(s.gitIn('diff', '--cached', '--name-only')).toBe('scratch.txt')
    expect(s.gitIn('status', '--porcelain')).toContain('?? node_modules')
  })

  test('SC-58: a huge status is capped at 1000 entries without line counts', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'changed\n')
    for (let i = 0; i < 1500; i++) s.write(`many/f${String(i).padStart(4, '0')}.txt`, 'x\n')

    const result = await s.cli(['git', 'status', '--json'])
    const status = JSON.parse(result.stdout) as GitStatus
    expect(status.capped).toBe(true)
    expect(status.entries).toHaveLength(1000)
    expect(status.entries.every((entry) => entry.added === undefined)).toBe(true)

    await s.api('stage', { scope: 'tracked' })
    expect(s.gitIn('diff', '--cached', '--name-only')).toBe('math.ts')
    rmSync(join(s.feat.path, 'many'), { recursive: true })
  })
})
