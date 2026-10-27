import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { QuirkyClient, Repo, Session, UiState, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { commitFiles, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { githubUser, makeOrigin, makeProject, repoSet, useGlobalGitConfig } from './fixtures/repos'
import { button, click, dialogNamed, dialogs, field, modEnter, pressEscape, setSelect, setText, toastTitles, topDialog } from './window/dom'

const SIDEBAR = 'sidebar-section:quirky.worktree/worktrees'
const SESSION_VIEW = 'view:quirky.session/worktree'
const NEW_WORKTREE = 'command:quirky.worktree/new-worktree'
const CREATE = 'New workspace'
const FALLBACK = 'Workspace created from a local base'
const SLOW = 40_000

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

/** A real daemon with the real repo, worktree and session plugins, and a headless window on it. */
async function boot(): Promise<World> {
  const harness = await startHarness({ home: makeTempHome('qwc-'), builtinPluginsDir: builtinsDir() })
  const agent = await harness.connect('cli', 'setup')
  const root = realpathSync(makeTempDir('qwc-root-'))
  await agent.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const win = await startHeadlessWindow({ home: harness.home, runtime: harness.runtime })
  current = { harness, win, agent, root }
  return current
}

type Project = { repo: Repo; dir: string }

async function addProject(w: World, name: string, options: Parameters<typeof makeProject>[1] = {}): Promise<Project> {
  const dir = makeProject(join(scratch(), name), options)
  const repo = (await w.agent.callAny('quirky.repo/add', { path: dir })) as Repo
  await w.win.waitFor(() => [...document.querySelectorAll('.repo-name')].some((e) => e.textContent === name))
  return { repo, dir }
}

const worktrees = async (agent: QuirkyClient) => (await agent.callAny('quirky.worktree/list', {})) as Worktree[]
const sessionsOf = async (agent: QuirkyClient, worktreeId: string) => (await agent.callAny('quirky.session/list', { worktree: worktreeId })) as Session[]
const uiState = async (agent: QuirkyClient) => (await agent.callAny('ui.state', {})) as UiState
const openView = async (agent: QuirkyClient) => (await uiState(agent)).layout.view as { id: string; input?: { worktree?: string } } | null
const report = async (agent: QuirkyClient): Promise<any> => (await uiState(agent)).slots.find((slot) => slot.id === SIDEBAR)?.report

/** The dialog the section reports once it has reported one of `kind`; the report trails the DOM. */
const reportedDialog = (w: World, kind: string) =>
  w.win.waitFor(async () => {
    const dialog = (await report(w.agent))?.dialog
    return dialog?.kind === kind ? dialog : undefined
  })

const named = (w: World, name: string, repoId?: string) =>
  w.win.waitFor(async () =>
    (await worktrees(w.agent)).find((x) => x.name === name && (repoId === undefined || x.repoId === repoId) && x.createdBy !== 'external')
  )

async function openCreate(w: World, project: Project): Promise<HTMLElement> {
  await w.win.waitFor(() => !dialogNamed(CREATE))
  await w.agent.callAny('ui.command.run', { id: NEW_WORKTREE, args: { repo: project.repo.id } })
  const dialog = await w.win.waitFor(() => dialogNamed(CREATE))
  await w.win.waitFor(() => field<HTMLSelectElement>(dialog, 'Project')?.value === project.repo.id)
  await w.win.waitFor(() => field(dialog, 'Name')?.placeholder)
  return dialog
}

const closed = (w: World, title: string) => w.win.waitFor(() => !dialogNamed(title))

async function expandAdvanced(dialog: HTMLElement): Promise<void> {
  const toggle = button(dialog, 'Advanced')!
  if (toggle.getAttribute('aria-expanded') !== 'true') await click(toggle)
}

const pendingCard = (name: string) =>
  [...document.querySelectorAll('li.worktree.pending')].find((li) => li.querySelector('.worktree-name')?.textContent === name)

test('SC-28: a blank name still creates, with the generated name as the placeholder', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const dialog = await openCreate(w, api)

  const name = field(dialog, 'Name')!
  expect(name.value).toBe('')
  const suggested = (await w.agent.callAny('quirky.worktree/suggestName', { repo: api.repo.id })) as { name: string }
  expect(name.placeholder).toBe(suggested.name)
  expect(name.placeholder).not.toBe('')
  const submit = button(dialog, 'Create')!
  expect(submit.disabled).toBe(false)

  await click(submit)
  const made = await named(w, name.placeholder)
  expect(made.repoId).toBe(api.repo.id)
  await closed(w, CREATE)
  await w.win.waitFor(async () => (await openView(w.agent))?.input?.worktree === made.id)
}, SLOW)

test('SC-28: Mod+Enter submits the dialog', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const dialog = await openCreate(w, api)
  await setText(field(dialog, 'Name')!, 'by-keyboard')
  await modEnter(field(dialog, 'Name')!)
  await named(w, 'by-keyboard')
  await closed(w, CREATE)
}, SLOW)

test('SC-25: a window create shows a pending row, then opens the result only if you stayed', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const hook = join(api.dir, '.git', 'hooks', 'post-checkout')
  writeFileSync(hook, '#!/bin/sh\nsleep 1.5\n')
  chmodSync(hook, 0o755)
  const main = (await worktrees(w.agent)).find((x) => x.repoId === api.repo.id && x.isMain)!

  const first = await openCreate(w, api)
  await setText(field(first, 'Name')!, 'slow')
  await click(button(first, 'Create')!)
  await w.win.waitFor(() => pendingCard('slow'))
  const entry = await w.win.waitFor(async () =>
    (await report(w.agent))?.projects?.[0]?.worktrees?.find((x: { id: string }) => x.id === 'pending:slow')
  )
  expect(entry).toMatchObject({ pending: true, name: 'slow', branch: null })
  const slow = await named(w, 'slow')
  await w.win.waitFor(async () => (await openView(w.agent))?.input?.worktree === slow.id)
  await w.win.waitFor(() => !pendingCard('slow'))

  const second = await openCreate(w, api)
  await setText(field(second, 'Name')!, 'slow2')
  await click(button(second, 'Create')!)
  await w.win.waitFor(() => pendingCard('slow2'))
  await w.agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: main.id } })
  await w.win.waitFor(() => toastTitles().includes('Created slow2'))
  expect((await openView(w.agent))?.input?.worktree).toBe(main.id)
  await w.win.waitFor(() => !pendingCard('slow2'))
}, SLOW)

test('SC-26: Create more keeps the dialog open and resets it', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  await repoSet(w.agent, 'api', { setupScript: 'echo hi', setupPolicy: 'ask' })
  const dialog = await openCreate(w, api)

  await click(field(dialog, 'Create more')!)
  expect(field(dialog, 'Create more')!.checked).toBe(true)
  await setText(field(dialog, 'Name')!, 'one')
  await setSelect(field<HTMLSelectElement>(dialog, 'Agent')!, 'claude')
  await setText(field<HTMLTextAreaElement>(dialog, 'Prompt')!, 'say hi')
  await expandAdvanced(dialog)
  expect(button(dialog, 'Create')!.disabled).toBe(true)
  await click(button(dialog, 'Run setup now')!)
  expect(button(dialog, 'Create')!.disabled).toBe(false)
  await click(button(dialog, 'Create')!)

  const one = await named(w, 'one')
  await w.win.waitFor(async () => (await sessionsOf(w.agent, one.id)).some((s) => s.title === 'Setup'))
  await w.win.waitFor(async () => (await sessionsOf(w.agent, one.id)).some((s) => s.agent === 'claude'))
  await w.win.waitFor(() => field(dialog, 'Name')!.value === '' && !field<HTMLSelectElement>(dialog, 'Agent')!.value)
  expect(dialogNamed(CREATE)).toBe(dialog)
  expect(field(dialog, 'Create more')!.checked).toBe(true)
  expect(field(dialog, 'Prompt')).toBeUndefined()
  expect(button(dialog, 'Create')!.disabled).toBe(true)
  await w.win.waitFor(() => field(dialog, 'Name')!.placeholder !== 'one')
  expect(await reportedDialog(w, 'create')).toEqual({ kind: 'create', repoId: api.repo.id })
}, SLOW)

test('creating from an existing branch hides the base and passes the branch', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  git(api.dir, 'branch', 'feat')
  const dialog = await openCreate(w, api)
  expect(field(dialog, 'Base')).toBeDefined()
  await setText(field(dialog, 'Existing branch')!, 'feat')
  expect(field(dialog, 'Base')).toBeUndefined()
  await click(button(dialog, 'Create')!)
  const made = await named(w, 'feat')
  expect(made.branch).toBe('feat')
  expect(made.keepBranch).toBe(true)
}, SLOW)

test('the Base field starts at the project base and is sent only when changed', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  git(api.dir, 'branch', 'dev')
  await repoSet(w.agent, 'api', { defaultBase: 'dev' })
  const dialog = await openCreate(w, api)
  await w.win.waitFor(() => field(dialog, 'Base')!.value === 'dev')
  await setText(field(dialog, 'Name')!, 'from-saved')
  await click(button(dialog, 'Create')!)
  const made = await named(w, 'from-saved')
  expect(made.baseRef).toBe('dev')
}, SLOW)

test('the Advanced fields reach the new workspace', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const docs = (await w.agent.callAny('quirky.worktree/create', { repo: api.repo.id, name: 'docs' })) as WorktreeCreateResult
  const dialog = await openCreate(w, api)
  await setText(field(dialog, 'Name')!, 'adv')
  expect(field(dialog, 'Display name')).toBeUndefined()
  await expandAdvanced(dialog)
  expect(field(dialog, 'Parent worktree')!.value).toBe('')
  const options = [...field<HTMLSelectElement>(dialog, 'Parent worktree')!.options].map((o) => o.textContent)
  expect(options).toEqual(['No parent', 'main · api · main', 'docs · api · zoe/docs'])
  await setText(field(dialog, 'Display name')!, 'Pretty')
  await setText(field(dialog, 'Branch name')!, 'zoe/custom')
  await setText(field<HTMLTextAreaElement>(dialog, 'Note')!, 'remember')
  await setSelect(field<HTMLSelectElement>(dialog, 'Parent worktree')!, docs.worktree.id)
  await click(button(dialog, 'Create')!)
  const made = await named(w, 'Pretty')
  expect(made).toMatchObject({ displayName: 'Pretty', branch: 'zoe/custom', comment: 'remember', parentId: docs.worktree.id })
  expect(basename(made.path)).toBe('adv')
}, SLOW)

test('a failed create toasts, keeps the dialog open and clears the pending row', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const dialog = await openCreate(w, api)
  await setText(field(dialog, 'Existing branch')!, 'ghost')
  await click(button(dialog, 'Create')!)
  await w.win.waitFor(() => toastTitles().includes('Could not create worktree'))
  expect(document.body.textContent).toContain('Branch "ghost" was not found.')
  expect(dialogNamed(CREATE)).toBe(dialog)
  await w.win.waitFor(() => !pendingCard('ghost'))
  expect(button(dialog, 'Create')!.disabled).toBe(false)
}, SLOW)

test('the project select switches the placeholder and the report follows it', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const web = await addProject(w, 'web')
  const dialog = await openCreate(w, api)
  await setSelect(field<HTMLSelectElement>(dialog, 'Project')!, web.repo.id)
  await w.win.waitFor(async () => (await report(w.agent)).dialog?.repoId === web.repo.id)
  await setText(field(dialog, 'Name')!, 'in-web')
  await click(button(dialog, 'Create')!)
  expect((await named(w, 'in-web')).repoId).toBe(web.repo.id)
}, SLOW)

test('SC-20: a create from an unreachable remote base shows the local-base notice', async () => {
  const w = await boot()
  const origin = makeOrigin(join(scratch(), 'origin.git'))
  const api = await addProject(w, 'api', { origin })
  git(api.dir, 'update-ref', '-d', 'refs/remotes/origin/main')
  git(api.dir, 'remote', 'set-url', 'origin', join(scratch(), 'gone.git'))

  const viaAgent = (await w.agent.callAny('quirky.worktree/create', { repo: api.repo.id, name: 'offline', base: 'origin/main' })) as WorktreeCreateResult
  const message = viaAgent.baseFallback!.message
  expect(message).toBe(
    'The remote-tracking ref origin/main was unavailable, so Quirky used local main instead. This workspace may not include the latest remote changes.'
  )

  const dialog = await openCreate(w, api)
  await setText(field(dialog, 'Name')!, 'offline3')
  await setText(field(dialog, 'Base')!, 'origin/main')
  await click(button(dialog, 'Create')!)
  const made = await named(w, 'offline3')
  expect(made.baseRef).toBe('main')
  const notice = await w.win.waitFor(() => dialogNamed(FALLBACK))
  expect(notice.textContent).toContain(message)
  expect(await reportedDialog(w, 'base-fallback')).toEqual({ kind: 'base-fallback', worktreeId: made.id })
  await click(button(notice, 'Got it')!)
  await closed(w, FALLBACK)
  await w.win.waitFor(async () => (await report(w.agent)).dialog === null)
}, SLOW)

test('SC-27: the window creates the same worktree as the CLI from the same input', async () => {
  const w = await boot()
  const origin = makeOrigin(join(scratch(), 'origin.git'))
  const copies = await Promise.all(['api1', 'api2'].map((name) => addProject(w, name, { origin })))
  for (const { repo, dir } of copies) {
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main')
    git(dir, 'remote', 'set-url', 'origin', join(scratch(), 'gone.git'))
    await repoSet(w.agent, repo.id, { setupPolicy: 'run-by-default', setupScript: 'echo hi' })
  }
  const [api1, api2] = copies as [Project, Project]

  const dialog = await openCreate(w, api1)
  await setText(field(dialog, 'Name')!, 'same')
  await setText(field(dialog, 'Base')!, 'origin/main')
  await click(button(dialog, 'Create')!)
  const viaWindow = await named(w, 'same', api1.repo.id)
  const notice = await w.win.waitFor(() => dialogNamed(FALLBACK))
  const viaCli = (await w.agent.callAny('quirky.worktree/create', { repo: api2.repo.id, name: 'same', base: 'origin/main', createdBy: 'cli' })) as WorktreeCreateResult

  expect(basename(viaWindow.path)).toBe(basename(viaCli.worktree.path))
  expect(viaWindow.branch).toBe('zoe/same')
  expect(viaCli.worktree.branch).toBe('zoe/same')
  expect(viaWindow.baseRef).toBe(viaCli.worktree.baseRef!)
  expect(viaWindow.baseRef).toBe('main')
  expect(notice.textContent).toContain(viaCli.baseFallback!.message)
  expect(viaWindow.status).toBe(viaCli.worktree.status)
  expect([viaWindow.createdBy, viaCli.worktree.createdBy]).toEqual(['window', 'cli'])
  const setups = await Promise.all([viaWindow.id, viaCli.worktree.id].map(async (id) => (await sessionsOf(w.agent, id)).filter((s) => s.title === 'Setup')))
  expect(setups.map((s) => s.length)).toEqual([1, 1])
}, SLOW)

test('SC-31: the window asks for the setup choice before it will create', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  await repoSet(w.agent, 'api', { setupScript: 'touch setup-ran.txt', setupPolicy: 'ask' })
  const dialog = await openCreate(w, api)

  expect(field(dialog, 'Display name')).toBeUndefined()
  expect(button(dialog, 'Advanced')!.getAttribute('aria-expanded')).toBe('false')
  await expandAdvanced(dialog)
  await w.win.waitFor(() => dialog.textContent?.includes('Setup script'))
  expect(dialog.querySelector('.setup-badge')?.textContent).toBe('local settings')
  expect(dialog.textContent).toContain('Wait for setup to complete before starting agent')
  expect(dialog.textContent).toContain('Run setup now?')
  expect(button(dialog, 'Skip for now')).toBeDefined()
  const submit = button(dialog, 'Create')!
  expect(submit.disabled).toBe(true)

  await click(button(dialog, 'Run setup now')!)
  expect(submit.disabled).toBe(false)
  await setText(field(dialog, 'Name')!, 'with-setup')
  await click(submit)
  const made = await named(w, 'with-setup')
  await w.win.waitFor(async () => (await sessionsOf(w.agent, made.id)).some((s) => s.title === 'Setup'))
  const runner = resolve(made.path, git(made.path, 'rev-parse', '--git-path', 'quirky/setup-runner.sh'))
  expect(Bun.spawnSync(['/bin/bash', runner], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
  await w.win.waitFor(() => existsSync(join(made.path, 'setup-ran.txt')))

  const again = await openCreate(w, api)
  await expandAdvanced(again)
  await w.win.waitFor(() => button(again, 'Skip for now'))
  await click(button(again, 'Skip for now')!)
  await setText(field(again, 'Name')!, 'no-setup')
  await click(button(again, 'Create')!)
  const skipped = await named(w, 'no-setup')
  await closed(w, CREATE)
  await w.win.waitFor(async () => (await openView(w.agent))?.input?.worktree === skipped.id)
  await w.win.waitFor(async () =>
    (await sessionsOf(w.agent, skipped.id)).some((s) => s.kind === 'terminal' && s.agent === 'shell' && s.title !== 'Setup' && s.cwd === skipped.path)
  )
  const skippedSessions = await sessionsOf(w.agent, skipped.id)
  expect(skippedSessions.some((s) => s.title === 'Setup')).toBe(false)
  expect(existsSync(join(skipped.path, 'setup-ran.txt'))).toBe(false)
}, SLOW)

test('SC-33: the window asks before running an untrusted shared script', async () => {
  const w = await boot()
  const api = await addProject(w, 'api', { files: { 'quirky.yaml': 'scripts:\n  setup: "touch ran.txt"\n' } })
  await repoSet(w.agent, 'api', { setupPolicy: 'run-by-default' })
  const setupSessions = async (name: string) => {
    const made = await named(w, name)
    return (await sessionsOf(w.agent, made.id)).filter((s) => s.title === 'Setup')
  }
  const create = async (name: string) => {
    const dialog = await openCreate(w, api)
    await setText(field(dialog, 'Name')!, name)
    await click(button(dialog, 'Create')!)
    return dialog
  }

  await create('t1')
  const trust = await w.win.waitFor(() => dialogNamed('Run setup from api?'))
  expect(trust.textContent).toContain('touch ran.txt')
  expect(await reportedDialog(w, 'trust')).toEqual({ kind: 'trust', repoId: api.repo.id })
  expect(dialogs().length).toBe(2)
  await click(button(trust, "Don't run")!)
  await closed(w, 'Run setup from api?')
  expect(await setupSessions('t1')).toEqual([])
  expect(existsSync(join(w.root, 'api', 't1', 'ran.txt'))).toBe(false)

  await create('t2')
  await click(button(await w.win.waitFor(() => dialogNamed('Run setup from api?')), 'Run hooks')!)
  await w.win.waitFor(async () => (await setupSessions('t2')).length === 1)

  await create('t3')
  await click(button(await w.win.waitFor(() => dialogNamed('Run setup from api?')), 'Always trust')!)
  await w.win.waitFor(async () => (await setupSessions('t3')).length === 1)

  await create('t4')
  await w.win.waitFor(async () => (await setupSessions('t4')).length === 1)
  expect(dialogNamed('Run setup from api?')).toBeUndefined()

  commitFiles(api.dir, { 'quirky.yaml': 'scripts:\n  setup: "touch changed.txt"\n' })
  await create('t5')
  const changed = await w.win.waitFor(() => dialogNamed("api's setup changed — run the new version?"))
  expect(changed.textContent).toContain('touch changed.txt')
  await click(button(changed, 'Run hooks')!)
  await w.win.waitFor(async () => (await setupSessions('t5')).length === 1)
}, 60_000)

test('SC-42: the Update dialog edits the display name and notes', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const fix = ((await w.agent.callAny('quirky.worktree/create', { repo: api.repo.id, name: 'fix-login' })) as WorktreeCreateResult).worktree
  await w.win.waitFor(() => [...document.querySelectorAll('.worktree-name')].some((e) => e.textContent === 'fix-login'))

  const card = [...document.querySelectorAll('li.worktree')].find((li) => li.querySelector('.worktree-name')?.textContent === 'fix-login')!
  card.querySelector('.worktree-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
  const update = await w.win.waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === 'Update…'))
  update.click()

  const dialog = await w.win.waitFor(() => dialogNamed('Workspace details'))
  expect(dialog.querySelector('h2')?.textContent).toBe('Workspace details')
  expect(dialog.textContent).toContain('Attach reviews and tasks, and keep notes for this workspace.')
  expect(dialog.textContent).toContain('Shown in the sidebar. The folder name stays the same.')
  expect(dialog.textContent).toContain('Changes apply when you save')
  expect(field<HTMLTextAreaElement>(dialog, 'Notes')!.placeholder).toBe('Add notes')
  expect(await reportedDialog(w, 'update')).toEqual({ kind: 'update', worktreeId: fix.id })

  await setText(field(dialog, 'Display Name')!, 'Login fix')
  await setText(field<HTMLTextAreaElement>(dialog, 'Notes')!, '## todo\n- retry flow')
  await click(button(dialog, 'Save')!)
  await closed(w, 'Workspace details')

  await w.win.waitFor(() => [...document.querySelectorAll('.worktree-name')].some((e) => e.textContent === 'Login fix'))
  const after = (await worktrees(w.agent)).find((x) => x.id === fix.id)!
  expect(after).toMatchObject({ name: 'Login fix', displayName: 'Login fix', comment: '## todo\n- retry flow', branch: fix.branch, path: fix.path })
  expect(basename(after.path)).toBe('fix-login')
}, SLOW)

test('SC-41: the Set Parent dialog excludes the workspace and its descendants, saves, and the menu removes the parent', async () => {
  const w = await boot()
  const api = await addProject(w, 'api')
  const make = async (name: string, extra: Record<string, unknown> = {}) =>
    ((await w.agent.callAny('quirky.worktree/create', { repo: api.repo.id, name, ...extra })) as WorktreeCreateResult).worktree
  const a = await make('a')
  const b = await make('b', { parent: a.id })
  const c = await make('c', { parent: b.id })
  const d = await make('d')
  await w.win.waitFor(() => [...document.querySelectorAll('.worktree-name')].some((e) => e.textContent === 'd'))

  const menuFor = async (name: string, label: string) => {
    const card = [...document.querySelectorAll('li.worktree')].find((li) => li.querySelector('.worktree-name')?.textContent === name)!
    card.querySelector('.worktree-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
    const target = await w.win.waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === label))
    target.click()
  }

  await menuFor('a', 'Set Parent Worktree…')
  const dialog = await w.win.waitFor(() => dialogNamed('Set parent worktree'))
  expect(await reportedDialog(w, 'parent')).toEqual({ kind: 'parent', worktreeId: a.id })
  const select = field<HTMLSelectElement>(dialog, 'Parent worktree')!
  const labels = [...select.options].map((o) => o.textContent)
  expect(labels).toEqual(['main · api · main', 'd · api · zoe/d'])
  await setSelect(select, d.id)
  await click(button(dialog, 'Save')!)
  await closed(w, 'Set parent worktree')
  await w.win.waitFor(async () => (await worktrees(w.agent)).find((x) => x.id === a.id)?.parentId === d.id)
  const depthOfA = () =>
    [...document.querySelectorAll<HTMLElement>('li.worktree')].find((li) => li.querySelector('.worktree-name')?.textContent === 'a')?.style.getPropertyValue('--depth')
  await w.win.waitFor(() => depthOfA() === '1')

  await menuFor('a', 'Remove from Parent')
  await w.win.waitFor(async () => (await worktrees(w.agent)).find((x) => x.id === a.id)?.parentId === null)
  const rest = await worktrees(w.agent)
  expect(rest.find((x) => x.id === b.id)?.parentId).toBe(a.id)
  expect(rest.find((x) => x.id === c.id)?.parentId).toBe(b.id)
}, SLOW)

test('Escape closes only the dialog on top', async () => {
  const w = await boot()
  const api = await addProject(w, 'api', { files: { 'quirky.yaml': 'scripts:\n  setup: "touch ran.txt"\n' } })
  await repoSet(w.agent, 'api', { setupPolicy: 'run-by-default' })
  const dialog = await openCreate(w, api)
  await setText(field(dialog, 'Name')!, 'esc')
  await click(button(dialog, 'Create')!)
  await w.win.waitFor(() => dialogNamed('Run setup from api?'))
  await pressEscape()
  await closed(w, 'Run setup from api?')
  expect(topDialog()).toBe(dialog)
  expect((await worktrees(w.agent)).some((x) => x.name === 'esc')).toBe(false)
  expect(button(dialog, 'Create')!.disabled).toBe(false)
}, SLOW)
