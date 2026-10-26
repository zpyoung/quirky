import { describe, expect, test } from 'bun:test'
import { parseDistroManifest } from '../src'

const base = { id: 'night', name: 'Night', version: '1.0.0' }

function parse(manifest: unknown) {
  return parseDistroManifest(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
}

function errorsOf(manifest: unknown): string[] {
  const result = parse(manifest)
  if (result.ok) throw new Error('expected the manifest to be refused')
  return result.errors
}

describe('parseDistroManifest', () => {
  test('a minimal manifest parses', () => {
    expect(parse(base)).toEqual({ ok: true, manifest: base })
  })

  test('a full manifest parses and canonicalizes keybinding chords', () => {
    const full = {
      ...base,
      description: 'Dark and quiet',
      plugins: ['plugins/night.extras', 'other'],
      disable: ['quirky.git', 'panel:quirky.git/source-control'],
      settings: { 'setting:quirky.terminal/scrollback': 6000, 'setting:a.b/c': true, 'setting:a.b/d': 'x' },
      theme: 'theme:night.extras/dusk',
      keybindings: { 'Cmd+Shift+D': 'command:night.extras/palette' },
    }
    const result = parse(full)
    expect(result).toEqual({
      ok: true,
      manifest: { ...full, keybindings: { 'mod+shift+d': 'command:night.extras/palette' } },
    })
  })

  test('text that is not a JSON object is refused', () => {
    expect(errorsOf('{nope')[0]).toContain("can't be parsed")
    expect(errorsOf('[]')[0]).toContain('expected a JSON object')
  })

  test('required fields and the ID syntax are checked', () => {
    expect(errorsOf({})).toEqual([
      "missing required field 'id'",
      "missing required field 'name'",
      "missing required field 'version'",
    ])
    expect(errorsOf({ ...base, id: 'Night Mode' })).toEqual(["id 'Night Mode' is not a valid plugin ID"])
    expect(errorsOf({ ...base, name: '' })).toEqual(["field 'name' must be a non-empty string"])
  })

  test('unknown fields are errors', () => {
    expect(errorsOf({ ...base, colour: 'blue' })).toEqual(["unknown field 'colour'"])
  })

  test('every problem is reported in one pass', () => {
    const errors = errorsOf({ ...base, extra: 1, theme: 3, disable: 'quirky.git' })
    expect(errors).toHaveLength(3)
  })

  test('plugins must be relative directories inside the distro', () => {
    for (const bad of ['/abs/plugin', '../outside', 'a/../../b', '', '.', 'C:\\x', 'a\\..\\..\\b']) {
      expect(errorsOf({ ...base, plugins: [bad] }).join('\n')).toContain('plugins')
    }
    expect(errorsOf({ ...base, plugins: 'a' })).toEqual(["field 'plugins' must be an array of strings"])
    expect(errorsOf({ ...base, plugins: ['a', 'a'] })).toEqual(["plugins: duplicate directory 'a'"])
    expect(parse({ ...base, plugins: ['a/./b'] }).ok).toBe(true)
  })

  test('disable entries are plugin IDs or contribution IDs', () => {
    expect(parse({ ...base, disable: ['quirky.git', 'panel:quirky.git/source-control'] }).ok).toBe(true)
    expect(errorsOf({ ...base, disable: ['Not An ID', 'panel:bad'] })).toEqual([
      "disable: 'Not An ID' is not a plugin ID or a contribution ID",
      "disable: 'panel:bad' is not a plugin ID or a contribution ID",
    ])
    expect(errorsOf({ ...base, disable: ['a', 'a'] })).toEqual(["disable: duplicate entry 'a'"])
  })

  test('settings are keyed by setting IDs and hold booleans, numbers or strings', () => {
    expect(errorsOf({ ...base, settings: { 'quirky.terminal/scrollback': 1 } })).toEqual([
      "settings: 'quirky.terminal/scrollback' is not a setting contribution ID",
    ])
    expect(errorsOf({ ...base, settings: { 'command:a/b': 1 } })).toEqual(["settings: 'command:a/b' is not a setting contribution ID"])
    expect(errorsOf({ ...base, settings: { 'setting:a/b': null, 'setting:a/c': [1], 'setting:a/d': {} } })).toEqual([
      "settings: value of 'setting:a/b' must be a boolean, number or string",
      "settings: value of 'setting:a/c' must be a boolean, number or string",
      "settings: value of 'setting:a/d' must be a boolean, number or string",
    ])
    expect(errorsOf({ ...base, settings: [] })).toEqual(["field 'settings' must be an object"])
  })

  test('theme must be a theme contribution ID', () => {
    expect(errorsOf({ ...base, theme: 'dusk' })).toEqual(["theme: 'dusk' is not a theme contribution ID"])
    expect(errorsOf({ ...base, theme: 'panel:a/dusk' })).toEqual(["theme: 'panel:a/dusk' is not a theme contribution ID"])
  })

  test('keybindings need parseable chords and command IDs, and no two spellings of one chord', () => {
    expect(errorsOf({ ...base, keybindings: { d: 'command:a/b' } })).toEqual([
      'keybindings: d: key needs a modifier or a function key',
    ])
    expect(errorsOf({ ...base, keybindings: { 'mod+d': 'palette' } })).toEqual([
      "keybindings: value of 'mod+d' must be a command contribution ID, got 'palette'",
    ])
    expect(errorsOf({ ...base, keybindings: { 'mod+d': 'panel:a/b' } })).toEqual([
      "keybindings: value of 'mod+d' must be a command contribution ID, got 'panel:a/b'",
    ])
    expect(errorsOf({ ...base, keybindings: { 'cmd+d': 'command:a/b', 'mod+D': 'command:a/c' } })).toEqual([
      "keybindings: 'mod+D' repeats the chord mod+d",
    ])
  })
})
