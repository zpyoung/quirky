import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { commitFiles, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { BaseError, resolveBase } from '../src/daemon/base'
import { makeOrigin, makeProject } from './fixtures/repos'

const { scratch } = isolateGitConfig()

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as BaseError
  }
  throw new Error('expected resolveBase to fail')
}

describe('resolveBase without a remote', () => {
  test('the detected default is the first of main, master', async () => {
    const dir = makeProject(join(scratch(), 'a'))
    expect(await resolveBase(dir)).toEqual({ fullRef: 'refs/heads/main', shortRef: 'main' })
    git(dir, 'branch', '-m', 'main', 'master')
    expect(await resolveBase(dir)).toEqual({ fullRef: 'refs/heads/master', shortRef: 'master' })
    git(dir, 'branch', '-m', 'master', 'trunk')
    const refused = await failureOf(resolveBase(dir))
    expect(refused).toMatchObject({ reason: 'no-base', message: 'Could not resolve a default base ref for this repo. Pass an explicit --base and try again.' })
  })

  test('a requested base wins over a saved one, a saved one over the detected, and an unusable saved one is ignored', async () => {
    const dir = makeProject(join(scratch(), 'b'))
    git(dir, 'branch', 'release')
    git(dir, 'branch', 'feature/x')
    expect((await resolveBase(dir, { requested: 'feature/x', saved: 'release' })).shortRef).toBe('feature/x')
    expect((await resolveBase(dir, { saved: 'release' })).shortRef).toBe('release')
    expect((await resolveBase(dir, { saved: 'missing' })).shortRef).toBe('main')
    expect((await resolveBase(dir, { saved: '  ' })).shortRef).toBe('main')
    const trunk = makeProject(join(scratch(), 'c'))
    git(trunk, 'branch', '-m', 'main', 'trunk')
    expect((await resolveBase(trunk, { saved: 'trunk' })).shortRef).toBe('trunk')
    expect((await failureOf(resolveBase(trunk, { saved: 'missing' }))).reason).toBe('no-base')
  })

  test('a name resolves to a local branch, then to any commit-ish; an unknown one is not-found', async () => {
    const dir = makeProject(join(scratch(), 'd'))
    const sha = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'tag', 'v1')
    expect(await resolveBase(dir, { requested: sha })).toEqual({ fullRef: sha, shortRef: sha })
    expect(await resolveBase(dir, { requested: 'v1' })).toEqual({ fullRef: sha, shortRef: 'v1' })
    const missing = await failureOf(resolveBase(dir, { requested: 'nope' }))
    expect(missing).toMatchObject({ reason: 'not-found', message: 'Base ref "nope" was not found.' })
  })
})

describe('resolveBase with a remote', () => {
  function clone(options: { branch?: string } = {}) {
    const origin = makeOrigin(join(scratch(), 'origin.git'), options)
    return { origin, dir: makeProject(join(scratch(), 'clone'), { origin }) }
  }

  test('origin/HEAD decides the default, even when a saved base is the same ref', async () => {
    const { dir } = clone({ branch: 'develop' })
    expect(await resolveBase(dir)).toEqual({ fullRef: 'refs/remotes/origin/develop', shortRef: 'origin/develop' })
    expect((await resolveBase(dir, { saved: 'origin/develop' })).shortRef).toBe('origin/develop')
  })

  test('an existing remote-tracking base is used at once and refreshed in the background', async () => {
    const { origin, dir } = clone()
    const pusher = makeProject(join(scratch(), 'pusher'), { origin })
    commitFiles(pusher, { 'n.txt': 'new\n' })
    git(pusher, 'push', '-q', 'origin', 'main')
    const stale = git(dir, 'rev-parse', 'origin/main')
    expect(await resolveBase(dir, { requested: 'origin/main' })).toEqual({ fullRef: 'refs/remotes/origin/main', shortRef: 'origin/main' })
    await waitFor(() => (git(dir, 'rev-parse', 'origin/main') !== stale ? true : undefined), 5000)
  })

  test('a remote base that is not fetched yet is fetched first', async () => {
    const { origin, dir } = clone()
    const pusher = makeProject(join(scratch(), 'pusher'), { origin })
    git(pusher, 'push', '-q', 'origin', 'main:refs/heads/develop')
    expect(Bun.spawnSync(['git', 'rev-parse', '--verify', '-q', 'origin/develop'], { cwd: dir }).exitCode).not.toBe(0)
    expect(await resolveBase(dir, { requested: 'origin/develop' })).toEqual({ fullRef: 'refs/remotes/origin/develop', shortRef: 'origin/develop' })
  })

  test('a local branch named exactly like the remote ref is used with no fetch and no notice', async () => {
    const { dir } = clone()
    git(dir, 'remote', 'set-url', 'origin', join(scratch(), 'gone.git'))
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main')
    git(dir, 'branch', 'origin/main', 'main')
    expect(await resolveBase(dir, { requested: 'origin/main' })).toEqual({ fullRef: 'refs/heads/origin/main', shortRef: 'origin/main' })
  })

  test('an unreachable remote falls back to the local branch with the notice, or fails when fallback is off or impossible', async () => {
    const { dir } = clone()
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main')
    git(dir, 'remote', 'set-url', 'origin', join(scratch(), 'gone.git'))
    const fallback = await resolveBase(dir, { requested: 'origin/main' })
    expect(fallback).toEqual({
      fullRef: 'refs/heads/main',
      shortRef: 'main',
      fallback: {
        requestedRef: 'origin/main',
        localRef: 'main',
        message: 'The remote-tracking ref origin/main was unavailable, so Quirky used local main instead. This workspace may not include the latest remote changes.'
      }
    })
    const off = await failureOf(resolveBase(dir, { requested: 'origin/main', allowLocalFallback: false }))
    expect(off).toMatchObject({
      reason: 'base-unreachable',
      message: 'Could not refresh base ref "origin/main" from "origin". Check your network and try again.',
      data: { ref: 'origin/main', remote: 'origin' }
    })
    const none = await failureOf(resolveBase(dir, { requested: 'origin/ghost' }))
    expect(none.reason).toBe('base-unreachable')
  })

  test('a reachable remote that lacks the branch says it was not found after fetching', async () => {
    const { dir } = clone()
    const missing = await failureOf(resolveBase(dir, { requested: 'origin/ghost' }))
    expect(missing).toMatchObject({ reason: 'base-unreachable', message: 'Base ref "origin/ghost" was not found after fetching.' })
  })

  test('a slash in a name that is not a remote is a plain local branch', async () => {
    const { dir } = clone()
    git(dir, 'branch', 'feature/x')
    expect(await resolveBase(dir, { requested: 'feature/x' })).toEqual({ fullRef: 'refs/heads/feature/x', shortRef: 'feature/x' })
  })
})
