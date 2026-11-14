import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import type * as EmulatorModule from '../../src/window/EmulatorView'
import type * as ShortcutsModule from '../../src/window/ShortcutSettings'
import type * as SessionsModule from '../../src/window/SessionsPanel'
import type * as FloatingModule from '../../src/window/floating/FloatingOverlay'
import { $, $$, button, cleanup, click, command, fakeContext, loadQuickCommands, qc, qcFake, render, settle, unloadQuickCommands } from './qc-support'

const QC_DIALOG = 'command:quirky.terminal/quick-command-dialog'
const QC_COPY = 'command:quirky.terminal/copy-quick-command'
const EMPTY_TEXT = 'No quick commands saved. Run them from the Command button in the tab bar, or right-click inside any terminal.'

type TestModules = {
  emulator: typeof EmulatorModule
  shortcuts: typeof ShortcutsModule
  sessions: typeof SessionsModule
  floating: typeof FloatingModule
}

let modules: TestModules

beforeAll(async () => {
  await loadQuickCommands()
  // ReactDOM and its dependent components must load after happy-dom registers event support.
  modules = {
    emulator: await import('../../src/window/EmulatorView'),
    shortcuts: await import('../../src/window/ShortcutSettings'),
    sessions: await import('../../src/window/SessionsPanel'),
    floating: await import('../../src/window/floating/FloatingOverlay')
  }
})

afterAll(unloadQuickCommands)
afterEach(cleanup)

function expectLoading(element: ParentNode, text: string): void {
  const status = element.querySelector('[role="status"]')
  expect(status).not.toBeNull()
  expect(status?.querySelector('.ui-notice-line')?.textContent).toBe(text)
}

function session(sessionId: string) {
  return {
    sessionId,
    state: 'running',
    pid: 101,
    cwd: '/tmp/api',
    shellState: 'ready',
    worktreeId: 'wt_main',
    workspace: 'api/main',
    tabTitle: 'Terminal 1',
    worktreeName: 'main'
  }
}

describe('Terminal panel and floating surface states', () => {
  test('1. emulator loading is announced as status, not an error', async () => {
    const fake = fakeContext({ 'quirky.terminal/emulators': () => new Promise(() => {}) })
    const { element } = await render(createElement(modules.emulator.EmulatorView, { context: fake.context }))

    expectLoading(element, 'Loading simulators…')
    expect(element.querySelector('[role="alert"]')).toBeNull()
  })

  test('2. emulator errors can retry into the empty state', async () => {
    let attempts = 0
    const fake = fakeContext({
      'quirky.terminal/emulators': () => {
        attempts += 1
        if (attempts === 1) throw new Error('simctl missing')
        return { available: true, devices: [] }
      }
    })
    const { element } = await render(createElement(modules.emulator.EmulatorView, { context: fake.context }))

    const error = $('.ui-inline-error', element)!
    expect($$('.ui-inline-error', element)).toHaveLength(1)
    expect(error.textContent).toContain('simctl missing')
    await click(button('Retry', error))

    expect(fake.callsTo('quirky.terminal/emulators')).toHaveLength(2)
    expect(element.querySelector('[role="alert"]')).toBeNull()
    expect($('.ui-empty-state', element)?.textContent).toContain('No available iOS simulators. Install a simulator runtime in Xcode, then Refresh.')
  })

  test('3. an unavailable emulator listing is an error, not an empty state', async () => {
    const fake = fakeContext({
      'quirky.terminal/emulators': () => ({ available: false, reason: 'Xcode is not installed.', devices: [] })
    })
    const { element } = await render(createElement(modules.emulator.EmulatorView, { context: fake.context }))

    expect($('.ui-inline-error', element)?.textContent).toContain('Xcode is not installed.')
    expect($('.ui-empty-state', element)).toBeNull()
  })

  test('4. a selected booted emulator announces frame capture while it is pending', async () => {
    const fake = fakeContext({
      'quirky.terminal/emulators': () => ({ available: true, devices: [{ id: 'D1', name: 'iPhone 16', state: 'Booted' }] }),
      'quirky.terminal/emulatorFrame': () => new Promise(() => {})
    })
    const { element } = await render(createElement(modules.emulator.EmulatorView, { context: fake.context, input: { device: 'D1' } }))

    expectLoading(element, 'Capturing iPhone 16…')
  })

  test('5. Shortcut Settings announces its initial load', async () => {
    const fake = fakeContext({ 'ui.contributions': () => new Promise(() => {}) })
    const { element } = await render(createElement(modules.shortcuts.ShortcutSettings, { context: fake.context }))

    expectLoading(element, 'Loading shortcuts…')
  })

  test('6. Shortcut Settings shows a load failure without an empty state', async () => {
    const fake = fakeContext({ 'ui.contributions': () => { throw new Error('daemon gone') } })
    const { element } = await render(createElement(modules.shortcuts.ShortcutSettings, { context: fake.context }))

    expect($('.ui-inline-error', element)?.textContent).toContain('daemon gone')
    expect($('.ui-empty-state', element)).toBeNull()
  })

  test('7. Shortcut actions use the keybinding API and show refused saves inline', async () => {
    const binding = {
      id: 'keybinding:quirky.terminal/clear',
      plugin: 'quirky.terminal',
      key: 'mod+k',
      command: 'command:quirky.terminal/clear',
      status: 'active'
    }
    let failSet = false
    const fake = fakeContext({
      'ui.contributions': () => ({ commands: [{ id: binding.command, title: 'Clear' }], keybindings: [binding] }),
      'keybinding.set': () => {
        if (failSet) throw new Error('mod++ is not a chord')
        return [binding]
      },
      'keybinding.reset': () => [binding]
    })
    const { element } = await render(createElement(modules.shortcuts.ShortcutSettings, { context: fake.context }))

    await click(button('Save', element))
    await click(button('Disable', element))
    await click(button('Reset', element))
    expect(fake.callsTo('keybinding.set').map(({ params }) => params)).toEqual([
      { id: binding.id, key: 'mod+k' },
      { id: binding.id, key: null }
    ])
    expect(fake.callsTo('keybinding.reset').map(({ params }) => params)).toEqual([{ id: binding.id }])

    failSet = true
    await click(button('Save', element))
    expect($('.ui-inline-error', element)?.textContent).toContain('mod++ is not a chord')
  })

  test('8. Sessions announces loading without claiming there are no sessions', async () => {
    const fake = fakeContext({ 'quirky.terminal/sessions': () => new Promise(() => {}) })
    const { element } = await render(createElement(modules.sessions.SessionsPanel, { context: fake.context, report: () => {} }))

    expect(element.textContent).toContain('Sessions (0)')
    expect(element.textContent).not.toContain('No sessions.')
    expectLoading(element, 'Loading sessions…')
  })

  test('9. a first Sessions failure retries into the empty state without a toast', async () => {
    let attempts = 0
    const fake = fakeContext({
      'quirky.terminal/sessions': () => {
        attempts += 1
        if (attempts === 1) throw new Error('host down')
        return { sessions: [] }
      }
    })
    const { element } = await render(createElement(modules.sessions.SessionsPanel, { context: fake.context, report: () => {} }))

    const error = $('.ui-inline-error', element)!
    expect(error.textContent).toContain('Could not load sessions: host down')
    expect(button('Retry', error)).toBeDefined()
    expect(fake.toasts).toEqual([])
    expect($('.ui-empty-state', element)).toBeNull()
    await click(button('Retry', error))

    expect(element.querySelector('[role="alert"]')).toBeNull()
    expect($('.ui-empty-state', element)?.textContent).toContain('No sessions.')
  })

  test('10. a later Sessions failure keeps the previously loaded row', async () => {
    let attempts = 0
    const fake = fakeContext({
      'quirky.terminal/sessions': () => {
        attempts += 1
        if (attempts === 1) return { sessions: [session('s-1')] }
        throw new Error('blip')
      }
    })
    const { element } = await render(createElement(modules.sessions.SessionsPanel, { context: fake.context, report: () => {} }))

    expect(element.querySelector('[data-session="s-1"]')).not.toBeNull()
    await fake.emit({ type: 'quirky.session/changed', data: {} } as never)
    await settle()

    expect(element.querySelector('[data-session="s-1"]')).not.toBeNull()
    expect($('.ui-inline-error', element)?.textContent).toContain('Could not load sessions: blip')
  })

  test('11. the Quick Commands panel announces its initial load', async () => {
    const fake = fakeContext({ 'quirky.terminal/quickCommands': () => new Promise(() => {}) })
    const { element } = await render(createElement(qc().panel.QuickCommandsPanel, { context: fake.context }))

    expectLoading(element, 'Loading quick commands…')
    expect($('.ui-empty-state', element)).toBeNull()
  })

  test('12. a Quick Commands load failure retries into the empty state without a toast', async () => {
    let attempts = 0
    const fake = fakeContext({
      'quirky.terminal/quickCommands': () => {
        attempts += 1
        if (attempts === 1) throw new Error('store locked')
        return { commands: [] }
      }
    })
    const { element } = await render(createElement(qc().panel.QuickCommandsPanel, { context: fake.context }))

    const error = $('.ui-inline-error', element)!
    expect(error.textContent).toContain('Could not load quick commands: store locked')
    expect(button('Retry', error)).toBeDefined()
    expect(fake.toasts).toEqual([])
    expect(element.textContent).not.toContain(EMPTY_TEXT)
    await click(button('Retry', error))

    expect(element.querySelector('[role="alert"]')).toBeNull()
    expect($('.ui-empty-state', element)?.textContent).toContain(EMPTY_TEXT)
  })

  test('13. Add and Edit in the Quick Commands panel route through the dialog command', async () => {
    const hello = command({ id: 'hello', label: 'Hello', command: 'echo hello' })
    const { fake, executed } = qcFake({ commands: [hello] })
    fake.layout.worktree = 'wt_main'
    await render(createElement(qc().panel.QuickCommandsPanel, { context: fake.context }))

    await click(button('Add Command'))
    expect(executed).toEqual([{ id: QC_DIALOG, args: { action: 'open', repo: 'api' } }])
    expect($$('[role="dialog"]')).toHaveLength(1)
    expect($('[role="dialog"]')?.getAttribute('aria-label')).toBe('Add Quick Command')

    await click(button('Cancel'))
    expect($$('[role="dialog"]')).toHaveLength(0)
    await click(button('Edit Hello'))
    expect(executed).toEqual([
      { id: QC_DIALOG, args: { action: 'open', repo: 'api' } },
      { id: QC_DIALOG, args: { action: 'open', command: 'hello', repo: 'api' } }
    ])
    expect($$('[role="dialog"]')).toHaveLength(1)
    expect($('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit Quick Command')
  })

  test('14. a failed floating workspace read toasts and draws no overlay', async () => {
    const fake = fakeContext({ 'quirky.terminal/floating': () => { throw new Error('no daemon') } })
    await render(createElement(modules.floating.FloatingOverlay, { context: fake.context, workspaceOptions: () => ({}) }))

    expect(fake.toasts).toEqual([{ title: 'Could not load the floating workspace', body: 'no daemon' }])
    expect($$('[data-floating-button], [data-floating-panel]')).toHaveLength(0)
  })

  test('15. activate provides both quick-command commands', async () => {
    // Activation loads window providers only after the DOM has been installed.
    const ui = await import('../../src/ui')
    const fake = fakeContext({ 'ui.contributions': () => ({ commands: [], keybindings: [] }) })
    ui.activate(fake.context)
    await settle()

    expect(fake.provided.has(QC_DIALOG)).toBe(true)
    expect(fake.provided.has(QC_COPY)).toBe(true)
  })

  test('16. the strip owner opens with open-menu and closes locally', async () => {
    // Activation loads window providers only after the DOM has been installed.
    const ui = await import('../../src/ui')
    const fake = fakeContext()
    const executed: { id: string; args?: unknown }[] = []
    fake.context.executeCommand = async (id, args) => { executed.push({ id, args }) }
    const closed: (string | undefined)[] = []
    const source = { closeMenu: (group?: string) => { closed.push(group) } }

    await ui.setStripMenu(fake.context, source, 'grp-1', true)
    expect(executed).toEqual([{
      id: 'command:quirky.terminal/open-menu',
      args: { kind: 'quick-commands', target: 'grp-1' }
    }])
    expect(closed).toEqual([])

    await ui.setStripMenu(fake.context, source, 'grp-1', false)
    expect(closed).toEqual(['grp-1'])
    expect(executed).toHaveLength(1)
  })
})
