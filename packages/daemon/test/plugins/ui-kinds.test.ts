import { describe, expect, test } from 'bun:test'
import { parseManifest } from '../../src/plugins/manifest'

const base = { id: 'acme', name: 'Acme', version: '1.0.0' }

function result(manifest: Record<string, unknown>) {
  return parseManifest(JSON.stringify({ ...base, ...manifest }), {
    dirName: 'acme',
    dir: '/plugins/acme',
    source: 'installed',
  })
}

function errorsOf(manifest: Record<string, unknown>): string[] {
  const parsed = result(manifest)
  if (parsed.ok) throw new Error('expected the manifest to be rejected')
  return parsed.errors
}

const contributes = (kind: string, entry: Record<string, unknown>) => ({ contributes: { [kind]: [entry] } })
const errorsFor = (kind: string, entry: Record<string, unknown>) => errorsOf(contributes(kind, entry))
const accepts = (kind: string, entry: Record<string, unknown>) => result(contributes(kind, entry)).ok

describe('sidebar-section and panel entries', () => {
  test.each(['sidebar-section', 'panel'])('%s accepts title, description and order', (kind) => {
    expect(accepts(kind, { id: 'list', title: 'List', description: 'd', order: 10 })).toBe(true)
    expect(accepts(kind, { id: 'list', title: 'List', order: -1.5 })).toBe(true)
  })

  test.each(['sidebar-section', 'panel'])('%s requires a non-empty title', (kind) => {
    expect(errorsFor(kind, { id: 'list' })).toEqual([`${kind} list: title is required`])
    expect(errorsFor(kind, { id: 'list', title: '' })).toEqual([`${kind} list: title must be a non-empty string`])
    expect(errorsFor(kind, { id: 'list', title: 3 })).toEqual([`${kind} list: title must be a non-empty string`])
  })

  test.each(['sidebar-section', 'panel'])('%s order must be a finite number', (kind) => {
    for (const order of ['high', null, true]) {
      expect(errorsFor(kind, { id: 'p', title: 'P', order })).toEqual([`${kind} p: order must be a number`])
    }
    expect(errorsFor(kind, { id: 'p', title: 'P', order: 1e999 })).toEqual([`${kind} p: order must be a number`])
  })

  test.each(['sidebar-section', 'panel'])('%s rejects unknown fields and a non-string description', (kind) => {
    expect(errorsFor(kind, { id: 'p', title: 'P', icon: 'x', description: 1 })).toEqual([
      `${kind} p: unknown field \`icon\``,
      `${kind} p: description must be a string`,
    ])
  })
})

describe('view and command entries', () => {
  test.each(['view', 'command'])('%s title is optional', (kind) => {
    expect(accepts(kind, { id: 'go' })).toBe(true)
    expect(accepts(kind, { id: 'go', title: 'Go', description: 'd' })).toBe(true)
  })

  test.each(['view', 'command'])('%s title must be a non-empty string when present', (kind) => {
    expect(errorsFor(kind, { id: 'go', title: '' })).toEqual([`${kind} go: title must be a non-empty string`])
    expect(errorsFor(kind, { id: 'go', title: 1 })).toEqual([`${kind} go: title must be a non-empty string`])
  })

  test.each(['view', 'command'])('%s rejects unknown fields, including order', (kind) => {
    expect(errorsFor(kind, { id: 'go', icon: 'x', order: 1 })).toEqual([
      `${kind} go: unknown field \`icon\``,
      `${kind} go: unknown field \`order\``,
    ])
  })

  test.each(['view', 'command'])('%s description must be a string', (kind) => {
    expect(errorsFor(kind, { id: 'go', description: 1 })).toEqual([`${kind} go: description must be a string`])
  })
})

describe('keybinding entries', () => {
  test('accepts a chord with a command name or a full command ID', () => {
    expect(accepts('keybinding', { id: 'k', key: 'cmd+shift+k', command: 'open', description: 'd' })).toBe(true)
    expect(accepts('keybinding', { id: 'k', key: 'f5', command: 'command:other.plugin/run' })).toBe(true)
  })

  test('reports the chord problem with the label', () => {
    expect(errorsFor('keybinding', { id: 'k', key: 'x', command: 'open' })).toEqual([
      'keybinding k: key needs a modifier or a function key',
    ])
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+shift', command: 'open' })).toEqual([
      'keybinding k: key must end in one key',
    ])
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+foo', command: 'open' })).toEqual([
      'keybinding k: unknown key `foo`',
    ])
    expect(errorsFor('keybinding', { id: 'k', key: 'meta+k', command: 'open' })).toEqual([
      'keybinding k: unknown modifier `meta`',
    ])
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+mod+k', command: 'open' })).toEqual([
      'keybinding k: duplicate modifier `mod`',
    ])
  })

  test('requires a key and a command', () => {
    expect(errorsFor('keybinding', { id: 'k' })).toEqual(['keybinding k: key is required', 'keybinding k: command is required'])
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+k' })).toEqual(['keybinding k: command is required'])
  })

  test('key and command must be strings', () => {
    expect(errorsFor('keybinding', { id: 'k', key: 1, command: 2 })).toEqual([
      'keybinding k: key must be a string',
      'keybinding k: command must be a string',
    ])
  })

  test('command must be a contribution name or a full command ID', () => {
    const message = ['keybinding k: command must be a command name or a full command ID']
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+k', command: 'bad name' })).toEqual(message)
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+k', command: '' })).toEqual(message)
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+k', command: 'view:acme/page' })).toEqual(message)
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+k', command: 'command:nope' })).toEqual(message)
  })

  test('rejects unknown fields', () => {
    expect(errorsFor('keybinding', { id: 'k', key: 'mod+k', command: 'go', when: 'x' })).toEqual([
      'keybinding k: unknown field `when`',
    ])
  })
})

describe('setting entries', () => {
  const setting = (extra: Record<string, unknown>) => ({ id: 's', title: 'S', ...extra })

  test('accepts each type with a matching default', () => {
    expect(accepts('setting', setting({ type: 'boolean', default: false }))).toBe(true)
    expect(accepts('setting', setting({ type: 'string', default: '', description: 'd' }))).toBe(true)
    expect(accepts('setting', setting({ type: 'number', default: 5, minimum: 1, maximum: 10 }))).toBe(true)
    expect(accepts('setting', setting({ type: 'number', default: 5, minimum: 5, maximum: 5 }))).toBe(true)
    expect(accepts('setting', setting({ type: 'enum', default: 'a', values: ['a', 'b'] }))).toBe(true)
  })

  test('type must be one of the four', () => {
    const message = ['setting s: type must be boolean, number, string or enum']
    expect(errorsFor('setting', { id: 's', title: 'S', default: 1 })).toEqual(message)
    expect(errorsFor('setting', setting({ type: 'color', default: 1 }))).toEqual(message)
    expect(errorsFor('setting', setting({ type: 3, default: 1 }))).toEqual(message)
  })

  test('requires a title', () => {
    expect(errorsFor('setting', { id: 's', type: 'boolean', default: true })).toEqual(['setting s: title is required'])
    expect(errorsFor('setting', { id: 's', title: '', type: 'boolean', default: true })).toEqual([
      'setting s: title must be a non-empty string',
    ])
  })

  test('requires a default that matches the type', () => {
    expect(errorsFor('setting', setting({ type: 'number' }))).toEqual(['setting s: default is required'])
    expect(errorsFor('setting', setting({ type: 'number', default: 'big' }))).toEqual(['setting s: default must be a number'])
    expect(errorsFor('setting', setting({ type: 'boolean', default: 'yes' }))).toEqual(['setting s: default must be a boolean'])
    expect(errorsFor('setting', setting({ type: 'string', default: 1 }))).toEqual(['setting s: default must be a string'])
    expect(errorsFor('setting', setting({ type: 'enum', values: ['a'], default: 1 }))).toEqual([
      'setting s: default must be a string',
    ])
  })

  test('the default must respect the range and the enum values', () => {
    expect(errorsFor('setting', setting({ type: 'number', default: 0, minimum: 1 }))).toEqual([
      'setting s: default must be at least 1',
    ])
    expect(errorsFor('setting', setting({ type: 'number', default: 11, maximum: 10 }))).toEqual([
      'setting s: default must be at most 10',
    ])
    expect(errorsFor('setting', setting({ type: 'enum', values: ['a', 'b'], default: 'c' }))).toEqual([
      'setting s: default must be one of a, b',
    ])
  })

  test('minimum and maximum belong to number settings, are finite and ordered', () => {
    expect(errorsFor('setting', setting({ type: 'string', default: 'x', minimum: 1, maximum: 2 }))).toEqual([
      'setting s: minimum is only allowed for a number',
      'setting s: maximum is only allowed for a number',
    ])
    expect(errorsFor('setting', setting({ type: 'number', default: 1, minimum: 'low', maximum: null }))).toEqual([
      'setting s: minimum must be a number',
      'setting s: maximum must be a number',
    ])
    expect(errorsFor('setting', setting({ type: 'number', default: 5, minimum: 10, maximum: 1 }))).toEqual([
      'setting s: minimum must not be greater than maximum',
    ])
  })

  test('an enum requires values, and only an enum may have them', () => {
    expect(errorsFor('setting', setting({ type: 'enum', default: 'a' }))).toEqual(['setting s: values is required for an enum'])
    expect(errorsFor('setting', setting({ type: 'string', default: 'a', values: ['a'] }))).toEqual([
      'setting s: values is only allowed for an enum',
    ])
  })

  test('values must be a non-empty list of distinct non-empty strings', () => {
    const message = ['setting s: values must be a non-empty list of distinct non-empty strings']
    for (const values of [[], 'a', ['a', 'a'], ['a', ''], ['a', 1]]) {
      expect(errorsFor('setting', setting({ type: 'enum', default: 'a', values }))).toEqual(message)
    }
  })

  test('rejects unknown fields and a non-string description', () => {
    expect(errorsFor('setting', setting({ type: 'boolean', default: true, scope: 'x', description: 1 }))).toEqual([
      'setting s: unknown field `scope`',
      'setting s: description must be a string',
    ])
  })
})

describe('theme entries', () => {
  const theme = (extra: Record<string, unknown> = {}) => ({ id: 't', title: 'T', appearance: 'dark', ...extra })

  test('accepts a theme with no colors, or some colors in 3, 6 and 8 digit hex', () => {
    expect(accepts('theme', theme())).toBe(true)
    expect(accepts('theme', theme({ description: 'd', colors: { bg: '#123', text: '#aabbcc', accent: '#AABBCCDD' } }))).toBe(true)
  })

  test('requires a title', () => {
    expect(errorsFor('theme', { id: 't', appearance: 'dark' })).toEqual(['theme t: title is required'])
  })

  test('appearance must be dark or light', () => {
    expect(errorsFor('theme', theme({ appearance: 'blue' }))).toEqual(['theme t: appearance must be dark or light'])
    expect(errorsFor('theme', { id: 't', title: 'T' })).toEqual(['theme t: appearance must be dark or light'])
    expect(accepts('theme', theme({ appearance: 'light' }))).toBe(true)
  })

  test('colors must be an object', () => {
    for (const colors of ['red', [], null, 1]) {
      expect(errorsFor('theme', theme({ colors }))).toEqual(['theme t: colors must be an object'])
    }
  })

  test('a color name outside the tokens is unknown', () => {
    expect(errorsFor('theme', theme({ colors: { sparkle: '#fff' } }))).toEqual(['theme t: unknown color `sparkle`'])
  })

  test('a color value must be a hex color', () => {
    for (const value of ['red', '#12', '#12345', 'fff', 7, '#gggggg']) {
      expect(errorsFor('theme', theme({ colors: { bg: value } }))).toEqual(['theme t: color bg must be a hex color'])
    }
  })

  test('rejects unknown fields', () => {
    expect(errorsFor('theme', theme({ fonts: {} }))).toEqual(['theme t: unknown field `fonts`'])
  })
})

describe('overrides of UI kinds', () => {
  test('are labelled with the full ID', () => {
    expect(errorsOf({ overrides: [{ id: 'sidebar-section:quirky.sample/repos', title: 'Repos', order: 'x', icon: 1 }] })).toEqual([
      'override sidebar-section:quirky.sample/repos: unknown field `icon`',
      'override sidebar-section:quirky.sample/repos: order must be a number',
    ])
  })

  test('accept valid fields', () => {
    expect(result({ overrides: [{ id: 'panel:other/side', title: 'Side', order: 3 }] }).ok).toBe(true)
    expect(result({ overrides: [{ id: 'setting:other/size', type: 'number', title: 'Size', default: 3 }] }).ok).toBe(true)
  })

  test('title is not required on an override of a view or command', () => {
    expect(result({ overrides: [{ id: 'command:other/run' }] }).ok).toBe(true)
  })
})

describe('kinds with no checker', () => {
  test('widget entries are left alone', () => {
    expect(accepts('widget', { id: 'w', title: 1, anything: [1], order: 'x' })).toBe(true)
  })
})

describe('the ui field', () => {
  test('accepts a relative path inside the plugin directory', () => {
    const parsed = result({ ui: 'dist/ui.js' })
    expect(parsed.ok && parsed.manifest.ui).toBe('dist/ui.js')
  })

  test('rejects a path that escapes the plugin directory', () => {
    expect(errorsOf({ ui: '../x.js' })).toEqual(["field 'ui' must be a relative path inside the plugin directory, got '../x.js'"])
  })

  test('rejects an absolute path', () => {
    expect(errorsOf({ ui: '/etc/x.js' })).toEqual(["field 'ui' must be a relative path inside the plugin directory, got '/etc/x.js'"])
  })

  test('rejects a value that is not a non-empty string', () => {
    for (const ui of [3, '', null, ['a.js']]) {
      expect(errorsOf({ ui })).toEqual(["field 'ui' must be a non-empty string"])
    }
  })

  test('rejects a path that is not well-formed Unicode', () => {
    expect(errorsOf({ ui: '\ud800.js' })).toEqual(["field 'ui' must be a well-formed path"])
    expect(errorsOf({ main: 'dist/\udfff/x.js' })).toEqual(["field 'main' must be a well-formed path"])
    expect(result({ ui: 'ui/\u{1F600}.js' }).ok).toBe(true)
  })

  test('main keeps its own messages', () => {
    expect(errorsOf({ main: '../x.js' })).toEqual(["field 'main' must be a relative path inside the plugin directory, got '../x.js'"])
    expect(errorsOf({ main: 3 })).toEqual(["field 'main' must be a non-empty string"])
  })
})
