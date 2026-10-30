import { PLUGIN_API_VERSION, type PluginSource } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { parseManifest } from '../../src/plugins/manifest'

const base = { id: 'acme', name: 'Acme', version: '1.0.0', apiVersion: PLUGIN_API_VERSION }

function parse(manifest: unknown, at: { dirName?: string; dir?: string; source?: PluginSource } = {}) {
  const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  const id = (manifest as { id?: string } | null)?.id ?? 'acme'
  return parseManifest(text, {
    dirName: at.dirName ?? id,
    dir: at.dir ?? '/plugins/acme',
    source: at.source ?? 'installed',
  })
}

function errorsOf(manifest: unknown, at: Parameters<typeof parse>[1] = {}): string[] {
  const result = parse(manifest, at)
  if (result.ok) throw new Error('expected the manifest to be rejected')
  return result.errors
}

describe('parseManifest', () => {
  test('accepts a minimal manifest', () => {
    expect(parse(base)).toEqual({ ok: true, manifest: base })
  })

  test('accepts every field', () => {
    const manifest = {
      ...base,
      description: 'd',
      main: 'dist/index.js',
      activation: 'startup' as const,
      dependencies: ['other'],
      contributes: { command: [{ id: 'hello', title: 'Hello' }] },
      overrides: [{ id: 'command:other/run', title: 'Run' }],
      disables: ['command:other/stop'],
    }
    expect(parse(manifest)).toEqual({ ok: true, manifest })
  })

  test('rejects invalid JSON', () => {
    expect(errorsOf('{nope')[0]).toContain("can't be parsed")
  })

  test('rejects JSON that is not an object', () => {
    for (const text of ['[]', '3', 'null', '"x"']) expect(errorsOf(text)[0]).toContain("can't be parsed")
  })

  test('reports a missing required field', () => {
    for (const field of ['id', 'name', 'version', 'apiVersion']) {
      const manifest: Record<string, string> = { ...base }
      delete manifest[field]
      expect(errorsOf(manifest, { dirName: 'acme' })).toContain(`missing required field '${field}'`)
    }
  })

  test('reports required fields of the wrong type or empty', () => {
    expect(errorsOf({ ...base, name: 3 }).join('\n')).toContain("field 'name'")
    expect(errorsOf({ ...base, name: '' }).join('\n')).toContain("field 'name'")
    expect(errorsOf({ ...base, version: '' }).join('\n')).toContain("field 'version'")
    expect(errorsOf({ ...base, version: 1 }).join('\n')).toContain("field 'version'")
    expect(errorsOf({ ...base, apiVersion: '' }).join('\n')).toContain("field 'apiVersion'")
    expect(errorsOf({ ...base, apiVersion: 1 }).join('\n')).toContain("field 'apiVersion'")
    expect(errorsOf({ ...base, id: 5 }, { dirName: 'acme' }).join('\n')).toContain("field 'id'")
  })

  test('rejects malformed, unsafe and whitespace-padded API floors', () => {
    for (const apiVersion of [
      '^1.0.0',
      '01.0.0',
      '1.0',
      '1.0.0-alpha',
      '1.0.0+build',
      ' 1.0.0',
      '1.0.0 ',
      '9007199254740992.0.0'
    ]) {
      const errors = errorsOf({ ...base, apiVersion }).join('\n')
      expect(errors).toContain('apiVersion')
      expect(errors).toContain('major.minor.patch')
    }
  })

  test('rejects unsupported future releases and different major versions', () => {
    for (const apiVersion of ['1.2.1', '1.3.0', '2.0.0']) {
      const errors = errorsOf({ ...base, apiVersion }).join('\n')
      expect(errors).toContain(apiVersion)
      expect(errors).toContain(PLUGIN_API_VERSION)
    }
  })

  test('reports API incompatibility alongside other manifest problems', () => {
    const errors = errorsOf({ ...base, apiVersion: '2.0.0', extra: true, main: '/outside.js' })
    expect(errors).toContain("unknown field 'extra'")
    expect(errors.some((error) => error.includes('2.0.0') && error.includes(PLUGIN_API_VERSION))).toBe(true)
    expect(errors.some((error) => error.includes("field 'main'"))).toBe(true)
  })

  test('reports optional fields of the wrong type', () => {
    expect(errorsOf({ ...base, description: 1 }).join('\n')).toContain("field 'description'")
    expect(errorsOf({ ...base, main: 1 }).join('\n')).toContain("field 'main'")
    expect(errorsOf({ ...base, activation: 'eager' }).join('\n')).toContain("field 'activation'")
    expect(errorsOf({ ...base, dependencies: 'x' }).join('\n')).toContain("field 'dependencies'")
    expect(errorsOf({ ...base, dependencies: [1] }).join('\n')).toContain('dependencies')
    expect(errorsOf({ ...base, contributes: [] }).join('\n')).toContain("field 'contributes'")
    expect(errorsOf({ ...base, overrides: {} }).join('\n')).toContain("field 'overrides'")
    expect(errorsOf({ ...base, disables: 'x' }).join('\n')).toContain("field 'disables'")
  })

  test('rejects an unknown field and names it', () => {
    expect(errorsOf({ ...base, contribute: {} })).toContain("unknown field 'contribute'")
  })

  test('rejects an invalid plugin ID', () => {
    for (const id of ['Acme', 'a b', '-a', 'a..b', 'x'.repeat(65)]) {
      expect(errorsOf({ ...base, id }, { dirName: id }).join('\n')).toContain('not a valid plugin ID')
    }
  })

  test('rejects an invalid kind', () => {
    expect(errorsOf({ ...base, contributes: { Command: [{ id: 'a' }] } }).join('\n')).toContain("kind 'Command'")
  })

  test('rejects an invalid contribution name', () => {
    expect(errorsOf({ ...base, contributes: { command: [{ id: 'bad name' }] } }).join('\n')).toContain("name 'bad name'")
  })

  test('rejects a contribution entry that is not an object with a string id', () => {
    expect(errorsOf({ ...base, contributes: { command: ['x'] } }).join('\n')).toContain('contributes.command[0]')
    expect(errorsOf({ ...base, contributes: { command: [{}] } }).join('\n')).toContain('contributes.command[0]')
    expect(errorsOf({ ...base, contributes: { command: 'x' } }).join('\n')).toContain('contributes.command')
  })

  test('rejects an invalid override ID', () => {
    expect(errorsOf({ ...base, overrides: [{ id: 'nope' }] }).join('\n')).toContain("override ID 'nope'")
    expect(errorsOf({ ...base, overrides: [{ id: 'Cmd:other/run' }] }).join('\n')).toContain("override ID 'Cmd:other/run'")
  })

  test('rejects an invalid disables ID', () => {
    expect(errorsOf({ ...base, disables: ['nope'] }).join('\n')).toContain("disables ID 'nope'")
  })

  test('rejects a duplicate name within one kind but allows it across kinds', () => {
    const dup = { command: [{ id: 'a' }, { id: 'a' }] }
    expect(errorsOf({ ...base, contributes: dup }).join('\n')).toContain("duplicate name 'a'")
    const ok = { command: [{ id: 'a' }], panel: [{ id: 'a', title: 'A' }] }
    expect(parse({ ...base, contributes: ok }).ok).toBe(true)
  })

  test('reports a repeated name that is also invalid as both errors', () => {
    const errors = errorsOf({ ...base, contributes: { command: [{ id: 'Bad Name' }, { id: 'Bad Name' }] } })
    expect(errors).toContainEqual(expect.stringContaining("name 'Bad Name' is not valid"))
    expect(errors).toContainEqual(expect.stringContaining("duplicate name 'Bad Name'"))
  })

  test('rejects a duplicate override ID', () => {
    const overrides = [{ id: 'command:other/run' }, { id: 'command:other/run' }]
    expect(errorsOf({ ...base, overrides }).join('\n')).toContain("duplicate override ID 'command:other/run'")
  })

  test('rejects a duplicate dependency', () => {
    expect(errorsOf({ ...base, dependencies: ['a', 'a'] }).join('\n')).toContain("duplicate dependency 'a'")
  })

  test('rejects a dependency on itself', () => {
    expect(errorsOf({ ...base, dependencies: ['acme'] }).join('\n')).toContain('itself')
  })

  test('rejects malformed dependency IDs, naming each', () => {
    const errors = errorsOf({ ...base, dependencies: ['Bad ID', 'command:other/run', ''] })
    expect(errors).toEqual([
      "dependencies: invalid plugin ID 'Bad ID'",
      "dependencies: invalid plugin ID 'command:other/run'",
      "dependencies: invalid plugin ID ''",
    ])
  })

  test('reports a self-dependency and its duplicate independently', () => {
    const errors = errorsOf({ ...base, dependencies: ['acme', 'acme'] })
    expect(errors.filter((e) => e.includes('cannot depend on itself'))).toHaveLength(2)
    expect(errors).toContain("dependencies: duplicate dependency 'acme'")
  })

  test('rejects an override of its own namespace', () => {
    const errors = errorsOf({ ...base, overrides: [{ id: 'command:acme/run' }] })
    expect(errors.join('\n')).toContain('use contributes for your own IDs')
  })

  test('rejects an absolute main', () => {
    expect(errorsOf({ ...base, main: '/etc/passwd' }).join('\n')).toContain("field 'main'")
  })

  test('rejects a main that escapes the directory', () => {
    for (const main of ['../x.js', 'a/../../x.js', '..']) {
      expect(errorsOf({ ...base, main }).join('\n')).toContain("field 'main'")
    }
  })

  test('accepts a main that stays inside the directory', () => {
    expect(parse({ ...base, main: 'a/../b.js' }).ok).toBe(true)
  })

  test("rejects a directory name that doesn't match the ID", () => {
    expect(errorsOf(base, { dirName: 'other' }).join('\n')).toContain("directory name doesn't match the ID")
  })

  test('reserves the quirky. prefix for built-ins', () => {
    const manifest = { ...base, id: 'quirky.core' }
    expect(errorsOf(manifest, { source: 'installed' }).join('\n')).toContain('the quirky. prefix is reserved for built-ins')
    expect(parse(manifest, { source: 'builtin' }).ok).toBe(true)
  })

  test('reports every error, not just the first', () => {
    const errors = errorsOf({ ...base, extra: 1, name: '', main: '/x', disables: ['bad'] }, { dirName: 'other' })
    expect(errors.length).toBeGreaterThanOrEqual(5)
  })
})
