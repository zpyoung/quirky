import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type GitDiff } from '@quirky/protocol'
import { commitInFeat, isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const diff = (params: Record<string, unknown>): Promise<GitDiff> => s!.api('diff', params)
const PNG = (marker: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker])

describe('diff sources', () => {
  test('SC-55: staged reads HEAD to index, unstaged reads index to disk, and untracked files diff against nothing', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'v2\n')
    s.gitIn('add', 'math.ts')
    s.write('math.ts', 'v3\n')
    s.write('notes.txt', 'fresh\n')

    expect(await diff({ path: 'math.ts', source: 'staged' })).toMatchObject({ source: 'staged', staged: true, original: 'a\nb\nc\nd\ne\n', modified: 'v2\n', kind: 'text' })
    expect(await diff({ path: 'math.ts', source: 'unstaged' })).toMatchObject({ source: 'unstaged', staged: false, original: 'v2\n', modified: 'v3\n', kind: 'text' })
    expect(await diff({ path: 'notes.txt', source: 'unstaged' })).toMatchObject({ original: '', modified: 'fresh\n' })
  })

  test('SC-55: the v1 staged flag means the staged source, and the source defaults to unstaged', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'v2\n')
    s.gitIn('add', 'math.ts')
    s.write('math.ts', 'v3\n')
    expect(await diff({ path: 'math.ts', staged: true })).toMatchObject({ source: 'staged', staged: true, modified: 'v2\n' })
    expect(await diff({ path: 'math.ts', staged: false })).toMatchObject({ source: 'unstaged', modified: 'v3\n' })
    expect(await diff({ path: 'math.ts' })).toMatchObject({ source: 'unstaged', original: 'v2\n' })
    expect(await diff({ path: 'math.ts', source: 'staged', staged: false })).toMatchObject({ source: 'staged' })
    const unstaged = await diff({ path: 'math.ts' })
    expect(unstaged.modifiedHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('SC-55: branch reads the merge base to head of the current compare, or the oids it is given', async () => {
    s = await startScenario(scratch)
    const base = s.gitIn('rev-parse', 'HEAD')
    commitInFeat(s, { 'util.ts': 'util\n', 'math.ts': 'v1\n' }, 'first')
    s.gitIn('mv', 'old.ts', 'renamed.ts')
    const head = commitInFeat(s, { 'math.ts': 'v2\n' }, 'second')

    expect(await diff({ path: 'util.ts', source: 'branch' })).toMatchObject({ source: 'branch', original: '', modified: 'util\n' })
    expect(await diff({ path: 'math.ts', source: 'branch' })).toMatchObject({ original: 'a\nb\nc\nd\ne\n', modified: 'v2\n' })
    expect(await diff({ path: 'renamed.ts', oldPath: 'old.ts', source: 'branch' })).toMatchObject({
      oldPath: 'old.ts',
      original: 'export const a = 1\nexport const b = 2\n',
      modified: 'export const a = 1\nexport const b = 2\n'
    })
    expect(await diff({ path: 'math.ts', source: 'branch', mergeBase: base, head })).toMatchObject({ original: 'a\nb\nc\nd\ne\n', modified: 'v2\n' })
    const middle = s.gitIn('rev-parse', 'HEAD~1')
    expect(await diff({ path: 'math.ts', source: 'branch', head: middle })).toMatchObject({ original: 'a\nb\nc\nd\ne\n', modified: 'v1\n' })
  })

  test('SC-53: commit reads the first parent to the commit, defaulting the parent, and a root commit against nothing', async () => {
    s = await startScenario(scratch)
    const root = s.gitIn('rev-parse', 'HEAD')
    const commit = commitInFeat(s, { 'math.ts': 'changed\n' }, 'change')
    expect(await diff({ path: 'math.ts', source: 'commit', commit })).toMatchObject({ source: 'commit', original: 'a\nb\nc\nd\ne\n', modified: 'changed\n' })
    expect(await diff({ path: 'math.ts', source: 'commit', commit, parent: root })).toMatchObject({ original: 'a\nb\nc\nd\ne\n' })
    expect(await diff({ path: 'README.md', source: 'commit', commit: root })).toMatchObject({ original: '', modified: 'one\ntwo\n' })
  })

  test('branch needs a ready compare, and commit needs a commit; oids must be full lowercase hex', async () => {
    s = await startScenario(scratch)
    await s.client.callAny('quirky.worktree/set', { worktree: s.feat.id, baseRef: 'origin/gone' })
    expect(await s.fails(diff({ path: 'math.ts', source: 'branch' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Base ref origin/gone could not be resolved in this repository.'
    })
    expect(await s.fails(diff({ path: 'math.ts', source: 'commit' }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    for (const params of [{ mergeBase: 'HEAD', head: 'a'.repeat(40) }, { commit: 'HEAD' }, { commit: 'A'.repeat(40) }, { commit: 'a'.repeat(40), parent: 'abc' }]) {
      const source = 'commit' in params ? 'commit' : 'branch'
      expect(await s.fails(diff({ path: 'math.ts', source, ...params })), JSON.stringify(params)).toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
  })

  test('SC-57: a branch or commit diff git cannot read fails with git\'s message instead of looking empty', async () => {
    s = await startScenario(scratch)
    const head = s.gitIn('rev-parse', 'HEAD')
    const missing = 'b'.repeat(40)
    const branch = await s.fails(diff({ path: 'math.ts', source: 'branch', mergeBase: missing, head }))
    expect(branch).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'failed' } })
    expect(branch.message).toContain(missing)
    const commit = await s.fails(diff({ path: 'math.ts', source: 'commit', commit: missing, parent: head }))
    expect(commit).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'failed' } })
    expect(commit.message).toContain(missing)
  })

  test('the path must stay inside the worktree for every source', async () => {
    s = await startScenario(scratch)
    for (const source of ['staged', 'unstaged', 'branch', 'commit']) {
      expect(await s.fails(diff({ path: '../x', source, commit: 'a'.repeat(40) })), source).toMatchObject({
        code: RpcErrorCode.InvalidParams,
        data: { reason: 'outside-worktree' }
      })
    }
    expect(await s.fails(diff({ path: 'math.ts', oldPath: '/etc/passwd', source: 'branch' }))).toMatchObject({ data: { reason: 'outside-worktree' } })
  })
})

describe('diff content kinds', () => {
  test('SC-56: images, binary files, files over the render limit, huge files and deleted files', async () => {
    s = await startScenario(scratch)
    const root = s.feat.path
    writeFileSync(join(root, 'logo.png'), PNG(1))
    writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(root, 'big.txt'), Array.from({ length: 130_000 }, (_, i) => `line ${i}\n`).join(''))
    writeFileSync(join(root, 'huge.json'), '{}\n')
    commitInFeat(s, {}, 'assets')
    writeFileSync(join(root, 'logo.png'), PNG(2))
    writeFileSync(join(root, 'blob.bin'), Buffer.from([4, 5, 0, 6]))
    writeFileSync(join(root, 'big.txt'), Array.from({ length: 130_000 }, (_, i) => `changed ${i}\n`).join(''))
    writeFileSync(join(root, 'huge.json'), Buffer.alloc(11 * 1024 * 1024, 0x61))
    rmSync(join(root, 'c.ts'))

    const logo = await diff({ path: 'logo.png' })
    expect(logo).toMatchObject({ kind: 'image', binary: true, mime: 'image/png' })
    expect(logo.original).toBe(PNG(1).toString('base64'))
    expect(logo.modified).toBe(PNG(2).toString('base64'))
    expect(await diff({ path: 'blob.bin' })).toMatchObject({ kind: 'binary', binary: true, original: '', modified: '' })
    expect(await diff({ path: 'huge.json' })).toMatchObject({ kind: 'binary', binary: true, original: '', modified: '' })
    const big = await diff({ path: 'big.txt' })
    expect(big).toMatchObject({ kind: 'text', binary: false, original: '', modified: '', tooLarge: { originalLines: 130_000, modifiedLines: 130_000, reason: 'lines' } })
    expect(await diff({ path: 'c.ts' })).toMatchObject({ original: 'sea\n', modified: '', modifiedDeleted: true, modifiedHash: null })
  })

  test('SC-67: a symlinked file diffs as its link text, never the target', async () => {
    s = await startScenario(scratch)
    symlinkSync('/etc/hosts', join(s.feat.path, 'link.txt'))
    const result = await diff({ path: 'link.txt' })
    expect(result.modified).toBe('/etc/hosts')
    expect(result.original).toBe('')
  })
})
