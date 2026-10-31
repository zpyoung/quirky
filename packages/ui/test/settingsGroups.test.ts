import { expect, test } from 'bun:test'
import { DEFAULT_THEME, type SettingInfo, type ThemeInfo } from '@quirky/protocol'
import { settingsGroups, themePicker } from '../src/plugins/settingsGroups'

const fontSize: SettingInfo = {
  id: 'setting:acme.notes/fontSize',
  plugin: 'acme.notes',
  pluginName: 'Notes',
  type: 'number',
  title: 'Font size',
  default: 13,
  minimum: 8,
  maximum: 32,
  value: 18
}
const mode: SettingInfo = {
  id: 'setting:acme.notes/mode',
  plugin: 'acme.notes',
  pluginName: 'Notes',
  type: 'enum',
  title: 'Mode',
  description: 'How notes are listed',
  default: 'list',
  values: ['list', 'grid'],
  value: 'grid'
}
const hidden: SettingInfo = {
  id: 'setting:acme.files/hidden',
  plugin: 'acme.files',
  pluginName: 'Files',
  type: 'boolean',
  title: 'Show hidden',
  default: false,
  value: true
}
const label: SettingInfo = {
  id: 'setting:acme.files/label',
  plugin: 'acme.files',
  pluginName: 'Files',
  type: 'string',
  title: 'Label',
  default: 'files',
  value: 'files'
}

test('SC-24: groups by plugin ID, sorted, with settings sorted by ID', () => {
  const groups = settingsGroups([mode, label, fontSize, hidden])
  expect(groups.map((group) => group.plugin)).toEqual(['acme.files', 'acme.notes'])
  expect(groups[0].fields.map((field) => field.id)).toEqual([hidden.id, label.id])
  expect(groups[1].fields.map((field) => field.id)).toEqual([fontSize.id, mode.id])
})

test('SC-24: each type gets its control and shows the current value', () => {
  const [files, notes] = settingsGroups([fontSize, mode, hidden, label])
  expect(files.fields[0]).toMatchObject({ title: 'Show hidden', control: { kind: 'checkbox' }, value: true })
  expect(files.fields[1]).toMatchObject({ control: { kind: 'text' }, value: 'files' })
  expect(notes.fields[0]).toMatchObject({ control: { kind: 'number', min: 8, max: 32 }, value: 18 })
  expect(notes.fields[1]).toMatchObject({
    control: { kind: 'select', options: ['list', 'grid'] },
    description: 'How notes are listed',
    value: 'grid'
  })
})

test('SC-24: a number setting without bounds has an unbounded control, and no settings give no groups', () => {
  const free: SettingInfo = { ...fontSize, minimum: undefined, maximum: undefined }
  expect(settingsGroups([free])[0].fields[0].control).toEqual({ kind: 'number', min: undefined, max: undefined })
  expect(settingsGroups([])).toEqual([])
})

test('SC-24: does not reorder or mutate its input', () => {
  const input = [mode, fontSize]
  settingsGroups(input)
  expect(input).toEqual([mode, fontSize])
})

test('categorical settings render under their declared category and section', () => {
  const separators: SettingInfo = {
    ...hidden,
    id: 'setting:quirky.sidebar-extras/sidebarSectionSeparators',
    plugin: 'quirky.sidebar-extras',
    pluginName: 'Sidebar Extras',
    title: 'Show dividers',
    category: 'Appearance',
    section: 'Window & Sidebar'
  }
  const groups = settingsGroups([fontSize, separators])
  expect(groups[0]).toMatchObject({
    kind: 'category',
    category: 'Appearance',
    sections: [{ section: 'Window & Sidebar', fields: [{ id: separators.id }] }]
  })
  expect(groups[1]).toMatchObject({ kind: 'plugin', plugin: 'acme.notes', fields: [{ id: fontSize.id }] })
})

const solar: ThemeInfo = {
  id: 'theme:acme.solar/solar',
  plugin: 'acme.solar',
  title: 'Solar',
  appearance: 'light',
  colors: DEFAULT_THEME.colors
}


test('SC-26: a chosen theme that is no longer offered shows as the default', () => {
  expect(themePicker([DEFAULT_THEME], solar.id).selected).toBe('default')
})
