import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitApi } from '../src/api'
import { MAX_BLOB_BYTES, stagedPatch } from '../src/diffs'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'

const { scratch } = isolateGitConfig()

describe('stagedPatch', () => {
  test('returns the minimal staged patch without colour', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\ntwo\nthree\n' })
    writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\n')
    git(repo, 'add', 'a.txt')
    const { patch, omitted } = await stagedPatch(repo)
    expect(omitted).toBe(false)
    expect(patch).toStartWith('diff --git a/a.txt b/a.txt\n')
    expect(patch).toContain('-two\n+2\n')
    expect(patch).not.toContain('\u001b')
  })

  test('ignores unstaged changes', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n' })
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    expect(await stagedPatch(repo)).toEqual({ patch: '', omitted: false })
  })

  test('does not run a configured external diff tool', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n' })
    git(repo, 'config', 'diff.external', 'false')
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    git(repo, 'add', 'a.txt')
    const { patch } = await stagedPatch(repo)
    expect(patch).toContain('+two\n')
  })

  test('reports a patch over 10 MiB as omitted and empty', async () => {
    const repo = makeRepo(scratch())
    const line = `${'x'.repeat(63)}\n`
    writeFileSync(join(repo, 'big.txt'), line.repeat(Math.ceil((MAX_BLOB_BYTES + 1024) / line.length)))
    git(repo, 'add', 'big.txt')
    expect(await stagedPatch(repo)).toEqual({ patch: '', omitted: true })
  })

  test('is reachable through gitApi', () => {
    expect(gitApi().stagedPatch).toBe(stagedPatch)
  })
})
