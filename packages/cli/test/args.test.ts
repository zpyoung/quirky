import { describe, expect, test } from 'bun:test'
import { UsageError, flagBoolean, flagInt, flagString, parseArgs } from '../src/args'

const defs = { json: 'boolean', help: 'boolean', name: 'string', lines: 'int', force: 'boolean' } as const

describe('parseArgs', () => {
  test('splits positionals from flags', () => {
    const parsed = parseArgs(['a', '--force', 'b', '--name', 'x'], defs)
    expect(parsed.positionals).toEqual(['a', 'b'])
    expect(flagBoolean(parsed, 'force')).toBe(true)
    expect(flagString(parsed, 'name')).toBe('x')
  })

  test('supports --flag=value', () => {
    const parsed = parseArgs(['--name=a=b', '--lines=5'], defs)
    expect(flagString(parsed, 'name')).toBe('a=b')
    expect(flagInt(parsed, 'lines')).toBe(5)
  })

  test('string flags take any next token, including dashed ones', () => {
    expect(flagString(parseArgs(['--name', '--weird'], defs), 'name')).toBe('--weird')
  })

  test('-- ends flag parsing', () => {
    const parsed = parseArgs(['--force', '--', '--name', '-x'], defs)
    expect(parsed.positionals).toEqual(['--name', '-x'])
    expect(flagString(parsed, 'name')).toBeUndefined()
  })

  test('a lone dash is a positional', () => {
    expect(parseArgs(['-'], defs).positionals).toEqual(['-'])
  })

  test('-h is an alias for --help', () => {
    expect(flagBoolean(parseArgs(['-h'], defs), 'help')).toBe(true)
  })

  test('boolean flags default to false and accept =true/=false', () => {
    expect(flagBoolean(parseArgs([], defs), 'force')).toBe(false)
    expect(flagBoolean(parseArgs(['--force=false'], defs), 'force')).toBe(false)
    expect(flagBoolean(parseArgs(['--force=true'], defs), 'force')).toBe(true)
  })

  test('last occurrence wins', () => {
    expect(flagString(parseArgs(['--name', 'a', '--name', 'b'], defs), 'name')).toBe('b')
  })

  test('rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'], defs)).toThrow(UsageError)
    expect(() => parseArgs(['-x'], defs)).toThrow(/unknown flag -x/)
  })

  test('rejects a missing value', () => {
    expect(() => parseArgs(['--name'], defs)).toThrow(/--name requires a value/)
  })

  test('rejects non-integer values for int flags', () => {
    expect(() => parseArgs(['--lines', 'abc'], defs)).toThrow(/--lines must be an integer/)
    expect(() => parseArgs(['--lines', '1.5'], defs)).toThrow(UsageError)
  })

  test('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['--force=maybe'], defs)).toThrow(UsageError)
  })
})
