import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import {
  DEFAULT_THEME,
  RpcErrorCode,
  THEME_TOKENS,
  type PluginInfo,
  type QuirkyClient,
  type QuirkyEvent,
  type UiModel
} from '@quirky/protocol'
import { runCli } from '../../../cli/test/fixtures/fake-daemon'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, moduleSource, readMarker, removeTempDirs, writePlugin, type ModuleBehavior } from './fixtures'

type Manifest = { id: string } & Record<string, unknown>

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

/** The error a call rejects with; `.rejects` misreports daemon errors raised in the same process. */
async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

/**
 * A fresh temp home with a temp built-in plugin directory. `start` and `restart` run a real
 * daemon over them; `restart` keeps the same home so stored state and plugin files carry over.
 */
function makeEnv() {
  const home = makeTempHome()
  const builtin = makeTempDir('qd-builtin-')
  const installed = join(home, 'plugins')
  const env = {
    home,
    builtin,
    installed,
    marker: join(makeTempDir('qd-marker-'), 'marker.log'),
    harness: null as Harness | null,
    async start(): Promise<Harness> {
      const harness = await startHarness({ home, builtinPluginsDir: builtin })
      harnesses.push(harness)
      env.harness = harness
      return harness
    },
    async restart(): Promise<Harness> {
      const old = env.harness!
      harnesses.splice(harnesses.indexOf(old), 1)
      for (const client of old.clients) client.close()
      await old.daemon.stop()
      old.pty.stop()
      return env.start()
    },
    cli: (...args: string[]) => runCli(args, { home }),
    /** The CLI's stdout parsed as JSON; fails the test when the command does not exit 0. */
    async cliJson<T>(...args: string[]): Promise<T> {
      const result = await runCli([...args, '--json'], { home })
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      return JSON.parse(result.stdout) as T
    }
  }
  return env
}

type Env = ReturnType<typeof makeEnv>

/** Writes an installed (or built-in, via `root`) plugin whose daemon module records into `marker`. */
function modulePlugin(
  root: string,
  marker: string,
  manifest: Manifest,
  options: { behavior?: ModuleBehavior; files?: Record<string, string> } = {}
): string {
  return writePlugin(
    root,
    { name: manifest.id, version: '1.0.0', main: 'main.ts', ...manifest },
    {
      'main.ts': moduleSource(marker, manifest.id, options.behavior),
      ...(typeof manifest.ui === 'string' ? { [manifest.ui]: uiSource(marker, manifest.id) } : {}),
      ...options.files
    }
  )
}

/** A UI module that records its own import, so a test can prove the daemon never loads it. */
const uiSource = (marker: string, id: string) =>
  `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(marker)}, 'ui import ${id}\\n')\nexport function activate() {}\n`

async function pluginInfo(client: QuirkyClient, id: string): Promise<PluginInfo> {
  return (await client.call('plugin.list', {})).find((plugin) => plugin.id === id)!
}

const warnings = (plugin: PluginInfo) => plugin.diagnostics.filter((item) => item.level === 'warning').map((item) => item.message)

/** The non-header rows of the first table under `header` in the CLI's output, split into cells. */
function tableRows(stdout: string, header: string): string[][] {
  const section = stdout.trimEnd().split('\n\n').find((block) => block.startsWith(`${header}\n`))
  if (!section) throw new Error(`no ${header} table in:\n${stdout}`)
  return section
    .split('\n')
    .slice(2)
    .map((line) => line.split(/\s{2,}/))
}

const notesSetting = 'setting:acme.notes/fontSize'
const fontSize = { id: 'fontSize', type: 'number', title: 'Font size', default: 13, minimum: 8, maximum: 32 }

describe('the UI model', () => {
  test('SC-1: sidebar sections are listed in order, and nothing loads', async () => {
    const env = makeEnv()
    modulePlugin(
      env.installed,
      env.marker,
      {
        id: 'acme.notes',
        ui: 'ui.js',
        contributes: { 'sidebar-section': [{ id: 'list', title: 'Notes', order: 20 }, { id: 'tags', title: 'Tags' }] }
      },
      { files: { 'ui.js': uiSource(env.marker, 'acme.notes') } }
    )
    modulePlugin(
      env.installed,
      env.marker,
      { id: 'acme.files', ui: 'ui.js', contributes: { 'sidebar-section': [{ id: 'tree', title: 'Files', order: 20 }] } },
      { files: { 'ui.js': uiSource(env.marker, 'acme.files') } }
    )
    expect(readMarker(env.marker)).toEqual([])
    await env.start()

    const result = await env.cli('ui', 'contributions')
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(tableRows(result.stdout, 'SIDEBAR')).toEqual([
      ['sidebar-section:acme.files/tree', 'acme.files', 'Files', '20', '/plugins/acme.files/ui.js'],
      ['sidebar-section:acme.notes/list', 'acme.notes', 'Notes', '20', '/plugins/acme.notes/ui.js'],
      ['sidebar-section:acme.notes/tags', 'acme.notes', 'Tags', '100', '/plugins/acme.notes/ui.js']
    ])

    const model = await env.cliJson<UiModel>('ui', 'contributions')
    expect(model.sidebarSections).toEqual([
      { id: 'sidebar-section:acme.files/tree', kind: 'sidebar-section', plugin: 'acme.files', title: 'Files', order: 20, module: '/plugins/acme.files/ui.js' },
      { id: 'sidebar-section:acme.notes/list', kind: 'sidebar-section', plugin: 'acme.notes', title: 'Notes', order: 20, module: '/plugins/acme.notes/ui.js' },
      { id: 'sidebar-section:acme.notes/tags', kind: 'sidebar-section', plugin: 'acme.notes', title: 'Tags', order: 100, module: '/plugins/acme.notes/ui.js' }
    ])
    // neither the UI modules nor the daemon modules have been imported
    expect(readMarker(env.marker)).toEqual([])
  })

  test('SC-2: every UI kind appears in the model', async () => {
    const env = makeEnv()
    modulePlugin(
      env.installed,
      env.marker,
      {
        id: 'acme.notes',
        ui: 'ui.js',
        contributes: {
          'sidebar-section': [{ id: 'list', title: 'Notes', order: 20 }],
          panel: [{ id: 'outline', title: 'Outline', order: 3 }],
          view: [{ id: 'page', title: 'Page' }],
          command: [{ id: 'new', title: 'New note' }],
          keybinding: [{ id: 'new-key', key: 'cmd+shift+n', command: 'new' }],
          setting: [fontSize],
          theme: [{ id: 'solar', title: 'Solar', appearance: 'light', colors: { bg: '#fdf6e3' } }]
        }
      },
      { files: { 'ui.js': uiSource(env.marker, 'acme.notes') } }
    )
    const harness = await env.start()
    const client = await harness.connect()
    const model = await client.call('ui.contributions', {})
    const module = '/plugins/acme.notes/ui.js'

    expect(model.sidebarSections).toMatchObject([{ id: 'sidebar-section:acme.notes/list', title: 'Notes', order: 20, plugin: 'acme.notes', module }])
    expect(model.panels).toMatchObject([{ id: 'panel:acme.notes/outline', title: 'Outline', order: 3, module }])
    expect(model.views).toMatchObject([{ id: 'view:acme.notes/page', title: 'Page', module }])
    expect(model.commands).toMatchObject([{ id: 'command:acme.notes/new', title: 'New note', plugin: 'acme.notes', module }])
    expect(model.keybindings).toEqual([
      { id: 'keybinding:acme.notes/new-key', plugin: 'acme.notes', key: 'mod+shift+n', command: 'command:acme.notes/new', status: 'active' }
    ])
    expect(model.settings).toEqual([{ id: notesSetting, plugin: 'acme.notes', type: 'number', title: 'Font size', default: 13, minimum: 8, maximum: 32 }])

    const solar = model.themes.find((theme) => theme.id === 'theme:acme.notes/solar')!
    expect(solar).toMatchObject({ plugin: 'acme.notes', title: 'Solar', appearance: 'light' })
    expect(Object.keys(solar.colors).sort()).toEqual([...THEME_TOKENS].sort())
    expect(solar.colors.bg).toBe('#fdf6e3')
    expect(solar.colors.text).toBe(DEFAULT_THEME.colors.text)
    expect(model.themes[0]!.id).toBe('default')
    expect(model.modules['acme.notes']!.url).toBe(module)
  })

  test('SC-3: an override replaces a slot\'s contribution and its code', async () => {
    const env = makeEnv()
    modulePlugin(env.builtin, env.marker, {
      id: 'quirky.sample',
      contributes: { 'sidebar-section': [{ id: 'repos', title: 'Repos', order: 10 }] }
    })
    modulePlugin(
      env.installed,
      env.marker,
      {
        id: 'acme.sidebar',
        ui: 'ui.js',
        overrides: [{ id: 'sidebar-section:quirky.sample/repos', title: 'Acme', order: 5 }]
      },
      { files: { 'ui.js': uiSource(env.marker, 'acme.sidebar') } }
    )
    const harness = await env.start()
    const client = await harness.connect()
    const model = await client.call('ui.contributions', {})

    expect(model.sidebarSections).toEqual([
      {
        id: 'sidebar-section:quirky.sample/repos',
        kind: 'sidebar-section',
        plugin: 'acme.sidebar',
        title: 'Acme',
        order: 5,
        module: '/plugins/acme.sidebar/ui.js'
      }
    ])
  })

  describe('SC-5: malformed UI contributions make the plugin invalid', () => {
    const problems: [string, Record<string, unknown>, string][] = [
      ['sidebar section with no title', { contributes: { 'sidebar-section': [{ id: 'list' }] } }, 'sidebar-section list: title is required'],
      ['panel with a string order', { contributes: { panel: [{ id: 'p', title: 'P', order: 'high' }] } }, 'panel p: order must be a number'],
      ['command with an unknown field', { contributes: { command: [{ id: 'go', icon: 'x' }] } }, 'command go: unknown field `icon`'],
      ['keybinding without a modifier', { contributes: { keybinding: [{ id: 'k', key: 'x', command: 'go' }] } }, 'keybinding k: key needs a modifier or a function key'],
      ['keybinding with no final key', { contributes: { keybinding: [{ id: 'k', key: 'mod+shift', command: 'go' }] } }, 'keybinding k: key must end in one key'],
      ['keybinding with no command', { contributes: { keybinding: [{ id: 'k', key: 'mod+k' }] } }, 'keybinding k: command is required'],
      ['number setting with a string default', { contributes: { setting: [{ id: 'size', type: 'number', title: 'Size', default: 'big' }] } }, 'setting size: default must be a number'],
      ['enum setting with no values', { contributes: { setting: [{ id: 'mode', type: 'enum', title: 'Mode', default: 'a' }] } }, 'setting mode: values is required for an enum'],
      ['theme with an unknown color', { contributes: { theme: [{ id: 't', title: 'T', appearance: 'dark', colors: { sparkle: '#ffffff' } }] } }, 'theme t: unknown color `sparkle`'],
      ['theme with a bad appearance', { contributes: { theme: [{ id: 't', title: 'T', appearance: 'blue' }] } }, 'theme t: appearance must be dark or light'],
      ['ui path outside the plugin', { ui: '../x.js' }, "field 'ui' must be a relative path inside the plugin directory"]
    ]

    test('each problem is reported by plugin.list, and the valid plugins work normally', async () => {
      const env = makeEnv()
      problems.forEach(([, manifest], index) => {
        writePlugin(env.installed, { id: `acme.bad${index}`, name: `acme.bad${index}`, version: '1.0.0', ...manifest })
      })
      modulePlugin(env.installed, env.marker, {
        id: 'acme.good',
        contributes: { setting: [{ ...fontSize, id: 'size' }] }
      })
      const harness = await env.start()
      const client = await harness.connect()
      const plugins = await client.call('plugin.list', {})

      for (const [index, [title, , message]] of problems.entries()) {
        const plugin = plugins.find((candidate) => candidate.id === `acme.bad${index}`)
        expect(plugin, title).toBeDefined()
        expect(plugin!.state, title).toBe('invalid')
        expect(plugin!.diagnostics, title).toHaveLength(1)
        expect(plugin!.diagnostics[0]!.level, title).toBe('error')
        // the `ui` diagnostic appends the offending value after the rule
        expect(plugin!.diagnostics[0]!.message.startsWith(message), title).toBe(true)
      }
      expect(plugins.find((plugin) => plugin.id === 'acme.good')!.state).not.toBe('invalid')
      expect((await client.call('setting.get', { id: 'setting:acme.good/size' })).value).toBe(13)
      const model = await client.call('ui.contributions', {})
      expect(model.settings.map((entry) => entry.id)).toEqual(['setting:acme.good/size'])
    })
  })

  test('SC-6: code-backed contributions without a UI module carry a warning, and the setting still works', async () => {
    const env = makeEnv()
    writePlugin(env.installed, {
      id: 'acme.bare',
      name: 'acme.bare',
      version: '1.0.0',
      contributes: { command: [{ id: 'go', title: 'Go' }], setting: [{ id: 'size', type: 'number', title: 'Size', default: 4 }] }
    })
    const harness = await env.start()
    const client = await harness.connect()

    const bare = await pluginInfo(client, 'acme.bare')
    expect(bare.state).not.toBe('invalid')
    expect(warnings(bare)).toEqual(['declares commands, views, panels or sidebar sections but has no ui module'])
    expect(bare.ui).toBeUndefined()

    const model = await client.call('ui.contributions', {})
    expect(model.commands).toMatchObject([{ id: 'command:acme.bare/go', module: null }])
    expect((await client.call('setting.set', { id: 'setting:acme.bare/size', value: 9 })).value).toBe(9)
    expect((await env.cliJson<{ value: number }>('setting', 'get', 'setting:acme.bare/size')).value).toBe(9)
  })
})

describe('commands and keybindings', () => {
  const sampleKeys = (env: Env) =>
    modulePlugin(env.builtin, env.marker, {
      id: 'quirky.sample',
      ui: 'ui.js',
      contributes: {
        command: [{ id: 'sample', title: 'Sample' }],
        keybinding: [{ id: 'k', key: 'mod+k', command: 'sample' }]
      }
    })

  test('SC-16: two keybindings on one chord: one wins, and the other is reported', async () => {
    const env = makeEnv()
    sampleKeys(env)
    modulePlugin(env.installed, env.marker, {
      id: 'acme.keys',
      ui: 'ui.js',
      contributes: {
        command: [{ id: 'keys', title: 'Keys' }],
        keybinding: [{ id: 'k', key: 'mod+k', command: 'keys' }]
      }
    })
    const harness = await env.start()
    const client = await harness.connect()

    const model = await client.call('ui.contributions', {})
    expect(model.keybindings).toEqual([
      { id: 'keybinding:acme.keys/k', plugin: 'acme.keys', key: 'mod+k', command: 'command:acme.keys/keys', status: 'active' },
      {
        id: 'keybinding:quirky.sample/k',
        plugin: 'quirky.sample',
        key: 'mod+k',
        command: 'command:quirky.sample/sample',
        status: 'shadowed',
        shadowedBy: 'keybinding:acme.keys/k'
      }
    ])
    expect(warnings(await pluginInfo(client, 'quirky.sample'))).toEqual([
      'keybinding:quirky.sample/k is shadowed by keybinding:acme.keys/k on mod+k'
    ])
    expect(warnings(await pluginInfo(client, 'acme.keys'))).toEqual([])

    const disabled = await env.cli('plugin', 'disable', 'keybinding:acme.keys/k')
    expect(disabled.code).toBe(0)
    const after = await client.call('ui.contributions', {})
    expect(after.keybindings).toEqual([
      {
        id: 'keybinding:quirky.sample/k',
        plugin: 'quirky.sample',
        key: 'mod+k',
        command: 'command:quirky.sample/sample',
        status: 'active'
      }
    ])
    expect(warnings(await pluginInfo(client, 'quirky.sample'))).toEqual([])
  })

  test('SC-17: the window\'s own shortcuts are reserved', async () => {
    const env = makeEnv()
    modulePlugin(env.installed, env.marker, {
      id: 'acme.keys',
      ui: 'ui.js',
      contributes: {
        command: [{ id: 'term', title: 'Term' }],
        keybinding: [{ id: 't', key: 'mod+t', command: 'term' }]
      }
    })
    const harness = await env.start()
    const client = await harness.connect()

    const model = await client.call('ui.contributions', {})
    expect(model.keybindings).toEqual([
      {
        id: 'keybinding:acme.keys/t',
        plugin: 'acme.keys',
        key: 'mod+t',
        command: 'command:acme.keys/term',
        status: 'shadowed',
        shadowedBy: 'kernel'
      }
    ])
    const [warning] = warnings(await pluginInfo(client, 'acme.keys'))
    expect(warning).toContain('keybinding:acme.keys/t is shadowed by')
    expect(warning).toContain('mod+t')

    const listed = await env.cli('ui', 'contributions')
    expect(tableRows(listed.stdout, 'KEYBINDINGS')).toEqual([
      ['keybinding:acme.keys/t', 'mod+t', 'command:acme.keys/term', 'shadowed by kernel']
    ])
  })

  test('SC-18: a keybinding whose command isn\'t in effect is unbound, and never takes part in a clash', async () => {
    const env = makeEnv()
    sampleKeys(env)
    modulePlugin(env.installed, env.marker, {
      id: 'acme.notes',
      ui: 'ui.js',
      contributes: {
        command: [{ id: 'new', title: 'New note' }],
        keybinding: [{ id: 'new-key', key: 'mod+k', command: 'new' }]
      }
    })
    const harness = await env.start()
    const client = await harness.connect()
    const keybindings = async () => (await client.call('ui.contributions', {})).keybindings

    // before the disable the installed plugin wins the chord
    expect((await keybindings()).map((item) => [item.id, item.status])).toEqual([
      ['keybinding:acme.notes/new-key', 'active'],
      ['keybinding:quirky.sample/k', 'shadowed']
    ])

    const disabled = await env.cli('plugin', 'disable', 'command:acme.notes/new')
    expect(disabled.code).toBe(0)

    // the unbound keybinding drops out, so the lower-precedence working one is active
    expect(await keybindings()).toEqual([
      { id: 'keybinding:acme.notes/new-key', plugin: 'acme.notes', key: 'mod+k', command: 'command:acme.notes/new', status: 'unbound' },
      {
        id: 'keybinding:quirky.sample/k',
        plugin: 'quirky.sample',
        key: 'mod+k',
        command: 'command:quirky.sample/sample',
        status: 'active'
      }
    ])
    expect(warnings(await pluginInfo(client, 'quirky.sample'))).toEqual([])
  })

  test('SC-18: a lone keybinding whose command is disabled stays unbound', async () => {
    const env = makeEnv()
    modulePlugin(env.installed, env.marker, {
      id: 'acme.notes',
      ui: 'ui.js',
      contributes: {
        command: [{ id: 'new', title: 'New note' }],
        keybinding: [{ id: 'new-key', key: 'mod+shift+n', command: 'new' }]
      }
    })
    const harness = await env.start()
    const client = await harness.connect()
    await env.cli('plugin', 'disable', 'command:acme.notes/new')
    const model = await client.call('ui.contributions', {})
    expect(model.commands).toEqual([])
    expect(model.keybindings.map((item) => item.status)).toEqual(['unbound'])
  })
})

describe('settings', () => {
  const writeNotes = (env: Env, setting: Record<string, unknown> = fontSize, extra: Manifest['contributes'] = {}) =>
    modulePlugin(env.installed, env.marker, {
      id: 'acme.notes',
      ui: 'ui.js',
      contributes: { setting: [setting], ...(extra as object) }
    })

  /** Events from a subscribed client that match `type`, kept up to date as they arrive. */
  const eventsOf = (events: QuirkyEvent[], type: string) => events.filter((event) => event.type === type)

  test('SC-19: a setting is read, changed, persisted and reset', async () => {
    const env = makeEnv()
    writeNotes(env)
    let harness = await env.start()
    let { events } = await harness.connectWithEvents()
    const value = async () => JSON.parse((await env.cli('setting', 'get', notesSetting)).stdout)
    const stored = async () => (await (await harness.connect()).call('setting.get', { id: notesSetting })).stored

    expect(await value()).toBe(13)
    expect(await stored()).toBeUndefined()

    const set = await env.cli('setting', 'set', notesSetting, '16')
    expect(set.code).toBe(0)
    expect(set.stdout.trim()).toBe('16')
    await waitFor(() => eventsOf(events, 'setting.changed').length === 1)
    expect(eventsOf(events, 'setting.changed')).toEqual([{ type: 'setting.changed', id: notesSetting, value: 16 }])
    expect(await value()).toBe(16)

    harness = await env.restart()
    ;({ events } = await harness.connectWithEvents())
    expect(await value()).toBe(16)

    const reset = await env.cli('setting', 'reset', notesSetting)
    expect(reset.code).toBe(0)
    expect(reset.stdout.trim()).toBe('13')
    await waitFor(() => eventsOf(events, 'setting.changed').length === 1)
    expect(eventsOf(events, 'setting.changed')).toEqual([{ type: 'setting.changed', id: notesSetting, value: 13 }])
    expect(await value()).toBe(13)
    expect(await stored()).toBeUndefined()

    const listed = await env.cli('setting', 'list')
    expect(listed.stdout).toContain(notesSetting)
  })

  test('SC-20: invalid values are refused', async () => {
    const env = makeEnv()
    writeNotes(env, fontSize, { setting: [fontSize, { id: 'mode', type: 'enum', title: 'Mode', default: 'list', values: ['list', 'grid'] }] })
    const harness = await env.start()
    const client = await harness.connect()
    const modeId = 'setting:acme.notes/mode'
    await client.call('setting.set', { id: notesSetting, value: 16 })
    await client.call('setting.set', { id: modeId, value: 'grid' })

    const rows: [string[], number, string][] = [
      [['setting', 'set', notesSetting, '"big"'], RpcErrorCode.InvalidParams, `${notesSetting} must be a number`],
      [['setting', 'set', notesSetting, '40'], RpcErrorCode.InvalidParams, `${notesSetting} must be at most 32`],
      [['setting', 'set', modeId, 'tiles'], RpcErrorCode.InvalidParams, `${modeId} must be one of list, grid`],
      [['setting', 'set', 'setting:acme.notes/ghost', '1'], RpcErrorCode.NotFound, 'no setting setting:acme.notes/ghost']
    ]
    for (const [args, code, message] of rows) {
      const result = await env.cli(...args)
      expect(result.code, args.join(' ')).not.toBe(0)
      expect(result.stdout, args.join(' ')).toBe('')
      expect(result.stderr, args.join(' ')).toContain(message)
      // the same call straight through the API carries the error code
      const error = await failure(client.callAny('setting.set', { id: args[2], value: args[3] === '"big"' ? 'big' : /^\d+$/.test(args[3]!) ? Number(args[3]) : args[3] }))
      expect(error).toMatchObject({ code, message })
    }

    expect(await client.call('setting.get', { id: notesSetting })).toMatchObject({ value: 16, stored: { value: 16, valid: true } })
    expect(await client.call('setting.get', { id: modeId })).toMatchObject({ value: 'grid', stored: { value: 'grid', valid: true } })
  })

  test('SC-21: a stored value that no longer fits reads as the default, and is kept', async () => {
    const env = makeEnv()
    writeNotes(env)
    let harness = await env.start()
    await (await harness.connect()).call('setting.set', { id: notesSetting, value: 30 })

    writeNotes(env, { ...fontSize, maximum: 24 })
    harness = await env.restart()
    const client = await harness.connect()
    expect(await client.call('setting.get', { id: notesSetting })).toMatchObject({
      value: 13,
      stored: { value: 30, valid: false }
    })
    const listed = await env.cli('setting', 'list')
    expect(listed.stdout).toContain('stored 30 is invalid')

    writeNotes(env, { ...fontSize, maximum: 32 })
    harness = await env.restart()
    expect(await (await harness.connect()).call('setting.get', { id: notesSetting })).toMatchObject({
      value: 30,
      stored: { value: 30, valid: true }
    })
  })

  test('SC-22: settings of a disabled plugin are kept', async () => {
    const env = makeEnv()
    writeNotes(env)
    const harness = await env.start()
    const client = await harness.connect()
    await client.call('setting.set', { id: notesSetting, value: 16 })

    expect((await env.cli('plugin', 'disable', 'acme.notes')).code).toBe(0)
    expect(await client.call('setting.list', {})).toEqual([])
    expect((await env.cli('setting', 'list')).stdout.trim()).toBe('no settings')
    expect((await failure(client.call('setting.get', { id: notesSetting }))).code).toBe(RpcErrorCode.NotFound)

    expect((await env.cli('plugin', 'enable', 'acme.notes')).code).toBe(0)
    expect(await client.call('setting.get', { id: notesSetting })).toMatchObject({ value: 16 })
    expect(JSON.parse((await env.cli('setting', 'get', notesSetting)).stdout)).toBe(16)
  })

  test('SC-23: a daemon plugin reads settings through context.getSetting', async () => {
    const env = makeEnv()
    modulePlugin(
      env.installed,
      env.marker,
      {
        id: 'acme.notes',
        ui: 'ui.js',
        contributes: { setting: [fontSize], method: [{ id: 'size' }, { id: 'other' }, { id: 'ghost' }] }
      },
      {
        behavior: {
          activate: `
            context.provide('method:acme.notes/size', () => context.getSetting('fontSize'))
            context.provide('method:acme.notes/other', () => context.getSetting('setting:acme.files/hidden'))
            context.provide('method:acme.notes/ghost', () => context.getSetting('ghost'))`
        }
      }
    )
    writePlugin(env.installed, {
      id: 'acme.files',
      name: 'acme.files',
      version: '1.0.0',
      contributes: { setting: [{ id: 'hidden', type: 'boolean', title: 'Hidden', default: true }] }
    })
    const harness = await env.start()
    const client = await harness.connect()

    expect(await client.callAny('acme.notes/size', {})).toBe(13)
    await client.call('setting.set', { id: notesSetting, value: 20 })
    expect(await client.callAny('acme.notes/size', {})).toBe(20)

    expect(await client.callAny('acme.notes/other', {})).toBe(true)
    await client.call('setting.set', { id: 'setting:acme.files/hidden', value: false })
    expect(await client.callAny('acme.notes/other', {})).toBe(false)

    const error = await failure(client.callAny('acme.notes/ghost', {}))
    expect(error.message).toContain('no setting setting:acme.notes/ghost')
  })
})

describe('themes', () => {
  const solarId = 'theme:acme.solar/solar'
  const writeSolar = (env: Env) =>
    writePlugin(env.installed, {
      id: 'acme.solar',
      name: 'acme.solar',
      version: '1.0.0',
      contributes: { theme: [{ id: 'solar', title: 'Solar', appearance: 'light', colors: { bg: '#fdf6e3', text: '#657b83' } }] }
    })

  test('SC-25: a theme is listed, chosen and persisted, with missing colors filled in', async () => {
    const env = makeEnv()
    writeSolar(env)
    let harness = await env.start()
    let { events } = await harness.connectWithEvents()

    const before = await env.cli('theme', 'list')
    expect(before.code).toBe(0)
    const rows = before.stdout.trimEnd().split('\n').slice(1).map((line) => line.split(/\s{2,}/))
    expect(rows).toEqual([
      ['default', 'Quirky Dark', 'dark', '*'],
      [solarId, 'Solar', 'light']
    ])

    const set = await env.cli('theme', 'set', solarId)
    expect(set.code).toBe(0)
    expect(set.stdout.trim()).toBe(solarId)
    await waitFor(() => events.find((event) => event.type === 'theme.changed'))
    expect(events.filter((event) => event.type === 'theme.changed')).toEqual([
      { type: 'theme.changed', chosen: solarId, active: solarId }
    ])

    const list = await env.cliJson<{ chosen: string; active: string; themes: { id: string; colors: Record<string, string> }[] }>('theme', 'list')
    expect(list).toMatchObject({ chosen: solarId, active: solarId })
    const solar = list.themes.find((theme) => theme.id === solarId)!
    expect(solar.colors).toEqual({ ...DEFAULT_THEME.colors, bg: '#fdf6e3', text: '#657b83' })
    expect(list.themes[0]!.id).toBe('default')

    harness = await env.restart()
    ;({ events } = await harness.connectWithEvents())
    const afterRestart = await env.cli('theme', 'list')
    expect(afterRestart.stdout.trimEnd().split('\n').slice(1).map((line) => line.split(/\s{2,}/))).toEqual([
      ['default', 'Quirky Dark', 'dark'],
      [solarId, 'Solar', 'light', '*']
    ])

    const back = await env.cli('theme', 'set', 'default')
    expect(back.code).toBe(0)
    expect(back.stdout.trim()).toBe('default')
    await waitFor(() => events.find((event) => event.type === 'theme.changed'))
    expect(events.find((event) => event.type === 'theme.changed')).toEqual({ type: 'theme.changed', chosen: 'default', active: 'default' })
    expect(await (await harness.connect()).call('theme.list', {})).toMatchObject({ chosen: 'default', active: 'default' })
  })

  test('SC-26: a chosen theme that goes away falls back, and comes back', async () => {
    const env = makeEnv()
    writeSolar(env)
    const harness = await env.start()
    const client = await harness.connect()
    await client.call('theme.set', { id: solarId })

    expect((await env.cli('plugin', 'disable', 'acme.solar')).code).toBe(0)
    const disabled = await client.call('theme.list', {})
    expect(disabled).toMatchObject({ chosen: solarId, active: 'default' })
    expect(disabled.themes.map((theme) => theme.id)).toEqual(['default'])
    expect((await client.call('ui.contributions', {})).theme).toEqual({ chosen: solarId, active: 'default' })

    expect((await env.cli('plugin', 'enable', 'acme.solar')).code).toBe(0)
    const enabled = await client.call('theme.list', {})
    expect(enabled).toMatchObject({ chosen: solarId, active: solarId })
    expect(enabled.themes.map((theme) => theme.id)).toEqual(['default', solarId])
  })

  test('SC-27: an unknown theme is refused', async () => {
    const env = makeEnv()
    writeSolar(env)
    const harness = await env.start()
    const client = await harness.connect()
    await client.call('theme.set', { id: solarId })

    const result = await env.cli('theme', 'set', 'theme:acme.ghost/x')
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no theme theme:acme.ghost/x')
    expect(await failure(client.call('theme.set', { id: 'theme:acme.ghost/x' }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no theme theme:acme.ghost/x'
    })
    expect(await client.call('theme.list', {})).toMatchObject({ chosen: solarId, active: solarId })
  })
})

/** One HTTP/1.1 request with the path sent exactly as given, since `fetch` collapses `%2e%2e`. */
function rawRequest(port: number, path: string, method = 'GET'): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let data = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`))
    socket.on('data', (chunk) => (data += chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      const split = data.indexOf('\r\n\r\n')
      const head = data.slice(0, split)
      resolve({ status: Number(head.split(' ')[1]), headers: head.toLowerCase(), body: data.slice(split + 4) })
    })
  })
}

describe('serving plugin UI files', () => {
  test('SC-28: the daemon serves plugin UI files, and only those', async () => {
    const env = makeEnv()
    const outside = makeTempDir('qd-outside-')
    writeFileSync(join(outside, 'leak.js'), 'export const leaked = true\n')
    // the parent of every plugin directory: what `%2e%2e` reaches when it is not refused
    mkdirSync(env.installed, { recursive: true })
    writeFileSync(join(env.installed, 'secret'), 'top secret\n')
    const notes = modulePlugin(
      env.installed,
      env.marker,
      { id: 'acme.notes', ui: 'dist/ui.js', contributes: { command: [{ id: 'new', title: 'New' }] } },
      {
        files: {
          'dist/ui.js': "import './chunk.js'\nexport function activate() {}\n",
          'dist/chunk.js': 'export const chunk = 1\n'
        }
      }
    )
    symlinkSync(join(outside, 'leak.js'), join(notes, 'dist', 'leak.js'))
    symlinkSync(outside, join(notes, 'dist', 'outside'))
    writePlugin(env.installed, { id: 'acme.bare', name: 'acme.bare', version: '1.0.0' }, { 'anything.js': 'export {}\n' })
    writePlugin(
      env.installed,
      { id: 'acme.bad', name: 'acme.bad', version: '1.0.0', ui: 'ui.js', contributes: { command: [{ id: 'go', icon: 'x' }] } },
      { 'ui.js': 'export {}\n' }
    )
    const harness = await env.start()
    const port = harness.runtime.port
    const base = `http://127.0.0.1:${port}`

    expect((await pluginInfoVia(harness, 'acme.bad')).state).toBe('invalid')

    const ui = await fetch(`${base}/plugins/acme.notes/dist/ui.js`)
    expect(ui.status).toBe(200)
    expect(ui.headers.get('content-type')).toContain('text/javascript')
    expect(await ui.text()).toContain("import './chunk.js'")
    const chunk = await fetch(`${base}/plugins/acme.notes/dist/chunk.js`)
    expect(chunk.status).toBe(200)
    expect(chunk.headers.get('content-type')).toContain('text/javascript')
    expect(await chunk.text()).toBe('export const chunk = 1\n')

    const escape = await rawRequest(port, '/plugins/acme.notes/%2e%2e/secret')
    expect(escape.status).toBe(404)
    expect(escape.body).not.toContain('top secret')
    expect((await rawRequest(port, '/plugins/acme.notes/%2E%2E/acme.bare/anything.js')).status).toBe(404)
    expect((await rawRequest(port, '/plugins/acme.notes/../secret')).status).toBe(404)
    expect((await rawRequest(port, '/plugins/acme.notes/dist/%2e%2e/%2e%2e/secret')).status).toBe(404)
    expect((await rawRequest(port, '/plugins/acme.notes/%2e%2e%2fsecret')).status).toBe(404)

    expect((await fetch(`${base}/plugins/acme.bare/anything.js`)).status).toBe(404)
    expect((await fetch(`${base}/plugins/acme.bad/ui.js`)).status).toBe(404)
    expect((await fetch(`${base}/plugins/acme.ghost/ui.js`)).status).toBe(404)

    // a symlink that leaves the plugin directory is not served, as a file or as a directory
    expect((await fetch(`${base}/plugins/acme.notes/dist/leak.js`)).status).toBe(404)
    expect((await fetch(`${base}/plugins/acme.notes/dist/outside/leak.js`)).status).toBe(404)

    const head = await fetch(`${base}/plugins/acme.notes/dist/ui.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toContain('text/javascript')
    expect(await head.text()).toBe('')
    expect((await fetch(`${base}/plugins/acme.ghost/ui.js`, { method: 'HEAD' })).status).toBe(404)
    expect((await rawRequest(port, '/plugins/acme.notes/%2e%2e/secret', 'HEAD')).status).toBe(404)

    // nothing the daemon served ran any plugin code
    expect(readMarker(env.marker)).toEqual([])
    expect(existsSync(env.marker)).toBe(false)
  })
})

async function pluginInfoVia(harness: Harness, id: string): Promise<PluginInfo> {
  return pluginInfo(await harness.connect(), id)
}
