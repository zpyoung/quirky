import { PLUGIN_API_VERSION, type ContributionInfo, type PluginInfo } from '@quirky/protocol'
import { expect, test } from 'bun:test'
import { buildUiModel } from '../../src/plugins/ui-model'
import { parseManifest } from '../../src/plugins/manifest'

const menuItem = {
  id: 'new-loop',
  menu: 'quirky.terminal/tab',
  title: 'Loop…',
  command: 'new'
}

const loopPlugin: PluginInfo = {
  id: 'quirky.loops',
  name: 'Background loops',
  apiVersion: PLUGIN_API_VERSION,
  version: '0.1.0',
  source: 'builtin',
  dir: '/plugins/quirky.loops',
  ui: 'dist/ui.js',
  activation: 'lazy',
  dependencies: [],
  state: 'inactive',
  diagnostics: []
}

const declarations: ContributionInfo[] = [
  {
    id: 'menu-item:quirky.loops/new-loop',
    kind: 'menu-item',
    name: 'new-loop',
    plugin: 'quirky.loops',
    override: false,
    status: 'effective',
    data: menuItem
  },
  {
    id: 'command:quirky.loops/new',
    kind: 'command',
    name: 'new',
    plugin: 'quirky.loops',
    override: false,
    status: 'effective',
    data: { title: 'New loop' }
  }
]

test('the terminal tab menu accepts and projects loop contributions as public commands', () => {
  const parsed = parseManifest(JSON.stringify({
    id: 'quirky.loops',
    name: 'Background loops',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    contributes: { 'menu-item': [menuItem] }
  }), { dirName: 'quirky.loops', dir: loopPlugin.dir, source: 'builtin' })
  expect(parsed.ok).toBe(true)

  const { model } = buildUiModel({ declarations, plugins: [loopPlugin], chosenTheme: 'default' })
  expect(model.menuItems).toEqual([{
    id: 'menu-item:quirky.loops/new-loop',
    plugin: 'quirky.loops',
    menu: 'quirky.terminal/tab',
    title: 'Loop…',
    command: 'command:quirky.loops/new'
  }])
})

test('tab menu items retain valid quick-command placement and reject unknown placement', () => {
  const placed = parseManifest(JSON.stringify({
    id: 'quirky.loops',
    name: 'Background loops',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    contributes: { 'menu-item': [{ ...menuItem, after: 'quick-commands' }] }
  }), { dirName: 'quirky.loops', dir: loopPlugin.dir, source: 'builtin' })
  expect(placed.ok).toBe(true)

  const invalid = parseManifest(JSON.stringify({
    id: 'quirky.loops',
    name: 'Background loops',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    contributes: { 'menu-item': [{ ...menuItem, after: 'copy' }] }
  }), { dirName: 'quirky.loops', dir: loopPlugin.dir, source: 'builtin' })
  expect(invalid.ok).toBe(false)
})

test('the full loops manifest declares its UI command module and menu target', async () => {
  const text = await Bun.file(new URL('../../../../plugins/quirky.loops/quirky-plugin.json', import.meta.url)).text()
  const parsed = parseManifest(text, { dirName: 'quirky.loops', dir: '/plugins/quirky.loops', source: 'builtin' })
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  expect(parsed.manifest.ui).toBe('dist/ui.js')
})
