import { afterEach, describe, expect, test } from 'bun:test'
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
    const fake = createFakeGit()
    fake.addRepo('/repo')
    await fake.addWorktree('/repo', '/wt/a', 'a', 'main')
    expect((await fake.listWorktrees('/repo')).map((w) => w.path)).toEqual(['/repo', '/wt/a'])
    await fake.removeWorktree('/repo', '/wt/a', false)
    expect((await fake.listWorktrees('/repo')).map((w) => w.path)).toEqual(['/repo'])
  })

  test('the fake rejects paths outside any registered repo', async () => {
    const fake = createFakeGit()
    await expect(fake.resolveRepoRoot('/nowhere')).rejects.toBeInstanceOf(realGit.GitError)
  })
})
