import { rmSync, writeFileSync } from 'node:fs'
import { afterEach, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import type { ProjectGroup, QuirkyClient, Repo, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { failure, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'

const SIDEBAR = 'sidebar-section:quirky.worktree/worktrees'
const SESSION_VIEW = 'view:quirky.session/worktree'
const REPO_ROOT = resolve(import.meta.dir, '../../..')
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts')
const { scratch } = isolateGitConfig()
const SLOW = 30_000

type World = {
  harness: Harness
  processScope: ProcessScope
  win: HeadlessWindow
  agent: QuirkyClient
  api: Repo
  main: Worktree
  feature: Worktree
  group: ProjectGroup
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

let current: World | null = null

afterEach(async () => {
  if (!current) return
  const world = current
  current = null
  try {
    await world.win.stop()
  } finally {
    try {
      await world.processScope.cleanup()
    } finally {
      try {
        await world.harness.cleanup()
      } finally {
        removeTempDirs()
        rmSync(world.harness.home, { recursive: true, force: true })
      }
    }
  }
})

async function boot(): Promise<World> {
  const home = makeTempHome('qwt-sidebar-extras-')
  let harness: Harness | undefined
  let processScope: ProcessScope | undefined
  let win: HeadlessWindow | undefined
  try {
    harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
    processScope = createProcessScope(home)
    const agent = await harness.connect('cli', 'sidebar-extras-e2e')
    const root = resolve(makeTempDir('qwt-sidebar-extras-root-'))
    await agent.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
    const api = (await agent.callAny('quirky.repo/add', { path: makeRepo(join(scratch(), 'api')) })) as Repo
    const worktrees = (await agent.callAny('quirky.worktree/list', { repo: api.id })) as Worktree[]
    const main = worktrees.find((item) => item.isMain)!
    const feature = ((await agent.callAny('quirky.worktree/create', { repo: api.id, name: 'feature' })) as WorktreeCreateResult).worktree
    const group = (await agent.callAny('quirky.repo/groupCreate', { name: 'Team' })) as ProjectGroup
    win = await startHeadlessWindow({ home, runtime: harness.runtime })
    const cli = async (args: string[]) => {
      const child = processScope!.spawn([process.execPath, CLI_MAIN, ...args], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, QUIRKY_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
        child.exited
      ])
      return { code, stdout, stderr }
    }
    const world: World = { harness, processScope, win, agent, api, main, feature, group, cli }
    current = world
    return world
  } catch (error) {
    try {
      await win?.stop()
    } finally {
      try {
        await processScope?.cleanup()
      } finally {
        try {
          await harness?.cleanup()
        } finally {
          removeTempDirs()
          rmSync(home, { recursive: true, force: true })
        }
      }
    }
    throw error
  }
}

type SidebarReport = {
  dialog: unknown
  groups: { id: string }[]
  hiddenCount?: number
  separators?: { enabled: boolean; eligibleBoundaries?: string[] }
}

const report = async (agent: QuirkyClient): Promise<SidebarReport | undefined> => {
  const state = (await agent.callAny('ui.state', {})) as UiState
  const entry = state.slots.find((slot) => slot.id === SIDEBAR)
  const value = entry?.report
  return value && typeof value === 'object' ? value as SidebarReport : undefined
}

function card(name: string, project?: string): HTMLElement | undefined {
  const sections = [...document.querySelectorAll<HTMLElement>('section.repo, section.group')].filter(
    (section) => project === undefined || section.querySelector('.repo-name')?.textContent === project
  )
  for (const section of sections) {
    const found = [...section.querySelectorAll<HTMLElement>('li.worktree')].find((row) => row.querySelector('.worktree-name')?.textContent === name)
    if (found) return found
  }
  return undefined
}

const rowGeometry = () =>
  [...document.querySelectorAll<HTMLElement>('li.worktree')].map((row) => {
    const bounds = row.getBoundingClientRect()
    return { name: row.querySelector('.worktree-name')?.textContent, top: bounds.top, bottom: bounds.bottom, height: bounds.height }
  })
const menuItem = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
    (element) => element.textContent?.replace(/\s*▸$/, '').trim() === label
  )

async function openMenu(win: HeadlessWindow, name: string, project: string): Promise<void> {
  const target = card(name, project)?.querySelector<HTMLElement>('.worktree-menu')
  if (!target) throw new Error(`no action button for ${project}/${name}`)
  target.click()
  await win.waitFor(() => document.querySelector('[role="menu"]'))
}

async function choose(win: HeadlessWindow, label: string): Promise<void> {
  const target = await win.waitFor(() => menuItem(label))
  target.click()
}

async function cliJson<T>(world: World, args: string[]): Promise<T> {
  const result = await world.cli([...args, '--json'])
  expect(result.code, result.stderr || result.stdout).toBe(0)
  return JSON.parse(result.stdout) as T
}

const sidebarState = (world: World) => cliJson<{ preferences: { workspaceActivityWindow: string; alwaysShowDefaultBranchWorkspace: boolean }; active: { worktreeId: string } | null }>(world, ['sidebar-extras', 'state'])
type DirtyActivityReport = { count: number; dirty: boolean; available: boolean; title: string }

async function activityReport(agent: QuirkyClient): Promise<DirtyActivityReport | undefined> {
  const state = (await agent.callAny('ui.state', {})) as UiState
  const slot = state.slots.find((candidate) => candidate.kind === 'activity-item' && candidate.title === 'Source Control')
  const value = slot?.report
  if (!value || typeof value !== 'object') return undefined
  if (!('count' in value) || typeof value.count !== 'number') return undefined
  if (!('dirty' in value) || typeof value.dirty !== 'boolean') return undefined
  if (!('available' in value) || typeof value.available !== 'boolean') return undefined
  if (!('title' in value) || typeof value.title !== 'string') return undefined
  return { count: value.count, dirty: value.dirty, available: value.available, title: value.title }
}

async function runGit(world: World, cwd: string, args: string[]): Promise<void> {
  const child = world.processScope.spawn(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: world.harness.home,
      QUIRKY_HOME: world.harness.home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr || stdout}`)
}

test('SC-02/08/10/17: real CLI and sidebar share activity preferences, selected workspace, and membership', async () => {
  const world = await boot()
  const { win, agent, api, feature, group } = world
  await win.waitFor(() => card('feature', 'api'))
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: feature.id } })
  await win.waitFor(() => card('feature', 'api')?.classList.contains('selected'))
  await win.waitFor(async () => {
    const state = (await agent.callAny('quirky.sidebar-extras/state', {})) as { active: { worktreeId: string } | null }
    return state.active?.worktreeId === feature.id ? state : undefined
  })

  const initial = await sidebarState(world)
  expect(initial.preferences.workspaceActivityWindow).toBe('all')
  expect(initial.active).toMatchObject({ worktreeId: feature.id })

  const filter = await win.waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => /workspace options|filters/i.test(button.textContent ?? '') || /workspace options|filters/i.test(button.getAttribute('aria-label') ?? '')
  ))
  filter.click()
  const week = await win.waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Week'))
  week.click()
  await win.waitFor(async () => {
    const state = (await agent.callAny('quirky.sidebar-extras/state', {})) as { preferences: { workspaceActivityWindow: string } }
    return state.preferences.workspaceActivityWindow === 'week' ? state : undefined
  })
  const fromSidebar = await sidebarState(world)
  expect(fromSidebar.preferences.workspaceActivityWindow).toBe('week')

  const fromCli = await cliJson<{ preferences: { workspaceActivityWindow: string; alwaysShowDefaultBranchWorkspace: boolean } }>(world, [
    'sidebar-extras', 'set', '--workspace-activity-window', 'live-only', '--always-show-default-branch-workspace=false'
  ])
  expect(fromCli.preferences).toMatchObject({ workspaceActivityWindow: 'live-only', alwaysShowDefaultBranchWorkspace: false })
  await win.waitFor(() => !card('main', 'api'))
  expect(card('feature', 'api')?.classList.contains('selected')).toBe(true)

  await openMenu(win, 'feature', 'api')
  await choose(win, 'Add worktree to group')
  await choose(win, 'Team')
  await win.waitFor(async () => ((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).find((item) => item.id === feature.id)?.projectGroupId === group.id)
  await win.waitFor(() => card('feature')?.closest('section.group')?.querySelector('.group-name')?.textContent === 'Team')
  expect(card('feature')?.closest('section.group')?.querySelector('.group-name')?.textContent).toBe('Team')
  expect((await report(agent))?.groups.some((item) => item.id === group.id)).toBe(true)

  await openMenu(win, 'feature', 'api')
  await choose(win, 'Remove worktree from group')
  await win.waitFor(async () => ((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).find((item) => item.id === feature.id)?.projectGroupId === null)
  await win.waitFor(() => card('feature', 'api'))
  expect(card('feature', 'api')).toBeDefined()

  const reset = await cliJson<{ preferences: { workspaceActivityWindow: string } }>(world, ['sidebar-extras', 'set', '--workspace-activity-window', 'all'])
  expect(reset.preferences.workspaceActivityWindow).toBe('all')
  await win.waitFor(() => card('main', 'api'))
  const state = await report(agent)
  expect(state?.dialog).toBeNull()
  expect((await agent.callAny('quirky.repo/list', {})) as Repo[]).toContainEqual(expect.objectContaining({ id: api.id, name: 'api' }))
}, SLOW)

test('SC-14/15/17: the real dirty activity item follows the active worktree and counts staged plus unstaged rows', async () => {
  const world = await boot()
  const { win, agent, feature, main } = world
  await win.waitFor(() => card('feature', 'api'))
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: feature.id } })
  await win.waitFor(async () => {
    const state = (await agent.callAny('quirky.sidebar-extras/state', {})) as { active: { worktreeId: string } | null }
    return state.active?.worktreeId === feature.id ? state : undefined
  })

  const clean = await win.waitFor(() => activityReport(agent))
  expect(clean).toMatchObject({ count: 0, dirty: false, available: true, title: 'Source Control' })

  const file = join(feature.path, 'sidebar-dirty.txt')
  writeFileSync(file, 'unstaged\n')
  await agent.callAny('quirky.worktree/set', { worktree: feature.id, comment: 'refresh dirty status one' })
  const untracked = await win.waitFor(async () => {
    const report = await activityReport(agent)
    return report?.count === 1 ? report : undefined
  })
  expect(untracked).toMatchObject({ count: 1, dirty: true, available: true })
  expect(untracked.title).toMatch(/1 change/)

  await runGit(world, feature.path, ['add', '--', 'sidebar-dirty.txt'])
  writeFileSync(file, 'staged and unstaged\n')
  await agent.callAny('quirky.worktree/set', { worktree: feature.id, comment: 'refresh dirty status two' })
  const modified = await win.waitFor(async () => {
    const report = await activityReport(agent)
    return report?.count === 2 ? report : undefined
  })
  expect(modified).toMatchObject({ count: 2, dirty: true, available: true })
  expect(modified.title).toMatch(/2 changes/)
  expect((await cliJson<DirtyActivityReport>(world, ['sidebar-extras', 'dirty', '--worktree', feature.id])).count).toBe(2)

  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: main.id } })
  await win.waitFor(async () => {
    const state = (await agent.callAny('quirky.sidebar-extras/state', {})) as { active: { worktreeId: string } | null }
    return state.active?.worktreeId === main.id ? state : undefined
  })
  const backgroundDirty = await win.waitFor(async () => {
    const report = await activityReport(agent)
    return report?.count === 0 ? report : undefined
  })
  expect(backgroundDirty).toMatchObject({ count: 0, dirty: false, available: true, title: 'Source Control' })

  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: null } })
  await win.waitFor(async () => {
    const state = (await agent.callAny('quirky.sidebar-extras/state', {})) as { active: { worktreeId: string } | null }
    return state.active === null ? state : undefined
  })
  expect(await win.waitFor(() => activityReport(agent))).toMatchObject({ count: 0, dirty: false, title: 'Source Control' })
}, SLOW)

test('SC-16/17: appearance setting changes separators through CLI without changing sidebar row identity', async () => {
  const world = await boot()
  const { win, agent, api, feature } = world
  await win.waitFor(() => card('feature', 'api'))
  const before = await report(agent)
  const rowsBefore = rowGeometry()
  expect(before?.separators?.enabled).toBe(true)

  const settings = (await agent.callAny('setting.list', {})) as { id: string; name?: string; title?: string }[]
  const separators = settings.find((setting) => /sidebar section separators/i.test(JSON.stringify(setting)))
  expect(separators).toBeDefined()
  const changed = await world.cli(['setting', 'set', separators!.id, 'false', '--json'])
  expect(changed.code, changed.stderr || changed.stdout).toBe(0)
  const after = await win.waitFor(async () => {
    const latest = await report(agent)
    return latest?.separators?.enabled === false ? latest : undefined
  })
  expect(after.separators?.enabled).toBe(false)

  const rowsAfter = rowGeometry()
  expect(rowsAfter).toEqual(rowsBefore)
  expect(card('feature', 'api')).toBeDefined()
  expect((await agent.callAny('quirky.repo/list', {})) as Repo[]).toContainEqual(expect.objectContaining({ id: api.id }))
  expect((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).toContainEqual(expect.objectContaining({ id: feature.id }))
}, SLOW)

test('disabled sidebar extras leaves core worktree dispatch available', async () => {
  const world = await boot()
  const { win, agent, feature } = world
  await win.waitFor(() => card('feature'))
  await agent.callAny('plugin.disable', { id: 'quirky.sidebar-extras' })
  await win.waitFor(() => card('feature'))

  const result = await failure(agent.callAny('quirky.worktree/set', { worktree: feature.id, unread: true }))
  expect(result.message).not.toMatch(/sidebar extras/i)
  expect(((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).find((item) => item.id === feature.id)?.unread).toBe(true)
  const state = await world.cli(['sidebar-extras', 'state', '--json'])
  expect(state.code).not.toBe(0)
}, SLOW)
