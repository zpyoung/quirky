import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanForRepos } from '../src/scan'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tree(repos: string[], plain: string[] = []): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qd-scan-')))
  dirs.push(root)
  for (const repo of repos) mkdirSync(join(root, repo, '.git'), { recursive: true })
  for (const dir of plain) mkdirSync(join(root, dir), { recursive: true })
  return root
}

const names = (result: { repos: { name: string }[] }) => result.repos.map((r) => r.name)

describe('scanForRepos', () => {
  test('finds repos by their .git entry and returns them sorted by path', async () => {
    const root = tree(['web', 'cli'], ['docs'])
    const result = await scanForRepos(root, { maxDepth: 3, maxRepos: 100 })
    expect(result).toEqual({
      repos: [
        { path: join(root, 'cli'), name: 'cli' },
        { path: join(root, 'web'), name: 'web' }
      ],
      truncated: false
    })
  })

  test('a .git file (a linked worktree) counts as a repo', async () => {
    const root = tree([], ['linked'])
    writeFileSync(join(root, 'linked', '.git'), 'gitdir: /elsewhere\n')
    expect(names(await scanForRepos(root, { maxDepth: 3, maxRepos: 100 }))).toEqual(['linked'])
  })

  test('respects the depth: a repo four levels down needs maxDepth 4', async () => {
    const root = tree(['a/b/c/deep', 'a/shallow'])
    expect(names(await scanForRepos(root, { maxDepth: 3, maxRepos: 100 }))).toEqual(['shallow'])
    expect(names(await scanForRepos(root, { maxDepth: 4, maxRepos: 100 }))).toEqual(['deep', 'shallow'])
    expect(names(await scanForRepos(root, { maxDepth: 1, maxRepos: 100 }))).toEqual([])
  })

  test('skips node_modules, build output and hidden folders', async () => {
    const root = tree(['node_modules/pkg', 'dist/x', '.cache/y', 'vendor/z', 'ok'])
    expect(names(await scanForRepos(root, { maxDepth: 3, maxRepos: 100 }))).toEqual(['ok'])
  })

  test('does not descend into a repo it found', async () => {
    const root = tree(['web', 'web/vendored', 'cli'])
    expect(names(await scanForRepos(root, { maxDepth: 3, maxRepos: 100 }))).toEqual(['cli', 'web'])
  })

  test('the scanned folder itself is returned when it is a repo', async () => {
    const root = tree(['.'], ['inner'])
    const result = await scanForRepos(root, { maxDepth: 3, maxRepos: 100 })
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0]!.path).toBe(root)
  })

  test('stops at maxRepos and reports truncation', async () => {
    const root = tree(['a', 'b', 'c'])
    expect(await scanForRepos(root, { maxDepth: 3, maxRepos: 2 })).toEqual({
      repos: [
        { path: join(root, 'a'), name: 'a' },
        { path: join(root, 'b'), name: 'b' }
      ],
      truncated: true
    })
    expect((await scanForRepos(root, { maxDepth: 3, maxRepos: 3 })).truncated).toBe(false)
  })

  test('does not follow symlinks', async () => {
    const root = tree(['real'])
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(names(await scanForRepos(root, { maxDepth: 3, maxRepos: 100 }))).toEqual(['real'])
  })

  test('a missing folder rejects', async () => {
    await expect(scanForRepos(join(tmpdir(), 'qd-scan-missing-x'), { maxDepth: 3, maxRepos: 100 })).rejects.toThrow()
  })
})
