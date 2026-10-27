import { act } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { $, $$, button, cleanup, click, command, fill, key, loadQuickCommands, pick, qc, qcFake, quickCommandsChanged, settle, unloadQuickCommands, type World } from './qc-support'

beforeAll(loadQuickCommands)
afterAll(unloadQuickCommands)

type Report = { count: number; filter: string; query: string; rows: { id: string; label: string; scope: string }[] }

let unmount: (() => void) | null = null
afterEach(async () => {
  await act(async () => void unmount?.())
  unmount = null
  await cleanup()
})

const EMPTY = 'No quick commands saved. Run them from the Quick Commands button in the tab bar, or right-click inside any terminal.'

async function openPanel(init: Partial<World> = {}, options: { worktree?: string | null } = {}) {
  const { fake, world } = qcFake(init)
  const worktree = options.worktree === undefined ? 'wt_main' : options.worktree
  if (worktree) fake.layout.view = { id: 'view:quirky.session/worktree', input: { worktree } }
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: Report[] = []
  await act(async () => {
    unmount = qc().panel.mountQuickCommandsPanel(fake.context, element, { report: (state: Report) => void reports.push(state) })
  })
  await settle()
  return { fake, world, element, reports, last: () => reports.at(-1)! }
}

const rowLabels = (element: HTMLElement) => $$('[data-command]', element).map((row) => row.getAttribute('data-command'))
const search = (element: HTMLElement) => $<HTMLInputElement>('input[type="search"]', element)!
const filter = (element: HTMLElement) => $<HTMLSelectElement>('select', element)!

const hello = command({ id: 'hello', label: 'Hello', command: 'echo hello' })
const project = command({ id: 'test', label: 'Test', command: 'bun test', scope: 'repo', repo: 'api' })
const draft = command({ id: 'draft', label: 'Draft', command: 'echo draft', appendEnter: false })

describe('Quick Commands panel', () => {
  test('SC-49: with nothing saved it shows the empty text and the header controls', async () => {
    const { element, last } = await openPanel()
    expect(element.textContent).toContain(EMPTY)
    expect(search(element).getAttribute('placeholder')).toBe('Search quick commands')
    expect($$('option', filter(element)).map((option) => option.textContent)).toEqual(['All commands', 'Global', 'Project'])
    expect(button('Add Command', element)).toBeDefined()
    expect(last()).toEqual({ count: 0, filter: 'all', query: '', rows: [] })
  })

  test('SC-49: adding a command with Project preselected to the current repo lists it with a badge and an Enter hint', async () => {
    const { fake, element, last } = await openPanel()
    await click(button('Add Command', element))
    const dialog = $('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Add Quick Command')
    expect($<HTMLInputElement>('input[name="scope"][value="repo"]')!.checked).toBe(true)
    await fill($<HTMLInputElement>('input[name="label"]')!, 'Hello')
    await fill($<HTMLTextAreaElement>('textarea[name="command"]')!, 'echo hello')
    await key($('textarea[name="command"]')!, 'Enter', { metaKey: true })

    expect(fake.callsTo('quirky.terminal/addQuickCommand')[0]!.params).toMatchObject({ label: 'Hello', command: 'echo hello', scope: 'repo', repo: 'api' })
    expect($('[role="dialog"]')).toBeNull()
    const row = $('[data-command="hello"]', element)!
    expect(row.textContent).toContain('Hello')
    expect(row.textContent).toContain('Project')
    expect(row.textContent).toContain('echo hello')
    expect(row.textContent).toContain('Enter')
    expect(element.textContent).not.toContain(EMPTY)
    expect(last()).toEqual({ count: 1, filter: 'all', query: '', rows: [{ id: 'hello', label: 'Hello', scope: 'repo' }] })
  })

  test('the Add dialog starts on Global when the window has no repo', async () => {
    const { element } = await openPanel({}, { worktree: 'floating' })
    await click(button('Add Command', element))
    expect($('input[name="scope"][value="repo"]')).toBeNull()
    expect($<HTMLInputElement>('input[name="scope"][value="global"]')!.checked).toBe(true)
  })

  test('rows show the scope badge, the command, and an Enter, Insert or Agent hint', async () => {
    const review = command({ id: 'review', label: 'Review', kind: 'agent', agent: 'claude', command: 'review the diff', appendEnter: false })
    const { element } = await openPanel({ commands: [hello, project, draft, review] })
    const text = (id: string) => $(`[data-command="${id}"]`, element)!.textContent!
    expect(text('hello')).toContain('Global')
    expect(text('hello')).toContain('Enter')
    expect(text('test')).toContain('Project')
    expect(text('draft')).toContain('Insert')
    expect(text('draft')).not.toContain('Enter')
    expect(text('review')).toContain('Agent')
  })

  test('SC-49: the scope filter and the search box narrow the list and the report follows', async () => {
    const { element, last } = await openPanel({ commands: [hello, project, draft] })
    expect(rowLabels(element)).toEqual(['hello', 'test', 'draft'])
    expect(last().count).toBe(3)

    await pick(filter(element), 'global')
    expect(rowLabels(element)).toEqual(['hello', 'draft'])
    expect(last()).toMatchObject({ count: 3, filter: 'global', rows: [{ id: 'hello', label: 'Hello', scope: 'global' }, { id: 'draft', label: 'Draft', scope: 'global' }] })

    await pick(filter(element), 'repo')
    expect(rowLabels(element)).toEqual(['test'])

    await pick(filter(element), 'all')
    await fill(search(element), 'dra')
    expect(rowLabels(element)).toEqual(['draft'])
    expect(last()).toMatchObject({ query: 'dra', filter: 'all', rows: [{ id: 'draft', label: 'Draft', scope: 'global' }] })

    await fill(search(element), 'nothing like it')
    expect(rowLabels(element)).toEqual([])
    expect(element.textContent).toContain('No commands match this search.')
    expect(element.textContent).not.toContain(EMPTY)

    await fill(search(element), '')
    await pick(filter(element), 'repo')
    await fill(search(element), 'hello')
    expect(element.textContent).toContain('No commands match this search.')
  })

  test('search also matches the command text', async () => {
    const { element } = await openPanel({ commands: [hello, draft] })
    await fill(search(element), 'echo draft')
    expect(rowLabels(element)).toEqual(['draft'])
  })

  test('Edit opens the dialog with the saved values and Save updates the row', async () => {
    const { fake, element } = await openPanel({ commands: [hello] })
    await click(button('Edit Hello', element))
    expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Edit Quick Command')
    expect($<HTMLInputElement>('input[name="label"]')!.value).toBe('Hello')
    await fill($<HTMLInputElement>('input[name="label"]')!, 'Hello again')
    await click(button('Save'))
    expect(fake.callsTo('quirky.terminal/updateQuickCommand')[0]!.params).toMatchObject({ id: 'hello', label: 'Hello again' })
    expect($('[data-command="hello"]', element)!.textContent).toContain('Hello again')
  })

  test('Delete asks first, and only a yes removes the command with yes: true', async () => {
    const { fake, world, element, last } = await openPanel({ commands: [hello, draft] })
    fake.state.confirmAnswer = false
    await click(button('Delete Hello', element))
    expect(fake.confirms).toHaveLength(1)
    expect(fake.confirms[0]!.title).toBe('Delete "Hello"?')
    expect(fake.callsTo('quirky.terminal/removeQuickCommand')).toHaveLength(0)
    expect(rowLabels(element)).toEqual(['hello', 'draft'])

    fake.state.confirmAnswer = true
    await click(button('Delete Hello', element))
    expect(fake.callsTo('quirky.terminal/removeQuickCommand')[0]!.params).toEqual({ id: 'hello', yes: true })
    expect(world.commands.map((entry) => entry.id)).toEqual(['draft'])
    expect(rowLabels(element)).toEqual(['draft'])
    expect(last().count).toBe(1)
  })

  test('a failed delete is reported in a toast and keeps the row', async () => {
    const { fake, world, element } = await openPanel({ commands: [hello] })
    world.commands = []
    await click(button('Delete Hello', element))
    expect(fake.toasts.at(-1)!.title).toBe('Could not delete quick command')
  })

  test('the quickCommands event reloads the list', async () => {
    const { fake, world, element, last } = await openPanel({ commands: [hello] })
    world.commands = [hello, draft]
    await fake.emit(quickCommandsChanged)
    await settle()
    expect(rowLabels(element)).toEqual(['hello', 'draft'])
    expect(last().count).toBe(2)
  })

  test('the panel asks for every saved command, not just the current repo\'s', async () => {
    const { fake } = await openPanel({ commands: [hello, project] })
    expect(fake.callsTo('quirky.terminal/quickCommands')[0]!.params).toEqual({ all: true })
  })

  test('unmounting stops listening for events', async () => {
    const { fake, world } = await openPanel({ commands: [hello] })
    const before = fake.callsTo('quirky.terminal/quickCommands').length
    await act(async () => void unmount?.())
    unmount = null
    world.commands = []
    await fake.emit(quickCommandsChanged)
    expect(fake.callsTo('quirky.terminal/quickCommands')).toHaveLength(before)
  })
})
