import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { diffSource, stagedPatch } from '../src/diffs'
import { GitError } from '../src/index'
import { runGit } from '../src/run'
import { gitDirOf, statusV2 } from '../src/status'

const { scratch } = isolateGitConfig()
const realGit = Bun.which('git')!
const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

/** Puts a `git` that runs `script` first on PATH; `$REAL_GIT` and `$LOG` are available to it. */
function fakeGit(script: string): { log: () => string[] } {
  const bin = scratch()
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls.log')
  const file = join(bin, 'git')
  writeFileSync(file, `#!/bin/sh\nREAL_GIT=${realGit}\nLOG=${log}\necho "$@" >> "$LOG"\n${script}\n`)
  chmodSync(file, 0o755)
  process.env.PATH = `${bin}:${originalPath}`
  return { log: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
}

describe('gitDirOf', () => {
  test('caches a successful lookup per worktree', async () => {
    const dir = makeRepo(scratch())
    const first = await gitDirOf(dir)
    expect(first).toBe(join(dir, '.git'))
    fakeGit('exit 1')
    expect(await gitDirOf(dir)).toBe(first)
  })

  test('a lookup that never settles fails within the bound and the next call retries', async () => {
    const dir = makeRepo(scratch())
    const fake = fakeGit('exec sleep 30')
    const started = Date.now()
    const failure = await gitDirOf(dir, 300).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(GitError)
    expect((failure as Error).message).toContain('timed out')
    expect(Date.now() - started).toBeLessThan(5_000)

    process.env.PATH = originalPath
    expect(await gitDirOf(dir)).toBe(join(dir, '.git'))
    expect(fake.log()).toHaveLength(1)
  })

  test('a failed lookup is not cached', async () => {
    const dir = makeRepo(scratch())
    fakeGit('echo boom >&2; exit 3')
    await expect(gitDirOf(dir)).rejects.toThrow(GitError)
    process.env.PATH = originalPath
    expect(await gitDirOf(dir)).toBe(join(dir, '.git'))
  })
})

/**
 * Bun on Linux can lose the wakeup for a subprocess pipe when several children exit in one loop
 * turn: git has exited, its bytes sit unread in the socket and the read never settles. A
 * descendant that keeps the pipe open after git exits looks the same from here.
 */
describe('git output that never ends after git exited', () => {
  const heldOpen = 'sleep 4 &\necho hello\nexit 0'

  test('a read-only run retries and then fails instead of hanging', async () => {
    const dir = makeRepo(scratch())
    const fake = fakeGit(heldOpen)
    const started = Date.now()
    const failure = await runGit(dir, ['rev-parse', 'HEAD'], { readOnly: true, stallMs: 100 }).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(GitError)
    expect((failure as Error).message).toContain('did not end')
    expect(fake.log()).toHaveLength(3)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test('a read-only run succeeds when a retry gets through', async () => {
    const dir = makeRepo(scratch())
    const fake = fakeGit(`if [ "$(wc -l < "$LOG")" -le 1 ]; then ${heldOpen}; fi\nexec "$REAL_GIT" "$@"`)
    const result = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], { readOnly: true, stallMs: 100 })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe('true')
    expect(fake.log()).toHaveLength(2)
  })

  test('a command that may write is never run twice', async () => {
    const dir = makeRepo(scratch())
    const fake = fakeGit(heldOpen)
    const failure = await runGit(dir, ['tag', 'x'], { stallMs: 100 }).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(GitError)
    expect(fake.log()).toHaveLength(1)
  })

  test('a streamed status retries a read that stalled', async () => {
    const dir = makeRepo(scratch())
    writeFileSync(join(dir, 'new.txt'), 'x\n')
    const fake = fakeGit(`if [ "$(grep -c status "$LOG")" -le 1 ] && [ "$1" = -c ]; then ${heldOpen}; fi\nexec "$REAL_GIT" "$@"`)
    const status = await statusV2(dir)
    expect(status.entries.map((e) => e.path)).toEqual(['new.txt'])
    expect(fake.log().filter((line) => line.includes('status --porcelain=v2'))).toHaveLength(2)
  })
  test('a blob read for a diff retries a read that stalled', async () => {
    const dir = makeRepo(scratch(), { 'a.txt': 'one\n' })
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const fake = fakeGit(`if [ "$1" = show ] && [ "$(grep -c '^show' "$LOG")" -le 1 ]; then ${heldOpen}; fi\nexec "$REAL_GIT" "$@"`)
    const diff = await diffSource(dir, { path: 'a.txt', source: 'unstaged' })
    expect(diff).toMatchObject({ original: 'one\n', modified: 'two\n' })
    expect(fake.log().filter((line) => line.startsWith('show'))).toHaveLength(2)
  })

  test('a patch read retries a read that stalled', async () => {
    const dir = makeRepo(scratch(), { 'a.txt': 'one\n' })
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    Bun.spawnSync(['git', 'add', 'a.txt'], { cwd: dir })
    const fake = fakeGit(`if [ "$1" = diff ] && [ "$(grep -c '^diff' "$LOG")" -le 1 ]; then ${heldOpen}; fi\nexec "$REAL_GIT" "$@"`)
    const { patch, omitted } = await stagedPatch(dir)
    expect(omitted).toBe(false)
    expect(patch).toContain('+two')
    expect(fake.log().filter((line) => line.startsWith('diff'))).toHaveLength(2)
  })
})
