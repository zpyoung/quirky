import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectGroup, QuirkyClient, Repo, RepoDetails, Session, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { commitFiles, failure, git, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { githubUser, useGlobalGitConfig } from './fixtures/repos'
import { button, click, dialogNamed, field, listRowName, menuItem, sectionHeadingMatches, setSelect, setText, toastContaining, toastMessages } from './window/dom'

const WORKTREES_CONTRIBUTION = 'sidebar-section:quirky.worktree/worktrees'
const WORKTREES_TOOL = WORKTREES_CONTRIBUTION
const SLOW = 40_000
const CONFIRM_DELETE = 'setting:quirky.worktree/confirmDelete'

const { scratch } = isolateGitConfig()
beforeEach(() => useGlobalGitConfig(scratch, githubUser('zoe')))

type World = { harness: Harness; win: HeadlessWindow; agent: QuirkyClient; root: string }
let current: World | null = null

afterEach(async () => {
  if (!current) return
  await current.win.stop()
  await current.harness.cleanup()
  current = null
  removeTempDirs()
})

/** A real daemon with the real repo, worktree, session and git plugins, and a headless window on it. */
async function boot(): Promise<World> {
  const harness = await startHarness({ home: makeHomeWithoutAutoHooks('qwp-'), builtinPluginsDir: builtinsDir() })
  const agent = await harness.connect('cli', 'setup')
  const root = realpathSync(makeTempDir('qwp-root-'))
  await agent.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const win = await startHeadlessWindow({ home: harness.home, runtime: harness.runtime })
  current = { harness, win, agent, root }
  await win.waitFor(async () => {
    const slot = await sidebarSlot(agent)
    return slot?.shown && slot.report !== undefined ? slot : undefined
  })
  return current
}

const repoNamed = (w: World, name: string) => w.win.waitFor(async () => ((await w.agent.callAny('quirky.repo/list', {})) as Repo[]).find((r) => r.name === name))
const repos = async (agent: QuirkyClient) => (await agent.callAny('quirky.repo/list', {})) as Repo[]
const groups = async (agent: QuirkyClient) => (await agent.callAny('quirky.repo/groupList', {})) as ProjectGroup[]
const worktrees = async (agent: QuirkyClient) => (await agent.callAny('quirky.worktree/list', {})) as Worktree[]
const sessions = async (agent: QuirkyClient) => (await agent.callAny('quirky.session/list', {})) as Session[]
const uiState = async (agent: QuirkyClient) => (await agent.callAny('ui.state', {})) as UiState
const rendererState = async (agent: QuirkyClient): Promise<UiState | undefined> => {
  const overview = await uiState(agent)
  const renderers = overview.windows.filter((window) => window.name === 'quirky-ui')
  if (renderers.length !== 1) return undefined
  return await agent.callAny('ui.window.state', { connId: renderers[0]!.connId }) as UiState
}
const sidebarPanel = (): HTMLElement | undefined =>
  document.querySelector<HTMLElement>(`[data-tool-panel="${WORKTREES_TOOL}"]`) ?? undefined
const sidebarElements = <T extends Element>(selector: string): T[] =>
  [...(sidebarPanel()?.querySelectorAll<T>(selector) ?? [])]

const sidebarSlot = async (agent: QuirkyClient) => {
  const state = await rendererState(agent)
  return state?.slots.find((slot) => slot.id === WORKTREES_CONTRIBUTION)
}

const report = async (agent: QuirkyClient): Promise<any> => (await sidebarSlot(agent))?.report
const created = async (agent: QuirkyClient, params: Record<string, unknown>) => ((await agent.callAny('quirky.worktree/create', params)) as WorktreeCreateResult).worktree
const branches = (dir: string) => git(dir, 'branch', '--format=%(refname:short)').split('\n')

const addApi = async (w: World, name = 'api') => {
  const dir = makeRepo(join(scratch(), name))
  const repo = (await w.agent.callAny('quirky.repo/add', { path: dir })) as Repo
  await w.win.waitFor(() => sidebarElements<HTMLElement>('section.repo').some((section) => sectionHeadingMatches(section, name)))
  return { repo, dir }
}

const reportedDialog = (w: World, kind: string | null) =>
  w.win.waitFor(async () => {
    const dialog = (await report(w.agent))?.dialog ?? null
    return (dialog === null ? kind === null : dialog.kind === kind) ? { dialog } : undefined
  }).then((found) => found.dialog)

const closed = (w: World, title: string) => w.win.waitFor(() => !dialogNamed(title))

function card(name: string): HTMLElement | undefined {
  return sidebarElements<HTMLElement>('[data-worktree-id]').find((row) => listRowName(row) === name)
}

const projectSection = (name: string) => sidebarElements<HTMLElement>('section.repo').find((section) => sectionHeadingMatches(section, name))
const groupSection = (name: string) => sidebarElements<HTMLElement>('section.group').find((section) => sectionHeadingMatches(section, name))

const item = (label: string): HTMLElement | undefined => menuItem(document, label)
const branchNotice = (): HTMLElement | undefined =>
  sidebarPanel()?.querySelector<HTMLElement>('[aria-label="Kept branches"] [role="status"]') ?? undefined



async function choose(win: HeadlessWindow, label: string): Promise<void> {
  const target = await win.waitFor(() => item(label))
  target.click()
  await Bun.sleep(30)
}

async function openCardMenu(win: HeadlessWindow, name: string): Promise<void> {
  const row = await win.waitFor(() => card(name))
  await click(button(row, `Actions for ${name}`)!)
  await win.waitFor(() => document.querySelector('[role="menu"]'))
}

async function openProjectMenu(win: HeadlessWindow, name: string): Promise<void> {
  const section = await win.waitFor(() => projectSection(name))
  await click(button(section, `Actions for ${name}`)!)
  await win.waitFor(() => document.querySelector('[role="menu"]'))
}

async function openGroupMenu(win: HeadlessWindow, name: string): Promise<void> {
  const section = await win.waitFor(() => groupSection(name))
  await click(button(section, `Actions for group ${name}`)!)
  await win.waitFor(() => document.querySelector('[role="menu"]'))
}

/** Opens Add project and submits `path` from its field. */
async function submitPath(w: World, path: string): Promise<HTMLElement> {
  await click(await w.win.waitFor(() => button(document, 'Add project')))
  const dialog = await w.win.waitFor(() => dialogNamed('Add project'))
  await reportedDialog(w, 'add-project')
  await setText(field(dialog, 'Path')!, path)
  await click(button(dialog, 'Add')!)
  return dialog
}

test('SC-3: a plain folder offers Open as Folder, which adds a one-workspace folder project', async () => {
  const w = await boot()
  const dir = join(scratch(), 'w', 'notes')
  mkdirSync(dir, { recursive: true })
  const path = realpathSync(dir)

  await submitPath(w, path)
  const asking = await w.win.waitFor(() => dialogNamed('Open as Folder'))
  expect(await reportedDialog(w, 'open-as-folder')).toMatchObject({ kind: 'open-as-folder', path })
  expect(button(asking, 'Cancel')).toBeDefined()
  expect(await repos(w.agent)).toEqual([])

  await click(button(asking, 'Open as Folder')!)
  await closed(w, 'Open as Folder')
  const notes = await repoNamed(w, 'notes')
  expect(notes).toMatchObject({ kind: 'folder', path })
  const mine = (await worktrees(w.agent)).filter((x) => x.repoId === notes.id)
  expect(mine).toHaveLength(1)
  expect(mine[0]).toMatchObject({ kind: 'folder', path })

  await w.win.waitFor(() => card('notes'))
  await click(button(card('notes')!, 'Open notes')!)
  const shell = (await w.agent.callAny('quirky.session/create', { worktree: mine[0]!.id, agent: 'shell' })) as Session
  expect(shell.cwd).toBe(path)
  await reportedDialog(w, null)
}, SLOW)

test('SC-3: Cancel on the folder question adds nothing, and a path that cannot be added toasts', async () => {
  const w = await boot()
  const dir = join(scratch(), 'plain')
  mkdirSync(dir, { recursive: true })
  await submitPath(w, realpathSync(dir))
  const asking = await w.win.waitFor(() => dialogNamed('Open as Folder'))
  await click(button(asking, 'Cancel')!)
  await closed(w, 'Open as Folder')
  expect(await repos(w.agent)).toEqual([])
  await reportedDialog(w, null)

  await submitPath(w, join(scratch(), 'missing'))
  await w.win.waitFor(() => toastMessages().some((message) => message.includes('Could not add project')))
}, SLOW)

test('SC-3: a repository path is added straight away', async () => {
  const w = await boot()
  const dir = makeRepo(join(scratch(), 'api'))
  await submitPath(w, dir)
  await closed(w, 'Add project')
  expect((await repoNamed(w, 'api')).kind).toBe('git')
  await w.win.waitFor(() => projectSection('api'))
}, SLOW)

test('SC-8: a folder of repositories is imported as a group or separately, by the choice', async () => {
  const w = await boot()
  const apps = join(scratch(), 'w', 'apps')
  makeRepo(join(apps, 'web'))
  makeRepo(join(apps, 'cli'))
  const tools = join(scratch(), 'w', 'tools')
  makeRepo(join(tools, 'lint'))
  makeRepo(join(tools, 'fmt'))
  const appsPath = realpathSync(apps)

  await submitPath(w, appsPath)
  const asking = await w.win.waitFor(() => dialogNamed('Import repositories'))
  expect(field(asking, 'Group name')!.value).toBe('apps')
  expect(button(asking, 'No, import separately')).toBeDefined()
  expect(await reportedDialog(w, 'import')).toMatchObject({ kind: 'import', path: appsPath })
  expect(await repos(w.agent)).toEqual([])

  await click(button(asking, 'Yes, import as group')!)
  await closed(w, 'Import repositories')
  await w.win.waitFor(() => groupSection('apps')?.querySelectorAll('section.repo').length === 2)
  const grouped = await groups(w.agent)
  expect(grouped.map((g) => g.name)).toEqual(['apps'])
  expect(grouped[0]!.repoIds).toHaveLength(2)
  expect((await report(w.agent)).groups[0].projects.map((p: { name: string }) => p.name).sort()).toEqual(['cli', 'web'])

  const toolsPath = realpathSync(tools)
  await submitPath(w, toolsPath)
  const second = await w.win.waitFor(() => dialogNamed('Import repositories'))
  await click(button(second, 'No, import separately')!)
  await closed(w, 'Import repositories')
  await w.win.waitFor(() => projectSection('lint') && projectSection('fmt'))
  expect(projectSection('lint')!.closest('section.group')).toBeNull()
  expect((await groups(w.agent)).map((g) => g.name)).toEqual(['apps'])
  expect((await repos(w.agent)).filter((r) => r.groupId === null).map((r) => r.name).sort()).toEqual(['fmt', 'lint'])
}, SLOW)

test('SC-8: the group name can be changed before importing', async () => {
  const w = await boot()
  const apps = join(scratch(), 'w', 'apps')
  makeRepo(join(apps, 'web'))
  await submitPath(w, realpathSync(apps))
  const asking = await w.win.waitFor(() => dialogNamed('Import repositories'))
  await setText(field(asking, 'Group name')!, 'frontends')
  await click(button(asking, 'Yes, import as group')!)
  await w.win.waitFor(() => groupSection('frontends'))
  expect((await groups(w.agent)).map((g) => g.name)).toEqual(['frontends'])
}, SLOW)

test('SC-9: Remove Project closes terminals, leaves folders and forgets metadata', async () => {
  const w = await boot()
  const { repo, dir } = await addApi(w)
  const fix = await created(w.agent, { repo: repo.id, name: 'fix-login' })
  await w.agent.callAny('quirky.worktree/set', { worktree: fix.id, displayName: 'Login fix' })
  const main = (await worktrees(w.agent)).find((x) => x.repoId === repo.id && x.isMain)!
  await w.agent.callAny('quirky.session/create', { worktree: main.id, agent: 'shell' })
  await w.agent.callAny('quirky.session/create', { worktree: fix.id, agent: 'shell' })
  expect(await sessions(w.agent)).toHaveLength(2)

  await openProjectMenu(w.win, 'api')
  await choose(w.win, 'Remove Project…')
  const dialog = await w.win.waitFor(() => dialogNamed('Remove Project'))
  expect(await reportedDialog(w, 'remove-project')).toMatchObject({ kind: 'remove-project', repoId: repo.id })
  expect(await repos(w.agent)).toHaveLength(1)

  await click(await w.win.waitFor(() => {
    const action = button(dialog, 'Remove')
    return action && !action.disabled ? action : undefined
  }))
  await w.win.waitFor(async () => (await repos(w.agent)).length === 0)
  await closed(w, 'Remove Project')
  await w.win.waitFor(async () => (await sessions(w.agent)).length === 0)
  expect(existsSync(dir)).toBe(true)
  expect(existsSync(fix.path)).toBe(true)
  await w.win.waitFor(() => !projectSection('api'))

  await w.agent.callAny('quirky.repo/add', { path: dir })
  const again = (await worktrees(w.agent)).find((x) => x.path === fix.path)!
  expect(again.displayName).toBeNull()
  expect(again.name).toBe('fix-login')
}, SLOW)

test('SC-9: Cancel on project removal preserves the project', async () => {
  const w = await boot()
  const { dir } = await addApi(w)
  await openProjectMenu(w.win, 'api')
  await choose(w.win, 'Remove Project…')
  const dialog = await w.win.waitFor(() => dialogNamed('Remove Project'))
  await click(button(dialog, 'Cancel')!)
  await closed(w, 'Remove Project')
  expect(existsSync(dir)).toBe(true)
  expect(await repos(w.agent)).toHaveLength(1)
}, SLOW)

test('SC-10: groups are made, filled, renamed, collapsed and deleted from the window, and the report follows', async () => {
  const w = await boot()
  const api = await addApi(w, 'api')
  const web = await addApi(w, 'web')

  await openProjectMenu(w.win, 'api')
  await choose(w.win, 'New Group from Project…')
  const naming = await w.win.waitFor(() => dialogNamed('New Group'))
  expect(await reportedDialog(w, 'group')).toMatchObject({ kind: 'group', action: 'new', repoId: api.repo.id })
  await setText(field(naming, 'Group name')!, 'backend')
  await click(button(naming, 'Create')!)
  await closed(w, 'New Group')
  await w.win.waitFor(() => {
    const project = groupSection('backend')?.querySelector('section.repo')
    return project && sectionHeadingMatches(project, 'api')
  })
  let listed = await groups(w.agent)
  expect(listed.map((g) => [g.name, g.repoIds])).toEqual([['backend', [api.repo.id]]])

  await openProjectMenu(w.win, 'web')
  await choose(w.win, 'Move to Group')
  expect(item('No group')).toBeUndefined()
  await choose(w.win, 'backend')
  await w.win.waitFor(() => groupSection('backend')?.querySelectorAll('section.repo').length === 2)
  // the window pushes its report after it renders, so the report can trail the DOM
  const filled = await w.win.waitFor(async () => {
    const next = await report(w.agent)
    return next?.groups?.[0]?.projects?.length === 2 ? next : undefined
  })
  expect(filled.groups[0].projects.map((p: { id: string }) => p.id).sort()).toEqual([api.repo.id, web.repo.id].sort())

  await openGroupMenu(w.win, 'backend')
  await choose(w.win, 'Rename…')
  const renaming = await w.win.waitFor(() => dialogNamed('Rename Group'))
  expect(await reportedDialog(w, 'group')).toMatchObject({ kind: 'group', action: 'rename', groupId: listed[0]!.id })
  expect(field(renaming, 'Group name')!.value).toBe('backend')
  await setText(field(renaming, 'Group name')!, 'services')
  await click(button(renaming, 'Rename')!)
  await closed(w, 'Rename Group')
  await w.win.waitFor(() => groupSection('services'))
  expect((await groups(w.agent)).map((g) => g.name)).toEqual(['services'])

  await click(button(groupSection('services')!, 'Collapse group services')!)
  await w.win.waitFor(async () => (await report(w.agent)).groups[0].collapsed === true)
  expect((await groups(w.agent))[0]!.collapsed).toBe(true)
  await click(button(groupSection('services')!, 'Expand group services')!)
  await w.win.waitFor(() => groupSection('services')?.querySelectorAll('section.repo').length === 2)

  await openProjectMenu(w.win, 'web')
  await choose(w.win, 'Move to Group')
  await choose(w.win, 'No group')
  await w.win.waitFor(() => groupSection('services')?.querySelectorAll('section.repo').length === 1)
  expect((await groups(w.agent))[0]!.repoIds).toEqual([api.repo.id])
  expect((await repos(w.agent)).find((r) => r.name === 'web')!.groupId).toBeNull()

  const waitForDeleteDialog = () => w.win.waitFor(async () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) return undefined
    const reported = (await report(w.agent))?.dialog
    return reported?.kind === 'group' && reported.action === 'delete' ? { dialog, reported } : undefined
  })

  await openGroupMenu(w.win, 'services')
  await choose(w.win, 'Delete Group…')
  const deleting = await waitForDeleteDialog()
  expect(deleting.reported).toMatchObject({ kind: 'group', action: 'delete', groupId: listed[0]!.id })
  expect(button(deleting.dialog, 'Cancel')).toBeDefined()
  expect(button(deleting.dialog, 'Delete Group')).toBeDefined()
  await click(button(deleting.dialog, 'Cancel')!)
  await w.win.waitFor(() => !document.querySelector('[role="dialog"]'))
  await reportedDialog(w, null)
  expect(await groups(w.agent)).toMatchObject([{ id: listed[0]!.id, name: 'services', repoIds: [api.repo.id] }])
  expect((await repos(w.agent)).find((r) => r.name === 'api')!.groupId).toBe(listed[0]!.id)

  await openGroupMenu(w.win, 'services')
  await choose(w.win, 'Delete Group…')
  const confirming = await waitForDeleteDialog()
  expect(confirming.reported).toMatchObject({ kind: 'group', action: 'delete', groupId: listed[0]!.id })
  await click(await w.win.waitFor(() => {
    const action = button(confirming.dialog, 'Delete Group')
    return action && !action.disabled ? action : undefined
  }))
  await w.win.waitFor(() => !document.querySelector('[role="dialog"]'))
  await reportedDialog(w, null)
  await w.win.waitFor(() => !groupSection('services'))
  expect(await groups(w.agent)).toEqual([])
  expect((await repos(w.agent)).map((r) => r.groupId)).toEqual([null, null])
  const final = await w.win.waitFor(async () => {
    const next = await report(w.agent)
    return next?.groups?.length === 0 ? next : undefined
  })
  expect(final.projects.map((p: { name: string }) => p.name)).toEqual(['api', 'web'])
}, SLOW)

test('SC-10: moving a project to a different group takes it out of the first', async () => {
  const w = await boot()
  const api = await addApi(w)
  const one = (await w.agent.callAny('quirky.repo/groupCreate', { name: 'one' })) as ProjectGroup
  await w.agent.callAny('quirky.repo/groupCreate', { name: 'two' })
  await w.agent.callAny('quirky.repo/groupAdd', { group: one.id, repo: api.repo.id })
  await w.win.waitFor(() => groupSection('one')?.querySelector('section.repo'))
  await openProjectMenu(w.win, 'api')
  await choose(w.win, 'Move to Group')
  expect(item('one')).toBeUndefined()
  expect(item('No group')).toBeDefined()
  await choose(w.win, 'two')
  await w.win.waitFor(() => groupSection('two')?.querySelector('section.repo'))
  const listed = await groups(w.agent)
  expect(listed.find((g) => g.name === 'one')!.repoIds).toEqual([])
  expect(listed.find((g) => g.name === 'two')!.repoIds).toEqual([api.repo.id])
}, SLOW)

test('SC-60: Project Settings shows what repo set stored, and saving a change shows in repo show', async () => {
  const w = await boot()
  const { repo, dir } = await addApi(w)
  writeFileSync(join(dir, 'quirky.yaml'), 'scripts:\n  setup: echo shared-setup\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'hooks')
  await w.agent.callAny('quirky.repo/set', {
    repo: repo.id,
    displayName: 'API',
    defaultBase: 'origin/develop',
    worktreeLocation: join(w.root, 'api-ws'),
    setupPolicy: 'ask',
    agentStartup: 'wait-for-setup',
    commandSource: 'run-both',
    setupScript: 'make deps'
  })
  await w.win.waitFor(() => projectSection('API'))

  await openProjectMenu(w.win, 'API')
  await choose(w.win, 'Project Settings…')
  const dialog = await w.win.waitFor(() => dialogNamed('Project Settings > API'))
  expect(await reportedDialog(w, 'project-settings')).toMatchObject({ kind: 'project-settings', repoId: repo.id })
  await w.win.waitFor(() => field(dialog, 'Display Name')?.value === 'API')
  expect(field(dialog, 'Default Worktree Base')!.value).toBe('origin/develop')
  expect(field(dialog, 'Worktree Location')!.value).toBe(join(w.root, 'api-ws'))
  expect(field<HTMLTextAreaElement>(dialog, 'Setup Script')!.value).toBe('make deps')
  expect(field<HTMLSelectElement>(dialog, 'When to run')!.value).toBe('ask')
  expect(field(dialog, 'Wait for setup to complete before starting agent')!.checked).toBe(true)
  expect(field<HTMLSelectElement>(dialog, 'Command Source')!.value).toBe('run-both')
  expect(field<HTMLTextAreaElement>(dialog, 'Archive Script')!.value).toBe('')
  expect(dialog.textContent).toContain('echo shared-setup')
  expect(dialog.textContent).toContain('quirky.yaml')

  await setText(field(dialog, 'Project icon')!, '🧭')
  await setText(field(dialog, 'Display Name')!, 'Api service')
  await setText(field(dialog, 'Default Worktree Base')!, '')
  await setText(field<HTMLTextAreaElement>(dialog, 'Archive Script')!, 'echo bye')
  await setSelect(field<HTMLSelectElement>(dialog, 'When to run')!, 'skip-by-default')
  await click(field(dialog, 'Wait for setup to complete before starting agent')!)
  await setSelect(field<HTMLSelectElement>(dialog, 'Command Source')!, 'local-only')
  await click(button(dialog, 'Save')!)
  await closed(w, 'Project Settings > API')

  const shown = (await w.agent.callAny('quirky.repo/show', { repo: repo.id })) as RepoDetails
  expect(shown.repo.displayName).toBe('Api service')
  expect(shown.settings).toMatchObject({
    defaultBase: null,
    worktreeLocation: join(w.root, 'api-ws'),
    setupPolicy: 'skip-by-default',
    agentStartup: 'start-immediately',
    commandSource: 'local-only',
    setupScript: 'make deps',
    archiveScript: 'echo bye'
  })
  await w.win.waitFor(() => projectSection('Api service'))
  const metadata = await w.agent.callAny('quirky.worktree/projectMetadata', { repo: repo.id }) as { identity: { icon: string | null } }
  expect(metadata.identity.icon).toBe('🧭')
  await expect(w.agent.callAny('quirky.worktree/setProjectMetadata', {
    repo: repo.id,
    identity: { icon: '<svg onload=alert(1)>' }
  })).rejects.toThrow(/icon/i)
  expect((await w.agent.callAny('quirky.worktree/projectMetadata', { repo: repo.id }) as { identity: { icon: string | null } }).identity.icon).toBe('🧭')
  await expect(w.agent.callAny('quirky.worktree/setProjectMetadata', {
    repo: repo.id,
    identity: { icon: 'javascript:alert(1)' }
  })).rejects.toThrow(/icon/i)
  await expect(w.agent.callAny('quirky.worktree/setProjectMetadata', {
    repo: repo.id,
    identity: { trackerProject: 'javascript:alert(1)' }
  })).rejects.toThrow(/HTTPS/i)
  expect((await w.agent.callAny('quirky.worktree/projectMetadata', { repo: repo.id }) as { identity: { trackerProject: string | null } }).identity.trackerProject).toBeNull()
}, SLOW)

async function dirtyAndLocked(w: World) {
  const { repo, dir } = await addApi(w)
  const dirty = await created(w.agent, { repo: repo.id, name: 'dirty' })
  writeFileSync(join(dirty.path, 'scratch.txt'), 'x\n')
  const locked = await created(w.agent, { repo: repo.id, name: 'locked' })
  git(dir, 'worktree', 'lock', '--reason', 'ci holds it', locked.path)
  await w.win.waitFor(() => card('dirty') && card('locked'))
  return { repo, dir, dirty, locked }
}

test('SC-57: the confirmation disables future prompts and a locked workspace is refused', async () => {
  const w = await boot()
  const { dirty, locked } = await dirtyAndLocked(w)

  await openCardMenu(w.win, 'dirty')
  await choose(w.win, 'Delete')
  const dialog = await w.win.waitFor(() => dialogNamed('Delete Workspace'))
  expect(button(dialog, 'Cancel')).toBeDefined()
  expect(await reportedDialog(w, 'delete')).toMatchObject({ kind: 'delete', worktreeId: dirty.id })

  await click(field(dialog, "Don't ask again")!)
  await click(button(dialog, 'Delete Workspace')!)
  await closed(w, 'Delete Workspace')
  await w.win.waitFor(async () => !(await worktrees(w.agent)).some((x) => x.id === dirty.id))
  expect(existsSync(dirty.path)).toBe(false)
  expect(toastMessages().some((message) => message.includes("We'll skip this confirmation next time."))).toBe(true)
  expect(await w.agent.callAny('setting.get', { id: CONFIRM_DELETE })).toMatchObject({ value: false })

  const refusal = await failure(w.agent.callAny('quirky.worktree/remove', { worktree: locked.id, yes: true, force: true }))
  await openCardMenu(w.win, 'locked')
  await choose(w.win, 'Delete')
  await w.win.waitFor(() => toastContaining('Failed to delete workspace locked'))
  expect(dialogNamed('Delete Workspace')).toBeUndefined()
  const toast = toastContaining('Failed to delete workspace locked')!
  expect(toast.textContent).toContain(refusal.message)
  expect(refusal.message).toContain('ci holds it')
  expect((await worktrees(w.agent)).some((x) => x.id === locked.id)).toBe(true)
}, SLOW)

test('SC-57: canceling a dirty workspace deletion leaves it present', async () => {
  const w = await boot()
  const { dirty } = await dirtyAndLocked(w)
  writeFileSync(join(dirty.path, 'second.txt'), 'y\n')
  await openCardMenu(w.win, 'dirty')
  await choose(w.win, 'Delete')
  const dialog = await w.win.waitFor(() => dialogNamed('Delete Workspace'))
  await click(button(dialog, 'Cancel')!)
  await closed(w, 'Delete Workspace')
  expect((await worktrees(w.agent)).some((x) => x.id === dirty.id)).toBe(true)
  expect(existsSync(dirty.path)).toBe(true)
  expect(existsSync(join(dirty.path, 'scratch.txt'))).toBe(true)
  expect(existsSync(join(dirty.path, 'second.txt'))).toBe(true)
  await reportedDialog(w, null)
}, SLOW)

test('SC-57: deleting a selected workspace clears its view and selection', async () => {
  const w = await boot()
  const { repo } = await addApi(w)
  const selected = await created(w.agent, { repo: repo.id, name: 'selected' })
  await w.win.waitFor(() => card('selected'))

  await click(button(card('selected')!, 'Open selected')!)
  await w.win.waitFor(async () => {
    const layout = (await rendererState(w.agent))?.layout
    return layout?.worktree === selected.id && layout.view?.id === 'view:quirky.session/worktree' ? layout : undefined
  })
  expect((await rendererState(w.agent))?.layout).toMatchObject({
    worktree: selected.id,
    view: { id: 'view:quirky.session/worktree', input: { worktree: selected.id } }
  })

  await openCardMenu(w.win, 'selected')
  await choose(w.win, 'Delete')
  const dialog = await w.win.waitFor(() => dialogNamed('Delete Workspace'))
  const worktreeChanges: unknown[] = []
  w.agent.onEvent((event) => {
    if (event.type === 'quirky.worktree/changed' && 'data' in event) worktreeChanges.push(event.data)
  })
  await w.agent.callAny('events.subscribe', {})
  await click(button(dialog, 'Delete Workspace')!)
  await closed(w, 'Delete Workspace')
  await w.win.waitFor(async () => !(await worktrees(w.agent)).some((worktree) => worktree.id === selected.id))
  await w.win.waitFor(() => !card('selected'))
  await w.win.waitFor(() => worktreeChanges.some((data) =>
    typeof data === 'object' && data !== null &&
    'worktreeId' in data && data.worktreeId === selected.id &&
    'removed' in data && data.removed === true
  ))
  await w.win.waitFor(async () => {
    const layout = (await rendererState(w.agent))?.layout
    return layout !== undefined && layout.worktree !== selected.id && !layout.viewTabs?.some((tab) => {
      const input = tab.input
      return typeof input === 'object' && input !== null && 'worktree' in input && input.worktree === selected.id
    })
  })

  expect((await rendererState(w.agent))?.layout).toMatchObject({
    view: null,
    viewTabs: [],
    worktree: null
  })
}, SLOW)

test('SC-57: a folder workspace can be deleted', async () => {
  const w = await boot()
  const dir = join(scratch(), 'docs')
  mkdirSync(dir, { recursive: true })
  const docs = (await w.agent.callAny('quirky.repo/add', { path: realpathSync(dir), folder: true })) as Repo
  const extra = await created(w.agent, { repo: docs.id, name: 'extra' })
  await w.win.waitFor(() => card('extra'))
  await openCardMenu(w.win, 'extra')
  await choose(w.win, 'Delete')
  const dialog = await w.win.waitFor(() => dialogNamed('Delete Workspace'))
  await Bun.sleep(200)
  await click(button(dialog, 'Delete Workspace')!)
  await w.win.waitFor(async () => !(await worktrees(w.agent)).some((x) => x.id === extra.id))
}, SLOW)

test('SC-53: Delete with Descendants warns about the children and removes them with the parent', async () => {
  const w = await boot()
  const { repo } = await addApi(w)
  const a = await created(w.agent, { repo: repo.id, name: 'a' })
  const b = await created(w.agent, { repo: repo.id, name: 'b', parent: a.id })
  const c = await created(w.agent, { repo: repo.id, name: 'c', parent: b.id })
  await w.win.waitFor(() => card('c'))

  await openCardMenu(w.win, 'a')
  expect(item('Delete')).toBeUndefined()
  await choose(w.win, 'Delete with Descendants (2)…')
  const dialog = await w.win.waitFor(() => dialogNamed('Delete Workspace'))
  const listed = [...dialog.querySelectorAll('ul li')].map((li) => li.textContent)
  expect(listed.sort()).toEqual(['b', 'c'])
  expect(await reportedDialog(w, 'delete')).toMatchObject({ kind: 'delete', worktreeId: a.id })

  await click(button(dialog, 'Delete Workspace')!)
  await closed(w, 'Delete Workspace')
  await w.win.waitFor(async () => !(await worktrees(w.agent)).some((x) => [a.id, b.id, c.id].includes(x.id)))
  expect([a, b, c].map((x) => existsSync(x.path))).toEqual([false, false, false])
}, SLOW)

test('SC-53: with the setting off, Delete goes straight through', async () => {
  const w = await boot()
  const { repo } = await addApi(w)
  const fix = await created(w.agent, { repo: repo.id, name: 'fix-login' })
  await w.agent.callAny('setting.set', { id: CONFIRM_DELETE, value: false })
  await w.win.waitFor(() => card('fix-login'))
  await Bun.sleep(100)
  await openCardMenu(w.win, 'fix-login')
  await choose(w.win, 'Delete')
  await w.win.waitFor(async () => !(await worktrees(w.agent)).some((x) => x.id === fix.id))
  expect(dialogNamed('Delete Workspace')).toBeUndefined()
}, SLOW)

test('SC-58: an unmerged branch is kept, the section offers Delete branch, and using it deletes the branch', async () => {
  const w = await boot()
  const { repo, dir } = await addApi(w)
  const fix = await created(w.agent, { repo: repo.id, name: 'fix-login' })
  commitFiles(fix.path, { 'fix.txt': 'fix\n' })
  expect(fix.branch).toBe('zoe/fix-login')
  await w.win.waitFor(() => card('fix-login'))

  await openCardMenu(w.win, 'fix-login')
  await choose(w.win, 'Delete')
  const dialog = await w.win.waitFor(() => dialogNamed('Delete Workspace'))
  await click(button(dialog, 'Delete Workspace')!)
  await closed(w, 'Delete Workspace')

  const notice = await w.win.waitFor(() => branchNotice())
  expect(button(notice, 'Dismiss')).toBeDefined()
  const reported = await w.win.waitFor(async () => {
    const next = await report(w.agent)
    return next?.notices?.length ? next : undefined
  })
  expect(reported.notices).toEqual([{ kind: 'kept-branch', branch: 'zoe/fix-login', repoId: repo.id }])
  expect(branches(dir)).toContain('zoe/fix-login')

  await click(button(notice, 'Delete branch')!)
  await w.win.waitFor(() => !branchNotice())
  expect(branches(dir)).not.toContain('zoe/fix-login')
  await w.win.waitFor(async () => (await report(w.agent)).notices.length === 0)
}, SLOW)

test('SC-58: Dismiss removes the notice and keeps the branch', async () => {
  const w = await boot()
  const { repo, dir } = await addApi(w)
  const fix = await created(w.agent, { repo: repo.id, name: 'fix-login' })
  commitFiles(fix.path, { 'fix.txt': 'fix\n' })
  await w.agent.callAny('setting.set', { id: CONFIRM_DELETE, value: false })
  await w.win.waitFor(() => card('fix-login'))
  await Bun.sleep(100)
  await openCardMenu(w.win, 'fix-login')
  await choose(w.win, 'Delete')
  const notice = await w.win.waitFor(() => branchNotice())
  await click(button(notice, 'Dismiss')!)
  await w.win.waitFor(() => !branchNotice())
  expect(branches(dir)).toContain('zoe/fix-login')
}, SLOW)

test('SC-58: a branch that moved on is not deleted, and the failure toasts', async () => {
  const w = await boot()
  const { repo, dir } = await addApi(w)
  const fix = await created(w.agent, { repo: repo.id, name: 'fix-login' })
  commitFiles(fix.path, { 'fix.txt': 'fix\n' })
  await w.agent.callAny('setting.set', { id: CONFIRM_DELETE, value: false })
  await w.win.waitFor(() => card('fix-login'))
  await Bun.sleep(100)
  await openCardMenu(w.win, 'fix-login')
  await choose(w.win, 'Delete')
  const notice = await w.win.waitFor(() => branchNotice())
  git(dir, 'update-ref', 'refs/heads/zoe/fix-login', git(dir, 'rev-parse', 'main'))
  await click(button(notice, 'Delete branch')!)
  await w.win.waitFor(() => toastMessages().some((message) => message.includes('Could not delete branch')))
  expect(branches(dir)).toContain('zoe/fix-login')
}, SLOW)
