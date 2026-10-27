import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings, parseSettingsArguments, SettingsError } from '../../src/core/settings'

const cwd = mkdtempSync(join(tmpdir(), 'quirky-settings-'))
afterAll(() => rmSync(cwd, { recursive: true, force: true }))
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024

function jsonAtSettingsLimit(): string {
  const prefix = '{"payload":"'
  const suffix = '"}'
  return `${prefix}${'x'.repeat(MAX_SETTINGS_BYTES - prefix.length - suffix.length)}${suffix}`
}

describe('parseSettingsArguments', () => {
  test('combines JSON and equals-form settings in argument order and removes their flags', () => {
    const result = parseSettingsArguments(
      [
        '--settings',
        '{"nested":{"first":true,"replace":["old"]},"enabled":true}',
        '--verbose',
        `--settings=${JSON.stringify({ nested: { second: true, replace: ['new'] }, enabled: false })}`
      ],
      cwd
    )

    expect(result.args).toEqual(['--verbose'])
    expect(result.settings).toEqual({
      nested: { first: true, second: true, replace: ['new'] },
      enabled: false
    })
  })

  test('reads settings files relative to cwd and merges repeated files', () => {
    writeFileSync(join(cwd, 'first.json'), JSON.stringify({ hooks: { Stop: ['first'] }, values: [1] }))
    writeFileSync(join(cwd, 'second.json'), JSON.stringify({ hooks: { SessionStart: ['second'] }, values: [2] }))

    const result = parseSettingsArguments(['--settings', 'first.json', '--settings=second.json'], cwd)

    expect(result.args).toEqual([])
    expect(result.settings).toEqual({ hooks: { Stop: ['first'], SessionStart: ['second'] }, values: [2] })
  })

  test('reads a valid settings file at the 4 MiB limit', () => {
    const path = join(cwd, 'at-limit.json')
    const contents = jsonAtSettingsLimit()
    writeFileSync(path, contents)

    const result = parseSettingsArguments(['--settings', path], cwd)

    expect((result.settings.payload as string).length).toBe(MAX_SETTINGS_BYTES - '{"payload":"'.length - '"}'.length)
  })

  test('rejects settings files larger than the 4 MiB limit', () => {
    const path = join(cwd, 'over-limit.json')
    writeFileSync(path, `${jsonAtSettingsLimit()} `)

    expect(() => parseSettingsArguments(['--settings', path], cwd)).toThrow(
      `--settings file ${path} exceeds ${MAX_SETTINGS_BYTES} bytes`
    )
  })

  test('follows symlinks to regular settings files', () => {
    const target = join(cwd, 'symlink-target.json')
    const link = join(cwd, 'symlink-settings.json')
    writeFileSync(target, JSON.stringify({ linked: true }))
    symlinkSync(target, link)

    expect(parseSettingsArguments(['--settings', link], cwd).settings).toEqual({ linked: true })
  })

  test('rejects non-regular device settings files', () => {
    expect(() => parseSettingsArguments(['--settings', '/dev/null'], cwd)).toThrow('regular file')
  })

  test('does not treat arguments after the terminator as settings', () => {
    const after = join(cwd, 'after.json')
    writeFileSync(after, JSON.stringify({ after: true }))

    const result = parseSettingsArguments(['--settings', '{"before":true}', '--', '--settings', after], cwd)

    expect(result.args).toEqual(['--', '--settings', after])
    expect(result.settings).toEqual({ before: true })
  })

  test('reports unreadable and malformed settings files', () => {
    writeFileSync(join(cwd, 'broken.json'), '{ broken')

    expect(() => parseSettingsArguments(['--settings', 'missing.json'], cwd)).toThrow(SettingsError)
    expect(() => parseSettingsArguments(['--settings', 'broken.json'], cwd)).toThrow('broken.json')
  })

  test('reports malformed inline JSON instead of silently treating it as a file', () => {
    expect(() => parseSettingsArguments(['--settings={"broken":'], cwd)).toThrow(SettingsError)
  })

  test('rejects prototype-dangerous keys in user JSON', () => {
    const unsafe = '{"safe":true,"nested":{"constructor":{"prototype":{"polluted":true}}}}'
    expect(() => parseSettingsArguments(['--settings', unsafe], cwd)).toThrow(SettingsError)
  })

})

describe('mergeSettings', () => {
  test('recursively merges objects, replaces arrays, and leaves prior state unchanged', () => {
    const earlier = { nested: { first: true, replace: ['old'] }, enabled: true }
    const result = mergeSettings(earlier, { nested: { second: true, replace: ['new'] }, enabled: false })

    expect(result).toEqual({ nested: { first: true, second: true, replace: ['new'] }, enabled: false })
    expect(earlier).toEqual({ nested: { first: true, replace: ['old'] }, enabled: true })
  })

  test('rejects non-JSON values and dangerous keys', () => {
    expect(() => mergeSettings({ bad: Number.NaN })).toThrow(SettingsError)
    expect(() => mergeSettings(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(SettingsError)
    expect(() => mergeSettings({ bad: new Date() })).toThrow(SettingsError)
  })
})
