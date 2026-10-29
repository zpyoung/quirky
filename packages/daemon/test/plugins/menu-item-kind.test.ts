import { PLUGIN_API_VERSION, type ContributionInfo, type ContributionStatus, type PluginInfo } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { parseManifest } from '../../src/plugins/manifest'
import { buildUiModel } from '../../src/plugins/ui-model'

const base = { id: 'acme', name: 'Acme', version: '1.0.0', apiVersion: PLUGIN_API_VERSION }

function parse(entry: Record<string, unknown>) {
  return parseManifest(JSON.stringify({ ...base, contributes: { 'menu-item': [entry] } }), {
    dirName: 'acme',
    dir: '/plugins/acme',
    source: 'installed',
  })
}

function errorsFor(entry: Record<string, unknown>): string[] {
  const parsed = parse(entry)
  if (parsed.ok) throw new Error('expected the manifest to be rejected')
  return parsed.errors
}

const GOOD = { id: 'handoff', menu: 'quirky.terminal/pane', title: 'Hand Off', command: 'open', when: { agent: 'any' }, after: 'quick-commands' }

function plugin(id: string): PluginInfo {
  return { id, name: id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, source: 'installed', dir: `/plugins/${id}`, activation: 'lazy', dependencies: [], state: 'inactive', diagnostics: [] }
}

function decl(owner: string, name: string, data: Record<string, unknown>, status: ContributionStatus = 'effective'): ContributionInfo {
  return { id: `menu-item:${owner}/${name}`, kind: 'menu-item', name, plugin: owner, override: false, status, data }
}

function command(owner: string, name: string): ContributionInfo {
  return { id: `command:${owner}/${name}`, kind: 'command', name, plugin: owner, override: false, status: 'effective', data: { title: name } }
}

describe('menu-item entries', () => {
  test('a complete entry is accepted, with or without the optional fields', () => {
    expect(parse(GOOD).ok).toBe(true)
    expect(parse({ id: 'plain', menu: 'quirky.terminal/pane', title: 'Plain', command: 'command:acme/open' }).ok).toBe(true)
    expect(parse({ id: 'any', menu: 'quirky.terminal/pane', title: 'Any', command: 'open', when: {} }).ok).toBe(true)
  })

  test('menu targets accept pane and tab and reject unrelated targets', () => {
    expect(parse(GOOD).ok).toBe(true)
    expect(parse({ ...GOOD, menu: 'quirky.terminal/tab', when: undefined }).ok).toBe(true)
    expect(parse({ ...GOOD, menu: 'quirky.terminal/tab' }).ok).toBe(false)
    expect(parse({ ...GOOD, menu: 'quirky.terminal/other' }).ok).toBe(false)
  })
  test('title and command are required', () => {
    const { title: _title, command: _command, ...bare } = GOOD
    expect(errorsFor(bare)).toEqual(['menu-item handoff: title is required', 'menu-item handoff: command is required'])
    expect(errorsFor({ ...GOOD, command: 'not a command' })).toEqual(['menu-item handoff: command must be a command name or a full command ID'])
    expect(errorsFor({ ...GOOD, command: 'view:acme/open' })).toEqual(['menu-item handoff: command must be a command name or a full command ID'])
  })

  test('when.agent accepts only any, and when takes no other condition', () => {
    expect(errorsFor({ ...GOOD, when: { agent: 'claude' } })).toEqual(['menu-item handoff: when.agent must be any'])
    expect(errorsFor({ ...GOOD, when: { branch: 'main' } })).toEqual(['menu-item handoff: unknown condition `branch` in when'])
    expect(errorsFor({ ...GOOD, when: 'agent' })).toEqual(['menu-item handoff: when must be an object'])
  })

  test('after accepts only quick-commands, and unknown fields are rejected', () => {
    expect(errorsFor({ ...GOOD, after: 'copy' })).toEqual(['menu-item handoff: after must be quick-commands'])
    expect(errorsFor({ ...GOOD, icon: 'x' })).toEqual(['menu-item handoff: unknown field `icon`'])
  })
})

describe('menu items in the UI model', () => {
  const plugins = [plugin('acme.handoff'), plugin('acme.other')]

  test('effective items are listed with the command as a full ID', () => {
    const { model } = buildUiModel({
      declarations: [
        decl('acme.handoff', 'hand-off', { menu: 'quirky.terminal/pane', title: 'Hand Off', command: 'open', when: { agent: 'any' }, after: 'quick-commands' }),
        decl('acme.other', 'plain', { menu: 'quirky.terminal/pane', title: 'Plain', command: 'command:acme.other/go' }),
        command('acme.handoff', 'open'),
        command('acme.other', 'go'),
      ],
      plugins,
      chosenTheme: 'default',
    })
    expect(model.menuItems).toEqual([
      {
        id: 'menu-item:acme.handoff/hand-off',
        plugin: 'acme.handoff',
        menu: 'quirky.terminal/pane',
        title: 'Hand Off',
        command: 'command:acme.handoff/open',
        when: { agent: 'any' },
        after: 'quick-commands',
      },
      { id: 'menu-item:acme.other/plain', plugin: 'acme.other', menu: 'quirky.terminal/pane', title: 'Plain', command: 'command:acme.other/go' },
    ])
  })

  test('items of a disabled or overridden plugin are absent', () => {
    const data = { menu: 'quirky.terminal/pane', title: 'Item', command: 'open' }
    const { model } = buildUiModel({
      declarations: [
        decl('acme.handoff', 'kept', data),
        decl('acme.other', 'off', data, 'disabled'),
        decl('acme.other', 'lost', data, 'overridden'),
      ],
      plugins,
      chosenTheme: 'default',
    })
    expect(model.menuItems.map((item) => item.id)).toEqual(['menu-item:acme.handoff/kept'])
  })

  test('no declarations gives an empty list', () => {
    expect(buildUiModel({ declarations: [], plugins, chosenTheme: 'default' }).model.menuItems).toEqual([])
  })
})
