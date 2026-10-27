import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { startGitHarness, type GitHarness } from './support'

let g: GitHarness
afterEach(() => g.cleanup())

describe('quirky.git against a real repository', () => {
  test('status, diff, stage, unstage and commit work on a temp repo', async () => {
    g = await startGitHarness({ realGit: true })
    const { call } = g
    writeFileSync(join(g.main.path, 'a.txt'), 'new\n')

    const dirty = await call('quirky.git/status', { worktree: g.main.id })
    expect(dirty).toMatchObject({ branch: 'main', files: [{ path: 'a.txt', index: ' ', worktree: 'M' }] })
    expect(await call('quirky.git/diff', { worktree: g.main.id, path: 'a.txt' })).toMatchObject({
      staged: false,
      original: 'old\n',
      modified: 'new\n'
    })

    await call('quirky.git/stage', { worktree: g.main.id, paths: ['a.txt'] })
    expect((await call('quirky.git/status', { worktree: g.main.id })).files[0]).toMatchObject({ index: 'M', worktree: ' ' })
    await call('quirky.git/unstage', { worktree: g.main.id, paths: ['a.txt'] })
    expect((await call('quirky.git/status', { worktree: g.main.id })).files[0]).toMatchObject({ index: ' ', worktree: 'M' })

    await call('quirky.git/stage', { worktree: g.main.id, paths: ['a.txt'] })
    const { sha } = await call('quirky.git/commit', { worktree: g.main.id, message: 'edit' })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect((await call('quirky.git/status', { worktree: g.main.id })).files).toEqual([])
    expect(readFileSync(join(g.main.path, 'a.txt'), 'utf8')).toBe('new\n')
    await waitFor(() => g.events.filter((e) => e.type === 'quirky.git/changed').length >= 4)
  })

  test('a git failure reports git stderr', async () => {
    g = await startGitHarness({ realGit: true })
    const error = await g.call('quirky.git/stage', { worktree: g.main.id, paths: ['missing.txt'] }).catch((e) => e)
    expect(error.code).toBe(-32009)
    expect(error.data).toEqual({ reason: 'failed' })
    expect(error.message).toContain("pathspec ':(literal)missing.txt' did not match")
  })
})
