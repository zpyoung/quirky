import { PLUGIN_API_VERSION, type PluginManifest, type PluginSource } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import type { DiscoveredPlugin } from '../../src/plugins/discover'
import { computeRegistry } from '../../src/plugins/registry'

function plugin(id: string, extra: Partial<PluginManifest> = {}, source: PluginSource = 'installed'): DiscoveredPlugin {
  return {
    id,
    dir: `/plugins/${id}`,
    source,
    manifest: { id, name: id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, ...extra },
    errors: [],
  }
}

function broken(id: string, errors: string[] = ['bad manifest'], source: PluginSource = 'installed'): DiscoveredPlugin {
  return { id, dir: `/plugins/${id}`, source, manifest: null, errors }
}

function compute(plugins: DiscoveredPlugin[], disabled: string[] = []) {
  return computeRegistry(plugins, new Set(disabled))
}

function entry(registry: ReturnType<typeof compute>, id: string, source?: PluginSource) {
  const found = registry.entries.find((e) => e.discovered.id === id && (!source || e.discovered.source === source))
  if (!found) throw new Error(`no entry ${id}`)
  return found
}

function declaration(registry: ReturnType<typeof compute>, id: string, pluginId: string) {
  const found = registry.declarations.find((d) => d.id === id && d.plugin === pluginId)
  if (!found) throw new Error(`no declaration ${id} from ${pluginId}`)
  return found
}

const cmd = (name: string, extra: object = {}) => ({ command: [{ id: name, ...extra }] })

describe('computeRegistry: declarations', () => {
  test('contributions and overrides become declarations with data minus id', () => {
    const registry = compute([
      plugin('base', { contributes: cmd('run', { title: 'Run', keys: ['a'] }) }),
      plugin('over', { overrides: [{ id: 'command:base/run', title: 'Better' }] }),
    ])
    expect(declaration(registry, 'command:base/run', 'base')).toEqual({
      id: 'command:base/run',
      kind: 'command',
      name: 'run',
      plugin: 'base',
      override: false,
      status: 'overridden',
      overriddenBy: 'over',
      data: { title: 'Run', keys: ['a'] },
    })
    expect(registry.effective.get('command:base/run')).toEqual({
      id: 'command:base/run',
      kind: 'command',
      name: 'run',
      plugin: 'over',
      override: true,
      status: 'effective',
      data: { title: 'Better' },
    })
  })

  test('a plain contribution is effective', () => {
    const registry = compute([plugin('a', { contributes: cmd('go', { title: 'Go' }) })])
    expect(registry.effective.get('command:a/go')?.status).toBe('effective')
    expect(registry.declarations).toHaveLength(1)
  })

  test('declarations are sorted by id then plugin', () => {
    const registry = compute([
      plugin('b', { contributes: cmd('x') }),
      plugin('a', { contributes: { panel: [{ id: 'y', title: 'Y' }], command: [{ id: 'z' }] } }),
    ])
    expect(registry.declarations.map((d) => d.id)).toEqual(['command:a/z', 'command:b/x', 'panel:a/y'])
  })

  test('entries are sorted by id with built-in before installed, and plugins maps the usable entry', () => {
    const registry = compute([
      plugin('zed'),
      broken('quirky.core', ['duplicates the built-in plugin quirky.core'], 'installed'),
      plugin('quirky.core', {}, 'builtin'),
      plugin('alpha'),
    ])
    expect(registry.entries.map((e) => `${e.discovered.source}:${e.discovered.id}`)).toEqual([
      'installed:alpha',
      'builtin:quirky.core',
      'installed:quirky.core',
      'installed:zed',
    ])
    expect(registry.plugins.get('quirky.core')?.discovered.source).toBe('builtin')
    expect(registry.plugins.get('quirky.core')?.status).toBe('enabled')
    expect(entry(registry, 'quirky.core', 'installed').status).toBe('invalid')
  })
})

describe('computeRegistry: invalid plugins', () => {
  test('a plugin with load errors is invalid with error diagnostics and declares nothing', () => {
    const registry = compute([broken('bad', ['one', 'two'])])
    const bad = entry(registry, 'bad')
    expect(bad.status).toBe('invalid')
    expect(bad.diagnostics).toEqual([
      { level: 'error', message: 'one' },
      { level: 'error', message: 'two' },
    ])
    expect(registry.declarations).toEqual([])
  })

  test('a missing dependency makes the plugin invalid', () => {
    const registry = compute([plugin('a', { dependencies: ['ghost'] })])
    expect(entry(registry, 'a').status).toBe('invalid')
    expect(entry(registry, 'a').diagnostics).toEqual([{ level: 'error', message: 'dependency ghost is not installed' }])
  })

  test('a dependency on an invalid plugin makes the plugin invalid', () => {
    const registry = compute([broken('bad'), plugin('a', { dependencies: ['bad'] })])
    expect(entry(registry, 'a').status).toBe('invalid')
    expect(entry(registry, 'a').diagnostics).toEqual([{ level: 'error', message: 'dependency bad is invalid' }])
  })

  test('invalidity propagates down a chain', () => {
    const registry = compute([
      broken('bad'),
      plugin('a', { dependencies: ['bad'] }),
      plugin('b', { dependencies: ['a'] }),
    ])
    expect(entry(registry, 'b').status).toBe('invalid')
    expect(entry(registry, 'b').diagnostics).toEqual([{ level: 'error', message: 'dependency a is invalid' }])
  })

  test('both members of a two-plugin cycle are invalid with the sorted cycle', () => {
    const registry = compute([plugin('b', { dependencies: ['a'] }), plugin('a', { dependencies: ['b'] })])
    for (const id of ['a', 'b']) {
      expect(entry(registry, id).status).toBe('invalid')
      expect(entry(registry, id).diagnostics).toEqual([{ level: 'error', message: 'dependency cycle: a, b' }])
    }
  })

  test('a plugin depending on a cycle member is invalid because the member is invalid', () => {
    const registry = compute([
      plugin('a', { dependencies: ['b'] }),
      plugin('b', { dependencies: ['a'] }),
      plugin('c', { dependencies: ['a'] }),
    ])
    expect(entry(registry, 'c').status).toBe('invalid')
    expect(entry(registry, 'c').diagnostics).toEqual([{ level: 'error', message: 'dependency a is invalid' }])
  })

  test('a three-plugin cycle is reported once, sorted', () => {
    const registry = compute([
      plugin('c', { dependencies: ['a'] }),
      plugin('a', { dependencies: ['b'] }),
      plugin('b', { dependencies: ['c'] }),
    ])
    expect(entry(registry, 'b').diagnostics).toEqual([{ level: 'error', message: 'dependency cycle: a, b, c' }])
  })

  test('invalid plugins contribute nothing and invalid duplicates stay out of plugins', () => {
    const registry = compute([plugin('a', { contributes: cmd('x'), dependencies: ['ghost'] })])
    expect(registry.declarations).toEqual([])
    expect(registry.effective.size).toBe(0)
    expect(registry.plugins.get('a')?.status).toBe('invalid')
  })
})

describe('computeRegistry: disabled plugins', () => {
  test('a user-disabled plugin is disabled with its declarations marked owner', () => {
    const registry = compute([plugin('a', { contributes: cmd('x') })], ['a'])
    expect(entry(registry, 'a').status).toBe('disabled')
    expect(entry(registry, 'a').diagnostics).toEqual([{ level: 'error', message: 'disabled by the user' }])
    const d = declaration(registry, 'command:a/x', 'a')
    expect(d.status).toBe('disabled')
    expect(d.disabledBy).toBe('owner')
    expect(registry.effective.size).toBe(0)
  })

  test('a declaration of a disabled plugin is attributed to the owner even when its ID is also disabled', () => {
    const registry = compute([plugin('a', { contributes: cmd('run') })], ['a', 'command:a/run'])
    expect(declaration(registry, 'command:a/run', 'a')).toMatchObject({ status: 'disabled', disabledBy: 'owner' })
  })

  test('disabling cascades to dependents transitively', () => {
    const registry = compute(
      [plugin('a'), plugin('b', { dependencies: ['a'] }), plugin('c', { dependencies: ['b'] }), plugin('d')],
      ['a'],
    )
    expect(entry(registry, 'b').status).toBe('disabled')
    expect(entry(registry, 'b').diagnostics).toEqual([{ level: 'error', message: 'dependency a is disabled' }])
    expect(entry(registry, 'c').diagnostics).toEqual([{ level: 'error', message: 'dependency b is disabled' }])
    expect(entry(registry, 'd').status).toBe('enabled')
  })

  test('an invalid plugin stays invalid when its ID is in the disabled set', () => {
    const registry = compute([broken('bad')], ['bad'])
    expect(entry(registry, 'bad').status).toBe('invalid')
  })
})

describe('computeRegistry: disabled contributions', () => {
  test('a user-disabled contribution is disabled by user', () => {
    const registry = compute([plugin('a', { contributes: cmd('x') })], ['command:a/x'])
    const d = declaration(registry, 'command:a/x', 'a')
    expect(d.status).toBe('disabled')
    expect(d.disabledBy).toBe('user')
    expect(registry.effective.has('command:a/x')).toBe(false)
  })

  test("an enabled plugin's disables list switches contributions off, lowest plugin wins the attribution", () => {
    const registry = compute([
      plugin('a', { contributes: cmd('x') }),
      plugin('z', { disables: ['command:a/x'] }),
      plugin('m', { disables: ['command:a/x'] }),
    ])
    const d = declaration(registry, 'command:a/x', 'a')
    expect(d).toMatchObject({ status: 'disabled', disabledBy: 'plugin', disablingPlugin: 'm' })
  })

  test('the disables list stops applying when its plugin is disabled', () => {
    const plugins = [plugin('a', { contributes: cmd('x') }), plugin('z', { disables: ['command:a/x'] })]
    const registry = compute(plugins, ['z'])
    expect(declaration(registry, 'command:a/x', 'a').status).toBe('effective')
  })

  test('the disables list of an invalid plugin does not apply', () => {
    const plugins = [plugin('a', { contributes: cmd('x') }), plugin('z', { disables: ['command:a/x'], dependencies: ['ghost'] })]
    expect(declaration(compute(plugins), 'command:a/x', 'a').status).toBe('effective')
  })

  test('the user wins over a plugin in the attribution', () => {
    const registry = compute(
      [plugin('a', { contributes: cmd('x') }), plugin('z', { disables: ['command:a/x'] })],
      ['command:a/x'],
    )
    expect(declaration(registry, 'command:a/x', 'a')).toMatchObject({ status: 'disabled', disabledBy: 'user' })
    expect(declaration(registry, 'command:a/x', 'a').disablingPlugin).toBeUndefined()
  })

  test('disabled beats override: every declaration of the ID is disabled', () => {
    const registry = compute(
      [plugin('base', { contributes: cmd('run') }), plugin('over', { overrides: [{ id: 'command:base/run' }] })],
      ['command:base/run'],
    )
    expect(declaration(registry, 'command:base/run', 'base').status).toBe('disabled')
    expect(declaration(registry, 'command:base/run', 'over')).toMatchObject({ status: 'disabled', disabledBy: 'user' })
    expect(registry.effective.size).toBe(0)
  })
})

describe('computeRegistry: overrides', () => {
  const baseWith = (source: PluginSource = 'installed') => plugin('base', { contributes: cmd('run') }, source)
  const over = (id: string, extra: Partial<PluginManifest> = {}, source: PluginSource = 'installed') =>
    plugin(id, { overrides: [{ id: 'command:base/run', from: id }], ...extra }, source)

  test('an override beats the base', () => {
    const registry = compute([baseWith(), over('o')])
    expect(registry.effective.get('command:base/run')?.plugin).toBe('o')
    expect(declaration(registry, 'command:base/run', 'base')).toMatchObject({ status: 'overridden', overriddenBy: 'o' })
  })

  test('an installed override beats a built-in override even when the built-in ID sorts first', () => {
    const registry = compute([
      baseWith('builtin'),
      over('quirky.alpha', {}, 'builtin'),
      over('zzz', {}, 'installed'),
    ])
    expect(registry.effective.get('command:base/run')?.plugin).toBe('zzz')
    expect(declaration(registry, 'command:base/run', 'quirky.alpha')).toMatchObject({
      status: 'overridden',
      overriddenBy: 'zzz',
    })
    expect(entry(registry, 'quirky.alpha').diagnostics).toEqual([])
  })

  test('a dependent override beats the override of its dependency', () => {
    const registry = compute([
      baseWith(),
      over('aaa'),
      over('zzz', { dependencies: ['aaa'] }),
    ])
    expect(registry.effective.get('command:base/run')?.plugin).toBe('zzz')
    expect(declaration(registry, 'command:base/run', 'aaa').status).toBe('overridden')
  })

  test('a transitive dependent override beats the override it depends on indirectly', () => {
    const registry = compute([
      baseWith(),
      over('aaa'),
      plugin('mid', { dependencies: ['aaa'] }),
      over('zzz', { dependencies: ['mid'] }),
    ])
    expect(registry.effective.get('command:base/run')?.plugin).toBe('zzz')
  })

  test('two independent overrides: the lowest plugin ID wins and the other is rejected with a warning', () => {
    const registry = compute([baseWith(), over('bbb'), over('aaa')])
    expect(registry.effective.get('command:base/run')?.plugin).toBe('aaa')
    expect(declaration(registry, 'command:base/run', 'bbb')).toMatchObject({
      status: 'rejected',
      conflictWith: 'aaa',
    })
    expect(declaration(registry, 'command:base/run', 'base')).toMatchObject({ status: 'overridden', overriddenBy: 'aaa' })
    expect(entry(registry, 'bbb').diagnostics).toEqual([
      { level: 'warning', message: 'override of command:base/run conflicts with aaa' },
    ])
    expect(entry(registry, 'aaa').diagnostics).toEqual([])
    expect(entry(registry, 'bbb').status).toBe('enabled')
  })

  test('a non-maximal override is overridden, not rejected', () => {
    const registry = compute([baseWith(), over('aaa'), over('mmm', { dependencies: ['aaa'] }), over('bbb')])
    expect(registry.effective.get('command:base/run')?.plugin).toBe('bbb')
    expect(declaration(registry, 'command:base/run', 'aaa').status).toBe('overridden')
    expect(declaration(registry, 'command:base/run', 'mmm')).toMatchObject({ status: 'rejected', conflictWith: 'bbb' })
  })

  test('an override of nothing gets a warning when the namespace plugin is enabled', () => {
    const registry = compute([plugin('base'), plugin('o', { overrides: [{ id: 'command:base/run' }] })])
    expect(entry(registry, 'o').diagnostics).toEqual([
      { level: 'warning', message: 'override of command:base/run replaces nothing' },
    ])
    expect(registry.effective.get('command:base/run')?.plugin).toBe('o')
  })

  test('an override of a plugin that is not discovered at all gets the warning', () => {
    const registry = compute([plugin('o', { overrides: [{ id: 'command:ghost/run' }] })])
    expect(entry(registry, 'o').diagnostics).toEqual([
      { level: 'warning', message: 'override of command:ghost/run replaces nothing' },
    ])
  })

  test('no warning when the override target plugin is disabled', () => {
    const registry = compute([plugin('base'), plugin('o', { overrides: [{ id: 'command:base/run' }] })], ['base'])
    expect(entry(registry, 'o').diagnostics).toEqual([])
  })

  test('no warning when the override target plugin is invalid', () => {
    const registry = compute([broken('base'), plugin('o', { overrides: [{ id: 'command:base/run' }] })])
    expect(entry(registry, 'o').diagnostics).toEqual([])
  })

  test('no warning when the base exists', () => {
    const registry = compute([baseWith(), over('o')])
    expect(entry(registry, 'o').diagnostics).toEqual([])
  })

  test('declarations of a disabled plugin report disabledBy owner and stay out of the contest', () => {
    const registry = compute([baseWith(), over('o')], ['o'])
    expect(declaration(registry, 'command:base/run', 'o')).toMatchObject({ status: 'disabled', disabledBy: 'owner' })
    expect(registry.effective.get('command:base/run')?.plugin).toBe('base')
  })
})

describe('computeRegistry: determinism', () => {
  const plugins = [
    plugin('quirky.core', { contributes: cmd('run') }, 'builtin'),
    plugin('quirky.over', { overrides: [{ id: 'command:quirky.core/run' }] }, 'builtin'),
    broken('quirky.core', ['duplicates the built-in plugin quirky.core']),
    plugin('o1', { overrides: [{ id: 'command:quirky.core/run', n: 1 }] }),
    plugin('o2', { overrides: [{ id: 'command:quirky.core/run', n: 2 }], dependencies: ['dep'] }),
    plugin('dep', { disables: ['command:quirky.core/other'] }),
    plugin('quirky.other', {}, 'builtin'),
    plugin('c1', { dependencies: ['c2'] }),
    plugin('c2', { dependencies: ['c1'] }),
    plugin('c3', { dependencies: ['c1'] }),
    plugin('lonely', { dependencies: ['ghost'] }),
    plugin('x', { overrides: [{ id: 'command:nowhere/y' }] }),
  ]
  const disabled = ['quirky.other', 'command:quirky.core/extra']

  function snapshot(order: DiscoveredPlugin[]) {
    const registry = compute(order, disabled)
    return {
      entries: registry.entries,
      plugins: [...registry.plugins.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      declarations: registry.declarations,
      effective: [...registry.effective.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    }
  }

  test('reversed and shuffled input gives the same registry', () => {
    const expected = snapshot(plugins)
    expect(snapshot([...plugins].reverse())).toEqual(expected)
    const shuffled = [3, 7, 0, 10, 5, 1, 11, 8, 2, 9, 6, 4].map((i) => plugins[i])
    expect(snapshot(shuffled)).toEqual(expected)
  })

  test('the contested contribution resolves as expected', () => {
    const registry = compute(plugins, disabled)
    expect(registry.effective.get('command:quirky.core/run')?.plugin).toBe('o1')
  })
})

describe('computeRegistry: distro-disabled IDs', () => {
  const withDistro = (plugins: DiscoveredPlugin[], disabled: string[], distroDisabled: string[]) =>
    computeRegistry(plugins, new Set(disabled), distroDisabled)

  test('a distro-disabled plugin is disabled with the reason distro, and its contributions are disabled by the owner', () => {
    const registry = withDistro([plugin('a', { contributes: cmd('x') })], [], ['a'])
    expect(entry(registry, 'a')).toMatchObject({
      status: 'disabled',
      disabledReason: 'distro',
      diagnostics: [{ level: 'error', message: 'disabled by the distro' }],
    })
    expect(declaration(registry, 'command:a/x', 'a')).toMatchObject({ status: 'disabled', disabledBy: 'owner' })
  })

  test('a distro-disabled contribution is disabled by the distro', () => {
    const registry = withDistro([plugin('a', { contributes: cmd('x') })], [], ['command:a/x'])
    expect(declaration(registry, 'command:a/x', 'a')).toMatchObject({ status: 'disabled', disabledBy: 'distro' })
    expect(registry.effective.has('command:a/x')).toBe(false)
  })

  test('the user wins when both disabled the same ID', () => {
    const registry = withDistro([plugin('a', { contributes: cmd('x') })], ['a'], ['a'])
    expect(entry(registry, 'a')).toMatchObject({ status: 'disabled', disabledReason: 'user' })
    const contribution = withDistro([plugin('b', { contributes: cmd('x') })], ['command:b/x'], ['command:b/x'])
    expect(declaration(contribution, 'command:b/x', 'b').disabledBy).toBe('user')
  })

  test('a dependant of a distro-disabled plugin is disabled by dependency', () => {
    const registry = withDistro([plugin('a'), plugin('b', { dependencies: ['a'] })], [], ['a'])
    expect(entry(registry, 'b')).toMatchObject({ status: 'disabled', disabledReason: 'dependency' })
  })

  test('without distro IDs nothing changes and enabled plugins carry no reason', () => {
    const registry = compute([plugin('a')], ['a'])
    expect(entry(registry, 'a').disabledReason).toBe('user')
    expect(entry(compute([plugin('b')]), 'b').disabledReason).toBeUndefined()
  })
})
