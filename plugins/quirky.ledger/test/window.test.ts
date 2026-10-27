import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ProjectGroup, QuirkyClient, Repo, UiState, Worktree } from '@quirky/protocol'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { githubUser, useGlobalGitConfig } from '../../quirky.worktree/test/fixtures/repos'
import { button, click, dialogNamed, field, setSelect, setText } from '../../quirky.worktree/test/window/dom'

const OPEN = 'command:quirky.ledger/open'
const CONTROL = 'command:quirky.ledger/control'
const LEDGER_VIEW = 'view:quirky.ledger/ledger'
const LEDGER_PANEL = 'panel:quirky.ledger/ledger'
const { scratch } = isolateGitConfig()

beforeEach(() => useGlobalGitConfig(scratch, githubUser('ledger-ui')))

type World = { harness: Harness; win: HeadlessWindow; agent: QuirkyClient; repo: Repo; workspace: Worktree }
let current: World | null = null

afterEach(async () => {
  if (!current) return
  await current.win.stop()
  await current.harness.cleanup()
  current = null
  removeTempDirs()
})

async function boot(): Promise<World> {
  const harness = await startHarness({ home: makeTempHome('q-ledger-ui-'), builtinPluginsDir: builtinsDir() })
  const agent = await harness.connect('cli', 'ledger-window-test')
  const win = await startHeadlessWindow({ home: harness.home, runtime: harness.runtime })
  const repoPath = makeRepo(join(scratch(), 'api'))
  const repo = (await agent.callAny('quirky.repo/add', { path: repoPath })) as Repo
  const workspace = ((await agent.callAny('quirky.worktree/list', { repo: repo.id })) as Worktree[]).find((item) => item.isMain)!
  current = { harness, win, agent, repo, workspace }
  await win.waitFor(() => projectSection(repo.name))
  return current
}

const uiState = async (agent: QuirkyClient) => (await agent.callAny('ui.state', {})) as UiState
const request = async (world: World, body: Record<string, unknown>): Promise<any> => world.agent.callAny('quirky.ledger/request', body)
const owner = (world: World) => ({ tier: 'project' as const, id: world.repo.id })
const groupOwner = (group: ProjectGroup) => ({ tier: 'group' as const, id: group.id })

function projectSection(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('section.repo')].find((section) => section.querySelector('.repo-name')?.textContent === name)
}

function groupSection(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('section.group')].find((section) => section.querySelector('.group-name')?.textContent === name)
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.replace(/\s*▸$/, '').trim() === label)
}

async function projectMenu(world: World): Promise<void> {
  await click(await world.win.waitFor(() => projectSection(world.repo.name)?.querySelector<HTMLElement>('.project-menu'))!)
  await world.win.waitFor(() => document.querySelector('[role="menu"]'))
}

async function groupMenu(world: World, name: string): Promise<void> {
  await click(await world.win.waitFor(() => groupSection(name)?.querySelector<HTMLElement>('.group-menu'))!)
  await world.win.waitFor(() => document.querySelector('[role="menu"]'))
}

async function chooseMenu(world: World, label: string): Promise<void> {
  await click(await world.win.waitFor(() => menuItem(label))!)
}

async function openOwnerCommand(world: World): Promise<void> {
  await world.agent.callAny('ui.command.run', { id: OPEN, args: { target: { owner: owner(world) } } })
  await world.win.waitFor(() => document.querySelector('.ledger-page'))
}

async function createBug(world: World, title: string, path = 'src/a.ts'): Promise<any> {
  return request(world, {
    operation: 'file',
    target: { owner: owner(world) },
    type: 'bug',
    content: {
      title,
      file: { path, base: { kind: 'project', id: world.repo.id } },
      description: 'A reproducible failure.',
      severity: 'high'
    }
  })
}

async function createEntryFromForm(world: World, type: string, index: number): Promise<void> {
  const page = document.querySelector<HTMLElement>('.ledger-page')!
  await click(button(page, 'New entry')!)
  const form = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  await setSelect(field<HTMLSelectElement>(form, 'Type')!, type)
  await setText(field(form, 'Title')!, type === 'bug' && index === 1 ? 'duplicate form record' : `${type} form record ${index}`)
  if (type === 'bug' || type === 'test-gap') {
    const location = type === 'bug' ? 'File' : 'File under test'
    await world.win.waitFor(() => {
      const base = field<HTMLSelectElement>(form, 'Location base')
      return Boolean(base && [...base.options].some((option) => option.value === `project:${world.repo.id}`))
    })
    await setText(field(form, location)!, type === 'bug' && index === 1 ? 'src/duplicate.ts' : `src/${type}-${index}.ts`)
    await setSelect(field<HTMLSelectElement>(form, 'Location base')!, `project:${world.repo.id}`)
    if (type === 'bug') {
      await setText(field<HTMLTextAreaElement>(form, 'Description')!, 'Repro steps and observed behavior.')
      await setSelect(field<HTMLSelectElement>(form, 'Severity')!, 'medium')
    } else {
      await setText(field<HTMLTextAreaElement>(form, 'Reason skipped')!, 'Coverage deferred during the release cut.')
    }
  } else if (type === 'deferred') {
    await setText(field<HTMLTextAreaElement>(form, 'Why deferred')!, 'Blocked on an upstream dependency.')
    await setSelect(field<HTMLSelectElement>(form, 'Priority')!, 'low')
  } else if (type === 'proposal') {
    await setText(field<HTMLTextAreaElement>(form, 'Context')!, 'Two approaches are currently in use.')
    await setText(field<HTMLTextAreaElement>(form, 'Recommendation')!, 'Choose one supported approach.')
  } else {
    await setText(field<HTMLTextAreaElement>(form, 'Context')!, 'A durable tradeoff must be recorded.')
    await setText(field<HTMLTextAreaElement>(form, 'Decision')!, 'Use the shared project ledger.')
    await setText(field<HTMLTextAreaElement>(form, 'Consequences')!, 'Worktrees share one record history.')
    await setSelect(field<HTMLSelectElement>(form, 'Status')!, 'proposed')
  }
  await click(button(form, 'Create entry')!)
  await world.win.waitFor(() => !dialogNamed('New ledger entry'))
}

test('SC-13: the sidebar panel follows the active workspace, scopes and client search', async () => {
  const world = await boot()
  await request(world, {
    operation: 'file',
    target: { workspaceId: world.workspace.id },
    type: 'bug',
    content: {
      title: 'Panel origin record',
      file: { path: 'src/panel.ts', base: { kind: 'project', id: world.repo.id } },
      description: 'Origin-aware panel row.',
      severity: 'low'
    }
  })
  await world.agent.callAny('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: world.workspace.id } })
  await world.agent.callAny('ui.panel.open', { id: LEDGER_PANEL })
  const panel = await world.win.waitFor(() => document.querySelector<HTMLElement>('.ledger-panel'))
  await world.win.waitFor(() => panel.querySelector('.ledger-entry-row'))
  expect(panel.textContent).toContain('Panel origin record')
  expect([...panel.querySelectorAll('.ledger-scope-tabs button')].map((button) => button.textContent)).toEqual(['Worktree', 'Project'])
  expect((await uiState(world.agent)).slots.find((slot) => slot.id === LEDGER_PANEL)?.report).toMatchObject({
    view: 'panel',
    target: { workspaceId: world.workspace.id },
    scope: 'worktree'
  })

  await click(button(panel, 'Project')!)
  await world.win.waitFor(async () => {
    const report = (await uiState(world.agent)).slots.find((slot) => slot.id === LEDGER_PANEL)?.report
    return typeof report === 'object' && report !== null && 'scope' in report && report.scope === 'project'
  })
  const search = field(panel, 'Search title or ID')!
  await setText(search, 'not found')
  await world.win.waitFor(() => panel.textContent?.includes('No entries match this view.'))
  await setText(search, 'Panel origin')
  await world.win.waitFor(() => panel.querySelector('.ledger-entry-row'))

  await world.agent.callAny('ui.view.close', {})
  await world.win.waitFor(() => panel.textContent?.includes('Open a workspace to see its ledger.'))
}, SLOW)

test('SC-14: Open Ledger and real owner menus route to the same attached and detached catalog-backed page', async () => {
  const world = await boot()
  await createBug(world, 'Project menu entry')
  await world.agent.callAny('ui.command.run', { id: OPEN })
  const chooser = await world.win.waitFor(() => document.querySelector<HTMLElement>('.ledger-chooser'))
  expect(chooser.textContent).toContain('Open ledger')
  expect(chooser.textContent).toContain(`${world.repo.name}, Project · 1 entry`)
  expect((await uiState(world.agent)).slots.find((slot) => slot.id === LEDGER_VIEW)?.report).toMatchObject({ view: 'chooser' })

  await projectMenu(world)
  await chooseMenu(world, 'Open ledger')
  await world.win.waitFor(() => document.querySelector('.ledger-page'))
  expect(document.querySelector('.ledger-page h1')?.textContent).toBe(world.repo.name)
  expect(document.querySelector('.ledger-page')?.textContent).not.toContain(`${world.repo.name} ledger`)

  const group = (await world.agent.callAny('quirky.repo/groupCreate', { name: 'tools' })) as ProjectGroup
  await world.agent.callAny('quirky.repo/groupAdd', { group: group.id, repo: world.repo.id })
  await request(world, {
    operation: 'file',
    target: { owner: groupOwner(group) },
    type: 'proposal',
    content: { title: 'Group policy', context: 'Shared tools need a default.', recommendation: 'Keep one policy.' }
  })
  await world.win.waitFor(() => groupSection(group.name))
  await groupMenu(world, group.name)
  await chooseMenu(world, 'Open ledger')
  await world.win.waitFor(() => document.querySelector('.ledger-page h1')?.textContent === group.name)
  await world.agent.callAny('ui.command.run', { id: CONTROL, args: { action: 'detail', id: 'proposal-1' } })
  const commandedDetail = await world.win.waitFor(() => dialogNamed('Ledger entry proposal-1'))
  expect(commandedDetail.textContent).toContain('Group policy')
  await click(button(commandedDetail, 'Close')!)
  await world.agent.callAny('ui.command.run', { id: CONTROL, args: { action: 'new' } })
  const commandedForm = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  await click(button(commandedForm, 'Cancel')!)
  await world.agent.callAny('ui.command.run', { id: CONTROL, args: { action: 'sort', sort: 'title' } })
  await world.win.waitFor(async () => {
    const report = (await uiState(world.agent)).slots.find((slot) => slot.id === LEDGER_VIEW)?.report
    return typeof report === 'object' && report !== null && 'sort' in report && report.sort === 'title'
  })

  await world.agent.callAny('ui.command.run', {
    id: CONTROL,
    args: { action: 'filters', target: { owner: groupOwner(group) }, filters: { search: 'Group policy' } }
  })
  await world.win.waitFor(() => (document.querySelector('.ledger-page')?.textContent ?? '').includes('Group policy'))
  expect((await uiState(world.agent)).slots.find((slot) => slot.id === LEDGER_VIEW)?.report).toMatchObject({
    target: { owner: groupOwner(group) },
    filters: { search: 'Group policy' }
  })
}, SLOW)

test('SC-15: the real ledger form exposes complete typed fields and creates each of the five entry types', async () => {
  const world = await boot()
  await openOwnerCommand(world)
  for (const [index, type] of ['bug', 'deferred', 'test-gap', 'proposal', 'decision'].entries()) {
    await createEntryFromForm(world, type, index + 1)
  }
  const response = await request(world, { operation: 'list', target: { owner: owner(world) } })
  expect(response.entries.map((entry: { type: string }) => entry.type).sort()).toEqual(['bug', 'decision', 'deferred', 'proposal', 'test-gap'])
  expect(document.querySelectorAll('.ledger-entry-row')).toHaveLength(5)
  const bugEntry = response.entries.find((entry: { type: string }) => entry.type === 'bug')
  await click(button(document.querySelector('.ledger-page')!, `Edit ${bugEntry.id}`)!)
  const editForm = await world.win.waitFor(() => dialogNamed(`Edit ${bugEntry.id}`))
  expect(field<HTMLSelectElement>(editForm, 'Type')).toBeUndefined()
  expect(editForm.textContent).toContain(`Source revision: ${bugEntry.revision}`)
  await setText(field(editForm, 'Title')!, 'Stale local title')
  await request(world, {
    operation: 'edit',
    target: { owner: owner(world) },
    id: bugEntry.id,
    ifRevision: bugEntry.revision,
    content: { description: 'Concurrent revision wins.' }
  })
  await click(button(editForm, 'Save changes')!)
  await world.win.waitFor(() => editForm.textContent?.includes(`Current revision is ${bugEntry.revision + 1}`))
  const unchanged = await request(world, { operation: 'show', target: { owner: owner(world) }, id: bugEntry.id })
  expect(unchanged.entry.content.title).toBe(bugEntry.content.title)
  expect(unchanged.entry.content.description).toBe('Concurrent revision wins.')
  await click(button(editForm, 'Cancel')!)


  await click(button(document.querySelector('.ledger-page')!, 'New entry')!)
  const bugForm = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  await setSelect(field<HTMLSelectElement>(bugForm, 'Type')!, 'bug')
  await setText(field(bugForm, 'Title')!, 'duplicate form record')
  await setText(field(bugForm, 'File')!, 'src/duplicate.ts')
  await setSelect(field<HTMLSelectElement>(bugForm, 'Location base')!, `project:${world.repo.id}`)
  await setText(field<HTMLTextAreaElement>(bugForm, 'Description')!, 'A second matching report.')
  await setSelect(field<HTMLSelectElement>(bugForm, 'Severity')!, 'high')
  await click(button(bugForm, 'Create entry')!)
  const duplicateDialog = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  expect(duplicateDialog.textContent).toContain('Possible duplicate entries')
  expect(duplicateDialog.textContent).toContain('bug-')
  await click(button(duplicateDialog, 'Done')!)
  await click(button(document.querySelector('.ledger-page')!, 'New entry')!)
  const externalForm = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  await setSelect(field<HTMLSelectElement>(externalForm, 'Type')!, 'bug')
  await setText(field(externalForm, 'Title')!, 'External location validation')
  await setText(field(externalForm, 'File')!, '/outside/module.ts')
  await setSelect(field<HTMLSelectElement>(externalForm, 'Location base')!, `project:${world.repo.id}`)
  await setText(field<HTMLTextAreaElement>(externalForm, 'Description')!, 'Outside path requires host identity.')
  await setSelect(field<HTMLSelectElement>(externalForm, 'Severity')!, 'low')
  await click(field<HTMLInputElement>(externalForm, 'External location')!)
  await click(button(externalForm, 'Create entry')!)
  await world.win.waitFor(() => externalForm.textContent?.includes('External host is required.'))
  expect(await request(world, { operation: 'list', target: { owner: owner(world) } }).then((result) => result.entries)).toHaveLength(6)
  await click(button(externalForm, 'Cancel')!)
}, SLOW)

test('SC-16: detail keeps its complete history and actions reachable while its body scrolls independently', async () => {
  const world = await boot()
  const filed = await createBug(world, 'Long history regression')
  let revision = filed.entry.revision as number
  const id = filed.entry.id as string
  for (let index = 0; index < 14; index++) {
    const result = await request(world, {
      operation: 'edit',
      target: { owner: owner(world) },
      id,
      ifRevision: revision,
      content: { description: `History revision ${index + 1} with an additional detailed explanation.` }
    })
    revision = result.entry.revision
  }
  await openOwnerCommand(world)
  const row = await world.win.waitFor(() => document.querySelector<HTMLElement>(`.ledger-entry-row[data-entry-id="${id}"]`))
  await click(row.querySelector('button[aria-label^="Show details"]')!)
  const detail = await world.win.waitFor(() => dialogNamed(`Ledger entry ${id}`))
  expect(detail.textContent).toContain('Full history')
  expect(detail.textContent).toContain('Before')
  expect(detail.textContent).toContain('After')
  const body = detail.querySelector<HTMLElement>('.ledger-detail-body')!
  const footer = detail.querySelector<HTMLElement>('.ledger-detail-actions')!
  expect(getComputedStyle(body).overflowY).toBe('auto')
  expect(getComputedStyle(footer).flexShrink).toBe('0')
  expect(button(footer, 'Edit')?.disabled).toBe(false)
  expect(button(footer, 'Review')?.disabled).toBe(false)
  expect(button(footer, 'Open')?.disabled).toBe(true)
  expect(button(footer, 'Resolved')?.disabled).toBe(false)
  expect(button(footer, 'Archived')?.disabled).toBe(false)
  expect(field<HTMLSelectElement>(footer, 'Revert to revision')).toBeDefined()
  expect(button(footer, 'Close')).toBeDefined()
}, SLOW)

test('SC-17: triage snapshots conflict cleanly, then approval and confirmed state use refreshed revisions', async () => {
  const world = await boot()
  const filed = await createBug(world, 'Triage snapshot record')
  const id = filed.entry.id as string
  await openOwnerCommand(world)
  await click(button(document.querySelector('.ledger-page')!, 'Triage')!)
  const triage = await world.win.waitFor(() => dialogNamed('Operation review'))
  expect(triage.textContent).toContain('No entries are auto-resolved.')
  const firstSelection = await world.win.waitFor(() => triage.querySelector<HTMLInputElement>('input[type="checkbox"]'))
  await click(firstSelection)
  await click(button(triage, 'Resolve')!)
  const staleConfirm = await world.win.waitFor(() => dialogNamed('Confirm ledger action'))
  expect(staleConfirm.textContent).toContain(`${id} · revision 1 · Triage snapshot record`)
  await request(world, {
    operation: 'edit',
    target: { owner: owner(world) },
    id,
    ifRevision: 1,
    content: { description: 'A concurrent writer moved the candidate revision.' }
  })
  await click(button(staleConfirm, 'Confirm')!)
  await world.win.waitFor(() => triage.textContent?.includes('Review the refreshed revisions before confirming again.'))
  expect((await request(world, { operation: 'show', target: { owner: owner(world) }, id })).entry.revision).toBe(2)

  const refreshed = await world.win.waitFor(() => triage.querySelector<HTMLInputElement>('input[type="checkbox"]'))
  await click(refreshed)
  await click(button(triage, 'Approve review (1)')!)
  await world.win.waitFor(async () => {
    const result = await request(world, { operation: 'show', target: { owner: owner(world) }, id })
    return result.entry.reviewed && result.entry.revision === 3
  })

  await world.win.waitFor(() => triage.textContent?.includes('revision 3'))
  const approved = await world.win.waitFor(() => triage.querySelector<HTMLInputElement>('input[type="checkbox"]'))
  await click(approved)
  await click(button(triage, 'Resolve')!)
  const refreshedConfirm = await world.win.waitFor(() => dialogNamed('Confirm ledger action'))
  expect(refreshedConfirm.textContent).toContain(`${id} · revision 3 · Triage snapshot record`)
  await click(button(refreshedConfirm, 'Confirm')!)
  const resolved = await world.win.waitFor(async () => {
    const result = await request(world, { operation: 'show', target: { owner: owner(world) }, id })
    return result.entry.state === 'resolved' ? result.entry : undefined
  })
  expect(resolved.revision).toBe(4)
}, SLOW)

test('SC-17 and SC-11: project settings and owner-removal previews retain ledger snapshots', async () => {
  const world = await boot()
  await projectMenu(world)
  await chooseMenu(world, 'Project Settings…')
  const settings = await world.win.waitFor(() => dialogNamed(`Project Settings > ${world.repo.name}`))
  await world.win.waitFor(() => settings.textContent?.includes('This project has no ledger yet. File an entry to create one.'))
  await click(button(settings, 'Cancel')!)

  await createBug(world, 'Retention snapshot')
  await projectMenu(world)
  await chooseMenu(world, 'Project Settings…')
  const savedSettings = await world.win.waitFor(() => dialogNamed(`Project Settings > ${world.repo.name}`))
  const ledgerDays = await world.win.waitFor(() => field<HTMLInputElement>(savedSettings, 'Ledger Staleness'))
  expect(ledgerDays.value).toBe('90')
  await setText(ledgerDays, '0')
  await click(button(savedSettings, 'Save')!)
  await world.win.waitFor(() => savedSettings.textContent?.includes('Saved'))
  const updated = await request(world, { operation: 'list', target: { owner: owner(world) } })
  expect(updated.ledger.staleAfterDays).toBe(0)
  await click(button(savedSettings, 'Cancel')!)

  await projectMenu(world)
  await chooseMenu(world, 'Remove Project…')
  const remove = await world.win.waitFor(() => dialogNamed('Remove Project'))
  expect(remove.textContent).toContain('Ledger records retained: 1 entry across 1 ledger')
  const entry = updated.entries[0]
  await request(world, {
    operation: 'edit',
    target: { owner: owner(world) },
    id: entry.id,
    ifRevision: entry.revision,
    content: { description: 'Changed after the immutable removal preview.' }
  })
  await click(button(remove, 'Remove')!)
  await world.win.waitFor(() => document.querySelector('.toast-title')?.textContent === 'Could not remove project')
  expect(await world.agent.callAny('quirky.repo/list', {})).toContainEqual(expect.objectContaining({ id: world.repo.id }))
  await click(button(remove, 'Cancel')!)

  await projectMenu(world)
  await chooseMenu(world, 'Remove Project…')
  const retry = await world.win.waitFor(() => dialogNamed('Remove Project'))
  await click(button(retry, 'Remove')!)
  await world.win.waitFor(async () => !(await world.agent.callAny('quirky.repo/list', {}) as Repo[]).some((repo) => repo.id === world.repo.id))
  const catalog = await request(world, { operation: 'catalog' })
  expect(catalog.ledgers).toContainEqual(expect.objectContaining({ owner: null, formerOwner: owner(world), entryCount: 1 }))

  const replacementPath = makeRepo(join(scratch(), 'replacement'))
  const replacement = await world.agent.callAny('quirky.repo/add', { path: replacementPath }) as Repo
  await world.win.waitFor(() => projectSection(replacement.name))
  await world.agent.callAny('ui.command.run', { id: OPEN })
  const chooser = await world.win.waitFor(() => document.querySelector<HTMLElement>('.ledger-chooser'))
  const detachedRow = [...chooser.querySelectorAll<HTMLElement>('.ledger-chooser-row')].find((row) => row.textContent?.includes('Detached project ledger'))!
  expect(detachedRow.textContent).toContain('Detached project ledger · 1 entry')
  await click(button(detachedRow, 'Open')!)
  const detachedPage = await world.win.waitFor(() => document.querySelector<HTMLElement>('.ledger-page'))
  const attachOwner = field<HTMLSelectElement>(detachedPage, 'Attach ledger to owner')!
  await setSelect(attachOwner, `project:${replacement.id}`)
  await click(button(detachedPage, 'Attach')!)
  const attachConfirm = await world.win.waitFor(() => dialogNamed('Confirm ledger attachment'))
  expect(attachConfirm.textContent).toContain('ledger revision')
  await click(button(attachConfirm, 'Confirm')!)
  await world.win.waitFor(() => detachedPage.querySelector('h1')?.textContent === replacement.name)
  const attached = await request(world, { operation: 'catalog' })
  expect(attached.ledgers).toContainEqual(expect.objectContaining({ owner: { tier: 'project', id: replacement.id }, entryCount: 1 }))

  await click(button(detachedPage, 'Delete ledger')!)
  const deleteConfirm = await world.win.waitFor(() => dialogNamed('Confirm ledger deletion'))
  expect(deleteConfirm.textContent).toContain('Permanently delete this ledger, every entry body, and all history?')
  await click(button(deleteConfirm, 'Confirm')!)
  await world.win.waitFor(() => document.querySelector('.ledger-chooser'))
  expect((await request(world, { operation: 'catalog' })).ledgers).toHaveLength(0)
}, SLOW)

test('SC-11 and SC-14: group menu opens its ledger and deleting a group reports retained records', async () => {
  const world = await boot()
  const group = (await world.agent.callAny('quirky.repo/groupCreate', { name: 'platform' })) as ProjectGroup
  await world.agent.callAny('quirky.repo/groupAdd', { group: group.id, repo: world.repo.id })
  await request(world, {
    operation: 'file',
    target: { owner: groupOwner(group) },
    type: 'decision',
    content: { title: 'Platform decision', context: 'Why', decision: 'Do this', consequences: 'Shared', status: 'accepted' }
  })
  await groupMenu(world, group.name)
  await chooseMenu(world, 'Open ledger')
  await world.win.waitFor(() => document.querySelector('.ledger-page h1')?.textContent === group.name)
  await groupMenu(world, group.name)
  await chooseMenu(world, 'Delete Group…')
  const dialog = await world.win.waitFor(() => dialogNamed('Delete Group'))
  expect(dialog.textContent).toContain('Ledger records retained: 1 entry across 1 ledger')
  await click(button(dialog, 'Delete Group')!)
  await world.win.waitFor(async () => !(await world.agent.callAny('quirky.repo/groupList', {}) as ProjectGroup[]).some((item) => item.id === group.id))
  const catalog = await request(world, { operation: 'catalog' })
  expect(catalog.ledgers).toContainEqual(expect.objectContaining({ owner: null, formerOwner: groupOwner(group), entryCount: 1 }))
  await world.agent.callAny('ui.command.run', { id: OPEN })
  const chooser = await world.win.waitFor(() => document.querySelector<HTMLElement>('.ledger-chooser'))
  const detachedRow = [...chooser.querySelectorAll<HTMLElement>('.ledger-chooser-row')].find((row) => row.textContent?.includes('Detached group ledger'))!
  expect(detachedRow.textContent).toContain('Detached group ledger · 1 entry')
  await click(button(detachedRow, 'Open')!)
  const detachedPage = await world.win.waitFor(() => document.querySelector<HTMLElement>('.ledger-page'))
  await click(button(detachedPage, 'Delete ledger')!)
  const confirm = await world.win.waitFor(() => dialogNamed('Confirm ledger deletion'))
  expect(confirm.textContent).toContain('Permanently delete this ledger, every entry body, and all history?')
  await click(button(confirm, 'Confirm')!)
  await world.win.waitFor(async () => (await request(world, { operation: 'catalog' })).ledgers.length === 0)
}, SLOW)
