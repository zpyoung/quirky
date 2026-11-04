import { PLUGIN_API_VERSION, type ContributionInfo, type ContributionStatus, type PluginInfo } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { parseManifest } from '../../src/plugins/manifest'
import { buildUiModel } from '../../src/plugins/ui-model'

const base = { id: 'acme', name: 'Acme', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, ui: 'ui.js' }

function parse(entry: Record<string, unknown>) {
  return parseManifest(JSON.stringify({ ...base, contributes: { 'window-bar-item': [entry] } }), {
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

function plugin(id: string): PluginInfo {
  return { id, name: id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, source: 'installed', dir: `/plugins/${id}`, ui: 'ui.js', activation: 'lazy', dependencies: [], state: 'inactive', diagnostics: [] }
}

function decl(owner: string, name: string, data: Record<string, unknown>, status: ContributionStatus = 'effective'): ContributionInfo {
  return { id: `window-bar-item:${owner}/${name}`, kind: 'window-bar-item', name, plugin: owner, override: false, status, data }
}

describe('window-bar-item entries', () => {
  test('a complete entry is accepted, with or without the optional fields', () => {
    expect(parse({ id: 'avatar', title: 'Avatar', description: 'Avatar chip', order: 5 }).ok).toBe(true)
    expect(parse({ id: 'plain', title: 'Plain' }).ok).toBe(true)
  })

  test('title is required', () => {
    expect(errorsFor({ id: 'avatar' })).toEqual(['window-bar-item avatar: title is required'])
  })

  test('unknown fields are rejected', () => {
    expect(errorsFor({ id: 'avatar', title: 'Avatar', icon: 'x' })).toEqual(['window-bar-item avatar: unknown field `icon`'])
  })
})

describe('window-bar items in the UI model', () => {
  test('effective items are listed by order, then ID', () => {
    const { model } = buildUiModel({
      declarations: [
        decl('acme', 'late', { title: 'Late', order: 20 }),
        decl('acme', 'b-tie', { title: 'B', order: 10 }),
        decl('acme', 'a-tie', { title: 'A', order: 10 }),
      ],
      plugins: [plugin('acme')],
      chosenTheme: 'default',
    })
    expect(model.windowBarItems?.map((entry) => entry.id)).toEqual([
      'window-bar-item:acme/a-tie',
      'window-bar-item:acme/b-tie',
      'window-bar-item:acme/late',
    ])
    expect(model.windowBarItems?.[0]).toMatchObject({ kind: 'window-bar-item', plugin: 'acme', title: 'A', order: 10 })
    expect(model.windowBarItems?.[0]?.module).not.toBeNull()
  })

  test('an item that is not effective is absent', () => {
    const { model } = buildUiModel({
      declarations: [decl('acme', 'avatar', { title: 'Avatar' }, 'overridden')],
      plugins: [plugin('acme')],
      chosenTheme: 'default',
    })
    expect(model.windowBarItems).toEqual([])
  })
})
