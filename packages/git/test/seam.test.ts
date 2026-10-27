import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realGit from '../src/index'
import { gitApi } from '../src/api'
import { createFakeGit, useTestGit } from '../src/testing'

afterEach(() => useTestGit(null))

describe('git test seam', () => {
  test('gitApi returns the real module functions when no fake is installed', () => {
    const api = gitApi()
    expect(api.status).toBe(realGit.status)
    expect(api.addWorktree).toBe(realGit.addWorktree)
  })

  test('gitApi returns the installed fake and reverts after clearing', async () => {
    const fake = createFakeGit()
    fake.addRepo('/repo')
    useTestGit(fake)
    expect(gitApi()).toBe(fake)
    expect(await gitApi().resolveRepoRoot('/repo/sub')).toBe('/repo')
    expect(fake.calls.map((c) => c.fn)).toEqual(['resolveRepoRoot'])

    useTestGit(null)
    expect(gitApi().status).toBe(realGit.status)
  })

  test('the fake edits an in-memory worktree list', async () => {
    // the fake creates the worktree folder, so it needs a writable place
    const dir = mkdtempSync(join(tmpdir(), 'qg-seam-'))
    const worktree = join(dir, 'a')
    const fake = createFakeGit()
    fake.addRepo('/repo')
    try {
      await fake.addWorktree('/repo', worktree, 'a', 'main')
      expect((await fake.listWorktrees('/repo')).map((w) => w.path)).toEqual(['/repo', worktree])
      await fake.removeWorktree('/repo', worktree, false)
      expect((await fake.listWorktrees('/repo')).map((w) => w.path)).toEqual(['/repo'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the fake rejects paths outside any registered repo', async () => {
    const fake = createFakeGit()
    await expect(fake.resolveRepoRoot('/nowhere')).rejects.toBeInstanceOf(realGit.GitError)
  })
})
