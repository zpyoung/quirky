import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectGroup, QuirkyClient, Repo, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { failure, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { button, click, dialogNamed, field, listRowName, menuItem, openDisclosure, pressEscape, sectionHeading, sectionHeadingMatches, setText } from './window/dom'
const WORKTREES_CONTRIBUTION = 'sidebar-section:quirky.worktree/worktrees'
const WORKTREES_TOOL = WORKTREES_CONTRIBUTION
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
  await world.win.waitFor(async () => {
    const slot = await sidebarSlot(agent)
    return slot?.shown && slot.report !== undefined ? slot : undefined
  })
  return world
}

const sidebarPanel = (): HTMLElement | undefined =>
  document.querySelector<HTMLElement>(`[data-tool-panel="${WORKTREES_TOOL}"]`) ?? undefined
const sidebarElements = <T extends Element>(selector: string): T[] =>
  [...(sidebarPanel()?.querySelectorAll<T>(selector) ?? [])]
const rendererState = async (agent: QuirkyClient): Promise<UiState | undefined> => {
  const overview = (await agent.callAny('ui.state', {})) as UiState
  const renderers = overview.windows.filter((window) => window.name === 'quirky-ui')
  if (renderers.length !== 1) return undefined
  return await agent.callAny('ui.window.state', { connId: renderers[0]!.connId }) as UiState
}

const sidebarSlot = async (agent: QuirkyClient) => {
  const state = await rendererState(agent)
  return state?.slots.find((slot) => slot.id === WORKTREES_CONTRIBUTION)
}

const report = async (agent: QuirkyClient): Promise<any> => (await sidebarSlot(agent))?.report

type SidebarReportRow = {
  id: string
  name: string
  depth: number
  parentId: string | null
  status: string | null
  primary: boolean
  pinned: boolean
  pending: boolean
  removing: boolean
  selected: boolean
  workspaceStatus: string
}
type SidebarReportProject = { id: string; name: string; kind: string; worktrees: SidebarReportRow[] }
type SidebarReportGroup = { id: string; name: string; collapsed: boolean; worktrees: SidebarReportRow[]; projects: SidebarReportProject[] }
type SidebarReport = { projects: SidebarReportProject[]; groups: SidebarReportGroup[]; pinned: string[]; dialog: unknown }

const reportRow = async (agent: QuirkyClient, id: string): Promise<SidebarReportRow | undefined> => {
  const state = await report(agent) as SidebarReport | undefined
  const projects = [...(state?.projects ?? []), ...(state?.groups ?? []).flatMap((group) => group.projects)]
  return projects.flatMap((project) => project.worktrees).find((row) => row.id === id)
}

const listed = async (agent: QuirkyClient, id: string) =>
  ((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).find((w) => w.id === id)!


/** Finds the worktree row named `name`, in project `project` or, with none, the first match. */
function card(name: string, project?: string, scope: 'repo' | 'pinned' = 'repo'): HTMLElement | undefined {
  const sections = (scope === 'pinned'
    ? sidebarElements<HTMLElement>('[data-top-level-section="pinned"]')
    : sidebarElements<HTMLElement>('section.repo')).filter(
    (section) => project === undefined || sectionHeadingMatches(section, project)
  )
  for (const section of sections) {
    const found = [...section.querySelectorAll<HTMLElement>('[data-worktree-id]')].find((row) => listRowName(row) === name)
    if (found) return found
  }
  return undefined
}

async function openMenu(win: HeadlessWindow, name: string, project?: string): Promise<HTMLElement> {
  const row = card(name, project)
  if (!row) throw new Error(`no worktree row for ${project}/${name}`)
  await click(button(row, `Actions for ${name}`)!)
  return win.waitFor(() => document.querySelector<HTMLElement>('[role="menu"]') ?? undefined)
}

const item = (label: string): HTMLElement | undefined => menuItem(document, label)

async function choose(win: HeadlessWindow, label: string): Promise<void> {
  const target = await win.waitFor(() => item(label))
  target.click()
  await Bun.sleep(20)
}

test('SC-44: the sidebar reports project and group membership, primary worktrees, and nested children', async () => {
  const w = await boot({ nested: true, grouped: true, notes: true })
  const { win, agent, api, main, fixLogin, child, group, notes } = w
  await win.waitFor(() => card('child', 'api'))

  const groupSections = sidebarElements<HTMLElement>('section.group')
  const projectSections = sidebarElements<HTMLElement>('section.repo')
  expect(groupSections.map(sectionHeading)).toEqual(['services'])
  expect(projectSections.map(sectionHeading)).toEqual(['api', 'notes'])
  expect(sectionHeading(groupSections[0]!.querySelector('section.repo')!)).toBe('api')
  expect(sectionHeading(sidebarPanel()!.querySelector('section.group + section.repo')!)).toBe('notes')

  const apiRows = projectSections.find((section) => sectionHeadingMatches(section, 'api'))!
  expect([...apiRows.querySelectorAll<HTMLElement>('[data-worktree-id]')].map(listRowName)).toEqual(['main', 'fix-login', 'child'])
  const childToggle = card('fix-login', 'api')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(childToggle.getAttribute('aria-expanded')).toBe('true')

  await click(childToggle)
  await win.waitFor(() => !card('child', 'api'))
  await agent.callAny('quirky.worktree/set', { worktree: fixLogin.id, status: 'in-review' })
  await win.waitFor(async () => (await reportRow(agent, fixLogin.id))?.workspaceStatus === 'in-review')
  expect(card('child', 'api')).toBeUndefined()
  await agent.callAny('quirky.worktree/set', { worktree: fixLogin.id, status: 'in-progress' })
  await win.waitFor(async () => (await reportRow(agent, fixLogin.id))?.workspaceStatus === 'in-progress')
  await click(card('fix-login', 'api')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!)
  await win.waitFor(() => card('child', 'api'))
  const state = await win.waitFor(async () => {
    const next = await report(agent) as SidebarReport | undefined
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
  const section = sidebarElements<HTMLElement>('section.group').find((candidate) => sectionHeadingMatches(candidate, 'services'))!
  await click(button(section, 'Collapse group services')!)
  await win.waitFor(() => !card('fix-login', 'api'))
  expect(((await agent.callAny('quirky.repo/groupList', {})) as ProjectGroup[]).find((g) => g.id === group!.id)!.collapsed).toBe(true)
  expect((await report(agent)).groups[0].collapsed).toBe(true)
  await click(button(section, 'Expand group services')!)
}, SLOW)

test('SC-43: status, pin and unread from the card menu', async () => {
  const { win, agent, main, fixLogin, docs } = await boot({ docs: true })
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: main.id } })
  await win.waitFor(() => card('docs', 'api'))

  await openMenu(win, 'fix-login', 'api')
  await choose(win, 'Move to Status')
  await choose(win, 'In review')
  await win.waitFor(async () => (await listed(agent, fixLogin.id)).status === 'in-review')

  await win.waitFor(async () => (await reportRow(agent, fixLogin.id))?.workspaceStatus === 'in-review')
  await win.waitFor(() => card('fix-login', 'api')?.textContent?.includes('In review'))
  await openMenu(win, 'fix-login', 'api')
  await choose(win, 'Pin')
  await win.waitFor(() => card('fix-login', undefined, 'pinned'))
  expect((await listed(agent, fixLogin.id)).pinned).toBe(true)
  const pinnedSection = sidebarPanel()!.querySelector<HTMLElement>('[data-top-level-section="pinned"]')!
  expect(sectionHeading(pinnedSection)).toBe('Pinned')
  expect(pinnedSection.nextElementSibling?.getAttribute('data-top-level-section')?.startsWith('repo:')).toBe(true)
  expect(await reportRow(agent, fixLogin.id)).toMatchObject({ pinned: true, workspaceStatus: 'in-review' })
  expect((await report(agent)).pinned).toEqual([fixLogin.id])

  await agent.callAny('quirky.worktree/set', { worktree: docs!.id, unread: false })
  await openMenu(win, 'docs', 'api')
  await choose(win, 'Mark Unread')
  await win.waitFor(() => card('docs', 'api')!.querySelector('[role="img"][aria-label="Unread"]'))
  expect((await listed(agent, docs!.id)).unread).toBe(true)

  await click(button(card('docs', 'api')!, 'Open docs')!)
  await win.waitFor(async () => (await listed(agent, docs!.id)).unread === false)
  await win.waitFor(() => !card('docs', 'api')!.querySelector('[role="img"][aria-label="Unread"]'))
  const layout = ((await agent.callAny('ui.state', {})) as UiState).layout
  expect(layout.view).toEqual({ id: SESSION_VIEW, input: { worktree: docs!.id } })
}, SLOW)

test('SC-59: the primary checkout cannot be deleted', async () => {
  const { win, agent, main } = await boot()
  await win.waitFor(() => card('main', 'api'))
  const error = await failure(agent.callAny('quirky.worktree/remove', { worktree: main.id, yes: true }))
  expect(error.code).toBe(RpcErrorCode.Conflict)

  await openMenu(win, 'main', 'api')
  const del = item('Delete') as HTMLButtonElement
  expect(del.disabled).toBe(true)
  del.click()
  await Bun.sleep(20)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(await listed(agent, main.id)).toBeDefined()
}, SLOW)

const selectedProject = (dialog: ParentNode): string | null | undefined =>
  field<HTMLSelectElement>(dialog, 'Project')?.selectedOptions[0]?.textContent

test('SC-62: Mod+N and the API open the create dialog on the right project', async () => {
  const { win, agent, api, web, fixLogin } = await boot({ web: true })
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: fixLogin.id } })
  await win.waitFor(() => card('fix-login', 'api'))

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', metaKey: true, bubbles: true, cancelable: true }))
  const dialog = await win.waitFor(() => dialogNamed('New workspace'))
  expect(selectedProject(dialog)).toBe('api')
  const open = await win.waitFor(async () => {
    const next = await report(agent)
    return next?.dialog ? next : undefined
  })
  expect(open.dialog).toEqual({ kind: 'create', repoId: api.id })

  await pressEscape()
  await win.waitFor(() => !dialogNamed('New workspace'))
  await win.waitFor(async () => (await report(agent)).dialog === null)

  await agent.callAny('ui.command.run', { id: NEW_WORKTREE, args: { repo: 'web' } })
  await win.waitFor(() => {
    const next = dialogNamed('New workspace')
    return next && selectedProject(next) === 'web'
  })
  const second = await win.waitFor(async () => {
    const next = await report(agent)
    return next?.dialog ? next : undefined
  })
  expect(second.dialog).toEqual({ kind: 'create', repoId: web!.id })
}, SLOW)

test('workspace status icon/avatar controls persist safe plain text and render on the board', async () => {
  const { win, agent } = await boot()
  const statusOptionsButton = await win.waitFor(() => button(document, 'Worktrees options'))
  await click(statusOptionsButton)
  const statusOptions = await win.waitFor(() => dialogNamed('Worktrees options'))
  await openDisclosure('More workspace tools', statusOptions)
  const edit = await win.waitFor(() => button(statusOptions, 'Edit workspace statuses'))
  await click(edit)
  const dialog = await win.waitFor(() => dialogNamed('Workspace statuses'))
  const icon = field(dialog, 'Status icon 3')
  if (!icon) throw new Error('status editor did not expose the in-review icon control')
  await setText(icon, '🧪')
  await click(button(dialog, 'Save statuses')!)
  await win.waitFor(() => !dialogNamed('Workspace statuses'))

  const statuses = await agent.callAny('quirky.worktree/statusDefinitions', {}) as Array<{ id: string; icon?: string }>
  expect(statuses.find((status) => status.id === 'in-review')?.icon).toBe('🧪')
  const boardOptionsButton = await win.waitFor(() => button(document, 'Worktrees options'))
  await click(boardOptionsButton)
  const boardOptions = await win.waitFor(() => dialogNamed('Worktrees options'))
  await openDisclosure('More workspace tools', boardOptions)
  const board = await win.waitFor(() => button(boardOptions, 'Workspace board'))
  await click(board)
  const laneHeading = await win.waitFor(() =>
    sidebarElements<HTMLHeadingElement>('h2').find((heading) => heading.textContent?.includes('In review'))
  )
  expect(laneHeading.textContent).toContain('🧪')
  await expect(agent.callAny('quirky.worktree/setStatusDefinitions', {
    statuses: statuses.map((status) => status.id === 'in-review'
      ? { ...status, label: 'In review', color: '#a57de8', icon: '<svg onload=alert(1)>' }
      : { ...status, label: status.id, color: '#888888' })
  })).rejects.toThrow(/icon/i)
}, SLOW)
