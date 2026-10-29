import { describe, expect, test } from 'bun:test'
import { pluginApiCompatibilityError } from '../src/plugin-api'

describe('stable plugin API floors', () => {
  test.each([
    ['1.0.0', '1.0.0'],
    ['1.0.0', '1.1.0'],
    ['1.9.9', '1.10.0'],
    ['1.10.2', '1.10.2'],
    ['1.10.1', '1.10.2'],
    ['1.9007199254740991.0', '1.9007199254740991.1'],
  ])('supports floor %s on host %s', (target, host) => {
    expect(pluginApiCompatibilityError(target, host)).toBeNull()
  })

  test.each([
    ['1.0.1', '1.0.0'],
    ['1.1.0', '1.0.9'],
    ['1.10.0', '1.9.9'],
    ['2.0.0', '1.10.0'],
    ['0.9.0', '1.0.0'],
    ['1.0.0', '2.0.0'],
  ])('refuses floor %s on host %s', (target, host) => {
    const error = pluginApiCompatibilityError(target, host)
    expect(error).toContain(target)
    expect(error).toContain(host)
    expect(error).toContain('apiVersion')
  })

  test.each([
    undefined, null, 1, {}, [], '', '1', '1.0', '^1.0.0', '>=1.0.0',
    '01.0.0', '1.00.0', '1.0.00', '-1.0.0', '+1.0.0', ' 1.0.0',
    '1.0.0 ', '1.0.0\n', '1.0.0-beta', '1.0.0+build',
    '1.9007199254740992.0', '1.0.9007199254740992', '9007199254740992.0.0',
  ].map((target) => ({ target })))('rejects malformed target %j', ({ target }) => {
    expect(pluginApiCompatibilityError(target, '1.0.0')).toContain('apiVersion')
  })

  test('an invalid host version fails closed instead of authorizing a module', () => {
    expect(pluginApiCompatibilityError('1.0.0', 'not-a-release')).not.toBeNull()
    expect(pluginApiCompatibilityError('1.0.0', '1.0.0\n')).not.toBeNull()
  })
})
