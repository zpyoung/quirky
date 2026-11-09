import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { call, failure, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { DEFAULT_STOCK_OPTIONS } from '../src/control-types'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, stockFromAllSpec, type SavedView, type ViewsState } from '../src/view-types'
import { startRealProject, type RealProject } from './fixtures/real-project'

const { scratch } = isolateGitConfig()
setDefaultTimeout(60_000)

let p: RealProject | undefined
afterEach(async () => {
  await p?.t.cleanup()
  p = undefined
})

async function start() {
  p = await startRealProject(scratch)
  return p
}

const spec = () => allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
const saved = (id: string, name: string, starred = false): SavedView => ({ id, name, starred, spec: spec() })
const views = async (w: RealProject) => (await call(w.client, 'quirky.worktree/views')) as ViewsState
const setViews = (w: RealProject, state: unknown) => call(w.client, 'quirky.worktree/setViews', { state: state as Record<string, unknown> }) as Promise<ViewsState>
const activeView = async (w: RealProject, window: number, client = w.client) =>
  ((await call(client, 'quirky.worktree/activeView', { window })) as { viewId: string }).viewId

describe('views: stored state', () => {
  test('the default state has no saved views, shows Needs you and puts last activity on the right', async () => {
    const w = await start()
    expect(await views(w)).toEqual({ views: [], needsYouHidden: false, rowFact: 'last-activity' })
  })

  test('setViews stores a state and returns it normalised, and emits viewsChanged', async () => {
    const w = await start()
    const watcher = await w.t.h.connectWithEvents('cli')
    const result = await setViews(w, { views: [saved('v1', '  Release 2.4  ', true)], needsYouHidden: true, rowFact: 'pr' })
    expect(result).toEqual({ views: [saved('v1', 'Release 2.4', true)], needsYouHidden: true, rowFact: 'pr' })
    expect(await views(w)).toEqual(result)
    await waitFor(() => watcher.events.find((e) => e.type === 'quirky.worktree/viewsChanged'))
  })

  test('unknown keys are dropped at every level', async () => {
    const w = await start()
    const view = saved('v1', 'Mine')
    const dirty = {
      views: [{ ...view, extra: 1, spec: { filter: { ...view.spec.filter, extra: 1, activity: { ...view.spec.filter.activity, extra: 1 } }, display: { ...view.spec.display, extra: 1 }, extra: 1 } }],
      needsYouHidden: false,
      rowFact: 'branch',
      extra: 1
    }
    expect(await setViews(w, dirty)).toEqual({ views: [view], needsYouHidden: false, rowFact: 'branch' })
  })

  test('every field is validated', async () => {
    const w = await start()
    const base = saved('v1', 'Mine')
    const bad: unknown[] = [
      null,
      { views: 'x', needsYouHidden: false, rowFact: 'pr' },
      { views: [], needsYouHidden: 'no', rowFact: 'pr' },
      { views: [], needsYouHidden: false, rowFact: 'nope' },
      { views: [{ ...base, name: '   ' }], needsYouHidden: false, rowFact: 'pr' },
      { views: [{ ...base, id: 'all' }], needsYouHidden: false, rowFact: 'pr' },
      { views: [{ ...base, id: 'needs-you' }], needsYouHidden: false, rowFact: 'pr' },
      { views: [{ ...base, starred: 1 }], needsYouHidden: false, rowFact: 'pr' },
      { views: [base, base], needsYouHidden: false, rowFact: 'pr' },
      { views: [{ ...base, spec: { ...base.spec, display: { ...base.spec.display, groupBy: 'colour' } } }], needsYouHidden: false, rowFact: 'pr' },
      { views: [{ ...base, spec: { ...base.spec, filter: { ...base.spec.filter, statuses: ['blocked'] } } }], needsYouHidden: false, rowFact: 'pr' },
      { views: [{ ...base, spec: { ...base.spec, filter: { ...base.spec.filter, tagIds: [1] } } }], needsYouHidden: false, rowFact: 'pr' },
      { views: [{ ...base, spec: { ...base.spec, filter: { ...base.spec.filter, activity: { ...base.spec.filter.activity, workspaceActivityWindow: 'year' } } } }], needsYouHidden: false, rowFact: 'pr' }
    ]
    for (const state of bad) {
      expect((await failure(setViews(w, state))).code).toBe(RpcErrorCode.InvalidParams)
    }
    expect(await views(w)).toEqual({ views: [], needsYouHidden: false, rowFact: 'last-activity' })
  })
})

describe('views: the active view of each window', () => {
  test('a window with no choice starts on All', async () => {
    const w = await start()
    expect(await activeView(w, 1)).toBe('all')
  })

  test('each window keeps its own view and the last one chosen is where new windows start', async () => {
    const w = await start()
    await setViews(w, { views: [saved('v1', 'One'), saved('v2', 'Two')], needsYouHidden: false, rowFact: 'pr' })
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'v1' })
    await call(w.client, 'quirky.worktree/setActiveView', { window: 2, viewId: 'needs-you' })
    expect(await activeView(w, 1)).toBe('v1')
    expect(await activeView(w, 2)).toBe('needs-you')
    expect(await activeView(w, 3)).toBe('needs-you')
    await call(w.client, 'quirky.worktree/setActiveView', { window: 2, viewId: 'all' })
    expect(await activeView(w, 4)).toBe('all')
  })

  test('a window that never picked a view keeps the one it first read when another window switches', async () => {
    const w = await start()
    await setViews(w, { views: [saved('v1', 'One')], needsYouHidden: false, rowFact: 'pr' })
    expect(await activeView(w, 2)).toBe('all')
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'needs-you' })
    expect(await activeView(w, 2)).toBe('all')
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'v1' })
    expect(await activeView(w, 2)).toBe('all')
    expect(await activeView(w, 1)).toBe('v1')
    expect(await activeView(w, 3)).toBe('v1')
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'all' })
    expect(await activeView(w, 3)).toBe('v1')
  })

  test('a deleted or hidden view resolves to All, and choosing an unknown view is refused', async () => {
    const w = await start()
    await setViews(w, { views: [saved('v1', 'One')], needsYouHidden: false, rowFact: 'pr' })
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'v1' })
    await call(w.client, 'quirky.worktree/setActiveView', { window: 2, viewId: 'needs-you' })
    await setViews(w, { views: [], needsYouHidden: true, rowFact: 'pr' })
    expect(await activeView(w, 1)).toBe('all')
    expect(await activeView(w, 2)).toBe('all')
    for (const viewId of ['v1', 'needs-you', 'nope']) {
      expect((await failure(call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId }))).code).toBe(RpcErrorCode.InvalidParams)
    }
  })

  test('the window must be a positive integer', async () => {
    const w = await start()
    for (const window of [0, -1, 1.5, '1']) {
      expect((await failure(call(w.client, 'quirky.worktree/activeView', { window: window as number }))).code).toBe(RpcErrorCode.InvalidParams)
      expect((await failure(call(w.client, 'quirky.worktree/setActiveView', { window: window as number, viewId: 'all' }))).code).toBe(RpcErrorCode.InvalidParams)
    }
  })

  test('a window forgets its view when its connection closes and starts on the last one used', async () => {
    const w = await start()
    await setViews(w, { views: [saved('v1', 'One'), saved('v2', 'Two')], needsYouHidden: false, rowFact: 'pr' })
    const first = await w.t.h.connect('cli')
    const second = await w.t.h.connect('cli')
    await call(first, 'quirky.worktree/setActiveView', { window: 7, viewId: 'v1' })
    await call(second, 'quirky.worktree/setActiveView', { window: 8, viewId: 'v2' })
    expect(await activeView(w, 7)).toBe('v1')
    first.close()
    await waitForAsync(async () => ((await activeView(w, 7)) === 'v2' ? true : undefined))
    expect(await activeView(w, 8)).toBe('v2')
  })

  test('a window that only read its view forgets it when its connection closes', async () => {
    const w = await start()
    await setViews(w, { views: [saved('v1', 'One'), saved('v2', 'Two')], needsYouHidden: false, rowFact: 'pr' })
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'v1' })
    const reader = await w.t.h.connect('cli')
    expect(await activeView(w, 9, reader)).toBe('v1')
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'v2' })
    expect(await activeView(w, 9, reader)).toBe('v1')
    reader.close()
    const next = await w.t.h.connect('cli')
    await waitForAsync(async () => ((await activeView(w, 9, next)) === 'v2' ? true : undefined))
  })

  test('the last view survives a daemon restart and the per-window choices do not', async () => {
    const w = await start()
    await setViews(w, { views: [saved('v1', 'One')], needsYouHidden: false, rowFact: 'pr' })
    await call(w.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'v1' })
    const restarted = await w.t.restart()
    expect(await activeView(w, 1, restarted.client)).toBe('v1')
    await call(restarted.client, 'quirky.worktree/setActiveView', { window: 1, viewId: 'all' })
    expect(await activeView(w, 5, restarted.client)).toBe('all')
  })
})

describe('the All view round-trips through the stock options', () => {
  test('stock options become a spec and back, keeping what a spec has no field for', () => {
    const stock = { ...DEFAULT_STOCK_OPTIONS, groupBy: 'pr' as const, sortBy: 'name' as const, projectOrderBy: 'recent' as const, hideCliCreated: true, hideDetached: true, hideOtherClients: true, showSleeping: false, filterRepoIds: ['repo_a'], compact: true }
    const all = allSpecFromStock(stock, DEFAULT_ACTIVITY_PREFERENCES)
    expect(all.display).toEqual({ groupBy: 'pull-request', sortBy: 'name', projectOrder: 'recent', showAsleep: false, showNested: true })
    expect(all.filter).toMatchObject({ repoIds: ['repo_a'], hideCliCreated: true, hideDetachedHead: true, hideOtherDesktopClients: true, hideDefaultBranch: false, hideArchived: true, tagIds: [], sectionIds: [], statuses: [] })
    expect(stockFromAllSpec(all, stock)).toEqual(stock)
  })

  test('the default stock options are the section-and-project grouping, and tag grouping keeps the stored grouping', () => {
    const all = allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
    expect(all.display.groupBy).toBe('section-project')
    expect(stockFromAllSpec(all, DEFAULT_STOCK_OPTIONS)).toEqual(DEFAULT_STOCK_OPTIONS)
    const byTag = { ...all, display: { ...all.display, groupBy: 'tag' as const } }
    expect(stockFromAllSpec(byTag, { ...DEFAULT_STOCK_OPTIONS, groupBy: 'status' }).groupBy).toBe('status')
  })
})
