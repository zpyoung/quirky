import { KERNEL_METHOD_SCHEMAS, PLUGIN_API_VERSION, validateValue, type ContributionInfo, type ContributionStatus, type PluginInfo } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { parseManifest } from '../../src/plugins/manifest'
import { buildUiModel } from '../../src/plugins/ui-model'
import { resolveSetting } from '../../src/plugins/ui-service'

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

describe('published UI result schemas', () => {
  test('ui.contributions accepts windowBarItems and validates its array shape', () => {
    const { model } = buildUiModel({
      declarations: [decl('acme', 'pill', { title: 'Avatar' })],
      plugins: [plugin('acme')],
      chosenTheme: 'default',
    })
    expect(model.windowBarItems?.[0]?.id).toBe('window-bar-item:acme/pill')
    const schema = KERNEL_METHOD_SCHEMAS['ui.contributions'].result
    const result = { ...model, settings: [], themes: [], windowBarItems: [] }
    expect(validateValue(schema, result, 'result')).toBeNull()
    const { windowBarItems, ...withoutItems } = result
    expect(validateValue(schema, withoutItems, 'result')).toBeNull()
    expect(validateValue(schema, { ...result, windowBarItems: 'bad' }, 'result')).toBe('result.windowBarItems must be an array')
    expect(validateValue(schema, { ...result, windowBarItems: ['bad'] }, 'result')).toBe('result.windowBarItems[0] must be an object')
  })

  test('setting.list accepts resolved hidden settings and validates hidden and source', () => {
    const setting: ContributionInfo = {
      id: 'setting:acme/internal', kind: 'setting', name: 'internal', plugin: 'acme',
      override: false, status: 'effective',
      data: { title: 'Internal', type: 'boolean', default: false, hidden: true },
    }
    const { model } = buildUiModel({
      declarations: [setting],
      plugins: [plugin('acme')],
      chosenTheme: 'default',
    })
    const settings = model.settings.map((entry) => resolveSetting(entry, null, null))
    expect(settings[0]?.hidden).toBe(true)
    expect(settings[0]?.source).toBe('default')
    const schema = KERNEL_METHOD_SCHEMAS['setting.list'].result
    expect(validateValue(schema, settings, 'result')).toBeNull()
    expect(validateValue(schema, [{ ...settings[0]!, hidden: 'yes' }], 'result')).toBe('result[0].hidden must be a boolean')
    for (const source of ['user', 'distro', 'default']) {
      expect(validateValue(schema, [{ ...settings[0]!, source }], 'result')).toBeNull()
    }
    expect(validateValue(schema, [{ ...settings[0]!, source: 'other' }], 'result')).not.toBeNull()
  })
})
