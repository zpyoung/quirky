import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DistroInspection, PluginInspection, UiLayout, UiState } from '@quirky/protocol'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[], extra: { cwd?: string; env?: Record<string, string> } = {}) =>
  runCli(args, { home: daemon.home, ...extra })

const LAYOUT: UiLayout = {
  view: { id: 'view:quirky.session/worktree', input: { worktree: 'wt_1' } },
  panel: null,
  sidebar: true,
  focus: 'view',
  palette: true
}

describe('ui commands', () => {
  test('ui state prints the layout and one line per shown slot', async () => {
    const state: UiState = {
      windows: [{ connId: 3, name: 'window', focused: true, inputAt: null, present: false }],
      layout: LAYOUT,
      slots: [
        { id: 'sidebar-section:quirky.worktree/worktrees', kind: 'sidebar-section', plugin: 'quirky.worktree', title: 'Worktrees', shown: true, report: { repos: 1 } },
        { id: 'panel:quirky.git/source-control', kind: 'panel', plugin: 'quirky.git', title: 'Source control', shown: false },
        { id: 'view:quirky.session/worktree', kind: 'view', plugin: 'quirky.session', title: 'Session', shown: true }
      ]
    }
    daemon.results.set('ui.state', state)
    const result = await run(['ui', 'state'])
    expect(result.code).toBe(0)
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      'windows: 1',
      'view: view:quirky.session/worktree {"worktree":"wt_1"}',
      'panel: -',
      'sidebar: shown',
      'palette: open',
      'slot sidebar-section:quirky.worktree/worktrees: Worktrees {"repos":1}',
      'slot view:quirky.session/worktree: Session'
    ])
    expect(daemon.methodCalls('ui.state')).toEqual([{}])
    expect(JSON.parse((await run(['ui', 'state', '--json'])).stdout)).toEqual(state)
  })

  test('SC-67: ui state prints a shown overlay with its report, and ui contributions lists the OVERLAYS table', async () => {
    const state: UiState = {
      windows: [{ connId: 3, name: 'window', focused: true, inputAt: null, present: false }],
      layout: LAYOUT,
      slots: [
        { id: 'overlay:quirky.terminal/floating', kind: 'overlay', plugin: 'quirky.terminal', title: 'Floating', shown: true, report: { open: false } },
        { id: 'overlay:acme.hud/hud', kind: 'overlay', plugin: 'acme.hud', title: 'Hud', shown: false }
      ]
    }
    daemon.results.set('ui.state', state)
    const printed = (await run(['ui', 'state'])).stdout.trimEnd().split('\n')
    expect(printed.slice(6)).toEqual(['slot overlay:quirky.terminal/floating: Floating {"open":false}'])

    daemon.addUiSlot('overlay', 'quirky.terminal', 'floating', { title: 'Floating', order: 50, module: '/plugins/quirky.terminal/ui.js' })
    const sections = (await run(['ui', 'contributions'])).stdout.trimEnd().split('\n\n')
    expect(sections.map((section) => section.split('\n')[0])).toEqual(['OVERLAYS', 'THEMES'])
    expect(sections[0].split('\n')[2].split(/\s{2,}/)).toEqual([
      'overlay:quirky.terminal/floating',
      'quirky.terminal',
      'Floating',
      '50',
      '/plugins/quirky.terminal/ui.js'
    ])
    expect(JSON.parse((await run(['ui', 'contributions', '--json'])).stdout).overlays).toHaveLength(1)
  })

  test('ui open-view passes the id and the parsed --input', async () => {
    daemon.results.set('ui.view.open', LAYOUT)
    const result = await run(['ui', 'open-view', 'view:quirky.session/worktree', '--input', '{"worktree":"fix-login"}'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('ui.view.open')).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: 'fix-login' } }])
    expect(result.stdout).toContain('view: view:quirky.session/worktree')
    await run(['ui', 'open-view', 'view:acme.x/plain'])
    expect(daemon.methodCalls('ui.view.open')[1]).toEqual({ id: 'view:acme.x/plain' })
  })

  test('the other layout commands call their methods', async () => {
    for (const method of ['ui.view.close', 'ui.panel.open', 'ui.panel.close', 'ui.sidebar.set', 'ui.focus']) {
      daemon.results.set(method, LAYOUT)
    }
    expect((await run(['ui', 'close-view'])).code).toBe(0)
    expect((await run(['ui', 'open-panel', 'panel:quirky.git/source-control'])).code).toBe(0)
    expect((await run(['ui', 'close-panel'])).code).toBe(0)
    expect((await run(['ui', 'sidebar', 'hide'])).code).toBe(0)
    expect((await run(['ui', 'sidebar', 'show'])).code).toBe(0)
    expect((await run(['ui', 'focus', 'panel'])).code).toBe(0)
    expect(daemon.methodCalls('ui.view.close')).toEqual([{}])
    expect(daemon.methodCalls('ui.panel.open')).toEqual([{ id: 'panel:quirky.git/source-control' }])
    expect(daemon.methodCalls('ui.panel.close')).toEqual([{}])
    expect(daemon.methodCalls('ui.sidebar.set')).toEqual([{ visible: false }, { visible: true }])
    expect(daemon.methodCalls('ui.focus')).toEqual([{ target: 'panel' }])
  })

  test('sidebar and focus refuse other words before any call', async () => {
    const sidebar = await run(['ui', 'sidebar', 'sideways'])
    expect(sidebar.code).toBe(2)
    expect(sidebar.stderr).toContain('<state> must be show or hide')
    const focus = await run(['ui', 'focus', 'nowhere'])
    expect(focus.code).toBe(2)
    expect(focus.stderr).toContain('<target> must be one of sidebar, view, panel')
    expect(daemon.calls).toEqual([])
  })

  test('ui run prints the command result generically', async () => {
    daemon.results.set('ui.command.run', { result: 'hello zed' })
    const result = await run(['ui', 'run', 'command:acme.tools/greet', '--args', '{"name":"zed"}'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello zed\n')
    expect(daemon.methodCalls('ui.command.run')).toEqual([{ id: 'command:acme.tools/greet', args: { name: 'zed' } }])
    daemon.results.set('ui.command.run', { result: { ok: true, n: 2 } })
    expect((await run(['ui', 'run', 'command:acme.tools/count'])).stdout).toBe('ok: true\nn: 2\n')
    expect(daemon.methodCalls('ui.command.run')[1]).toEqual({ id: 'command:acme.tools/count' })
  })
})

const INSPECTION: PluginInspection = {
  id: 'acme.tools',
  name: 'Acme tools',
  version: '1.0.0',
  contributions: [
    { kind: 'method', id: 'method:acme.tools/greet', data: {} },
    { kind: 'panel', id: 'panel:acme.tools/notes', data: {} },
    { kind: 'keybinding', id: 'keybinding:acme.tools/open', data: { key: 'mod+shift+n' } }
  ],
  overrides: [{ id: 'panel:quirky.git/source-control', replaces: 'quirky.git' }],
  disables: []
}

const SC49_LISTING = [
  'acme.tools 1.0.0 (Acme tools)',
  'method     method:acme.tools/greet',
  'panel      panel:acme.tools/notes',
  'keybinding keybinding:acme.tools/open  mod+shift+n',
  'override   panel:quirky.git/source-control (replaces quirky.git\'s)'
]

describe('plugin commands', () => {
  let cwd: string
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync('/tmp/qcwd-'))
    daemon.results.set('plugin.inspect', INSPECTION)
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  test('SC-49: plugin inspect prints the listing for a path resolved against the cwd', async () => {
    const result = await run(['plugin', 'inspect', './acme.tools'], { cwd })
    expect(result.code).toBe(0)
    expect(result.stdout.trimEnd().split('\n')).toEqual(SC49_LISTING)
    expect(daemon.methodCalls('plugin.inspect')).toEqual([{ path: join(cwd, 'acme.tools') }])
    expect(JSON.parse((await run(['plugin', 'inspect', './acme.tools', '--json'], { cwd })).stdout)).toEqual(INSPECTION)
  })

  test('SC-51: a reinstall listing shows the version change and the differences', async () => {
    daemon.results.set('plugin.inspect', {
      ...INSPECTION,
      version: '1.1.0',
      installed: { version: '1.0.0', added: ['method:acme.tools/wipe'], removed: ['panel:acme.tools/old'] }
    })
    const lines = (await run(['plugin', 'inspect', './acme.tools'], { cwd })).stdout.trimEnd().split('\n')
    expect(lines[0]).toBe('acme.tools 1.0.0 → 1.1.0 (Acme tools)')
    expect(lines).toContain('+ method:acme.tools/wipe')
    expect(lines).toContain('- panel:acme.tools/old')
  })

  test('SC-50: plugin install prints the listing, then installs', async () => {
    daemon.results.set('plugin.install', { id: 'acme.tools', version: '1.0.0', state: 'inactive' })
    const result = await run(['plugin', 'install', './acme.tools'], { cwd })
    expect(result.code).toBe(0)
    expect(result.stdout.trimEnd().split('\n')).toEqual([...SC49_LISTING, '', 'installed acme.tools 1.0.0'])
    expect(daemon.calls.map((call) => call.method).filter((m) => m.startsWith('plugin.'))).toEqual(['plugin.inspect', 'plugin.install'])
    expect(daemon.methodCalls('plugin.install')).toEqual([{ path: join(cwd, 'acme.tools') }])
  })

  test('plugin install --yes passes yes, and --json prints only the result', async () => {
    daemon.results.set('plugin.install', { id: 'acme.tools', version: '1.0.0', state: 'inactive' })
    const result = await run(['plugin', 'install', './acme.tools', '--yes', '--json'], { cwd })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ id: 'acme.tools', version: '1.0.0', state: 'inactive' })
    expect(daemon.methodCalls('plugin.install')).toEqual([{ path: join(cwd, 'acme.tools'), yes: true }])
  })

  test('plugin uninstall calls plugin.uninstall', async () => {
    daemon.results.set('plugin.uninstall', { ok: true })
    const result = await run(['plugin', 'uninstall', 'acme.tools', '--yes'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('uninstalled acme.tools\n')
    expect(daemon.methodCalls('plugin.uninstall')).toEqual([{ id: 'acme.tools', yes: true }])
  })

  test('install and inspect need a path', async () => {
    expect((await run(['plugin', 'install'])).code).toBe(2)
    expect((await run(['plugin', 'inspect'])).code).toBe(2)
    expect(daemon.calls).toEqual([])
  })
})

const NIGHT: DistroInspection = {
  manifest: {
    id: 'night',
    name: 'Night',
    version: '1.0.0',
    plugins: ['night.extras'],
    disable: ['quirky.git'],
    settings: { 'quirky.terminal/scrollback': 6000 },
    theme: 'theme:night.extras/dusk',
    keybindings: { 'mod+shift+d': 'command:night.extras/palette' }
  },
  plugins: [{ ...INSPECTION, id: 'night.extras', name: 'Night extras', contributions: [{ kind: 'theme', id: 'theme:night.extras/dusk', data: {} }], overrides: [] }],
  settings: [{ id: 'quirky.terminal/scrollback', current: 2000, next: 6000 }]
}

describe('distro commands', () => {
  let cwd: string
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync('/tmp/qcwd-'))
    daemon.results.set('distro.inspect', NIGHT)
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  test('SC-57: distro inspect lists plugins, disables, settings, theme and keybindings', async () => {
    const result = await run(['distro', 'inspect', './night'], { cwd })
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('distro.inspect')).toEqual([{ path: join(cwd, 'night') }])
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      'night 1.0.0 (Night)',
      '',
      'night.extras 1.0.0 (Night extras)',
      'theme theme:night.extras/dusk',
      '',
      'disable    quirky.git',
      'setting    quirky.terminal/scrollback  2000 → 6000',
      'theme      theme:night.extras/dusk',
      'keybinding mod+shift+d  command:night.extras/palette'
    ])
  })


  test('SC-54: distro install prints the listing, then installs', async () => {
    daemon.results.set('distro.install', { id: 'night', name: 'Night', version: '1.0.0', plugins: ['night.extras'], installedAt: 1 })
    const result = await run(['distro', 'install', './night'], { cwd })
    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith('night 1.0.0 (Night)\n')
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe('installed night 1.0.0')
    expect(daemon.methodCalls('distro.install')).toEqual([{ path: join(cwd, 'night') }])
    const yes = await run(['distro', 'install', './night', '--yes'], { cwd })
    expect(yes.code).toBe(0)
    expect(daemon.methodCalls('distro.install')[1]).toEqual({ path: join(cwd, 'night'), yes: true })
  })

  test('distro list and remove', async () => {
    daemon.results.set('distro.list', [{ id: 'night', name: 'Night', version: '1.0.0', plugins: ['night.extras'], installedAt: 1 }])
    const list = await run(['distro', 'list'])
    expect(list.code).toBe(0)
    expect(list.stdout).toContain('night')
    expect(list.stdout).toContain('night.extras')
    expect(JSON.parse((await run(['distro', 'list', '--json'])).stdout)).toHaveLength(1)
    daemon.results.set('distro.remove', { ok: true })
    const removed = await run(['distro', 'remove', 'night', '--yes'])
    expect(removed.stdout).toBe('removed night\n')
    expect(daemon.methodCalls('distro.remove')).toEqual([{ id: 'night', yes: true }])
  })
})

describe('daemon restart', () => {
  const ENTRY = join(import.meta.dir, 'fixtures', 'fake-daemon-entry.ts')
  const startedFile = () => join(daemon.home, 'started.json')
  const started = () => JSON.parse(readFileSync(startedFile(), 'utf8')) as { pid: number; args: string[] }
  let scope: ProcessScope

  beforeEach(() => {
    scope = createProcessScope(daemon.home)
  })

  afterEach(async () => {
    if (existsSync(startedFile())) scope.track(started().pid)
    await scope.cleanup()
  })

  test('stops the daemon, waits for it to go, and starts a new one', async () => {
    const result = await run(['daemon', 'restart'], { env: { ...scope.env, QUIRKY_DAEMON_ENTRY: ENTRY } })
    if (existsSync(startedFile())) scope.track(started().pid)
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('daemon.stop')).toEqual([{}])
    expect(started().args).toEqual([])
    expect(result.stdout).toContain('restarted')
  })

  test('SC-58: --disable-plugins starts the new daemon in safe mode', async () => {
    const result = await run(['daemon', 'restart', '--disable-plugins'], { env: { ...scope.env, QUIRKY_DAEMON_ENTRY: ENTRY } })
    if (existsSync(startedFile())) scope.track(started().pid)
    expect(result.code).toBe(0)
    expect(started().args).toEqual(['--disable-plugins'])
  })
})
