import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ProjectGroup, QuirkyClient, Repo, UiState, Worktree } from '@quirky/protocol'
import { builtinsDir, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from '../../../packages/ui/test/fixtures/headless-window'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { githubUser, useGlobalGitConfig } from '../../quirky.worktree/test/fixtures/repos'
import { button, click, dialogNamed, field, menuItem as findMenuItem, sectionHeadingMatches, setSelect, setText, toastContaining } from '../../quirky.worktree/test/window/dom'

const SLOW = 40_000
const OPEN = 'command:quirky.ledger/open'
const CONTROL = 'command:quirky.ledger/control'
const LEDGER_VIEW = 'view:quirky.ledger/ledger'
const LEDGER_PANEL = 'panel:quirky.ledger/ledger'
const { scratch } = isolateGitConfig()

beforeEach(() => useGlobalGitConfig(scratch, githubUser('ledger-ui')))

type OwnedWorld = { harness: Harness; win?: HeadlessWindow }
type World = { harness: Harness; win: HeadlessWindow; agent: QuirkyClient; repo: Repo; workspace: Worktree }
let current: OwnedWorld | null = null

afterEach(async () => {
  const owned = current
  current = null
  const cleanupErrors: unknown[] = []
  if (owned?.win) {
    try {
      await owned.win.stop()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (owned) {
    try {
      await owned.harness.cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    removeTempDirs()
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Ledger window test cleanup failed')
})

async function boot(): Promise<World> {
  const harness = await startHarness({ builtinPluginsDir: builtinsDir() })
  const owned: OwnedWorld = { harness }
  current = owned
  const agent = await harness.connect('cli', 'ledger-window-test')
  const win = await startHeadlessWindow({ home: harness.home, runtime: harness.runtime })
  owned.win = win
  const repoPath = makeRepo(join(scratch(), 'api'))
  const repo = (await agent.callAny('quirky.repo/add', { path: repoPath })) as Repo
  const workspace = ((await agent.callAny('quirky.worktree/list', { repo: repo.id })) as Worktree[]).find((item) => item.isMain)!
  const world = { harness, win, agent, repo, workspace }
  await win.waitFor(() => projectSection(repo.name))
  return world
}

const uiState = async (agent: QuirkyClient) => (await agent.callAny('ui.state', {})) as UiState
const request = async (world: World, body: Record<string, unknown>): Promise<any> => world.agent.callAny('quirky.ledger/request', body)
const owner = (world: World) => ({ tier: 'project' as const, id: world.repo.id })
const groupOwner = (group: ProjectGroup) => ({ tier: 'group' as const, id: group.id })

const chooserSection = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('section')].find((section) =>
    section.querySelector(':scope > header h1')?.textContent?.trim() === 'Open ledger'
  )

const ledgerPage = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('section')].find((section) => {
    const title = section.querySelector(':scope > header h1')?.textContent?.trim()
    return title !== undefined && title !== 'Open ledger'
  })

function projectSection(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('section.repo')].find((section) => sectionHeadingMatches(section, name))
}

function groupSection(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('section.group')].find((section) => sectionHeadingMatches(section, name))
}

function menuItem(label: string): HTMLElement | undefined {
  return findMenuItem(document, label)
}

async function projectMenu(world: World): Promise<void> {
  const section = await world.win.waitFor(() => projectSection(world.repo.name))
  await click(button(section, `Actions for ${world.repo.name}`)!)
  await world.win.waitFor(() => document.querySelector('[role="menu"]'))
}

async function groupMenu(world: World, name: string): Promise<void> {
  const section = await world.win.waitFor(() => groupSection(name))
  await click(button(section, `Actions for group ${name}`)!)
  await world.win.waitFor(() => document.querySelector('[role="menu"]'))
}

async function chooseMenu(world: World, label: string): Promise<void> {
  await click(await world.win.waitFor(() => menuItem(label))!)
}

async function openOwnerCommand(world: World): Promise<void> {
  await world.agent.callAny('ui.command.run', { id: OPEN, args: { target: { owner: owner(world) } } })
  await world.win.waitFor(() => ledgerPage())
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
  const page = ledgerPage()!
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
  const panel = await world.win.waitFor(() => document.querySelector<HTMLElement>('[aria-label="Ledger panel"]'))
  await world.win.waitFor(() => panel.querySelector('ul li'))
  expect(panel.textContent).toContain('Panel origin record')

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
  await world.win.waitFor(() => panel.querySelector('ul li') === null)
  await setText(search, 'Panel origin')
  await world.win.waitFor(() => panel.querySelector('ul li'))

  await world.agent.callAny('ui.view.close', {})
  await world.win.waitFor(() => panel.querySelector('ul li') === null)
}, SLOW)

test('SC-14: Open Ledger and real owner menus route to the same attached and detached catalog-backed page', async () => {
  const world = await boot()
  await createBug(world, 'Project menu entry')
  await world.agent.callAny('ui.command.run', { id: OPEN })
  const chooser = await world.win.waitFor(() => {
    const section = chooserSection()
    return section?.querySelector('ul li') ? section : undefined
  })
  expect(button(chooser, `Open ledger ${world.repo.name}`)).toBeDefined()
  expect((await uiState(world.agent)).slots.find((slot) => slot.id === LEDGER_VIEW)?.report).toMatchObject({ view: 'chooser' })

  await projectMenu(world)
  await chooseMenu(world, 'Open ledger')
  await world.win.waitFor(() => ledgerPage())
  await world.win.waitFor(() => ledgerPage()?.querySelector(':scope > header h1')?.textContent === world.repo.name)

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
  await world.win.waitFor(() => ledgerPage()?.querySelector(':scope > header h1')?.textContent === group.name)
  await world.agent.callAny('ui.command.run', { id: CONTROL, args: { action: 'detail', id: 'proposal-1' } })
  const commandedDetail = await world.win.waitFor(() => dialogNamed('Ledger entry proposal-1'))
  expect(commandedDetail.textContent).toContain('Group policy')
  await click(button(commandedDetail, 'Close')!)
  await world.agent.callAny('ui.command.run', { id: CONTROL, args: { action: 'new' } })
  const commandedForm = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  const groupEntriesBeforeCancel = await request(world, { operation: 'list', target: { owner: groupOwner(group) } })
  await click(button(commandedForm, 'Cancel')!)
  expect((await request(world, { operation: 'list', target: { owner: groupOwner(group) } })).entries.map((entry: { id: string }) => entry.id))
    .toEqual(groupEntriesBeforeCancel.entries.map((entry: { id: string }) => entry.id))
  await world.agent.callAny('ui.command.run', { id: CONTROL, args: { action: 'sort', sort: 'title' } })
  await world.win.waitFor(async () => {
    const report = (await uiState(world.agent)).slots.find((slot) => slot.id === LEDGER_VIEW)?.report
    return typeof report === 'object' && report !== null && 'sort' in report && report.sort === 'title'
  })

  await world.agent.callAny('ui.command.run', {
    id: CONTROL,
    args: { action: 'filters', target: { owner: groupOwner(group) }, filters: { search: 'Group policy' } }
  })
  await world.win.waitFor(() => ledgerPage()?.textContent?.includes('Group policy'))
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
  expect(document.querySelectorAll('[data-entry-id]')).toHaveLength(5)
  const bugEntry = response.entries.find((entry: { type: string }) => entry.type === 'bug')
  await click(button(ledgerPage()!, `Edit ${bugEntry.id}`)!)
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
  await world.win.waitFor(() => editForm.querySelector('[role="alert"]'))
  const unchanged = await request(world, { operation: 'show', target: { owner: owner(world) }, id: bugEntry.id })
  expect(unchanged.entry.content.title).toBe(bugEntry.content.title)
  expect(unchanged.entry.content.description).toBe('Concurrent revision wins.')
  await click(button(editForm, 'Cancel')!)


  await click(button(ledgerPage()!, 'New entry')!)
  const bugForm = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  await setSelect(field<HTMLSelectElement>(bugForm, 'Type')!, 'bug')
  await setText(field(bugForm, 'Title')!, 'duplicate form record')
  await setText(field(bugForm, 'File')!, 'src/duplicate.ts')
  await setSelect(field<HTMLSelectElement>(bugForm, 'Location base')!, `project:${world.repo.id}`)
  await setText(field<HTMLTextAreaElement>(bugForm, 'Description')!, 'A second matching report.')
  await setSelect(field<HTMLSelectElement>(bugForm, 'Severity')!, 'high')
  await click(button(bugForm, 'Create entry')!)
  const duplicateDialog = await world.win.waitFor(() => {
    const dialog = dialogNamed('New ledger entry')
    return dialog?.querySelector('[aria-label="Possible duplicate entries"]') ? dialog : undefined
  })
  expect(duplicateDialog.querySelector('[aria-label="Possible duplicate entries"]')?.textContent).toContain('bug-1')
  await click(button(duplicateDialog, 'Done')!)
  await click(button(ledgerPage()!, 'New entry')!)
  const externalForm = await world.win.waitFor(() => dialogNamed('New ledger entry'))
  await setSelect(field<HTMLSelectElement>(externalForm, 'Type')!, 'bug')
  await setText(field(externalForm, 'Title')!, 'External location validation')
  await setText(field(externalForm, 'File')!, '/outside/module.ts')
  await setSelect(field<HTMLSelectElement>(externalForm, 'Location base')!, `project:${world.repo.id}`)
  await setText(field<HTMLTextAreaElement>(externalForm, 'Description')!, 'Outside path requires host identity.')
  await setSelect(field<HTMLSelectElement>(externalForm, 'Severity')!, 'low')
  await click(field<HTMLInputElement>(externalForm, 'External location')!)
  await click(button(externalForm, 'Create entry')!)
  await world.win.waitFor(() => externalForm.querySelector('[role="alert"]'))
  expect(await request(world, { operation: 'list', target: { owner: owner(world) } }).then((result) => result.entries)).toHaveLength(6)
  await click(button(externalForm, 'Cancel')!)
}, SLOW)

test('SC-16: long-history detail actions change state and revert through the public API', async () => {
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
  const row = await world.win.waitFor(() => document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`))
  await click(row.querySelector('button[aria-label^="Show details"]')!)
  const detail = await world.win.waitFor(() => {
    const dialog = dialogNamed(`Ledger entry ${id}`)
    return dialog && button(dialog, 'Edit') ? dialog : undefined
  })
  expect(detail.textContent).toContain('Full history')
  expect(detail.textContent).toContain('Before')
  expect(detail.textContent).toContain('After')
  const footer = detail.querySelector<HTMLElement>('footer')!
  expect(button(footer, 'Edit')?.disabled).toBe(false)
  expect(button(footer, 'Review')?.disabled).toBe(false)
  expect(button(footer, 'Open')?.disabled).toBe(true)
  expect(button(footer, 'Resolved')?.disabled).toBe(false)
  expect(button(footer, 'Archived')?.disabled).toBe(false)
  expect(field<HTMLSelectElement>(footer, 'Revert to revision')).toBeDefined()
  expect(button(footer, 'Close')).toBeDefined()
  await click(button(footer, 'Resolved')!)
  await world.win.waitFor(async () => (await request(world, { operation: 'show', target: { owner: owner(world) }, id })).entry?.state === 'resolved')
  const revertSelect = await world.win.waitFor(() => {
    const dialog = dialogNamed(`Ledger entry ${id}`)
    const select = dialog && field<HTMLSelectElement>(dialog, 'Revert to revision')
    return dialog?.textContent?.includes(`Revision ${revision + 1} · sequence`) && select && !select.disabled ? select : undefined
  })
  await setSelect(revertSelect, '1')
  await click(await world.win.waitFor(() => {
    const dialog = dialogNamed(`Ledger entry ${id}`)
    const action = dialog && button(dialog, 'Revert')
    return action && !action.disabled ? action : undefined
  }))
  await world.win.waitFor(async () => {
    const reverted = await request(world, { operation: 'show', target: { owner: owner(world) }, id })
    return reverted.entry?.state === 'open' && reverted.entry?.content.description === 'A reproducible failure.'
  })
}, SLOW)

test('SC-17: triage snapshots conflict cleanly, then approval and confirmed state use refreshed revisions', async () => {
  const world = await boot()
  const filed = await createBug(world, 'Triage snapshot record')
  const id = filed.entry.id as string
  await openOwnerCommand(world)
  await click(button(ledgerPage()!, 'Triage')!)
  const triage = await world.win.waitFor(() => dialogNamed('Operation review'))
  expect((await request(world, { operation: 'show', target: { owner: owner(world) }, id })).entry.state).toBe('open')
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
  await world.win.waitFor(() => triage.querySelector('[role="alert"]'))
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
  expect((await request(world, { operation: 'catalog' })).ledgers).toHaveLength(0)
  await click(button(settings, 'Cancel')!)

  await createBug(world, 'Retention snapshot')
  await projectMenu(world)
  await chooseMenu(world, 'Project Settings…')
  const savedSettings = await world.win.waitFor(() => dialogNamed(`Project Settings > ${world.repo.name}`))
  const ledgerDays = await world.win.waitFor(() => field<HTMLInputElement>(savedSettings, 'Ledger Staleness'))
  expect(ledgerDays.value).toBe('90')
  await setText(ledgerDays, '0')
  await click(button(savedSettings, 'Save')!)
  const updated = await world.win.waitFor(async () => {
    const latest = await request(world, { operation: 'list', target: { owner: owner(world) } })
    return latest.ledger.staleAfterDays === 0 ? latest : undefined
  })
  expect(updated.ledger.staleAfterDays).toBe(0)
  await click(button(savedSettings, 'Cancel')!)

  await projectMenu(world)
  await chooseMenu(world, 'Remove Project…')
  const remove = await world.win.waitFor(() => {
    const dialog = dialogNamed('Remove Project')
    const action = dialog && button(dialog, 'Remove')
    return action && !action.disabled ? dialog : undefined
  })
  const entry = updated.entries[0]
  await request(world, {
    operation: 'edit',
    target: { owner: owner(world) },
    id: entry.id,
    ifRevision: entry.revision,
    content: { description: 'Changed after the immutable removal preview.' }
  })
  await click(button(remove, 'Remove')!)
  await world.win.waitFor(() => toastContaining('Could not remove project'))
  expect(await world.agent.callAny('quirky.repo/list', {})).toContainEqual(expect.objectContaining({ id: world.repo.id }))
  await click(button(remove, 'Cancel')!)
  expect(await world.agent.callAny('quirky.repo/list', {})).toContainEqual(expect.objectContaining({ id: world.repo.id }))

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
  const chooser = await world.win.waitFor(() => chooserSection())
  const openDetached = await world.win.waitFor(() => button(chooser, `Open ledger ${world.repo.name}`))
  await click(openDetached)
  const detachedPage = await world.win.waitFor(() => ledgerPage())
  const attachOwner = await world.win.waitFor(() => {
    const select = field<HTMLSelectElement>(detachedPage, 'Attach ledger to owner')
    return select && [...select.options].some((option) => option.value === `project:${replacement.id}`) ? select : undefined
  })
  await setSelect(attachOwner, `project:${replacement.id}`)
  await click(await world.win.waitFor(() => {
    const action = button(detachedPage, 'Attach')
    return action && !action.disabled ? action : undefined
  }))
  const attachConfirm = await world.win.waitFor(() => dialogNamed('Confirm ledger attachment'))
  expect(attachConfirm.textContent).toContain('ledger revision')
  await click(button(attachConfirm, 'Confirm')!)
  await world.win.waitFor(() => detachedPage.querySelector('h1')?.textContent === replacement.name)
  const attached = await request(world, { operation: 'catalog' })
  expect(attached.ledgers).toContainEqual(expect.objectContaining({ owner: { tier: 'project', id: replacement.id }, entryCount: 1 }))

  await click(button(detachedPage, 'Delete ledger')!)
  const deleteConfirm = await world.win.waitFor(() => dialogNamed('Confirm ledger deletion'))
  await click(button(deleteConfirm, 'Confirm')!)
  await world.win.waitFor(() => chooserSection())
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
  await world.win.waitFor(() => ledgerPage()?.querySelector(':scope > header h1')?.textContent === group.name)
  await groupMenu(world, group.name)
  await chooseMenu(world, 'Delete Group…')
  const dialog = await world.win.waitFor(() => {
    const current = document.querySelector<HTMLElement>('[role="dialog"]')
    const action = current && button(current, 'Delete Group')
    return action && !action.disabled ? current : undefined
  })
  await click(button(dialog, 'Delete Group')!)
  await world.win.waitFor(async () => !(await world.agent.callAny('quirky.repo/groupList', {}) as ProjectGroup[]).some((item) => item.id === group.id))
  const catalog = await request(world, { operation: 'catalog' })
  expect(catalog.ledgers).toContainEqual(expect.objectContaining({ owner: null, formerOwner: groupOwner(group), entryCount: 1 }))
  const chooser = await world.win.waitFor(() => chooserSection())
  const openDetached = await world.win.waitFor(() => button(chooser, `Open ledger ${group.name}`))
  await click(openDetached)
  const detachedPage = await world.win.waitFor(() => ledgerPage())
  await click(await world.win.waitFor(() => button(detachedPage, 'Delete ledger')))
  const confirm = await world.win.waitFor(() => dialogNamed('Confirm ledger deletion'))
  await click(button(confirm, 'Confirm')!)
  await world.win.waitFor(async () => (await request(world, { operation: 'catalog' })).ledgers.length === 0)
}, SLOW)
