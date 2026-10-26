import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QuirkyClient, RpcError, RpcErrorCode, type PluginInfo } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { GitError } from '@quirky/git'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { startGitHarness, type GitHarness } from './support'

let g: GitHarness
beforeEach(async () => {
  g = await startGitHarness()
})
afterEach(() => g.cleanup())

async function errorOf(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the call to fail')
}

describe('quirky.git manifest', () => {
  test('is a built-in that depends on quirky.worktree and declares the source-control panel', async () => {
    const plugins = (await g.call('plugin.list', {})) as PluginInfo[]
    const git = plugins.find((plugin) => plugin.id === 'quirky.git')
    expect(git).toMatchObject({ source: 'builtin', dependencies: ['quirky.worktree'], activation: 'lazy' })
    const contributions = (await g.call('plugin.contributions', { pluginId: 'quirky.git' })) as { id: string }[]
    expect(contributions.map((c) => c.id).sort()).toEqual([
      'event:quirky.git/changed',
      'method:quirky.git/commit',
      'method:quirky.git/diff',
      'method:quirky.git/stage',
      'method:quirky.git/status',
      'method:quirky.git/unstage',
      'panel:quirky.git/source-control'
    ])
  })
})

describe('quirky.git methods', () => {
  test('run git in the worktree path and report changes', async () => {
    const { call, events } = g
    expect((await call('quirky.git/status', { worktree: g.main.id })).files).toHaveLength(1)
    expect(await call('quirky.git/diff', { worktree: g.main.id, path: 'a.txt', staged: true })).toMatchObject({
      staged: true,
      modified: 'new'
    })
    await call('quirky.git/stage', { worktree: g.main.id, paths: ['a.txt'] })
    await call('quirky.git/unstage', { worktree: g.main.id, paths: ['a.txt'] })
    expect(await call('quirky.git/commit', { worktree: g.main.id, message: 'msg' })).toEqual({
      sha: 'c'.repeat(40)
    })
    await waitFor(() => events.filter((e) => e.type === 'quirky.git/changed').length >= 3)
    expect(events.filter((e) => e.type === 'quirky.git/changed').map((e) => (e as { data: unknown }).data)).toEqual([
      { worktreeId: g.main.id },
      { worktreeId: g.main.id },
      { worktreeId: g.main.id }
    ])
    expect(g.git.calls.map((c) => [c.fn, c.args[0]])).toEqual([
      ['status', g.main.path],
      ['diff', g.main.path],
      ['stage', g.main.path],
      ['unstage', g.main.path],
      ['commit', g.main.path]
    ])
  })

  test('read-only methods emit nothing and a failed write does not announce a change', async () => {
    const { call, events } = g
    g.git.stage = async () => {
      throw new GitError('git add failed', 'fatal: pathspec missing did not match', 128)
    }
    await call('quirky.git/status', { worktree: g.main.id })
    await call('quirky.git/diff', { worktree: g.main.id, path: 'a.txt' })
    const error = await errorOf(call('quirky.git/stage', { worktree: g.main.id, paths: ['missing'] }))
    expect(error.code).toBe(RpcErrorCode.Internal)
    expect(error.message).toContain('fatal: pathspec missing did not match')
    await Bun.sleep(50)
    expect(events.filter((e) => e.type === 'quirky.git/changed')).toEqual([])
  })

  test('git failures surface git stderr, not the wrapper message', async () => {
    g.git.commit = async () => {
      throw new GitError('git commit failed', '  nothing to commit, working tree clean\n', 1)
    }
    const error = await errorOf(g.call('quirky.git/commit', { worktree: g.main.id, message: 'x' }))
    expect(error.code).toBe(RpcErrorCode.Internal)
    expect(error.message).toContain('nothing to commit, working tree clean')
    expect(error.message).not.toContain('git commit failed')
  })

  test('rejects a bare string where paths must be a list', async () => {
    const error = await errorOf(g.call('quirky.git/stage', { worktree: g.main.id, paths: 'a.txt' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('an unknown worktree is NotFound from the resolver and nothing runs', async () => {
    const error = await errorOf(g.call('quirky.git/status', { worktree: 'name:nope' }))
    expect(error.code).toBe(RpcErrorCode.NotFound)
    expect(g.git.calls).toEqual([])
  })

  test('SC-7: the worktree selector is resolved by quirky.worktree with the caller identity', async () => {
    const { call } = g
    await call('quirky.git/status', { worktree: 'branch:fix-login' })
    await call('quirky.git/status', { worktree: 'main' })
    await call('quirky.git/status', { worktree: `path:${g.fixLogin.path}/src` })
    expect(g.git.calls.map((c) => c.args[0])).toEqual([g.fixLogin.path, g.main.path, g.fixLogin.path])
  })

  test('SC-7: with no worktree, the caller session or cwd decides', async () => {
    const inFix = await QuirkyClient.connect(rpcUrl(g.h.runtime), { role: 'cli', cwd: `${g.fixLogin.path}/src` })
    const inSession = await QuirkyClient.connect(rpcUrl(g.h.runtime), {
      role: 'cli',
      cwd: `${g.fixLogin.path}/src`,
      worktreeId: g.main.id
    })
    try {
      await inFix.callAny('quirky.git/status', {})
      await inSession.callAny('quirky.git/status', {})
      expect(g.git.calls.map((c) => c.args[0])).toEqual([g.fixLogin.path, g.main.path])
    } finally {
      inFix.close()
      inSession.close()
    }
  })
})
