import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { discoverPlugins } from '../../src/plugins/discover'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

afterEach(removeTempDirs)

function manifest(id: string, extra: object = {}) {
  return { id, name: id, version: '1.0.0', ...extra }
}

function setup() {
  const root = makeTempDir()
  const builtin = join(root, 'builtin')
  const installed = join(root, 'installed')
  mkdirSync(builtin)
  mkdirSync(installed)
  return { root, builtin, installed }
}

describe('discoverPlugins', () => {
  test('reads both directories, built-ins first', () => {
    const { builtin, installed } = setup()
    writePlugin(builtin, manifest('quirky.core'))
    writePlugin(installed, manifest('acme'))
    const found = discoverPlugins({ builtin, installed })
    expect(found.map((p) => [p.source, p.id])).toEqual([
      ['builtin', 'quirky.core'],
      ['installed', 'acme'],
    ])
    expect(found[0].manifest?.name).toBe('quirky.core')
    expect(found[0].errors).toEqual([])
    expect(found[1].dir).toBe(join(installed, 'acme'))
  })

  test('a missing directory yields nothing', () => {
    const { root } = setup()
    expect(discoverPlugins({ builtin: null, installed: join(root, 'absent') })).toEqual([])
    expect(discoverPlugins({ builtin: join(root, 'absent-builtin'), installed: join(root, 'absent') })).toEqual([])
  })

  test('skips dot-directories and loose files', () => {
    const { installed } = setup()
    writePlugin(installed, manifest('hidden'), {}, { dirName: '.hidden' })
    writePlugin(installed, manifest('acme'))
    Bun.write(join(installed, 'notes.txt'), 'x')
    expect(discoverPlugins({ builtin: null, installed }).map((p) => p.id)).toEqual(['acme'])
  })

  test('a directory without a manifest is invalid and keeps the directory name as ID', () => {
    const { installed } = setup()
    mkdirSync(join(installed, 'empty'))
    const [plugin] = discoverPlugins({ builtin: null, installed })
    expect(plugin.id).toBe('empty')
    expect(plugin.manifest).toBeNull()
    expect(plugin.errors).toEqual(['no quirky-plugin.json'])
  })

  test("an unparseable manifest is invalid with a can't-be-parsed error", () => {
    const { installed } = setup()
    writePlugin(installed, '{nope', {}, { dirName: 'broken' })
    const [plugin] = discoverPlugins({ builtin: null, installed })
    expect(plugin.id).toBe('broken')
    expect(plugin.manifest).toBeNull()
    expect(plugin.errors.join('\n')).toContain("can't be parsed")
  })

  test('manifest errors make the plugin invalid with the directory name as ID', () => {
    const { installed } = setup()
    writePlugin(installed, manifest('acme'), {}, { dirName: 'other' })
    const [plugin] = discoverPlugins({ builtin: null, installed })
    expect(plugin.id).toBe('other')
    expect(plugin.errors.join('\n')).toContain("directory name doesn't match the ID")
  })

  test('an installed plugin cannot claim the quirky. prefix', () => {
    const { installed } = setup()
    writePlugin(installed, manifest('quirky.sneaky'))
    const [plugin] = discoverPlugins({ builtin: null, installed })
    expect(plugin.errors.join('\n')).toContain('the quirky. prefix is reserved for built-ins')
  })

  test('a duplicate of a built-in is a second, invalid entry and the built-in survives', () => {
    const { builtin, installed } = setup()
    writePlugin(builtin, manifest('quirky.core'))
    writePlugin(installed, manifest('quirky.core'))
    const found = discoverPlugins({ builtin, installed })
    expect(found).toHaveLength(2)
    expect(found[0].source).toBe('builtin')
    expect(found[0].errors).toEqual([])
    expect(found[1].source).toBe('installed')
    expect(found[1].errors).toContain('duplicates the built-in plugin quirky.core')
  })

  test('an installed plugin sharing a built-in ID outside the reserved prefix is also flagged', () => {
    const { builtin, installed } = setup()
    writePlugin(builtin, manifest('core'))
    writePlugin(installed, manifest('core'))
    const found = discoverPlugins({ builtin, installed })
    expect(found[0].errors).toEqual([])
    expect(found[1].errors).toEqual(['duplicates the built-in plugin core'])
  })

  test('an unusable installed manifest whose directory name matches a built-in ID is a duplicate', () => {
    const { builtin, installed } = setup()
    writePlugin(builtin, manifest('quirky.core'))
    writePlugin(installed, '{nope', {}, { dirName: 'quirky.core' })
    const found = discoverPlugins({ builtin, installed })
    expect(found[1].id).toBe('quirky.core')
    expect(found[1].errors).toContain('duplicates the built-in plugin quirky.core')
    expect(found[1].errors.join('\n')).toContain("can't be parsed")
  })

  test('each list is sorted by directory name', () => {
    const { builtin, installed } = setup()
    for (const id of ['quirky.b', 'quirky.a']) writePlugin(builtin, manifest(id))
    for (const id of ['zeta', 'alpha', 'mid']) writePlugin(installed, manifest(id))
    expect(discoverPlugins({ builtin, installed }).map((p) => p.id)).toEqual(['quirky.a', 'quirky.b', 'alpha', 'mid', 'zeta'])
  })

  test('a null built-in directory is skipped', () => {
    const { installed } = setup()
    writePlugin(installed, manifest('acme'))
    expect(discoverPlugins({ builtin: null, installed })).toHaveLength(1)
  })
})
