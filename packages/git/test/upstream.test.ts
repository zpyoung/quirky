import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { effectiveUpstream } from '../src/upstream'

const { scratch } = isolateGitConfig()

const none = { upstream: null, ahead: 0, behind: 0 }

function bareOrigin(): string {
  const origin = scratch()
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  return origin
}

/** A clone of a bare origin with `main` pushed and tracking. */
function cloneWithOrigin(): string {
  const dir = makeRepo(scratch())
  git(dir, 'remote', 'add', 'origin', bareOrigin().toString())
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  return dir
}

function commitFile(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text)
  git(dir, 'add', name)
  git(dir, 'commit', '-q', '-m', `edit ${name}`)
}

describe('effectiveUpstream', () => {
  test('a detached or missing branch has no upstream', async () => {
    const dir = cloneWithOrigin()
    expect(await effectiveUpstream(dir, null, none)).toEqual({
      hasUpstream: false,
      name: null,
      sha: null,
      ahead: 0,
      behind: 0,
      behindPatchEquivalent: null
    })
  })

  test('uses the porcelain upstream and counts when given', async () => {
    const dir = cloneWithOrigin()
    const sha = git(dir, 'rev-parse', 'origin/main')
    const result = await effectiveUpstream(dir, 'main', { upstream: 'origin/main', ahead: 3, behind: 0 })
    expect(result).toEqual({ hasUpstream: true, name: 'origin/main', sha, ahead: 3, behind: 0, behindPatchEquivalent: null })
  })

  test('reads @{upstream} when porcelain has none, and counts with rev-list', async () => {
    const dir = cloneWithOrigin()
    commitFile(dir, 'b.txt', 'b\n')
    commitFile(dir, 'c.txt', 'c\n')
    const result = await effectiveUpstream(dir, 'main', none)
    expect(result).toMatchObject({ hasUpstream: true, name: 'origin/main', ahead: 2, behind: 0, behindPatchEquivalent: null })
    expect(result.sha).toBe(git(dir, 'rev-parse', 'origin/main'))
  })

  test('falls back to the remote-tracking ref of the same name when nothing is configured', async () => {
    const dir = cloneWithOrigin()
    git(dir, 'checkout', '-q', '-b', 'feat')
    commitFile(dir, 'f.txt', 'f\n')
    git(dir, 'push', '-q', 'origin', 'feat')
    expect(Bun.spawnSync(['git', 'config', '--get', 'branch.feat.remote'], { cwd: dir }).exitCode).toBe(1)
    const result = await effectiveUpstream(dir, 'feat', none)
    expect(result).toMatchObject({ hasUpstream: true, name: 'origin/feat', ahead: 0, behind: 0 })
    expect(result.sha).toBe(git(dir, 'rev-parse', 'origin/feat'))
  })

  test('the fallback uses branch.<b>.remote when that is not origin', async () => {
    const dir = cloneWithOrigin()
    git(dir, 'remote', 'add', 'fork', bareOrigin())
    git(dir, 'checkout', '-q', '-b', 'feat')
    git(dir, 'config', 'branch.feat.remote', 'fork')
    git(dir, 'push', '-q', 'fork', 'feat')
    commitFile(dir, 'f.txt', 'f\n')
    const result = await effectiveUpstream(dir, 'feat', none)
    expect(result).toMatchObject({ name: 'fork/feat', hasUpstream: true, ahead: 1, behind: 0 })
  })

  test('no upstream anywhere', async () => {
    const dir = makeRepo(scratch())
    expect(await effectiveUpstream(dir, 'main', none)).toEqual({
      hasUpstream: false,
      name: null,
      sha: null,
      ahead: 0,
      behind: 0,
      behindPatchEquivalent: null
    })
  })

  test('behind-only counts come from rev-list', async () => {
    const dir = cloneWithOrigin()
    commitFile(dir, 'b.txt', 'b\n')
    git(dir, 'push', '-q')
    git(dir, 'reset', '-q', '--hard', 'HEAD~1')
    const result = await effectiveUpstream(dir, 'main', none)
    expect(result).toMatchObject({ ahead: 0, behind: 1, behindPatchEquivalent: null })
  })

  test('a rebased branch is patch-equivalent', async () => {
    const dir = cloneWithOrigin()
    git(dir, 'checkout', '-q', '-b', 'feat')
    commitFile(dir, 'a1.txt', '1\n')
    commitFile(dir, 'a2.txt', '2\n')
    git(dir, 'push', '-q', '-u', 'origin', 'feat')
    git(dir, 'checkout', '-q', 'main')
    commitFile(dir, 'm.txt', 'm\n')
    git(dir, 'checkout', '-q', 'feat')
    git(dir, 'rebase', '-q', 'main')

    const result = await effectiveUpstream(dir, 'feat', { upstream: 'origin/feat', ahead: 2, behind: 2 })
    expect(result).toMatchObject({ ahead: 2, behind: 2, behindPatchEquivalent: true })
  })

  test('diverged histories with different changes are not patch-equivalent', async () => {
    const dir = cloneWithOrigin()
    git(dir, 'checkout', '-q', '-b', 'feat')
    commitFile(dir, 'a1.txt', '1\n')
    git(dir, 'push', '-q', '-u', 'origin', 'feat')
    git(dir, 'reset', '-q', '--hard', 'HEAD~1')
    commitFile(dir, 'other.txt', 'local\n')
    git(dir, 'checkout', '-q', 'main')
    git(dir, 'checkout', '-q', 'feat')

    const result = await effectiveUpstream(dir, 'feat', none)
    expect(result).toMatchObject({ ahead: 1, behind: 1, behindPatchEquivalent: false })
  })

  test('patch equivalence is only computed when diverged', async () => {
    const dir = cloneWithOrigin()
    commitFile(dir, 'b.txt', 'b\n')
    expect((await effectiveUpstream(dir, 'main', { upstream: 'origin/main', ahead: 1, behind: 0 })).behindPatchEquivalent).toBeNull()
  })
})
