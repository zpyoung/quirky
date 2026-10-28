import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })
const cells = (line: string) => line.split(/\s{2,}/)

describe('ui contributions', () => {
  test('prints one headed table per non-empty section', async () => {
    daemon.addUiSlot('sidebar-section', 'acme.notes', 'list', { title: 'Notes', order: 20, module: '/plugins/acme.notes/ui.js' })
    daemon.addUiSlot('sidebar-section', 'acme.notes', 'tags', { title: 'Tags' })
    daemon.addUiSlot('status-bar', 'acme.notes', 'usage', { title: 'Usage', order: 7 })
    daemon.addUiSlot('panel', 'acme.notes', 'inspector', { title: 'Inspector', order: 5 })
    daemon.addUiSlot('view', 'acme.notes', 'editor', { title: 'Editor' })
    daemon.addUiCommand('acme.notes', 'new', { title: 'New note', module: '/plugins/acme.notes/ui.js' })
    daemon.addUiCommand('acme.notes', 'sync', { title: 'Sync' })
    daemon.addKeybinding('acme.notes', 'new', 'mod+n', 'command:acme.notes/new')
    daemon.addKeybinding('acme.notes', 'close', 'mod+w', 'command:acme.notes/close', { status: 'shadowed', shadowedBy: 'kernel' })
    daemon.addKeybinding('acme.notes', 'gone', 'mod+g', 'command:acme.notes/gone', { status: 'unbound' })
    daemon.addSetting('acme.notes', 'fontSize', { title: 'Font size' })
    daemon.addSetting('acme.notes', 'mode', { type: 'enum', default: 'list', value: 'list', values: ['list', 'grid'] })
    daemon.addTheme('acme.solar', 'solar', { title: 'Solar' })

    const result = await run(['ui', 'contributions'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('ui.contributions')).toEqual([{}])
    const sections = result.stdout.trimEnd().split('\n\n')
    expect(sections.map((section) => section.split('\n')[0])).toEqual([
      'SIDEBAR',
      'STATUS BARS',
      'PANELS',
      'VIEWS',
      'COMMANDS',
      'KEYBINDINGS',
      'SETTINGS',
      'THEMES'
    ])
    const [sidebar, statusBars, panels, views, commands, keybindings, settings, themes] = sections.map((s) => s.split('\n').slice(1))

    expect(sidebar.map(cells)).toEqual([
      ['ID', 'PLUGIN', 'TITLE', 'ORDER', 'MODULE'],
      ['sidebar-section:acme.notes/list', 'acme.notes', 'Notes', '20', '/plugins/acme.notes/ui.js'],
      ['sidebar-section:acme.notes/tags', 'acme.notes', 'Tags', '100', '-']
    ])
    expect(statusBars.map(cells)[1]).toEqual(['status-bar:acme.notes/usage', 'acme.notes', 'Usage', '7', '-'])
    expect(panels.map(cells)[1]).toEqual(['panel:acme.notes/inspector', 'acme.notes', 'Inspector', '5', '-'])
    expect(views.map(cells)[1]).toEqual(['view:acme.notes/editor', 'acme.notes', 'Editor', '100', '-'])
    expect(commands.map(cells)).toEqual([
      ['ID', 'PLUGIN', 'TITLE', 'MODULE'],
      ['command:acme.notes/new', 'acme.notes', 'New note', '/plugins/acme.notes/ui.js'],
      ['command:acme.notes/sync', 'acme.notes', 'Sync', '-']
    ])
    expect(keybindings.map(cells)).toEqual([
      ['ID', 'KEY', 'COMMAND', 'STATUS'],
      ['keybinding:acme.notes/new', 'mod+n', 'command:acme.notes/new', 'active'],
      ['keybinding:acme.notes/close', 'mod+w', 'command:acme.notes/close', 'shadowed by kernel'],
      ['keybinding:acme.notes/gone', 'mod+g', 'command:acme.notes/gone', 'unbound']
    ])
    expect(settings.map(cells)).toEqual([
      ['ID', 'TYPE', 'DEFAULT'],
      ['setting:acme.notes/fontSize', 'number', '13'],
      ['setting:acme.notes/mode', 'enum', '"list"']
    ])
    expect(themes.map(cells)).toEqual([
      ['ID', 'TITLE', 'APPEARANCE'],
      ['default', 'Quirky Dark', 'dark'],
      ['theme:acme.solar/solar', 'Solar', 'light']
    ])
  })

  test('omits empty sections', async () => {
    daemon.addUiSlot('status-bar', 'acme.notes', 'usage')
    daemon.addUiSlot('panel', 'acme.notes', 'inspector')
    const result = await run(['ui', 'contributions'])
    const headers = result.stdout.trimEnd().split('\n\n').map((section) => section.split('\n')[0])
    expect(headers).toEqual(['STATUS BARS', 'PANELS', 'THEMES'])
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
