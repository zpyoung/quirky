import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { git, makeRepo, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import type { CleanupCandidate, StockWorktreeOptions } from '../src/control-types'

const { scratch } = isolateGitConfig()
const plugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.agent-status', 'quirky.sidebar-extras', 'quirky.terminal', 'quirky.git', 'quirky.editor']
type World = { t: PluginHarness; repoDir: string; repo: Repo }
let world: World | undefined

afterEach(async () => {
  await world?.t.cleanup()
  world = undefined
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function start(): Promise<World> {
  const t = await startPluginHarness({ realGit: true, plugins, fakeSession: false, home: makeHomeWithoutAutoHooks('qw-parity-home-') })
  const root = realpathSync(makeTempDir('qw-parity-root-'))
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repoDir = makeRepo(scratch())
  const repo = await call(t.client, 'quirky.repo/add', { path: repoDir }) as Repo
  return { t, repoDir, repo }
}

const create = async (w: World, name: string) =>
  ((await call(w.t.client, 'quirky.worktree/create', { repo: w.repo.id, name })) as WorktreeCreateResult).worktree

async function cli(w: World, args: string[]) {
  const proc = spawnCli(args, { home: w.t.h.home })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

describe('remaining workspace options are durable and truthful', () => {
  test('PR grouping, activity/project sorting, manual project order, card properties, and data-backed filters persist through API and CLI', async () => {
    const w = await start()
    world = w
    const defaults = await call(w.t.client, 'quirky.worktree/options') as StockWorktreeOptions
    expect(defaults).toMatchObject({ groupBy: 'project', sortBy: 'recent', projectOrderBy: 'manual', hideCliCreated: false, hideDefaultBranch: false, hideDetached: false })
    expect(defaults.showProperties).toContain('branch')

    const chosen = await call(w.t.client, 'quirky.worktree/setOptions', {
      groupBy: 'pr', sortBy: 'agent-activity', projectOrderBy: 'recent', hideCliCreated: true,
      hideDefaultBranch: true, hideDetached: true, filterRepoIds: [w.repo.id], showProperties: ['branch', 'notes', 'pullRequest']
    }) as StockWorktreeOptions
    expect(chosen).toMatchObject({ groupBy: 'pr', sortBy: 'agent-activity', projectOrderBy: 'recent', hideCliCreated: true, hideDefaultBranch: true, hideDetached: true, filterRepoIds: [w.repo.id], showProperties: ['branch', 'notes', 'pullRequest'] })
    await w.t.restart()
    expect(await call(w.t.client, 'quirky.worktree/options')).toEqual(chosen)

    const cliResult = await cli(w, ['worktree', 'options', '--group-by', 'status', '--sort-by', 'project', '--hide-cli-created', '--hide-default-branch', '--hide-detached', '--json'])
    expect(cliResult.code).toBe(0)
    expect(JSON.parse(cliResult.stdout)).toMatchObject({ groupBy: 'status', sortBy: 'project', hideCliCreated: true, hideDefaultBranch: true, hideDetached: true })
    await expect(call(w.t.client, 'quirky.worktree/setOptions', { hideOtherClient: true })).rejects.toThrow(/unknown/i)
  })

  test('manual project ordering updates the project list without reordering or changing worktree membership', async () => {
    const w = await start()
    world = w
    const otherPath = makeRepo(scratch())
    const other = await call(w.t.client, 'quirky.repo/add', { path: otherPath }) as Repo
    const rows = await call(w.t.client, 'quirky.worktree/list') as Worktree[]
    const [left, right] = rows.filter((row) => row.isMain)
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    const order = [other.id, w.repo.id]
    expect(await call(w.t.client, 'quirky.worktree/reorderProjects', { projects: order })).toEqual({ ok: true })
    await w.t.restart()
    expect(await call(w.t.client, 'quirky.worktree/projectOrder')).toEqual(order)
    expect((await call(w.t.client, 'quirky.worktree/list'))).toHaveLength(2)
  })
})

describe('external worktree visibility and project identity', () => {
  test('external show/hide/inherit policy and inbox suppression preserve the checkout', async () => {
    const w = await start()
    world = w
    const externalPath = join(scratch(), 'outside-checkout')
    git(w.repoDir, 'worktree', 'add', '-b', 'outside', externalPath, 'HEAD')
    const external = (await call(w.t.client, 'quirky.worktree/list', { repo: w.repo.id }) as Array<Worktree & { externalVisible: boolean }>).find((row) => row.path === realpathSync(externalPath))!
    expect(external.createdBy).toBe('external')
    expect(external.externalVisible).toBe(false)

    expect(await call(w.t.client, 'quirky.worktree/setProjectMetadata', { repo: w.repo.id, externalVisibility: 'show' })).toMatchObject({ externalVisibility: 'show' })
    expect((await call(w.t.client, 'quirky.worktree/list', { repo: w.repo.id }) as Array<Worktree & { externalVisible: boolean }>).find((row) => row.id === external.id)?.externalVisible).toBe(true)
    await call(w.t.client, 'quirky.worktree/setProjectMetadata', { repo: w.repo.id, externalVisibility: 'hide' })
    await call(w.t.client, 'quirky.worktree/suppressExternalInbox', { repo: w.repo.id, suppressed: true })
    expect(await call(w.t.client, 'quirky.worktree/externalInbox')).toMatchObject({ projects: [{ repoId: w.repo.id, suppressed: true, hiddenWorktreeIds: [external.id] }] })
    await call(w.t.client, 'quirky.worktree/setProjectMetadata', { repo: w.repo.id, externalVisibility: 'inherit' })
    expect((await call(w.t.client, 'quirky.worktree/projectMetadata', { repo: w.repo.id }) as { externalVisibility: string }).externalVisibility).toBe('inherit')
    expect(existsSync(externalPath)).toBe(true)

    const cliResult = await cli(w, ['worktree', 'project-set', w.repo.id, '--external-worktree-visibility', 'show', '--project-icon', 'λ', '--project-color', '#245566', '--tracker-project', 'APP', '--json'])
    expect(cliResult.code).toBe(0)
    expect(JSON.parse(cliResult.stdout)).toMatchObject({ externalVisibility: 'show', identity: { icon: 'λ', color: '#245566', trackerProject: 'APP' } })
  })

  test('project identity fields survive restart without changing the repo path', async () => {
    const w = await start()
    world = w
    await call(w.t.client, 'quirky.worktree/setProjectMetadata', {
      repo: w.repo.id,
      identity: { displayName: 'API project', icon: '◆', color: '#3178c6', trackerProject: 'QWK' }
    })
    await w.t.restart()
    expect(await call(w.t.client, 'quirky.worktree/projectMetadata', { repo: w.repo.id })).toMatchObject({ identity: { displayName: 'API project', icon: '◆', color: '#3178c6', trackerProject: 'QWK' } })
    expect((await call(w.t.client, 'quirky.repo/resolve', { selector: w.repo.id }) as Repo).path).toBe(w.repo.path)
  })
})

describe('workspace references and custom statuses', () => {
  test('manual references link and unlink without changing path or opening the referenced URL', async () => {
    const w = await start()
    world = w
    const worktree = await create(w, 'reference-target')
    const reference = await call(w.t.client, 'quirky.worktree/linkReference', { worktree: worktree.id, url: 'https://tracker.example/issues/42', label: 'APP-42' }) as { id: string; url: string; label: string }
    expect(reference).toMatchObject({ url: 'https://tracker.example/issues/42', label: 'APP-42' })
    expect((await call(w.t.client, 'quirky.worktree/show', { worktree: worktree.id }) as Worktree & { references: unknown[] }).references).toContainEqual(reference)
    await w.t.restart()
    expect(await call(w.t.client, 'quirky.worktree/references', { worktree: worktree.id })).toEqual([reference])
    await expect(call(w.t.client, 'quirky.worktree/linkReference', { worktree: worktree.id, url: 'javascript:alert(1)', label: 'unsafe' })).rejects.toThrow(/http/i)
    await call(w.t.client, 'quirky.worktree/unlinkReference', { worktree: worktree.id, reference: reference.id })
    expect(await call(w.t.client, 'quirky.worktree/references', { worktree: worktree.id })).toEqual([])
    expect((await call(w.t.client, 'quirky.worktree/list') as Worktree[]).find((row) => row.id === worktree.id)?.path).toBe(worktree.path)
  })

  test('custom status definitions drive the API and board status values and refuse deleting a status in use', async () => {
    const w = await start()
    world = w
    const worktree = await create(w, 'blocked-item')
    const statuses = [
      { id: 'todo', label: 'To do', color: '#888888' },
      { id: 'in-progress', label: 'In progress', color: '#3478c5' },
      { id: 'in-review', label: 'In review', color: '#a57de8' },
      { id: 'done', label: 'Done', color: '#48a878' },
      { id: 'blocked', label: 'Blocked', color: '#d05a55' }
    ]
    expect(await call(w.t.client, 'quirky.worktree/setStatusDefinitions', { statuses })).toEqual(statuses)
    expect(await call(w.t.client, 'quirky.worktree/set', { worktree: worktree.id, status: 'blocked' })).toMatchObject({ status: 'blocked' })
    await w.t.restart()
    expect(await call(w.t.client, 'quirky.worktree/statusDefinitions')).toEqual(statuses)
    await expect(call(w.t.client, 'quirky.worktree/setStatusDefinitions', { statuses: statuses.slice(0, 4) })).rejects.toThrow(/in use/i)
    const cliResult = await cli(w, ['worktree', 'status-list', '--json'])
    expect(cliResult.code).toBe(0)
    expect(JSON.parse(cliResult.stdout)).toEqual(statuses)
  })
})

describe('archived cleanup classification', () => {
  test('an archived workspace becomes a seven-day cleanup candidate only after the boundary and remains fingerprinted', async () => {
    const w = await start()
    world = w
    const worktree = await create(w, 'archived-review')
    const now = Date.now()
    await call(w.t.client, 'quirky.worktree/archive', { worktree: worktree.id, archivedAt: now - 7 * 86_400_000 + 1 })
    let preview = await call(w.t.client, 'quirky.worktree/cleanupPreview') as { candidates: CleanupCandidate[] }
    expect(preview.candidates.some((row) => row.worktreeId === worktree.id)).toBe(false)

    await call(w.t.client, 'quirky.worktree/archive', { worktree: worktree.id, archivedAt: now - 7 * 86_400_000 - 1 })
    preview = await call(w.t.client, 'quirky.worktree/cleanupPreview') as { candidates: CleanupCandidate[] }
    const candidate = preview.candidates.find((row) => row.worktreeId === worktree.id)
    expect(candidate).toMatchObject({ reason: 'archived-7day' })
    expect(candidate?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const result = await cli(w, ['worktree', 'archive', worktree.id, '--off', '--json'])
    expect(result.code).toBe(0)
    expect(await call(w.t.client, 'quirky.worktree/show', { worktree: worktree.id })).toMatchObject({ archivedAt: null })
  })
})
describe('workspace navigation and Open in', () => {
  test('API and CLI back/forward, previous/next, index selection, and Open in preserve the exact worktree', async () => {
    const w = await start()
    world = w
    const first = await create(w, 'nav-first')
    const second = await create(w, 'nav-second')
    const third = await create(w, 'nav-third')
    const main = (await call(w.t.client, 'quirky.worktree/list', { repo: w.repo.id }) as Worktree[]).find((worktree) => worktree.isMain)!
    const ui = await w.t.h.connect('ui')
    await ui.callAny('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: first.id } })

    await call(w.t.client, 'quirky.worktree/navigate', { worktree: second.id })
    await call(w.t.client, 'quirky.worktree/navigate', { worktree: third.id })
    const back = await cli(w, ['worktree', 'back', '--json'])
    expect(back.code).toBe(0)
    expect((await ui.callAny('ui.state') as { layout: { view: { input: { worktree: string } } } }).layout.view.input.worktree).toBe(second.id)

    await call(w.t.client, 'quirky.worktree/navigationForward')
    expect((await ui.callAny('ui.state') as { layout: { view: { input: { worktree: string } } } }).layout.view.input.worktree).toBe(third.id)
    await call(w.t.client, 'quirky.worktree/navigationMove', { direction: 'previous' })
    expect((await ui.callAny('ui.state') as { layout: { view: { input: { worktree: string } } } }).layout.view.input.worktree).toBe(main.id)
    await call(w.t.client, 'quirky.worktree/navigationMove', { direction: 'next' })
    expect((await ui.callAny('ui.state') as { layout: { view: { input: { worktree: string } } } }).layout.view.input.worktree).toBe(third.id)
    await call(w.t.client, 'quirky.worktree/navigationIndex', { index: 1 })
    expect((await ui.callAny('ui.state') as { layout: { view: { input: { worktree: string } } } }).layout.view.input.worktree).toBe(main.id)

    await call(w.t.client, 'quirky.worktree/openIn', { worktree: second.id, target: 'changes' })
    expect(await ui.callAny('ui.state')).toMatchObject({ layout: { view: { id: 'view:quirky.git/diff', input: { worktree: second.id, mode: 'combined', area: 'all' } } } })
  })

  test('navigation refuses ambiguous multi-window routing without changing the visible view', async () => {
    const w = await start()
    world = w
    const worktree = await create(w, 'nav-ambiguous')
    const first = await w.t.h.connect('ui')
    await w.t.h.connect('ui')
    await first.callAny('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: worktree.id } })
    await expect(call(w.t.client, 'quirky.worktree/navigate', { worktree: worktree.id })).rejects.toThrow(/window/i)
    expect((await first.callAny('ui.state') as { layout: { view: { input: { worktree: string } } } }).layout.view.input.worktree).toBe(worktree.id)
  })
})
