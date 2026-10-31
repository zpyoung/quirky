import { PLUGIN_API_VERSION, type ContributionInfo, type ContributionStatus, type PluginInfo, type PluginSource } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { buildUiModel } from '../../src/plugins/ui-model'
import { checkUiKindEntry } from '../../src/plugins/ui-kinds'

function plugin(id: string, extra: Partial<PluginInfo> = {}, source: PluginSource = 'installed'): PluginInfo {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    source,
    dir: `/plugins/${id}`,
    activation: 'lazy',
    dependencies: [],
    state: 'inactive',
    diagnostics: [],
    ...extra,
  }
}

function decl(
  kind: string,
  owner: string,
  name: string,
  data: Record<string, unknown> = {},
  extra: Partial<ContributionInfo> = {}
): ContributionInfo {
  return {
    id: `${kind}:${owner}/${name}`,
    kind,
    name,
    plugin: owner,
    override: false,
    status: 'effective',
    data,
    ...extra,
  }
}

function build(declarations: ContributionInfo[], plugins: PluginInfo[], chosenTheme = 'default') {
  return buildUiModel({ declarations, plugins, chosenTheme })
}

function withStatus(d: ContributionInfo, status: ContributionStatus): ContributionInfo {
  return { ...d, status }
}

const withUi = (id: string, source: PluginSource = 'installed', extra: Partial<PluginInfo> = {}) =>
  plugin(id, { ui: 'ui.js', ...extra }, source)

describe('slots', () => {
  test('sidebar sections sort by order then id, defaulting order to 100', () => {
    const { model } = build(
      [
        decl('sidebar-section', 'acme.notes', 'tags', { title: 'Tags' }),
        decl('sidebar-section', 'acme.notes', 'list', { title: 'List', order: 20 }),
        decl('sidebar-section', 'acme.files', 'tree', { title: 'Tree', order: 20 }),
      ],
      [withUi('acme.notes'), withUi('acme.files')]
    )
    expect(model.sidebarSections.map((s) => [s.id, s.order])).toEqual([
      ['sidebar-section:acme.files/tree', 20],
      ['sidebar-section:acme.notes/list', 20],
      ['sidebar-section:acme.notes/tags', 100],
    ])
    expect(model.sidebarSections[0]).toEqual({
      id: 'sidebar-section:acme.files/tree',
      kind: 'sidebar-section',
      plugin: 'acme.files',
      title: 'Tree',
      order: 20,
      module: '/plugins/acme.files/ui.js',
    })
  })

  test('status bars sort by order then ID and only effective override owners appear', () => {
    const base = withStatus(decl('status-bar', 'quirky.accounts', 'usage', { title: 'Usage', order: 10 }), 'overridden')
    const override = decl(
      'status-bar',
      'acme.status',
      'usage',
      { title: 'Account', order: 5 },
      { id: 'status-bar:quirky.accounts/usage', override: true }
    )
    const { model } = build(
      [
        base,
        override,
        decl('status-bar', 'acme.zed', 'late', { title: 'Late', order: 20 }),
        decl('status-bar', 'acme.alpha', 'early', { title: 'Early', order: 20 }),
        withStatus(decl('status-bar', 'acme.disabled', 'hidden', { title: 'Hidden' }), 'disabled')
      ],
      [withUi('acme.status'), withUi('acme.zed'), withUi('acme.alpha'), withUi('acme.disabled')]
    )

    expect(model.statusBars.map(({ id, order, plugin }) => [id, order, plugin])).toEqual([
      ['status-bar:quirky.accounts/usage', 5, 'acme.status'],
      ['status-bar:acme.alpha/early', 20, 'acme.alpha'],
      ['status-bar:acme.zed/late', 20, 'acme.zed']
    ])
    expect(model.modules['acme.status']?.provides).toEqual(['status-bar:quirky.accounts/usage'])
    expect(model.modules['quirky.accounts']).toBeUndefined()
  })

  test('panels sort by order then id; views by id with title defaulting to the name', () => {
    const { model } = build(
      [
        decl('panel', 'a.p', 'z', { title: 'Z', order: 1 }),
        decl('panel', 'a.p', 'b', { title: 'B', order: 5 }),
        decl('panel', 'a.p', 'a', { title: 'A', order: 5 }),
        decl('view', 'a.p', 'second'),
        decl('view', 'a.p', 'first', { title: 'First view' }),
      ],
      [withUi('a.p')]
    )
    expect(model.panels.map((p) => p.id)).toEqual(['panel:a.p/z', 'panel:a.p/a', 'panel:a.p/b'])
    expect(model.views.map((v) => [v.id, v.title, v.order, v.kind])).toEqual([
      ['view:a.p/first', 'First view', 100, 'view'],
      ['view:a.p/second', 'second', 100, 'view'],
    ])
  })

  test('overlays sort by order then id and are listed like panels', () => {
    const { model } = build(
      [
        decl('overlay', 'a.p', 'z', { title: 'Z', order: 1 }),
        decl('overlay', 'a.p', 'b', { title: 'B' }),
        decl('overlay', 'a.p', 'a', { title: 'A' }),
        withStatus(decl('overlay', 'a.p', 'off', { title: 'Off' }), 'disabled'),
      ],
      [withUi('a.p')]
    )
    expect(model.overlays).toEqual([
      { id: 'overlay:a.p/z', kind: 'overlay', plugin: 'a.p', title: 'Z', order: 1, module: '/plugins/a.p/ui.js' },
      { id: 'overlay:a.p/a', kind: 'overlay', plugin: 'a.p', title: 'A', order: 100, module: '/plugins/a.p/ui.js' },
      { id: 'overlay:a.p/b', kind: 'overlay', plugin: 'a.p', title: 'B', order: 100, module: '/plugins/a.p/ui.js' },
    ])
    expect(model.modules['a.p'].provides).toEqual(['overlay:a.p/a', 'overlay:a.p/b', 'overlay:a.p/off', 'overlay:a.p/z'])
  })

  test('a model with no overlays lists an empty array', () => {
    expect(build([], []).model.overlays).toEqual([])
  })

  test('commands sort by title then id; title defaults to the name; description is kept only when set', () => {
    const { model } = build(
      [
        decl('command', 'a.p', 'zeta', { title: 'Alpha' }),
        decl('command', 'a.p', 'beta'),
        decl('command', 'a.p', 'alpha', { title: 'Alpha', description: 'Does it' }),
      ],
      [withUi('a.p')]
    )
    expect(model.commands).toEqual([
      {
        id: 'command:a.p/alpha',
        plugin: 'a.p',
        title: 'Alpha',
        description: 'Does it',
        module: '/plugins/a.p/ui.js',
      },
      { id: 'command:a.p/zeta', plugin: 'a.p', title: 'Alpha', module: '/plugins/a.p/ui.js' },
      { id: 'command:a.p/beta', plugin: 'a.p', title: 'beta', module: '/plugins/a.p/ui.js' },
    ])
    expect('description' in model.commands[1]).toBe(false)
  })

  test('declarations that are not effective and other kinds are ignored', () => {
    const { model } = build(
      [
        withStatus(decl('view', 'a.p', 'gone'), 'disabled'),
        withStatus(decl('panel', 'a.p', 'old', { title: 'Old' }), 'overridden'),
        withStatus(decl('command', 'a.p', 'rej'), 'rejected'),
        decl('widget', 'a.p', 'w'),
      ],
      [withUi('a.p')]
    )
    expect(model.views).toEqual([])
    expect(model.panels).toEqual([])
    expect(model.commands).toEqual([])
    expect(model.modules).toEqual({})
  })

  test('a plugin whose ui path cannot be encoded gets a null module without hiding anyone else', () => {
    const { model } = build(
      [
        decl('command', 'a.bad', 'run', { title: 'Run' }),
        decl('setting', 'a.bad', 'size', { type: 'number', title: 'Size', default: 1 }),
        decl('command', 'a.ok', 'go', { title: 'Go' }),
      ],
      [plugin('a.bad', { ui: '\ud800.js' }), withUi('a.ok')]
    )
    expect(model.modules['a.bad']).toBeUndefined()
    expect(Object.keys(model.modules)).toEqual(['a.ok'])
    expect(model.commands.find((c) => c.plugin === 'a.bad')?.module).toBeNull()
    expect(model.commands.find((c) => c.plugin === 'a.ok')?.module).toBe('/plugins/a.ok/ui.js')
    expect(model.settings.map((s) => s.id)).toEqual(['setting:a.bad/size'])
  })

  test('slot without a ui module has a null module', () => {
    const { model } = build([decl('view', 'a.bare', 'v')], [plugin('a.bare')])
    expect(model.views[0].module).toBeNull()
  })
})

describe('contributions shown only while a setting is on', () => {
  const declarations = [
    decl('setting', 'acme.board', 'board-enabled', { type: 'boolean', title: 'Board', default: false }),
    decl('sidebar-section', 'acme.board', 'board', { title: 'Board', whenSetting: 'board-enabled' }),
    decl('sidebar-section', 'acme.board', 'always', { title: 'Always' })
  ]
  const ids = (model: ReturnType<typeof build>['model']) => ({
    sections: model.sidebarSections.map((entry) => entry.id),
    tools: (model.tools ?? []).map((tool) => tool.id).filter((id) => id.startsWith('sidebar-section:'))
  })

  test('a section whose setting is off is neither a section nor a tool', () => {
    const { model } = buildUiModel({ declarations, plugins: [withUi('acme.board')], chosenTheme: 'default', settingValue: (entry) => entry.default })
    expect(ids(model)).toEqual({ sections: ['sidebar-section:acme.board/always'], tools: ['sidebar-section:acme.board/always'] })
    expect(model.visibilitySettings).toEqual(['setting:acme.board/board-enabled'])
  })

  test('the section appears once its setting is on', () => {
    const { model } = buildUiModel({ declarations, plugins: [withUi('acme.board')], chosenTheme: 'default', settingValue: () => true })
    expect(ids(model).sections).toEqual(['sidebar-section:acme.board/always', 'sidebar-section:acme.board/board'])
    expect(ids(model).tools).toContain('sidebar-section:acme.board/board')
  })
})

describe('commands and keybindings shown only while a setting is on', () => {
  const declarations = [
    decl('setting', 'acme.board', 'board-enabled', { type: 'boolean', title: 'Board', default: false }),
    decl('setting', 'acme.board', 'gated', { type: 'boolean', title: 'Gated', default: true, whenSetting: 'board-enabled' }),
    decl('command', 'acme.board', 'open', { title: 'Open board', whenSetting: 'board-enabled' }),
    decl('command', 'acme.board', 'always', { title: 'Always' }),
    decl('keybinding', 'acme.board', 'open-key', { key: 'mod+shift+b', command: 'command:acme.board/open', whenSetting: 'board-enabled' }),
    decl('keybinding', 'acme.board', 'always-key', { key: 'mod+shift+a', command: 'command:acme.board/always' })
  ]
  const model = (value: boolean) =>
    buildUiModel({ declarations, plugins: [withUi('acme.board')], chosenTheme: 'default', settingValue: () => value })

  test('a command and a keybinding whose setting is off leave the model without a warning', () => {
    const { model: off, warnings } = model(false)
    expect(off.commands.map((entry) => entry.id)).toEqual(['command:acme.board/always'])
    expect(off.keybindings.map((entry) => entry.id)).toEqual(['keybinding:acme.board/always-key'])
    expect(warnings.get('acme.board') ?? []).toEqual([])
  })

  test('they appear once the setting is on', () => {
    const { model: on } = model(true)
    expect(on.commands.map((entry) => entry.id)).toEqual(['command:acme.board/always', 'command:acme.board/open'])
    expect(on.keybindings.map((entry) => entry.id).sort()).toEqual(['keybinding:acme.board/always-key', 'keybinding:acme.board/open-key'])
  })

  test('a setting with whenSetting stays in the model and carries the field', () => {
    const { model: off } = model(false)
    expect(off.settings.find((entry) => entry.id === 'setting:acme.board/gated')?.whenSetting).toBe('board-enabled')
    expect(off.visibilitySettings).toEqual(['setting:acme.board/board-enabled'])
  })

  test('without a settingValue source everything is shown', () => {
    const { model: all } = buildUiModel({ declarations, plugins: [withUi('acme.board')], chosenTheme: 'default' })
    expect(all.commands).toHaveLength(2)
    expect(all.keybindings).toHaveLength(2)
  })
})

describe('whenSetting validation on settings, commands and keybindings', () => {
  const entries: Array<[string, Record<string, unknown>]> = [
    ['setting', { id: 'a', type: 'boolean', title: 'A', default: false }],
    ['command', { id: 'a', title: 'A' }],
    ['keybinding', { id: 'a', key: 'mod+b', command: 'command:acme/a' }]
  ]

  test.each(entries)('%s accepts a non-empty whenSetting', (kind, entry) => {
    const errors: string[] = []
    checkUiKindEntry(kind, `${kind} a`, { ...entry, whenSetting: 'enabled' }, errors)
    expect(errors).toEqual([])
  })

  test.each(entries)('%s rejects an empty whenSetting', (kind, entry) => {
    const errors: string[] = []
    checkUiKindEntry(kind, `${kind} a`, { ...entry, whenSetting: '' }, errors)
    expect(errors).toEqual([`${kind} a: whenSetting must be a non-empty string`])
  })
})

describe('override ownership and modules', () => {
  test('an override gives the entry and module to the overriding plugin (SC-3)', () => {
    const base = withStatus(
      decl('sidebar-section', 'quirky.sample', 'repos', { title: 'Repos', order: 10 }),
      'overridden'
    )
    const override = decl(
      'sidebar-section',
      'acme.sidebar',
      'repos',
      { title: 'Acme', order: 5 },
      { id: 'sidebar-section:quirky.sample/repos', override: true }
    )
    const { model } = build(
      [base, override],
      [withUi('quirky.sample', 'builtin'), withUi('acme.sidebar')]
    )
    expect(model.sidebarSections).toEqual([
      {
        id: 'sidebar-section:quirky.sample/repos',
        kind: 'sidebar-section',
        plugin: 'acme.sidebar',
        title: 'Acme',
        order: 5,
        module: '/plugins/acme.sidebar/ui.js',
      },
    ])
    expect(model.modules['acme.sidebar'].provides).toEqual(['sidebar-section:quirky.sample/repos'])
    expect(model.modules['quirky.sample']).toBeUndefined()
  })

  test('module URL normalises the path and encodes each segment', () => {
    const cases: Array<[string, string]> = [
      ['ui.js', '/plugins/a.p/ui.js'],
      ['./dist/ui.js', '/plugins/a.p/dist/ui.js'],
      ['dist\\ui.js', '/plugins/a.p/dist/ui.js'],
      ['./we ird#na?me%.js', '/plugins/a.p/we%20ird%23na%3Fme%25.js'],
      ['sub dir/a#b.js', '/plugins/a.p/sub%20dir/a%23b.js'],
    ]
    for (const [ui, url] of cases) {
      const { model } = build([decl('view', 'a.p', 'v')], [plugin('a.p', { ui })])
      expect(model.modules['a.p'].url).toBe(url)
      expect(model.views[0].module).toBe(url)
    }
  })

  test('provides lists every code-backed declaration of the plugin, whatever its status', () => {
    const { model } = build(
      [
        decl('command', 'a.p', 'run'),
        withStatus(decl('view', 'a.p', 'off'), 'disabled'),
        withStatus(decl('panel', 'a.p', 'lost', { title: 'Lost' }), 'overridden'),
        withStatus(decl('sidebar-section', 'a.p', 'rej', { title: 'R' }), 'rejected'),
        decl('setting', 'a.p', 'size', { type: 'number', title: 'Size', default: 1 }),
        decl('keybinding', 'a.p', 'k', { key: 'mod+k', command: 'run' }),
        decl('command', 'b.q', 'other'),
      ],
      [withUi('a.p'), withUi('b.q')]
    )
    expect(model.modules['a.p'].provides).toEqual([
      'command:a.p/run',
      'panel:a.p/lost',
      'sidebar-section:a.p/rej',
      'view:a.p/off',
    ])
    expect(model.modules['b.q'].provides).toEqual(['command:b.q/other'])
  })

  test('a plugin owning only non-code-backed entries, or only non-effective ones, gets no module', () => {
    const { model, warnings } = build(
      [
        decl('setting', 'a.s', 'size', { type: 'boolean', title: 'S', default: true }),
        withStatus(decl('view', 'a.off', 'v'), 'disabled'),
      ],
      [withUi('a.s'), withUi('a.off')]
    )
    expect(model.modules).toEqual({})
    expect(warnings.size).toBe(0)
  })

  test('a plugin with no ui field has no module even with code-backed entries', () => {
    const { model } = build([decl('command', 'a.bare', 'go')], [plugin('a.bare')])
    expect(model.modules).toEqual({})
    expect(model.commands[0].module).toBeNull()
  })

  test('an invalid duplicate plugin entry does not hide the valid one', () => {
    const { model } = build(
      [decl('view', 'a.p', 'v')],
      [plugin('a.p', { state: 'invalid' }), plugin('a.p', { ui: 'ui.js' }, 'builtin')]
    )
    expect(model.modules['a.p'].url).toBe('/plugins/a.p/ui.js')
  })
})

describe('keybindings', () => {
  const key = (owner: string, name: string, chord: string, command = 'go', extra: Partial<ContributionInfo> = {}) =>
    decl('keybinding', owner, name, { key: chord, command }, extra)

  test('canonicalises the chord and resolves a short command name in the declaring plugin', () => {
    const { model } = build(
      [decl('command', 'a.p', 'go'), key('a.p', 'k', 'Shift+Cmd+K')],
      [withUi('a.p')]
    )
    expect(model.keybindings).toEqual([
      { id: 'keybinding:a.p/k', plugin: 'a.p', key: 'mod+shift+k', command: 'command:a.p/go', status: 'active' },
    ])
  })

  test('a full command ID is kept', () => {
    const { model } = build(
      [decl('command', 'a.p', 'go'), key('b.q', 'k', 'mod+k', 'command:a.p/go')],
      [withUi('a.p'), plugin('b.q')]
    )
    expect(model.keybindings[0]).toMatchObject({ command: 'command:a.p/go', status: 'active' })
  })

  test('an override binds the short name in the overriding plugin namespace', () => {
    const base = withStatus(key('a.p', 'k', 'mod+k'), 'overridden')
    const override = key('b.q', 'k', 'mod+j', 'run', { id: 'keybinding:a.p/k', override: true })
    const { model } = build(
      [base, override, decl('command', 'b.q', 'run')],
      [withUi('a.p'), withUi('b.q')]
    )
    expect(model.keybindings).toEqual([
      { id: 'keybinding:a.p/k', plugin: 'b.q', key: 'mod+j', command: 'command:b.q/run', status: 'active' },
    ])
  })

  test('skips a keybinding whose key does not parse', () => {
    const { model } = build(
      [decl('command', 'a.p', 'go'), key('a.p', 'bad', 'k'), key('a.p', 'good', 'mod+k')],
      [withUi('a.p')]
    )
    expect(model.keybindings.map((k) => k.id)).toEqual(['keybinding:a.p/good'])
  })

  test('keybindings sort by id', () => {
    const { model } = build(
      [decl('command', 'a.p', 'go'), key('a.p', 'z', 'mod+z'), key('a.p', 'a', 'mod+a')],
      [withUi('a.p')]
    )
    expect(model.keybindings.map((k) => k.id)).toEqual(['keybinding:a.p/a', 'keybinding:a.p/z'])
  })

  test('a keybinding whose command is missing or not effective is unbound, with no warning', () => {
    const { model, warnings } = build(
      [
        withStatus(decl('command', 'a.p', 'go'), 'disabled'),
        key('a.p', 'k', 'mod+k'),
        key('a.p', 'ghost', 'mod+g', 'nothing'),
      ],
      [withUi('a.p')]
    )
    expect(model.keybindings.map((k) => [k.id, k.status])).toEqual([
      ['keybinding:a.p/ghost', 'unbound'],
      ['keybinding:a.p/k', 'unbound'],
    ])
    expect(model.keybindings.every((k) => k.shadowedBy === undefined)).toBe(true)
    expect(warnings.size).toBe(0)
  })

  test('unbound drops out before the clash: a working lower-precedence binding wins (SC-18)', () => {
    const { model, warnings } = build(
      [
        withStatus(decl('command', 'acme.notes', 'new'), 'disabled'),
        decl('command', 'quirky.sample', 'open'),
        key('acme.notes', 'new-key', 'mod+shift+n', 'new'),
        key('quirky.sample', 'n', 'mod+shift+n', 'open'),
      ],
      [withUi('acme.notes'), withUi('quirky.sample', 'builtin')]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:acme.notes/new-key'].status).toBe('unbound')
    expect(byId['keybinding:quirky.sample/n'].status).toBe('active')
    expect(warnings.size).toBe(0)
  })

  test('an active conditional dock chord can coexist with the unconditional palette chord', () => {
    const { model, warnings } = build(
      [
        decl('command', 'quirky.palette', 'toggle'),
        decl('command', 'quirky.terminal', 'passthrough'),
        decl('keybinding', 'quirky.palette', 'toggle', { key: 'mod+shift+p', command: 'toggle' }),
        decl('keybinding', 'quirky.terminal', 'passthrough', {
          key: 'mod+shift+p',
          command: 'passthrough',
          when: 'terminalDockMounted && terminalFocus || terminalDockMounted && terminalDockFocus'
        })
      ],
      [withUi('quirky.palette', 'builtin'), withUi('quirky.terminal', 'builtin')]
    )
    const byId = Object.fromEntries(model.keybindings.map((binding) => [binding.id, binding]))
    expect(byId['keybinding:quirky.palette/toggle']).toMatchObject({ status: 'active', key: 'mod+shift+p' })
    expect(byId['keybinding:quirky.terminal/passthrough']).toMatchObject({
      status: 'active',
      key: 'mod+shift+p',
      when: 'terminalDockMounted && terminalFocus || terminalDockMounted && terminalDockFocus'
    })
    expect(warnings.size).toBe(0)
  })

  test('installed beats builtin and the loser carries the warning (SC-16)', () => {
    const { model, warnings } = build(
      [
        decl('command', 'quirky.sample', 'go'),
        decl('command', 'acme.keys', 'go'),
        key('quirky.sample', 'k', 'mod+k'),
        key('acme.keys', 'k', 'mod+k'),
      ],
      [withUi('quirky.sample', 'builtin'), withUi('acme.keys')]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:acme.keys/k'].status).toBe('active')
    expect(byId['keybinding:quirky.sample/k']).toMatchObject({
      status: 'shadowed',
      shadowedBy: 'keybinding:acme.keys/k',
    })
    expect(warnings.get('quirky.sample')).toEqual([
      { level: 'warning', message: 'keybinding:quirky.sample/k is shadowed by keybinding:acme.keys/k on mod+k' },
    ])
    expect(warnings.has('acme.keys')).toBe(false)
  })

  test('with equal sources a dependent beats its dependency, even transitively', () => {
    const plugins = [
      withUi('a.base'),
      withUi('z.mid', 'installed', { dependencies: ['a.base'] }),
      withUi('m.top', 'installed', { dependencies: ['z.mid'] }),
    ]
    const { model } = build(
      [
        decl('command', 'a.base', 'go'),
        decl('command', 'z.mid', 'go'),
        decl('command', 'm.top', 'go'),
        key('a.base', 'k', 'mod+k'),
        key('z.mid', 'k', 'mod+k'),
        key('m.top', 'k', 'mod+k'),
      ],
      plugins
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:m.top/k'].status).toBe('active')
    expect(byId['keybinding:z.mid/k'].shadowedBy).toBe('keybinding:m.top/k')
    expect(byId['keybinding:a.base/k'].shadowedBy).toBe('keybinding:m.top/k')
  })

  test('a dependent beats its dependency even when the dependency sorts first', () => {
    const { model } = build(
      [decl('command', 'a.base', 'go'), decl('command', 'b.app', 'go'), key('a.base', 'k', 'mod+k'), key('b.app', 'k', 'mod+k')],
      [withUi('a.base'), withUi('b.app', 'installed', { dependencies: ['a.base'] })]
    )
    expect(model.keybindings.find((k) => k.status === 'active')?.plugin).toBe('b.app')
  })

  test('among unrelated equals the owner ID that sorts first wins', () => {
    const { model, warnings } = build(
      [decl('command', 'a.one', 'go'), decl('command', 'b.two', 'go'), key('b.two', 'k', 'mod+k'), key('a.one', 'k', 'mod+k')],
      [withUi('a.one'), withUi('b.two')]
    )
    expect(model.keybindings.find((k) => k.status === 'active')?.plugin).toBe('a.one')
    expect(warnings.get('b.two')?.[0].message).toBe('keybinding:b.two/k is shadowed by keybinding:a.one/k on mod+k')
  })

  test('within one plugin the contribution ID that sorts first wins', () => {
    const { model } = build(
      [decl('command', 'a.p', 'go'), key('a.p', 'second', 'mod+k'), key('a.p', 'first', 'mod+k')],
      [withUi('a.p')]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:a.p/first'].status).toBe('active')
    expect(byId['keybinding:a.p/second']).toMatchObject({ status: 'shadowed', shadowedBy: 'keybinding:a.p/first' })
  })

  test('SC-68: the same chord with different when conditions is active in each group', () => {
    const { model, warnings } = build(
      [
        decl('command', 'a.p', 'in-terminal'),
        decl('command', 'a.p', 'elsewhere'),
        decl('keybinding', 'a.p', 'jt', { key: 'mod+j', command: 'in-terminal', when: 'terminalFocus' }),
        decl('keybinding', 'a.p', 'je', { key: 'Cmd+J', command: 'elsewhere', when: '!terminalFocus' }),
      ],
      [withUi('a.p')]
    )
    expect(model.keybindings).toEqual([
      { id: 'keybinding:a.p/je', plugin: 'a.p', key: 'mod+j', command: 'command:a.p/elsewhere', status: 'active', when: '!terminalFocus' },
      { id: 'keybinding:a.p/jt', plugin: 'a.p', key: 'mod+j', command: 'command:a.p/in-terminal', status: 'active', when: 'terminalFocus' },
    ])
    expect(warnings.size).toBe(0)
  })

  test('a binding with a when and one without on the same chord are both active', () => {
    const { model } = build(
      [
        decl('command', 'a.p', 'go'),
        key('a.p', 'plain', 'mod+k'),
        decl('keybinding', 'a.p', 'cond', { key: 'mod+k', command: 'go', when: 'terminalFocus' }),
      ],
      [withUi('a.p')]
    )
    expect(model.keybindings.map((k) => [k.id, k.status, k.when])).toEqual([
      ['keybinding:a.p/cond', 'active', 'terminalFocus'],
      ['keybinding:a.p/plain', 'active', undefined],
    ])
    expect('when' in model.keybindings[1]).toBe(false)
  })

  test('conditions that differ only in spacing or parentheses compete in one group', () => {
    const { model, warnings } = build(
      [
        decl('command', 'a.one', 'go'),
        decl('command', 'b.two', 'go'),
        decl('keybinding', 'a.one', 'k', { key: 'mod+k', command: 'go', when: 'x&&(y)' }),
        decl('keybinding', 'b.two', 'k', { key: 'mod+k', command: 'go', when: 'x  &&  y' }),
      ],
      [withUi('a.one'), withUi('b.two')]
    )
    expect(model.keybindings.map((k) => [k.id, k.status, k.shadowedBy, k.when])).toEqual([
      ['keybinding:a.one/k', 'active', undefined, 'x && y'],
      ['keybinding:b.two/k', 'shadowed', 'keybinding:a.one/k', 'x && y'],
    ])
    expect(warnings.get('b.two')?.[0].message).toBe('keybinding:b.two/k is shadowed by keybinding:a.one/k on mod+k')
  })

  test('installed beats builtin inside a when group only', () => {
    const { model } = build(
      [
        decl('command', 'quirky.sample', 'go'),
        decl('command', 'acme.keys', 'go'),
        decl('keybinding', 'quirky.sample', 'k', { key: 'mod+k', command: 'go', when: 'a' }),
        decl('keybinding', 'quirky.sample', 'other', { key: 'mod+k', command: 'go', when: 'b' }),
        decl('keybinding', 'acme.keys', 'k', { key: 'mod+k', command: 'go', when: 'a' }),
      ],
      [withUi('quirky.sample', 'builtin'), withUi('acme.keys')]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:acme.keys/k'].status).toBe('active')
    expect(byId['keybinding:quirky.sample/k']).toMatchObject({ status: 'shadowed', shadowedBy: 'keybinding:acme.keys/k' })
    expect(byId['keybinding:quirky.sample/other'].status).toBe('active')
  })


  test('an unbound binding with a when drops out of its group before the clash', () => {
    const { model } = build(
      [
        decl('command', 'quirky.sample', 'go'),
        decl('keybinding', 'acme.keys', 'k', { key: 'mod+k', command: 'ghost', when: 'a' }),
        decl('keybinding', 'quirky.sample', 'k', { key: 'mod+k', command: 'go', when: 'a' }),
      ],
      [withUi('quirky.sample', 'builtin'), withUi('acme.keys')]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:acme.keys/k']).toMatchObject({ status: 'unbound', when: 'a' })
    expect(byId['keybinding:quirky.sample/k'].status).toBe('active')
  })

  test('skips a keybinding whose when does not parse', () => {
    const { model } = build(
      [
        decl('command', 'a.p', 'go'),
        decl('keybinding', 'a.p', 'bad', { key: 'mod+k', command: 'go', when: 'a &&' }),
        key('a.p', 'good', 'mod+j'),
      ],
      [withUi('a.p')]
    )
    expect(model.keybindings.map((k) => k.id)).toEqual(['keybinding:a.p/good'])
  })

  test('the keybindings array is ordered by registry precedence: a plugin that beats another comes first', () => {
    const plugins = [
      withUi('a.base'),
      withUi('b.app', 'installed', { dependencies: ['a.base'] }),
      withUi('c.core', 'builtin'),
    ]
    const { model } = build(
      [
        decl('command', 'a.base', 'go'),
        decl('command', 'b.app', 'go'),
        decl('command', 'c.core', 'go'),
        key('c.core', 'a', 'mod+a'),
        key('a.base', 'z', 'mod+z'),
        key('a.base', 'a', 'mod+y'),
        key('b.app', 'k', 'mod+k'),
      ],
      plugins
    )
    // installed outranks builtin; b.app depends on a.base, so b.app comes before it
    expect(model.keybindings.map((k) => k.id)).toEqual([
      'keybinding:b.app/k',
      'keybinding:a.base/a',
      'keybinding:a.base/z',
      'keybinding:c.core/a',
    ])
  })

  test('distro bindings come first in manifest order, shadowed or not', () => {
    const { model } = buildUiModel({
      declarations: [decl('command', 'a.p', 'go'), key('a.p', 'k', 'mod+k'), key('a.p', 'j', 'mod+j')],
      plugins: [withUi('a.p')],
      chosenTheme: 'default',
      distroKeybindings: [
        { key: 'mod+z', command: 'command:a.p/go' },
        { key: 'mod+a', command: 'command:a.p/ghost' },
        { key: 'mod+k', command: 'command:a.p/go' },
      ],
      distroId: 'night',
    })
    expect(model.keybindings.map((k) => [k.id, k.status])).toEqual([
      ['keybinding:night/k1', 'active'],
      ['keybinding:night/k2', 'unbound'],
      ['keybinding:night/k3', 'active'],
      ['keybinding:a.p/j', 'active'],
      ['keybinding:a.p/k', 'shadowed'],
    ])
  })

  test('installed beats builtin before the dependency rule is considered', () => {
    const { model } = build(
      [decl('command', 'a.core', 'go'), decl('command', 'b.ext', 'go'), key('a.core', 'k', 'mod+k'), key('b.ext', 'k', 'mod+k')],
      [withUi('a.core', 'builtin', { dependencies: ['b.ext'] }), withUi('b.ext')]
    )
    expect(model.keybindings.find((k) => k.status === 'active')?.plugin).toBe('b.ext')
  })
})

describe('warnings', () => {
  test('a plugin with effective code-backed entries and no ui is warned once (SC-6)', () => {
    const { warnings } = build(
      [
        decl('command', 'acme.bare', 'go'),
        decl('view', 'acme.bare', 'v'),
        decl('setting', 'acme.bare', 'size', { type: 'number', title: 'Size', default: 1 }),
      ],
      [plugin('acme.bare')]
    )
    expect(warnings.get('acme.bare')).toHaveLength(1)
  })

  test('a plugin whose only code-backed entry is an overlay and has no ui is warned', () => {
    const { warnings } = build([decl('overlay', 'acme.bare', 'o', { title: 'O' })], [plugin('acme.bare')])
    expect(warnings.get('acme.bare')).toHaveLength(1)
  })

  test('a plugin with a ui module gets no missing-module warning', () => {
    const { warnings } = build([decl('command', 'a.p', 'go')], [withUi('a.p')])
    expect(warnings.size).toBe(0)
  })
})

describe('themes', () => {

  test('a disabled theme is not listed', () => {
    const { model } = build(
      [withStatus(decl('theme', 'acme.solar', 'solar', { title: 'Solar', appearance: 'light' }), 'disabled')],
      [plugin('acme.solar')]
    )
    expect(model.themes.some((theme) => theme.id === 'theme:acme.solar/solar')).toBe(false)
  })

  test('active is the chosen built-in or effective theme, else the default (SC-26)', () => {
    const solar = decl('theme', 'acme.solar', 'solar', { title: 'Solar', appearance: 'light' })
    const plugins = [plugin('acme.solar')]
    for (const id of ['default', 'dark', 'light']) {
      expect(build([solar], plugins, id).model.theme).toEqual({ chosen: id, active: id })
    }
    expect(build([solar], plugins, solar.id).model.theme).toEqual({ chosen: solar.id, active: solar.id })
    expect(build([withStatus(solar, 'disabled')], plugins, solar.id).model.theme).toEqual({
      chosen: solar.id,
      active: 'default',
    })
    expect(build([], plugins, 'theme:acme.ghost/x').model.theme).toEqual({
      chosen: 'theme:acme.ghost/x',
      active: 'default',
    })
  })
})

describe('settings', () => {
  test('each effective setting is listed by id with its declaration', () => {
    const { model } = build(
      [
        decl('setting', 'a.p', 'size', { type: 'number', title: 'Size', description: 'How big', default: 3, minimum: 1, maximum: 9 }),
        decl('setting', 'a.p', 'mode', { type: 'enum', title: 'Mode', default: 'x', values: ['x', 'y'] }),
        withStatus(decl('setting', 'a.p', 'off', { type: 'boolean', title: 'Off', default: false }), 'disabled'),
      ],
      [plugin('a.p')]
    )
    expect(model.settings).toMatchObject([
      { id: 'setting:a.p/mode', plugin: 'a.p', type: 'enum', title: 'Mode', default: 'x', values: ['x', 'y'] },
      {
        id: 'setting:a.p/size',
        plugin: 'a.p',
        type: 'number',
        title: 'Size',
        description: 'How big',
        default: 3,
        minimum: 1,
        maximum: 9,
      },
    ])
  })

  test('an overriding plugin owns the setting entry', () => {
    const override = decl(
      'setting',
      'b.q',
      'size',
      { type: 'number', title: 'Size', default: 7 },
      { id: 'setting:a.p/size', override: true }
    )
    const { model } = build(
      [withStatus(decl('setting', 'a.p', 'size', { type: 'number', title: 'Size', default: 1 }), 'overridden'), override],
      [plugin('a.p'), plugin('b.q')]
    )
    expect(model.settings).toMatchObject([
      { id: 'setting:a.p/size', plugin: 'b.q', type: 'number', title: 'Size', default: 7 },
    ])
  })
})

describe('distro keybindings', () => {
  const key = (owner: string, name: string, chord: string, command = 'go') =>
    decl('keybinding', owner, name, { key: chord, command })
  const withDistro = (
    declarations: ContributionInfo[],
    plugins: PluginInfo[],
    distroKeybindings: { key: string; command: string }[]
  ) => buildUiModel({ declarations, plugins, chosenTheme: 'default', distroKeybindings, distroId: 'night' })

  test('gets the ID keybinding:<distro>/k<n> in manifest order and plugin <distro>', () => {
    const { model } = withDistro(
      [decl('command', 'a.p', 'go'), decl('command', 'a.p', 'stop')],
      [withUi('a.p')],
      [
        { key: 'mod+shift+d', command: 'command:a.p/go' },
        { key: 'mod+shift+s', command: 'command:a.p/stop' },
      ]
    )
    expect(model.keybindings).toEqual([
      { id: 'keybinding:night/k1', plugin: 'night', key: 'mod+shift+d', command: 'command:a.p/go', status: 'active' },
      { id: 'keybinding:night/k2', plugin: 'night', key: 'mod+shift+s', command: 'command:a.p/stop', status: 'active' },
    ])
  })

  test('beats an installed plugin and a builtin on its chord, and the losers carry a warning', () => {
    const { model, warnings } = withDistro(
      [
        decl('command', 'quirky.sample', 'go'),
        decl('command', 'acme.keys', 'go'),
        key('quirky.sample', 'k', 'mod+k'),
        key('acme.keys', 'k', 'mod+k'),
      ],
      [withUi('quirky.sample', 'builtin'), withUi('acme.keys')],
      [{ key: 'mod+k', command: 'command:acme.keys/go' }]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:night/k1'].status).toBe('active')
    expect(byId['keybinding:acme.keys/k']).toMatchObject({ status: 'shadowed', shadowedBy: 'keybinding:night/k1' })
    expect(byId['keybinding:quirky.sample/k']).toMatchObject({ status: 'shadowed', shadowedBy: 'keybinding:night/k1' })
    expect(warnings.get('acme.keys')?.[0].message).toBe('keybinding:acme.keys/k is shadowed by keybinding:night/k1 on mod+k')
  })

  test('a distro binding normally overrides the unconditional palette binding', () => {
    const { model } = withDistro(
      [
        decl('command', 'quirky.palette', 'toggle'),
        decl('command', 'a.p', 'go'),
        key('quirky.palette', 'toggle', 'mod+shift+p', 'toggle')
      ],
      [withUi('quirky.palette', 'builtin'), withUi('a.p')],
      [{ key: 'mod+shift+p', command: 'command:a.p/go' }]
    )
    expect(model.keybindings).toContainEqual({
      id: 'keybinding:quirky.palette/toggle',
      plugin: 'quirky.palette',
      key: 'mod+shift+p',
      command: 'command:quirky.palette/toggle',
      status: 'shadowed',
      shadowedBy: 'keybinding:night/k1'
    })
    expect(model.keybindings).toContainEqual({
      id: 'keybinding:night/k1',
      plugin: 'night',
      key: 'mod+shift+p',
      command: 'command:a.p/go',
      status: 'active'
    })
  })

  test('a command that is not effective leaves it unbound and does not shadow others', () => {
    const { model } = withDistro(
      [decl('command', 'a.p', 'go'), key('a.p', 'k', 'mod+k')],
      [withUi('a.p')],
      [{ key: 'mod+k', command: 'command:a.p/ghost' }]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:night/k1'].status).toBe('unbound')
    expect(byId['keybinding:a.p/k'].status).toBe('active')
  })

  test('SC-68: a distro binding shadows only the unconditional group on its chord', () => {
    const { model, warnings } = withDistro(
      [
        decl('command', 'a.p', 'go'),
        key('a.p', 'plain', 'mod+k'),
        decl('keybinding', 'a.p', 'cond', { key: 'mod+k', command: 'go', when: 'terminalFocus' }),
      ],
      [withUi('a.p')],
      [{ key: 'mod+k', command: 'command:a.p/go' }]
    )
    const byId = Object.fromEntries(model.keybindings.map((k) => [k.id, k]))
    expect(byId['keybinding:night/k1'].status).toBe('active')
    expect(byId['keybinding:a.p/plain']).toMatchObject({ status: 'shadowed', shadowedBy: 'keybinding:night/k1' })
    expect(byId['keybinding:a.p/cond']).toMatchObject({ status: 'active', when: 'terminalFocus' })
    expect(warnings.get('a.p')).toHaveLength(1)
  })

  test('without distro input the model is unchanged', () => {
    const { model } = build([decl('command', 'a.p', 'go'), key('a.p', 'k', 'mod+k')], [withUi('a.p')])
    expect(model.keybindings.map((k) => k.id)).toEqual(['keybinding:a.p/k'])
    const empty = withDistro([decl('command', 'a.p', 'go')], [withUi('a.p')], [])
    expect(empty.model.keybindings).toEqual([])
  })
})

test('user-remapped distro collisions retain both bindings and expose the deterministic winner', () => {
  const { model } = buildUiModel({
    declarations: [decl('command', 'acme.keys', 'first'), decl('command', 'acme.keys', 'second')],
    plugins: [withUi('acme.keys')],
    chosenTheme: 'default',
    distroId: 'night',
    distroKeybindings: [
      { key: 'mod+k', command: 'command:acme.keys/first' },
      { key: 'mod+j', command: 'command:acme.keys/second' }
    ],
    keybindingOverrides: { 'keybinding:night/k1': 'mod+j' }
  })
  expect(model.keybindings.map(({ id, key, status, shadowedBy }) => ({ id, key, status, shadowedBy }))).toEqual([
    { id: 'keybinding:night/k1', key: 'mod+j', status: 'active', shadowedBy: undefined },
    { id: 'keybinding:night/k2', key: 'mod+j', status: 'shadowed', shadowedBy: 'keybinding:night/k1' }
  ])
})
