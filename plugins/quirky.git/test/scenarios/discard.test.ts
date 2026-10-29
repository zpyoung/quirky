import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { diverge, isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const read = (rel: string) => readFileSync(join(s!.feat.path, rel), 'utf8')

describe('discard', () => {
  test('SC-19: discarding a changed file asks first, and --yes does not (CLI)', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'edited\n')

    const asked = await s.cliAsk(['git', 'discard', '--paths', 'math.ts'], true)
    expect(asked.code).toBe(0)
    expect(asked.stderr).toContain(
      'confirm in Quirky: Discard changes to "math.ts"? This will revert the unstaged changes to this file. This cannot be undone.'
    )
    expect(read('math.ts')).toBe('a\nb\nc\nd\ne\n')
    expect(await s.askCount()).toBe(1)

    s.write('math.ts', 'edited again\n')
    const yes = await s.cli(['git', 'discard', '--paths', 'math.ts', '--yes'])
    expect(yes.code).toBe(0)
    expect(read('math.ts')).toBe('a\nb\nc\nd\ne\n')
    expect(await s.askCount()).toBe(1)
  })

  test('SC-19: a declined ask changes nothing (CLI)', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'edited\n')
    const declined = await s.cliAsk(['git', 'discard', '--paths', 'math.ts'], false)
    expect(declined.code).not.toBe(0)
    expect(read('math.ts')).toBe('edited\n')
  })

  test('SC-20: untracked files are deleted and deleted files restored', async () => {
    s = await startScenario(scratch)
    s.write('notes.txt', 'n\n')
    s.write('tmp/x', 'x\n')
    s.write('tmp/y', 'y\n')
    rmSync(join(s.feat.path, 'c.ts'))

    const asked = await s.fails(s.api('discard', { paths: ['notes.txt', 'tmp/x', 'c.ts'] }))
    expect(asked.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(existsSync(join(s.feat.path, 'notes.txt'))).toBe(true)

    await s.api('discard', { paths: ['notes.txt', 'tmp/x', 'c.ts'], yes: true })
    expect(existsSync(join(s.feat.path, 'notes.txt'))).toBe(false)
    expect(existsSync(join(s.feat.path, 'tmp/x'))).toBe(false)
    expect(existsSync(join(s.feat.path, 'tmp/y'))).toBe(true)
    expect(read('c.ts')).toBe('sea\n')
  })

  test('SC-20: a whole untracked folder can be discarded by its path', async () => {
    s = await startScenario(scratch)
    mkdirSync(join(s.feat.path, 'tmp'))
    s.write('tmp/x', 'x\n')
    await s.api('discard', { paths: ['tmp'], yes: true })
    expect(existsSync(join(s.feat.path, 'tmp'))).toBe(false)
  })

  test('SC-21: discarding the staged area unstages first, deleting staged additions', async () => {
    s = await startScenario(scratch)
    s.write('README.md', 'changed\n')
    s.write('added.ts', 'new\n')
    s.gitIn('add', 'README.md', 'added.ts')
    s.gitIn('mv', 'old.ts', 'new.ts')

    await s.api('discard', { area: 'staged', yes: true })
    expect(s.gitIn('status', '--porcelain')).toBe('')
    expect(read('README.md')).toBe('one\ntwo\n')
    expect(existsSync(join(s.feat.path, 'added.ts'))).toBe(false)
    expect(existsSync(join(s.feat.path, 'new.ts'))).toBe(false)
    expect(existsSync(join(s.feat.path, 'old.ts'))).toBe(true)
  })

  test('the unstaged and untracked areas discard only their own rows', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'edited\n')
    s.write('README.md', 'staged\n')
    s.gitIn('add', 'README.md')
    s.write('notes.txt', 'n\n')

    await s.api('discard', { area: 'unstaged', yes: true })
    expect(read('math.ts')).toBe('a\nb\nc\nd\ne\n')
    expect(existsSync(join(s.feat.path, 'notes.txt'))).toBe(true)
    expect(s.gitIn('diff', '--cached', '--name-only')).toBe('README.md')

    await s.api('discard', { area: 'untracked', yes: true })
    expect(existsSync(join(s.feat.path, 'notes.txt'))).toBe(false)
    expect(s.gitIn('diff', '--cached', '--name-only')).toBe('README.md')
  })

  test('SC-22: discard refuses conflicts, resolved conflicts, submodules and paths outside the worktree', async () => {
    s = await startScenario(scratch)
    s.addSubmodule()
    diverge(s, { 'a.ts': 'theirs\n', 'b.ts': 'theirs\n' }, { 'a.ts': 'ours\n', 'b.ts': 'ours\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)
    await s.api('conflictFile', { path: 'b.ts' })
    s.write('b.ts', 'resolved\n')
    await s.api('stage', { paths: ['b.ts'] })
    const before = s.gitIn('status', '--porcelain')

    const refusals = {
      'a.ts': 'not-discardable',
      'b.ts': 'not-discardable',
      'vendor/lib': 'not-discardable',
      '../outside.txt': 'outside-worktree'
    }
    for (const [path, reason] of Object.entries(refusals)) {
      const failure = await s.fails(s.api('discard', { paths: [path], yes: true }))
      expect(failure).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason } })
    }
    expect(s.gitIn('status', '--porcelain')).toBe(before)
    expect(read('b.ts')).toBe('resolved\n')
  })

  test('discard needs exactly one of paths and area, and a path may not be absolute', async () => {
    s = await startScenario(scratch)
    expect((await s.fails(s.api('discard', { yes: true }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await s.fails(s.api('discard', { paths: ['a.ts'], area: 'staged', yes: true }))).code).toBe(RpcErrorCode.InvalidParams)
    const absolute = await s.fails(s.api('discard', { paths: [join(s.feat.path, 'a.ts')], yes: true }))
    expect(absolute.data.reason).toBe('outside-worktree')
  })

  test('a path git cannot discard fails the call with the failures listed, after discarding the rest', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'edited\n')
    s.write('locked/f.txt', 'x\n')
    chmodSync(join(s.feat.path, 'locked'), 0o555)
    try {
      const failure = await s.fails(s.api('discard', { paths: ['math.ts', 'locked/f.txt'], yes: true }))
      expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Failed to discard 1 file(s)', data: { reason: 'failed' } })
      expect(failure.data.failures).toHaveLength(1)
      expect((failure.data.failures as { path: string }[])[0]!.path).toBe('locked/f.txt')
      expect(read('math.ts')).toBe('a\nb\nc\nd\ne\n')
    } finally {
      chmodSync(join(s.feat.path, 'locked'), 0o755)
    }
  })

  test('describeDiscard words each case as the window dialog does', async () => {
    s = await startScenario(scratch)
    s.write('notes.txt', 'n\n')
    s.write('extra.txt', 'e\n')
    rmSync(join(s.feat.path, 'c.ts'))
    s.write('math.ts', 'edited\n')
    s.write('README.md', 'staged\n')
    s.gitIn('add', 'README.md')
    const undone = 'This cannot be undone.'
    const describe = (params: Record<string, unknown>) => s!.api('describeDiscard', params)

    expect(await describe({ paths: ['notes.txt'] })).toBe(`Delete "notes.txt"? This will permanently delete this file. ${undone}`)
    expect(await describe({ paths: ['c.ts'] })).toBe(
      `Restore "c.ts"? This will restore the last staged version and discard the deletion. ${undone}`
    )
    expect(await describe({ paths: ['math.ts'] })).toBe(`Discard changes to "math.ts"? This will revert the unstaged changes to this file. ${undone}`)
    expect(await describe({ area: 'untracked' })).toBe(
      `Delete 2 untracked files? This will permanently delete these 2 untracked files. ${undone}`
    )
    expect(await describe({ area: 'staged' })).toBe(
      `Discard all staged changes? This will unstage and revert all staged changes. Staged new files will be deleted. ${undone}`
    )
    expect(await describe({ area: 'unstaged' })).toBe(`Discard all unstaged changes? This will revert all unstaged changes. ${undone}`)
    const asked = await s.fails(s.api('discard', { area: 'unstaged' }))
    expect(asked.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(asked.data.action).toBe(`Discard all unstaged changes? This will revert all unstaged changes. ${undone}`)
  })
})
