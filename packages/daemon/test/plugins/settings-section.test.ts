import { PLUGIN_API_VERSION, type ContributionInfo, type PluginInfo } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { buildUiModel } from '../../src/plugins/ui-model'
import { checkUiKindEntry } from '../../src/plugins/ui-kinds'

const plugin: PluginInfo = {
  id: 'quirky.vault',
  name: 'Agent Session History',
  version: '0.1.0',
  apiVersion: PLUGIN_API_VERSION,
  source: 'builtin',
  dir: '/plugins/quirky.vault',
  activation: 'lazy',
  dependencies: [],
  state: 'inactive',
  ui: 'src/ui.js',
  diagnostics: []
}

const section: ContributionInfo = {
  id: 'settings-section:quirky.vault/search',
  kind: 'settings-section',
  name: 'search',
  plugin: 'quirky.vault',
  override: false,
  status: 'effective',
  data: { title: 'Agent Session Search', description: 'Search transcripts.', order: 20 }
}

describe('generic settings-section contributions', () => {
  test('validates title, description and order like a UI slot without changing scalar setting validation', () => {
    const errors: string[] = []
    checkUiKindEntry('settings-section', 'settings-section search', section.data, errors)
    expect(errors).toEqual([])
    checkUiKindEntry('settings-section', 'settings-section search', { id: 'search', title: '', path: 'special' }, errors)
    expect(errors).toEqual([
      'settings-section search: unknown field `path`',
      'settings-section search: title must be a non-empty string'
    ])
  })

  test('builds a generic settings slot with the plugin module and scalar settings intact', () => {
    const setting: ContributionInfo = {
      id: 'setting:quirky.vault/search-enabled',
      kind: 'setting',
      name: 'search-enabled',
      plugin: 'quirky.vault',
      override: false,
      status: 'effective',
      data: { type: 'boolean', title: 'Enable search', default: false }
    }
    const { model } = buildUiModel({ declarations: [section, setting], plugins: [plugin], chosenTheme: 'default' })

    expect(model.settingsSections).toEqual([
      {
        id: section.id,
        kind: 'settings-section',
        plugin: 'quirky.vault',
        title: 'Agent Session Search',
        description: 'Search transcripts.',
        order: 20,
        module: '/plugins/quirky.vault/src/ui.js'
      }
    ])
    expect(model.modules['quirky.vault']?.provides).toEqual([section.id])
    expect(model.settings).toMatchObject([{ id: setting.id, type: 'boolean', default: false }])
  })
})
