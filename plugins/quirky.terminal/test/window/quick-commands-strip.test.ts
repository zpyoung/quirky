import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { $, $$, button, cleanup, click, command, fill, key, loadQuickCommands, qc, qcFake, quickCommandsChanged, render, unloadQuickCommands, type World } from './qc-support'
import type { Group } from '../../src/layout/types'

beforeAll(loadQuickCommands)
afterAll(unloadQuickCommands)
afterEach(cleanup)

function group(over: Partial<Group> = {}): Group {
  return { kind: 'group', id: 'grp-1', tabs: [], activeTab: null, recent: [], lastQuickCommand: null, ...over }
}

async function mountStrip(init: Partial<World> = {}, props: { workspace?: string; group?: Group; repo?: string | null } = {}) {
  const { fake, world } = qcFake(init)
  const g = props.group ?? group()
  const view = await render(
    createElement(qc().strip.QuickCommandsStripButton, {
      context: fake.context,
      workspace: props.workspace ?? 'wt_main',
      group: g,
      repo: props.repo === undefined ? 'api' : props.repo
    })
  )
  return { fake, world, view, g }
}

const label = () => $('[data-qc-run]')?.textContent?.trim()
const menu = () => $('[role="menu"]')
const rows = () => $$('[role="menuitem"]').map((row) => row.getAttribute('data-command'))

const hello = command({ id: 'hello', label: 'Hello', command: 'echo hello' })
const draft = command({ id: 'draft', label: 'Draft', command: 'echo draft', appendEnter: false })
const project = command({ id: 'test', label: 'Test', command: 'bun test', scope: 'repo', repo: 'api' })

describe('QuickCommandsStripButton', () => {
  test('SC-55: the floating workspace has no quick-command button', async () => {
    const { view, fake } = await mountStrip({ commands: [hello] }, { workspace: 'floating', repo: null })
    expect(view.element.innerHTML).toBe('')
    expect(fake.callsTo('quirky.terminal/quickCommands')).toHaveLength(0)
  })

  test('SC-51: with no commands it is one Command button that opens the Add dialog with Project preselected', async () => {
    const { fake, view } = await mountStrip()
    expect($('[data-qc-run]')).toBeNull()
    const single = button('Add quick command')
    expect(single.textContent?.trim()).toBe('Command')
    expect(single.getAttribute('title')).toBe('Save a quick command for this repo')
    await click(single)
    expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Add Quick Command')
    expect($<HTMLInputElement>('input[name="scope"][value="repo"]')!.checked).toBe(true)
    expect(fake.callsTo('quirky.terminal/quickCommands')[0]!.params).toEqual({ workspace: 'wt_main' })
    expect(view.element.querySelector('[role="menu"]')).toBeNull()
  })

  test('SC-51: saving from the strip dialog turns the button into the split button', async () => {
    await mountStrip()
    await click(button('Add quick command'))
    await fill($<HTMLInputElement>('input[name="label"]')!, 'Hello')
    await fill($<HTMLTextAreaElement>('textarea[name="command"]')!, 'echo hello')
    await click(button('Save'))
    expect(label()).toBe('Hello')
  })

  test('SC-51: the left half shows the pick and runs it in a new tab of this group', async () => {
    const { fake } = await mountStrip({ commands: [hello] })
    expect(label()).toBe('Hello')
    expect($('[data-qc-run]')!.getAttribute('aria-label')).toBe('Run quick command: Hello')
    expect($('[data-qc-run]')!.getAttribute('title')).toBe('Run: echo hello')
    await click($('[data-qc-run]')!)
    expect(fake.callsTo('quirky.terminal/runQuickCommand').map((call) => call.params)).toEqual([{ id: 'hello', workspace: 'wt_main', group: 'grp-1' }])
  })

  test('SC-54: the pick is the group\'s last command, else the first repo command, else the first global one', async () => {
    const commands = [hello, draft, project]
    await mountStrip({ commands }, { group: group({ lastQuickCommand: 'draft' }) })
    expect(label()).toBe('Draft')
    await cleanup()
    await mountStrip({ commands }, { group: group({ lastQuickCommand: 'gone' }) })
    expect(label()).toBe('Test')
    await cleanup()
    await mountStrip({ commands: [hello, draft] })
    expect(label()).toBe('Hello')
  })

  test('another repo\'s command is never offered', async () => {
    const other = command({ id: 'other', label: 'Other', scope: 'repo', repo: 'web' })
    await mountStrip({ commands: [other, hello] })
    expect(label()).toBe('Hello')
  })

  test('SC-50: a half-typed command is not offered to run', async () => {
    const half = command({ id: 'half', label: 'Half', command: '' })
    const { fake } = await mountStrip({ commands: [half] })
    const run = $<HTMLButtonElement>('[data-qc-run]')!
    expect(run.textContent?.trim()).toBe('Run')
    expect(run.disabled).toBe(true)
    await click(run)
    expect(fake.callsTo('quirky.terminal/runQuickCommand')).toHaveLength(0)
  })

  test('an agent command shows the agent in its tooltip', async () => {
    const review = command({ id: 'review', label: 'Review', kind: 'agent', agent: 'claude', command: 'review the diff', appendEnter: false })
    await mountStrip({ commands: [review] })
    expect($('[data-qc-run]')!.getAttribute('title')).toBe('Start claude: review the diff')
  })

  test('it follows the group\'s last command when the group changes', async () => {
    const { view, fake } = await mountStrip({ commands: [hello, draft] })
    expect(label()).toBe('Hello')
    await view.rerender(createElement(qc().strip.QuickCommandsStripButton, { context: fake.context, workspace: 'wt_main', group: group({ lastQuickCommand: 'draft' }), repo: 'api' }))
    expect(label()).toBe('Draft')
  })

  test('the quickCommands event reloads the commands', async () => {
    const { fake, world } = await mountStrip({ commands: [hello] })
    world.commands = [draft]
    await fake.emit(quickCommandsChanged)
    expect(label()).toBe('Draft')
    world.commands = []
    await fake.emit(quickCommandsChanged)
    expect($('[data-qc-run]')).toBeNull()
    expect(button('Add quick command')).toBeDefined()
  })

  test('a run that fails shows a toast', async () => {
    const { fake } = await mountStrip({ commands: [hello] })
    fake.context.call = async () => {
      throw new Error('session gone')
    }
    await click($('[data-qc-run]')!)
    expect(fake.toasts.at(-1)).toEqual({ title: 'Could not run quick command', body: 'session gone' })
  })

  describe('the menu', () => {
    test('SC-51: the chevron opens a menu with a search box, the rows and + Command', async () => {
      await mountStrip({ commands: [hello, draft, project] })
      expect(menu()).toBeNull()
      await click(button('More quick commands'))
      expect(menu()).not.toBeNull()
      expect($<HTMLInputElement>('input[type="search"]')!.getAttribute('placeholder')).toBe('Search quick commands...')
      expect(rows()).toEqual(['test', 'hello', 'draft'])
      expect(button('+ Command', menu()!)).toBeDefined()
      for (const name of ['Copy Hello', 'Edit Hello', 'Delete Hello']) expect(button(name)).toBeDefined()
    })

    test('the search box narrows the rows and says so when nothing matches', async () => {
      await mountStrip({ commands: [hello, draft, project] })
      await click(button('More quick commands'))
      await fill($<HTMLInputElement>('input[type="search"]')!, 'dra')
      expect(rows()).toEqual(['draft'])
      await fill($<HTMLInputElement>('input[type="search"]')!, 'qqq')
      expect(rows()).toEqual([])
      expect(menu()!.textContent).toContain('No commands match')
    })

    test('clicking a row runs it and closes the menu', async () => {
      const { fake } = await mountStrip({ commands: [hello, draft] })
      await click(button('More quick commands'))
      await click($('[data-command="draft"]')!)
      expect(fake.callsTo('quirky.terminal/runQuickCommand')[0]!.params).toEqual({ id: 'draft', workspace: 'wt_main', group: 'grp-1' })
      expect(menu()).toBeNull()
    })

    test('Enter in the search box runs the highlighted row, and the arrow keys move it', async () => {
      const { fake } = await mountStrip({ commands: [hello, draft] }, { group: group({ lastQuickCommand: 'hello' }) })
      await click(button('More quick commands'))
      const input = $<HTMLInputElement>('input[type="search"]')!
      await key(input, 'ArrowDown')
      await key(input, 'Enter')
      expect(fake.callsTo('quirky.terminal/runQuickCommand')[0]!.params).toMatchObject({ id: 'draft' })
    })

    test('Enter on a row action activates that button instead of running the highlighted row', async () => {
      const { fake } = await mountStrip({ commands: [hello] })
      await click(button('More quick commands'))
      for (const name of ['Copy Hello', 'Edit Hello', 'Delete Hello']) {
        const action = button(name)
        action.focus()
        await key(action, 'Enter')
      }
      const footer = button('+ Command')
      footer.focus()
      await key(footer, 'Enter')
      expect(fake.callsTo('quirky.terminal/runQuickCommand')).toHaveLength(0)
    })

    test('Escape closes the menu', async () => {
      await mountStrip({ commands: [hello] })
      await click(button('More quick commands'))
      await key($<HTMLInputElement>('input[type="search"]')!, 'Escape')
      expect(menu()).toBeNull()
    })

    test('Copy puts the command text on the clipboard without running it', async () => {
      const written: string[] = []
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void written.push(text) }, configurable: true })
      const { fake } = await mountStrip({ commands: [hello] })
      await click(button('More quick commands'))
      await click(button('Copy Hello'))
      expect(written).toEqual(['echo hello'])
      expect(fake.callsTo('quirky.terminal/runQuickCommand')).toHaveLength(0)
      expect(menu()).not.toBeNull()
    })

    test('Edit closes the menu and opens the Edit dialog', async () => {
      const { fake } = await mountStrip({ commands: [hello] })
      await click(button('More quick commands'))
      await click(button('Edit Hello'))
      expect(menu()).toBeNull()
      expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Edit Quick Command')
      await fill($<HTMLInputElement>('input[name="label"]')!, 'Hi')
      await click(button('Save'))
      expect(fake.callsTo('quirky.terminal/updateQuickCommand')[0]!.params).toMatchObject({ id: 'hello', label: 'Hi' })
      expect(label()).toBe('Hi')
    })

    test('Delete confirms and then removes with yes: true', async () => {
      const { fake, world } = await mountStrip({ commands: [hello, draft] })
      await click(button('More quick commands'))
      fake.state.confirmAnswer = false
      await click(button('Delete Hello'))
      expect(fake.callsTo('quirky.terminal/removeQuickCommand')).toHaveLength(0)
      await click(button('More quick commands'))
      fake.state.confirmAnswer = true
      await click(button('Delete Hello'))
      expect(fake.callsTo('quirky.terminal/removeQuickCommand')[0]!.params).toEqual({ id: 'hello', yes: true })
      expect(world.commands.map((entry) => entry.id)).toEqual(['draft'])
      expect(label()).toBe('Draft')
    })

    test('+ Command closes the menu and opens the Add dialog with Project preselected', async () => {
      await mountStrip({ commands: [hello] })
      await click(button('More quick commands'))
      await click(button('+ Command'))
      expect(menu()).toBeNull()
      expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Add Quick Command')
      expect($<HTMLInputElement>('input[name="scope"][value="repo"]')!.checked).toBe(true)
    })
  })
})
