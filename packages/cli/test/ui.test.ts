import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })

describe('ui contributions', () => {

  test('omits empty sections when windowBarItems is undefined', async () => {
    expect(daemon.ui.windowBarItems).toBeUndefined()
    daemon.addUiSlot('status-bar', 'acme.notes', 'usage')
    daemon.addUiSlot('panel', 'acme.notes', 'inspector')
    const result = await run(['ui', 'contributions'])
    const headers = result.stdout.trimEnd().split('\n\n').map((section) => section.split('\n')[0])
    expect(headers).toEqual(['STATUS BARS', 'PANELS', 'THEMES'])
  })

  test('omits WINDOW BAR ITEMS when windowBarItems is empty', async () => {
    daemon.ui.windowBarItems = []
    daemon.addUiSlot('status-bar', 'acme.notes', 'usage')
    daemon.addUiSlot('panel', 'acme.notes', 'inspector')
    const result = await run(['ui', 'contributions'])
    const headers = result.stdout.trimEnd().split('\n\n').map((section) => section.split('\n')[0])
    expect(headers).toEqual(['STATUS BARS', 'PANELS', 'THEMES'])
  })

  test('renders WINDOW BAR ITEMS when windowBarItems is non-empty and prints shown window-bar-item slots in ui state', async () => {
    daemon.addUiSlot('status-bar', 'acme.notes', 'usage')
    daemon.ui.windowBarItems = [{
      id: 'window-bar-item:quirky.avatar/pill',
      kind: 'window-bar-item',
      plugin: 'quirky.avatar',
      title: 'Avatar',
      order: 20,
      module: '/plugins/avatar/ui.js'
    }]
    daemon.addUiSlot('panel', 'acme.notes', 'inspector')

    const result = await run(['ui', 'contributions'])
    const sections = result.stdout.trimEnd().split('\n\n')
    const headers = sections.map((section) => section.split('\n')[0])
    expect(result.code).toBe(0)
    expect(headers).toEqual(['STATUS BARS', 'WINDOW BAR ITEMS', 'PANELS', 'THEMES'])
    const windowBarItems = sections.find((section) => section.startsWith('WINDOW BAR ITEMS'))!
    for (const value of ['window-bar-item:quirky.avatar/pill', 'quirky.avatar', 'Avatar', '20', '/plugins/avatar/ui.js']) {
      expect(windowBarItems).toContain(value)
    }

    const jsonResult = await run(['ui', 'contributions', '--json'])
    expect(JSON.parse(jsonResult.stdout).windowBarItems).toEqual(daemon.ui.windowBarItems)

    daemon.results.set('ui.state', {
      windows: [],
      layout: { view: null, panel: null, sidebar: true, focus: null },
      slots: [{
        id: 'window-bar-item:quirky.avatar/pill',
        kind: 'window-bar-item',
        plugin: 'quirky.avatar',
        title: 'Avatar',
        shown: true,
        report: { summary: '1 supervised' }
      }],
      toasts: []
    })
    const stateResult = await run(['ui', 'state'])
    expect(stateResult.stdout).toContain('slot window-bar-item:quirky.avatar/pill: Avatar {"summary":"1 supervised"}')
  })

  test('says so when every section is empty', async () => {
    daemon.ui.themes.length = 0
    const result = await run(['ui', 'contributions'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('no UI contributions\n')
  })

  test('a line break inside a title cannot break the table', async () => {
    daemon.addUiCommand('acme.notes', 'new', { title: 'New\nnote' })
    const result = await run(['ui', 'contributions'])
    expect(result.stdout).toContain('New\\nnote')
    const commands = result.stdout.split('\n\n').find((section) => section.startsWith('COMMANDS'))!
    expect(commands.split('\n')).toHaveLength(3)
  })

  test('--json prints the model', async () => {
    daemon.addUiSlot('view', 'acme.notes', 'editor')
    const result = await run(['ui', 'contributions', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(daemon.ui)
  })

  test('surplus arguments are a usage error', async () => {
    const result = await run(['ui', 'contributions', 'extra'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unexpected argument "extra"')
    expect(daemon.methodCalls('ui.contributions')).toEqual([])
  })
})

describe('ui tool commands', () => {
  test('invalid slots and empty size changes fail before reaching the daemon', async () => {
    const close = await run(['ui', 'close-tool', 'middle'])
    const resize = await run(['ui', 'resize-tools'])
    expect(close.code).toBe(2)
    expect(resize.code).toBe(2)
    expect(daemon.calls).toEqual([])
  })
})

describe('help', () => {
  test('lists the ui group and the command in the top-level help', async () => {
    const group = await run(['ui', '--help'])
    expect(group.code).toBe(0)
    expect(group.stdout).toContain('ui contributions')
    expect((await run(['help'])).stdout).toContain('ui contributions')
  })
})
