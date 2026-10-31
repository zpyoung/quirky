import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import type { QuirkyClient, Repo, UiLayout, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks } from '../../../packages/daemon/test/helpers'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { git, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'

const { scratch } = isolateGitConfig()
const controlPlugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.git', 'quirky.cli']

type World = { harness: PluginHarness; root: string; repo: Repo }
let world: World | undefined

afterEach(async () => {
  await world?.harness.cleanup()
  world = undefined
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function start(): Promise<World> {
  const harness = await startPluginHarness({
    realGit: true,
    plugins: controlPlugins,
    fakeSession: false,
    home: makeHomeWithoutAutoHooks('qw-window-home-')
  })
  const root = makeTempDir('qw-window-root-')
  await call(harness.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repoPath = makeRepo(scratch())
  const repo = await call(harness.client, 'quirky.repo/add', { path: repoPath }) as Repo
  return { harness, root, repo }
}

const create = async (client: QuirkyClient, repo: string, name: string) =>
  ((await call(client, 'quirky.worktree/create', { repo, name })) as WorktreeCreateResult).worktree

async function connIds(client: QuirkyClient): Promise<number[]> {
  const state = await call(client, 'ui.state') as UiState
  return state.windows.map((window) => window.connId)
}

async function layoutFor(client: QuirkyClient, connId: number) {
  const state = await call(client, 'ui.window.state', { connId }) as UiState & { connId: number }
  return state.layout
}

function viewWorktree(layout: UiLayout): unknown {
  const input = layout.view?.input
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !('worktree' in input)) return undefined
  return input.worktree
}

test('navigation history and open-in are isolated by exact kernel UI connection', async () => {
  const w = await start()
  world = w
  const [first, second] = await Promise.all([w.harness.connectAs({}, 'ui'), w.harness.connectAs({}, 'ui')])
  const ids = await connIds(w.harness.client)
  expect(ids).toHaveLength(2)
  const [firstId, secondId] = ids
  expect(firstId).toBeDefined()
  expect(secondId).toBeDefined()

  const rows = await call(w.harness.client, 'quirky.worktree/list') as Worktree[]
  const primary = rows.find((row) => row.isMain)!
  const alpha = await create(w.harness.client, w.repo.id, 'alpha')
  const beta = await create(w.harness.client, w.repo.id, 'beta')

  await expect(call(w.harness.client, 'quirky.worktree/navigate', { worktree: alpha.id })).rejects.toThrow(/multiple windows/i)
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: primary.id, window: firstId })
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: alpha.id, window: firstId })
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: primary.id, window: secondId })
  await call(w.harness.client, 'quirky.worktree/openIn', { worktree: beta.id, target: 'changes', window: secondId })

  expect(viewWorktree(await layoutFor(first, firstId!))).toBe(alpha.id)
  expect((await layoutFor(second, secondId!)).view?.id).toBe('view:quirky.git/diff')
  expect(viewWorktree(await layoutFor(second, secondId!))).toBe(beta.id)
  expect(await call(w.harness.client, 'quirky.worktree/navigationState', { window: firstId })).toMatchObject({ worktrees: [primary.id, alpha.id], index: 1 })
  expect(await call(w.harness.client, 'quirky.worktree/navigationState', { window: secondId })).toMatchObject({ worktrees: [primary.id, beta.id], index: 1 })

  await call(w.harness.client, 'quirky.worktree/navigationBack', { window: firstId })
  expect(viewWorktree(await layoutFor(first, firstId!))).toBe(primary.id)
  expect((await layoutFor(second, secondId!)).view?.id).toBe('view:quirky.git/diff')
  await call(w.harness.client, 'quirky.worktree/navigationForward', { window: firstId })
  expect(viewWorktree(await layoutFor(first, firstId!))).toBe(alpha.id)

  await expect(call(w.harness.client, 'quirky.worktree/navigationBack')).rejects.toThrow(/multiple windows/i)
  await expect(call(w.harness.client, 'quirky.worktree/navigate', { worktree: alpha.id, window: 2_147_483_647 })).rejects.toThrow(/window|connection/i)
})

test('create activation refuses an untargeted multiwindow before worktree mutation', async () => {
  const w = await start()
  world = w
  await Promise.all([w.harness.connectAs({}, 'ui'), w.harness.connectAs({}, 'ui')])
  await expect(call(w.harness.client, 'quirky.worktree/create', {
    repo: w.repo.id,
    name: 'ambiguous-activation',
    activate: true
  })).rejects.toThrow(/multiple windows/i)
  const rows = await call(w.harness.client, 'quirky.worktree/list') as Worktree[]
  expect(rows.some((row) => row.name === 'ambiguous-activation')).toBe(false)
  await expect(call(w.harness.client, 'quirky.worktree/create', {
    repo: w.repo.id,
    name: 'stale-activation',
    activate: true,
    window: 2_147_483_647
  })).rejects.toThrow(/window|connection/i)
  const afterStale = await call(w.harness.client, 'quirky.worktree/list') as Worktree[]
  expect(afterStale.some((row) => row.name === 'stale-activation')).toBe(false)
})

test('sleep and wake retain the selected window view and leave sessions and other layouts alive', async () => {
  const w = await start()
  world = w
  const [first, second] = await Promise.all([w.harness.connectAs({}, 'ui'), w.harness.connectAs({}, 'ui')])
  const [firstId, secondId] = await connIds(w.harness.client)
  const worktree = await create(w.harness.client, w.repo.id, 'parked')
  const other = await create(w.harness.client, w.repo.id, 'other')
  const session = await call(w.harness.client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' }) as { id: string }

  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: worktree.id, window: firstId })
  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.git/diff',
    input: { worktree: worktree.id, path: 'src/index.ts' }
  })
  await call(first, 'ui.window.view.open', { connId: firstId, id: 'view:quirky.cli/settings' })
  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.session/worktree',
    input: { worktree: worktree.id }
  })
  await call(second, 'ui.window.view.open', { connId: secondId, id: 'view:quirky.session/worktree', input: { worktree: other.id } })
  const firstBefore = await layoutFor(first, firstId!)
  const secondBefore = await layoutFor(second, secondId!)
  expect(firstBefore.viewTabs?.map((tab) => tab.id)).toEqual([
    'view:quirky.session/worktree',
    'view:quirky.git/diff',
    'view:quirky.cli/settings'
  ])
  expect(firstBefore.view).toEqual({ id: 'view:quirky.session/worktree', input: { worktree: worktree.id } })

  await expect(call(w.harness.client, 'quirky.worktree/sleep', { worktree: worktree.id })).rejects.toThrow(/multiple windows/i)
  await call(w.harness.client, 'quirky.worktree/sleep', { worktree: worktree.id, window: firstId })

  expect(await layoutFor(first, firstId!)).toEqual(firstBefore)
  expect(await layoutFor(second, secondId!)).toEqual(secondBefore)
  const sessions = await call(w.harness.client, 'quirky.session/list', { worktree: worktree.id }) as Array<{ id: string }>
  expect(sessions.some((row) => row.id === session.id)).toBe(true)
  expect(await call(w.harness.client, 'quirky.worktree/navigationState', { window: firstId })).toMatchObject({ worktrees: [worktree.id], index: 0 })

  await call(w.harness.client, 'quirky.worktree/wake', { worktree: worktree.id })
  expect(await layoutFor(first, firstId!)).toEqual(firstBefore)
  expect(await layoutFor(second, secondId!)).toEqual(secondBefore)
})

test('sleep resolves explicit view selectors without changing layout and refuses unknown view owners', async () => {
  const w = await start()
  world = w
  const ui = await w.harness.connectAs({}, 'ui')
  const [connId] = await connIds(w.harness.client)
  const worktree = await create(w.harness.client, w.repo.id, 'selector-owned-view')
  const session = await call(w.harness.client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' }) as { id: string }
  await call(ui, 'ui.window.view.open', {
    connId,
    id: 'view:quirky.session/worktree',
    input: { worktree: `id:${worktree.id}` }
  })
  const selected = await layoutFor(ui, connId!)

  await call(w.harness.client, 'quirky.worktree/sleep', { worktree: worktree.id, window: connId })
  expect(await layoutFor(ui, connId!)).toEqual(selected)
  const sessions = await call(w.harness.client, 'quirky.session/list', { worktree: worktree.id }) as Array<{ id: string }>
  expect(sessions.some((row) => row.id === session.id)).toBe(true)
  await call(w.harness.client, 'quirky.worktree/wake', { worktree: worktree.id })
  expect(await layoutFor(ui, connId!)).toEqual(selected)

  const unknown = await create(w.harness.client, w.repo.id, 'unknown-selector-view')
  await call(ui, 'ui.window.view.open', {
    connId,
    id: 'view:quirky.session/worktree',
    input: { worktree: 'id:wt_missing' }
  })
  await expect(call(w.harness.client, 'quirky.worktree/sleep', { worktree: unknown.id, window: connId })).rejects.toThrow(/could not sleep/i)
  const worktrees = await call(w.harness.client, 'quirky.worktree/list') as Array<{ id: string; sleeping: boolean }>
  expect(worktrees.find((row) => row.id === unknown.id)?.sleeping).toBe(false)
  expect((await layoutFor(ui, connId!)).view).not.toBeNull()
})

test('sleep resolves name, branch, and absolute path owners without changing their views', async () => {
  const w = await start()
  world = w
  const ui = await w.harness.connectAs({}, 'ui')
  const [connId] = await connIds(w.harness.client)
  const byName = await create(w.harness.client, w.repo.id, 'sleep-by-name')
  const byBranch = await create(w.harness.client, w.repo.id, 'sleep-by-branch')
  const byPath = await create(w.harness.client, w.repo.id, 'sleep-by-path')
  const byPathSelector = await create(w.harness.client, w.repo.id, 'sleep-by-path-selector')
  const cases = [
    { worktree: byName, id: 'view:quirky.session/worktree', input: { worktree: `name:${byName.name}` } },
    { worktree: byBranch, id: 'view:quirky.git/diff', input: { worktree: `branch:${byBranch.branch}`, path: 'src/index.ts' } },
    { worktree: byPath, id: 'view:quirky.session/worktree', input: { path: join(byPath.path, 'nested', 'file.ts') } },
    { worktree: byPathSelector, id: 'view:quirky.session/worktree', input: { worktree: `path:${join(byPathSelector.path, 'nested')}` } }
  ]

  for (const item of cases) {
    await call(ui, 'ui.window.view.open', { connId, id: item.id, input: item.input })
    const selected = await layoutFor(ui, connId!)
    await call(w.harness.client, 'quirky.worktree/sleep', { worktree: item.worktree.id, window: connId })
    expect(await layoutFor(ui, connId!)).toEqual(selected)
    const listed = await call(w.harness.client, 'quirky.worktree/list') as Array<{ id: string; sleeping: boolean }>
    expect(listed.find((row) => row.id === item.worktree.id)?.sleeping).toBe(true)
    await call(w.harness.client, 'quirky.worktree/wake', { worktree: item.worktree.id })
    expect(await layoutFor(ui, connId!)).toEqual(selected)
  }
})

test('sleep leaves unrelated non-workspace views open', async () => {
  const w = await start()
  world = w
  const ui = await w.harness.connectAs({}, 'ui')
  const [connId] = await connIds(w.harness.client)
  const target = await create(w.harness.client, w.repo.id, 'sleep-unrelated-view')
  await call(ui, 'ui.window.view.open', {
    connId,
    id: 'view:quirky.cli/settings',
    input: { worktree: 'id:wt_missing' }
  })

  await call(w.harness.client, 'quirky.worktree/sleep', { worktree: target.id, window: connId })
  expect((await layoutFor(ui, connId!)).view?.id).toBe('view:quirky.cli/settings')
  const listed = await call(w.harness.client, 'quirky.worktree/list') as Array<{ id: string; sleeping: boolean }>
  expect(listed.find((row) => row.id === target.id)?.sleeping).toBe(true)
})

test('sleep refuses ambiguous and malformed known view owners before changing state', async () => {
  const w = await start()
  world = w
  const ui = await w.harness.connectAs({}, 'ui')
  const [connId] = await connIds(w.harness.client)
  const target = await create(w.harness.client, w.repo.id, 'sleep-owner-target')
  const duplicateA = await create(w.harness.client, w.repo.id, 'duplicate-owner-a')
  const duplicateB = await create(w.harness.client, w.repo.id, 'duplicate-owner-b')
  await call(w.harness.client, 'quirky.worktree/set', { worktree: duplicateA.id, displayName: 'duplicate-owner' })
  await call(w.harness.client, 'quirky.worktree/set', { worktree: duplicateB.id, displayName: 'duplicate-owner' })
  const unresolvedViews = [
    { worktree: 'name:duplicate-owner' },
    { worktree: 'id:wt_missing' },
    { path: 'relative/workspace/path' }
  ]

  for (const input of unresolvedViews) {
    await call(ui, 'ui.window.view.open', { connId, id: 'view:quirky.session/worktree', input })
    await expect(call(w.harness.client, 'quirky.worktree/sleep', {
      worktree: target.id,
      window: connId
    })).rejects.toThrow(/could not sleep/i)
    expect((await layoutFor(ui, connId!)).view).not.toBeNull()
    const listed = await call(w.harness.client, 'quirky.worktree/list') as Array<{ id: string; sleeping: boolean }>
    expect(listed.find((row) => row.id === target.id)?.sleeping).toBe(false)
  }
})

test('history and next/previous/index resolve active selectors without crossing windows', async () => {
  const w = await start()
  world = w
  const [first, second] = await Promise.all([w.harness.connectAs({}, 'ui'), w.harness.connectAs({}, 'ui')])
  const [firstId, secondId] = await connIds(w.harness.client)
  const rows = await call(w.harness.client, 'quirky.worktree/list') as Worktree[]
  const primary = rows.find((row) => row.isMain)!
  const alpha = await create(w.harness.client, w.repo.id, 'selector-alpha')
  const beta = await create(w.harness.client, w.repo.id, 'selector-beta')
  await call(w.harness.client, 'quirky.worktree/setOptions', { sortBy: 'name' })

  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: primary.id, window: firstId })
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: `name:${alpha.name}`, window: firstId })
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: beta.id, window: secondId })
  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.session/worktree',
    input: { worktree: `id:${alpha.id}` }
  })
  await call(w.harness.client, 'quirky.worktree/navigationBack', { window: firstId })

  expect(viewWorktree(await layoutFor(first, firstId!))).toBe(primary.id)
  expect(viewWorktree(await layoutFor(second, secondId!))).toBe(beta.id)
  expect(await call(w.harness.client, 'quirky.worktree/navigationState', { window: firstId }))
    .toEqual({ worktrees: [primary.id, alpha.id], index: 0 })
  expect(await call(w.harness.client, 'quirky.worktree/navigationState', { window: secondId }))
    .toEqual({ worktrees: [beta.id], index: 0 })

  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.session/worktree',
    input: { path: primary.path }
  })
  await call(w.harness.client, 'quirky.worktree/navigationForward', { window: firstId })
  expect(viewWorktree(await layoutFor(first, firstId!))).toBe(alpha.id)

  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.session/worktree',
    input: { worktree: `branch:${alpha.branch}` }
  })
  const previous = await call(w.harness.client, 'quirky.worktree/navigationMove', { direction: 'previous', window: firstId }) as { worktreeId: string }
  expect(previous.worktreeId).toBe(primary.id)
  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.session/worktree',
    input: { worktree: `id:${primary.id}` }
  })
  const next = await call(w.harness.client, 'quirky.worktree/navigationMove', { direction: 'next', window: firstId }) as { worktreeId: string }
  expect(next.worktreeId).toBe(alpha.id)

  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.session/worktree',
    input: { worktree: `name:${alpha.name}` }
  })
  const indexed = await call(w.harness.client, 'quirky.worktree/navigationIndex', { index: 2, window: firstId }) as { worktreeId: string }
  expect(indexed.worktreeId).toBe(alpha.id)
  expect(viewWorktree(await layoutFor(second, secondId!))).toBe(beta.id)

  const before = await call(w.harness.client, 'quirky.worktree/navigationState', { window: firstId })
  await call(first, 'ui.window.view.open', {
    connId: firstId,
    id: 'view:quirky.session/worktree',
    input: { worktree: 'id:wt_missing' }
  })
  await expect(call(w.harness.client, 'quirky.worktree/navigationIndex', { index: 1, window: firstId })).rejects.toThrow(/owner|workspace|selector/i)
  expect(await call(w.harness.client, 'quirky.worktree/navigationState', { window: firstId })).toEqual(before)
  expect((await layoutFor(first, firstId!)).view?.input).toEqual({ worktree: 'id:wt_missing' })
})

test('compare-and-close refuses a stale inspected view without closing the newly selected view', async () => {
  const w = await start()
  world = w
  const ui = await w.harness.connectAs({}, 'ui')
  const [connId] = await connIds(w.harness.client)
  const first = await create(w.harness.client, w.repo.id, 'first')
  const second = await create(w.harness.client, w.repo.id, 'second')
  await call(ui, 'ui.window.view.open', { connId, id: 'view:quirky.session/worktree', input: { worktree: first.id } })
  const inspected = (await layoutFor(ui, connId!)).view!
  await call(ui, 'ui.window.view.open', { connId, id: 'view:quirky.session/worktree', input: { worktree: second.id } })
  await expect(call(ui, 'ui.window.view.close', { connId, expectedView: inspected })).rejects.toThrow(/changed|stale|expected/i)
  expect(viewWorktree(await layoutFor(ui, connId!))).toBe(second.id)
})

test('navigation CLI targets the selected numeric window and refuses missing window identities', async () => {
  const w = await start()
  world = w
  const [first, second] = await Promise.all([w.harness.connectAs({}, 'ui'), w.harness.connectAs({}, 'ui')])
  const [firstId, secondId] = await connIds(w.harness.client)
  const rows = await call(w.harness.client, 'quirky.worktree/list') as Worktree[]
  const primary = rows.find((row) => row.isMain)!
  const alpha = await create(w.harness.client, w.repo.id, 'cli-alpha')
  const beta = await create(w.harness.client, w.repo.id, 'cli-beta')
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: primary.id, window: firstId })
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: alpha.id, window: firstId })
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: beta.id, window: secondId })

  const proc = spawnCli(['worktree', 'back', '--window', String(firstId)], { home: w.harness.h.home })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect(code).toBe(0)
  expect(stdout).toContain(primary.id)
  expect(stderr).toBe('')
  expect(viewWorktree(await layoutFor(first, firstId!))).toBe(primary.id)
  expect(viewWorktree(await layoutFor(second, secondId!))).toBe(beta.id)

  const bad = spawnCli(['worktree', 'back', '--window', '2147483647'], { home: w.harness.h.home })
  const [badOut, badErr, badCode] = await Promise.all([new Response(bad.stdout).text(), new Response(bad.stderr).text(), bad.exited])
  expect(badCode).not.toBe(0)
  expect(`${badOut}${badErr}`).toMatch(/window|connection|not found/i)
})

test('navigating to a worktree outside the project filter returns the panel to All projects', async () => {
  const w = await start()
  world = w
  await w.harness.connectAs({}, 'ui')
  const otherPath = makeRepo(scratch())
  const other = await call(w.harness.client, 'quirky.repo/add', { path: otherPath }) as Repo
  const inside = await create(w.harness.client, w.repo.id, 'inside')
  const outside = await create(w.harness.client, other.id, 'outside')

  await call(w.harness.client, 'quirky.worktree/setOptions', { filterRepoIds: [w.repo.id] })
  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: inside.id })
  expect(await call(w.harness.client, 'quirky.worktree/options')).toMatchObject({ filterRepoIds: [w.repo.id] })

  await call(w.harness.client, 'quirky.worktree/navigate', { worktree: outside.id })
  expect(await call(w.harness.client, 'quirky.worktree/options')).toMatchObject({ filterRepoIds: [] })

  await call(w.harness.client, 'quirky.worktree/setOptions', { filterRepoIds: [other.id, w.repo.id] })
  await call(w.harness.client, 'quirky.worktree/navigationBack')
  expect(await call(w.harness.client, 'quirky.worktree/options')).toMatchObject({ filterRepoIds: [other.id, w.repo.id] })
})
