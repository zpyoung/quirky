import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectGroup, QuirkyClient, Repo, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { failure, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'

const SIDEBAR = 'sidebar-section:quirky.worktree/worktrees'
const SESSION_VIEW = 'view:quirky.session/worktree'
const NEW_WORKTREE = 'command:quirky.worktree/new-worktree'

const { scratch } = isolateGitConfig()

/** Booting a daemon, creating real worktrees and a window takes a few seconds. */
const SLOW = 30_000

type World = {
  harness: Harness
  win: HeadlessWindow
  agent: QuirkyClient
  api: Repo
  main: Worktree
  fixLogin: Worktree
  child?: Worktree
  docs?: Worktree
  web?: Repo
  notes?: Repo
  group?: ProjectGroup
}

let current: World | null = null

afterEach(async () => {
  if (!current) return
  await current.win.stop()
  await current.harness.cleanup()
  current = null
  removeTempDirs()
})

const created = async (agent: QuirkyClient, params: Record<string, unknown>) =>
  ((await agent.callAny('quirky.worktree/create', params)) as WorktreeCreateResult).worktree

/**
 * A real daemon with the real repo, worktree and session plugins, real git in temp folders, and a
 * headless window connected to it. Project `api` always has `fix-login`; the options add the rest.
 */
async function boot(options: { nested?: boolean; docs?: boolean; web?: boolean; grouped?: boolean; notes?: boolean } = {}): Promise<World> {
  const harness = await startHarness({ home: makeTempHome('qwt-'), builtinPluginsDir: builtinsDir() })
  const agent = await harness.connect('cli', 'setup')
  const root = realpathSync(makeTempDir('qwt-root-'))
  await agent.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })

  const api = (await agent.callAny('quirky.repo/add', { path: makeRepo(join(scratch(), 'api')) })) as Repo
  const main = ((await agent.callAny('quirky.worktree/list', { repo: api.id })) as Worktree[]).find((w) => w.isMain)!
  const fixLogin = await created(agent, { repo: api.id, name: 'fix-login' })
  const world: World = { harness, win: undefined as unknown as HeadlessWindow, agent, api, main, fixLogin }
  if (options.nested) world.child = await created(agent, { repo: api.id, name: 'child', parent: fixLogin.id })
  if (options.docs) world.docs = await created(agent, { repo: api.id, name: 'docs' })
  if (options.web) world.web = (await agent.callAny('quirky.repo/add', { path: makeRepo(join(scratch(), 'web')) })) as Repo
  if (options.grouped) {
    world.group = (await agent.callAny('quirky.repo/groupCreate', { name: 'services' })) as ProjectGroup
    await agent.callAny('quirky.repo/groupAdd', { group: world.group.id, repo: api.id })
  }
  if (options.notes) {
    const dir = join(scratch(), 'notes')
    mkdirSync(dir, { recursive: true })
    world.notes = (await agent.callAny('quirky.repo/add', { path: realpathSync(dir), folder: true })) as Repo
  }
  world.win = await startHeadlessWindow({ home: harness.home, runtime: harness.runtime })
  current = world
  return world
}

const report = async (agent: QuirkyClient): Promise<any> =>
  ((await agent.callAny('ui.state', {})) as UiState).slots.find((slot) => slot.id === SIDEBAR)?.report

const listed = async (agent: QuirkyClient, id: string) =>
  ((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).find((w) => w.id === id)!

const texts = (selector: string, within: ParentNode = document) => [...within.querySelectorAll(selector)].map((e) => e.textContent)

/** The `li.worktree` card named `name`, in the project section `project` or, with none, the first match. */
function card(name: string, project?: string, scope: 'repo' | 'pinned' = 'repo'): HTMLElement | undefined {
  const sections = [...document.querySelectorAll(`section.${scope}`)].filter(
    (section) => project === undefined || section.querySelector('.repo-name')?.textContent === project
  )
  for (const section of sections) {
    const found = [...section.querySelectorAll('li.worktree')].find((li) => li.querySelector('.worktree-name')?.textContent === name)
    if (found) return found as HTMLElement
  }
  return undefined
}

function openMenu(win: HeadlessWindow, name: string, project?: string): Promise<HTMLElement> {
  return win.waitFor(async () => {
    const target = card(name, project)?.querySelector('.worktree-main')
    if (!target) return undefined
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
    await Bun.sleep(20)
    return document.querySelector<HTMLElement>('[role="menu"]') ?? undefined
  })
}

const item = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((e) => e.textContent?.replace(/\s*▸$/, '').trim() === label)

async function choose(win: HeadlessWindow, label: string): Promise<void> {
  const target = await win.waitFor(() => item(label))
  target.click()
  await Bun.sleep(20)
}

test('SC-44: the sidebar shows groups, projects, the primary badge and nested children, and reports them', async () => {
  const w = await boot({ nested: true, grouped: true, notes: true })
  const { win, agent, api, main, fixLogin, child, group, notes } = w
  await win.waitFor(() => card('child', 'api'))

  expect(texts('.group-name')).toEqual(['services'])
  expect(texts('.repo-name')).toEqual(['api', 'notes'])
  const groupSection = document.querySelector('section.group')!
  expect(groupSection.querySelector('section.repo .repo-name')?.textContent).toBe('api')
  expect(document.querySelector('section.group + section.repo .repo-name')?.textContent).toBe('notes')

  const apiRows = [...document.querySelectorAll('section.repo')].find((s) => s.querySelector('.repo-name')?.textContent === 'api')!
  expect(texts('li.worktree .worktree-name', apiRows)).toEqual(['main', 'fix-login', 'child'])
  expect(card('main', 'api')!.querySelector('.tag-primary')?.textContent).toBe('primary')
  expect(card('fix-login', 'api')!.querySelector('.tag-primary')).toBeNull()
  const chip = card('fix-login', 'api')!.querySelector<HTMLElement>('.children-chip')!
  expect(chip.textContent).toBe('1 child')
  expect(card('child', 'api')!.style.getPropertyValue('--depth')).toBe('1')

  chip.click()
  await win.waitFor(() => !card('child', 'api'))
  card('fix-login', 'api')!.querySelector<HTMLElement>('.children-chip')!.click()
  await win.waitFor(() => card('child', 'api'))

  const state = await win.waitFor(async () => {
    const next = await report(agent)
    return next?.groups?.length ? next : undefined
  })
  const entry = (wt: Worktree, depth: number, primary: boolean) =>
    expect.objectContaining({
      id: wt.id,
      name: wt.name,
      branch: wt.branch,
      kind: wt.kind,
      primary,
      status: null,
      workspaceStatus: 'in-progress',
      pinned: false,
      parentId: wt.parentId,
      depth,
      pending: false,
      removing: false,
      selected: false
    })
  expect(child!.parentId).toBe(fixLogin.id)
  expect(state.pinned).toEqual([])
  expect(state.dialog).toBeNull()
  expect(state.groups).toEqual([
    {
      id: group!.id,
      name: 'services',
      collapsed: false,
      worktrees: [],
      projects: [
        { id: api.id, name: 'api', kind: 'git', worktrees: [entry(main, 0, true), entry(fixLogin, 0, false), entry(child!, 1, false)] }
      ]
    }
  ])
  expect(state.projects).toHaveLength(1)
  expect(state.projects[0]).toMatchObject({ id: notes!.id, name: 'notes', kind: 'folder' })
  expect(state.projects[0].worktrees).toHaveLength(1)
  expect(state.projects[0].worktrees[0]).toMatchObject({ kind: 'folder', primary: true, depth: 0 })
}, SLOW)

test('SC-44: a group collapses through quirky.repo/groupCollapse and its projects leave the tree', async () => {
  const { win, agent, group } = await boot({ grouped: true })
  await win.waitFor(() => card('fix-login', 'api'))
  document.querySelector<HTMLElement>('.group-toggle')!.click()
  await win.waitFor(() => !card('fix-login', 'api'))
  expect(((await agent.callAny('quirky.repo/groupList', {})) as ProjectGroup[]).find((g) => g.id === group!.id)!.collapsed).toBe(true)
  expect((await report(agent)).groups[0].collapsed).toBe(true)
  document.querySelector<HTMLElement>('.group-toggle')!.click()
  await win.waitFor(() => card('fix-login', 'api'))
}, SLOW)

test('SC-43: status, pin and unread from the card menu', async () => {
  const { win, agent, main, fixLogin, docs } = await boot({ docs: true })
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: main.id } })
  await win.waitFor(() => card('docs', 'api'))

  await openMenu(win, 'fix-login', 'api')
  await choose(win, 'Move to Status')
  await choose(win, 'In review')
  await win.waitFor(async () => (await listed(agent, fixLogin.id)).status === 'in-review')

  await openMenu(win, 'fix-login', 'api')
  await choose(win, 'Pin')
  await win.waitFor(() => card('fix-login', undefined, 'pinned'))
  expect((await listed(agent, fixLogin.id)).pinned).toBe(true)
  expect(document.querySelector('section.pinned .section-title')?.textContent).toBe('Pinned')
  expect(document.querySelector('section.pinned')!.nextElementSibling?.className).toContain('repo')
  expect(card('fix-login', 'api')!.querySelector('.tag-status')?.textContent).toBe('In review')
  expect(card('fix-login', undefined, 'pinned')!.querySelector('.tag-status')?.textContent).toBe('In review')
  expect((await report(agent)).pinned).toEqual([fixLogin.id])

  await agent.callAny('quirky.worktree/set', { worktree: docs!.id, unread: false })
  await openMenu(win, 'docs', 'api')
  await choose(win, 'Mark Unread')
  await win.waitFor(() => card('docs', 'api')!.querySelector('.glyph-unread[aria-label="Unread"]'))
  expect(card('docs', 'api')!.querySelector('.worktree-name-unread')).not.toBeNull()
  expect((await listed(agent, docs!.id)).unread).toBe(true)

  card('docs', 'api')!.querySelector<HTMLElement>('.worktree-main')!.click()
  await win.waitFor(async () => (await listed(agent, docs!.id)).unread === false)
  await win.waitFor(() => !card('docs', 'api')!.querySelector('.glyph-unread'))
  expect(card('docs', 'api')!.querySelector('.worktree-name-unread')).toBeNull()
  const layout = ((await agent.callAny('ui.state', {})) as UiState).layout
  expect(layout.view).toEqual({ id: SESSION_VIEW, input: { worktree: docs!.id } })
}, SLOW)

test('SC-59: the primary checkout cannot be deleted', async () => {
  const { win, agent, main } = await boot()
  await win.waitFor(() => card('main', 'api'))
  const error = await failure(agent.callAny('quirky.worktree/remove', { worktree: main.id, yes: true }))
  expect(error.code).toBe(RpcErrorCode.Conflict)
  expect(error.message).toBe('the primary worktree cannot be deleted; remove the project instead')

  await openMenu(win, 'main', 'api')
  const del = item('Delete') as HTMLButtonElement
  expect(del.disabled).toBe(true)
  expect(del.title).toBe('the primary worktree cannot be deleted; remove the project instead')
  del.click()
  await Bun.sleep(20)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(await listed(agent, main.id)).toBeDefined()
}, SLOW)

const selectedProject = (): string | null | undefined =>
  document.querySelector<HTMLSelectElement>('[role="dialog"] select')?.selectedOptions[0]?.textContent

test('SC-62: Mod+N and the API open the create dialog on the right project', async () => {
  const { win, agent, api, web, fixLogin } = await boot({ web: true })
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: fixLogin.id } })
  await win.waitFor(() => card('fix-login', 'api'))

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', metaKey: true, bubbles: true, cancelable: true }))
  const dialog = await win.waitFor(() => document.querySelector('[role="dialog"]'))
  expect(dialog.getAttribute('aria-label')).toBe('New workspace')
  expect(selectedProject()).toBe('api')
  const open = await win.waitFor(async () => {
    const next = await report(agent)
    return next?.dialog ? next : undefined
  })
  expect(open.dialog).toEqual({ kind: 'create', repoId: api.id })

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await win.waitFor(() => !document.querySelector('[role="dialog"]'))
  await win.waitFor(async () => (await report(agent)).dialog === null)

  await agent.callAny('ui.command.run', { id: NEW_WORKTREE, args: { repo: 'web' } })
  await win.waitFor(() => selectedProject() === 'web')
  const second = await win.waitFor(async () => {
    const next = await report(agent)
    return next?.dialog ? next : undefined
  })
  expect(second.dialog).toEqual({ kind: 'create', repoId: web!.id })
}, SLOW)
