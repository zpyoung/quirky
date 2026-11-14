import { afterEach, expect, test } from 'bun:test'
import { RpcErrorCode, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { addFakeRepo, fakeRegistrations } from './fixtures/fake-git'

let harness: PluginHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const call = (client: PluginHarness['client'], method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params)

async function cli(args: string[]) {
  const proc = spawnCli(args, { home: harness!.h.home })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { stdout, stderr, code }
}

test('a worktree comment set, edited and cleared through the API and the real CLI reads back the same after a daemon restart', async () => {
  harness = await startPluginHarness()
  fakeRegistrations(harness.git!)
  const repoPath = addFakeRepo(harness.git!, 'comments')
  const worktreesRoot = makeTempDir('qw-comments-root-')
  await call(harness.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: worktreesRoot })
  const repo = await call(harness.client, 'quirky.repo/add', { path: repoPath }) as Repo
  const created = await call(harness.client, 'quirky.worktree/create', { repo: repo.id, name: 'fix-login' }) as WorktreeCreateResult
  const worktree = created.worktree

  const apiSet = await call(harness.client, 'quirky.worktree/set', { worktree: worktree.id, comment: 'see the auth bug' }) as Worktree
  expect(apiSet.comment).toBe('see the auth bug')

  const set = await cli(['worktree', 'set', `id:${worktree.id}`, '--comment', '  waiting on review  ', '--json'])
  expect(set.code).toBe(0)
  expect(set.stderr).toBe('')
  expect(JSON.parse(set.stdout).comment).toBe('  waiting on review  ')

  const shown = await cli(['worktree', 'show', `id:${worktree.id}`, '--json'])
  expect(shown.code).toBe(0)
  expect(JSON.parse(shown.stdout).comment).toBe('  waiting on review  ')
  const listed = await call(harness.client, 'quirky.worktree/list', { repo: repo.id }) as Worktree[]
  expect(listed.find((item) => item.id === worktree.id)?.comment).toBe('  waiting on review  ')
  await expect(call(harness.client, 'quirky.worktree/set', { worktree: worktree.id, comment: 42 })).rejects.toMatchObject({
    code: RpcErrorCode.InvalidParams
  })
  const unchanged = await call(harness.client, 'quirky.worktree/show', { worktree: worktree.id }) as Worktree
  expect(unchanged.comment).toBe('  waiting on review  ')

  await harness.restart()
  const shownAfterRestart = await cli(['worktree', 'show', `id:${worktree.id}`, '--json'])
  expect(shownAfterRestart.code).toBe(0)
  expect(JSON.parse(shownAfterRestart.stdout).comment).toBe('  waiting on review  ')
  const textAfterRestart = await cli(['worktree', 'show', `id:${worktree.id}`])
  expect(textAfterRestart.code).toBe(0)
  expect(textAfterRestart.stdout).toContain('comment:   waiting on review  \n')

  const clear = await cli(['worktree', 'set', `id:${worktree.id}`, '--comment=', '--json'])
  expect(clear.code).toBe(0)
  expect(clear.stderr).toBe('')
  expect(JSON.parse(clear.stdout).comment).toBe('')
  const textAfterClear = await cli(['worktree', 'show', `id:${worktree.id}`])
  expect(textAfterClear.code).toBe(0)
  expect(textAfterClear.stdout).toContain('comment: -\n')

  await harness.restart()
  const clearedAfterRestart = await cli(['worktree', 'show', `id:${worktree.id}`, '--json'])
  expect(clearedAfterRestart.code).toBe(0)
  expect(JSON.parse(clearedAfterRestart.stdout).comment).toBe('')

  const missing = await cli(['worktree', 'set', 'id:missing', '--comment', 'x'])
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toMatch(/worktree/i)
  expect(missing.stderr).toContain('missing')
})
