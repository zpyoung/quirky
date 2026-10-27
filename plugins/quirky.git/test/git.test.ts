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
      'command:quirky.git/collapse-all',
      'command:quirky.git/load-diff',
      'command:quirky.git/next-change',
      'command:quirky.git/next-conflict',
      'command:quirky.git/open-branch-changes',
      'command:quirky.git/open-changes',
      'command:quirky.git/open-commit',
      'command:quirky.git/open-diff',
      'command:quirky.git/overwrite',
      'command:quirky.git/previous-change',
      'command:quirky.git/previous-conflict',
      'command:quirky.git/refresh-compare',
      'command:quirky.git/reload-from-disk',
      'command:quirky.git/revert-change',
      'command:quirky.git/review-conflicts',
      'command:quirky.git/save',
      'command:quirky.git/select',
      'command:quirky.git/set-filter',
      'command:quirky.git/show',
      'command:quirky.git/toggle-history',
      'event:quirky.git/changed',
      'event:quirky.git/notesChanged',
      'keybinding:quirky.git/next-change',
      'keybinding:quirky.git/previous-change',
      'keybinding:quirky.git/show',
      'method:quirky.git/abort',
      'method:quirky.git/addNote',
      'method:quirky.git/branches',
      'method:quirky.git/clearNotes',
      'method:quirky.git/commit',
      'method:quirky.git/commitFiles',
      'method:quirky.git/compare',
      'method:quirky.git/conflictFile',
      'method:quirky.git/continue',
      'method:quirky.git/deleteNote',
      'method:quirky.git/describeAbort',
      'method:quirky.git/describeClearNotes',
      'method:quirky.git/describeDiscard',
      'method:quirky.git/describeForcePush',
      'method:quirky.git/diff',
      'method:quirky.git/discard',
      'method:quirky.git/editNote',
      'method:quirky.git/fastForward',
      'method:quirky.git/fetch',
      'method:quirky.git/forcePush',
      'method:quirky.git/formatNotes',
      'method:quirky.git/history',
      'method:quirky.git/hugeFolders',
      'method:quirky.git/ignoreFolder',
      'method:quirky.git/noteTargets',
      'method:quirky.git/notes',
      'method:quirky.git/pull',
      'method:quirky.git/push',
      'method:quirky.git/rebaseFromBase',
      'method:quirky.git/reveal',
      'method:quirky.git/save',
      'method:quirky.git/sendNotes',
      'method:quirky.git/setBase',
      'method:quirky.git/stage',
      'method:quirky.git/status',
      'method:quirky.git/submoduleStatus',
      'method:quirky.git/sync',
      'method:quirky.git/unstage',
      'panel:quirky.git/source-control',
      'setting:quirky.git/combinedDiffFileTree',
      'setting:quirky.git/compareBase',
      'setting:quirky.git/diffCollapseUnchanged',
      'setting:quirky.git/diffDefaultView',
      'setting:quirky.git/diffShowWhitespace',
      'setting:quirky.git/diffWordWrap',
      'setting:quirky.git/groupOrder',
      'setting:quirky.git/viewMode',
      'view:quirky.git/diff'
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
      ['statusV2', g.main.path],
      ['diffSource', g.main.path],
      ['statusV2', g.main.path],
      ['stagePaths', g.main.path],
      ['statusV2', g.main.path],
      ['unstagePaths', g.main.path],
      ['commit', g.main.path]
    ])
  })

  test('read-only methods emit nothing and a failed write does not announce a change', async () => {
    const { call, events } = g
    g.git.stagePaths = async () => {
      throw new GitError('git add failed', 'fatal: pathspec missing did not match', 128)
    }
    await call('quirky.git/status', { worktree: g.main.id })
    await call('quirky.git/diff', { worktree: g.main.id, path: 'a.txt' })
    const error = await errorOf(call('quirky.git/stage', { worktree: g.main.id, paths: ['missing'] }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toEqual({ reason: 'failed' })
    expect(error.message).toContain('fatal: pathspec missing did not match')
    await Bun.sleep(50)
    expect(events.filter((e) => e.type === 'quirky.git/changed')).toEqual([])
  })

  test('git failures surface git stderr, not the wrapper message', async () => {
    g.git.commit = async () => {
      throw new GitError('git commit failed', '  nothing to commit, working tree clean\n', 1)
    }
    const error = await errorOf(g.call('quirky.git/commit', { worktree: g.main.id, message: 'x' }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toMatchObject({ reason: 'failed', summary: 'nothing to commit, working tree clean' })
    expect(error.message).toBe('nothing to commit, working tree clean')
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
