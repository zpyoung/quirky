import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings, parseSettingsArguments, SettingsError } from '../../src/core/settings'

const cwd = mkdtempSync(join(tmpdir(), 'quirky-settings-'))
afterAll(() => rmSync(cwd, { recursive: true, force: true }))

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
