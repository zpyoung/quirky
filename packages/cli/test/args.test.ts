import { describe, expect, test } from 'bun:test'
import { UsageError, extractGlobals, flagBoolean, flagInt, flagString, parseArgs, wantsHelp } from '../src/args'
import { isGlobalToken } from '../src/commands'
import type { FlagSpec } from '../src/command-spec'

const defs: Record<string, FlagSpec> = {
  name: { type: 'string', description: 'a name' },
  lines: { type: 'integer', description: 'a count' },
  force: { type: 'boolean', description: 'a switch' },
  ratio: { type: 'number', description: 'a ratio' },
  meta: { type: 'json', description: 'a document' },
  color: { type: 'string', description: 'a color', enum: ['red', 'blue'] },
  level: { type: 'integer', description: 'a level', enum: [1, 2] },
  tag: { type: 'string', description: 'tags', repeatable: true },
  must: { type: 'string', description: 'needed', required: true }
}
const parse = (argv: string[], extra: Record<string, FlagSpec> = {}) =>
  parseArgs(argv, { ...defs, must: { ...defs.must, required: false }, ...extra }, 'demo')

describe('parseArgs', () => {
  test('splits positionals from flags', () => {
    const parsed = parse(['a', '--force', 'b', '--name', 'x'])
    expect(parsed.positionals).toEqual(['a', 'b'])
    expect(flagBoolean(parsed, 'force')).toBe(true)
    expect(flagString(parsed, 'name')).toBe('x')
  })

  test('supports --flag=value', () => {
    const parsed = parse(['--name=a=b', '--lines=5'])
    expect(flagString(parsed, 'name')).toBe('a=b')
    expect(flagInt(parsed, 'lines')).toBe(5)
  })

  test('a value starting with -- must be written with =', () => {
    expect(() => parse(['--name', '--weird'])).toThrow('--name requires a value; write --name=<value> for a value starting with --')
    expect(flagString(parse(['--name=--weird']), 'name')).toBe('--weird')
  })

  test('a following token that starts with one dash is a value', () => {
    expect(flagInt(parse(['--lines', '-5']), 'lines')).toBe(-5)
    expect(flagString(parse(['--name', '-x']), 'name')).toBe('-x')
  })

  test('-- ends flag parsing', () => {
    const parsed = parse(['--force', '--', '--name', '-x'])
    expect(parsed.positionals).toEqual(['--name', '-x'])
    expect(flagString(parsed, 'name')).toBeUndefined()
  })

  test('a lone dash is a positional', () => {
    expect(parse(['-']).positionals).toEqual(['-'])
  })

  test('-h is an alias for --help', () => {
    expect(flagBoolean(parse(['-h']), 'help')).toBe(true)
  })

  test('boolean flags default to false and accept =true/=false', () => {
    expect(flagBoolean(parse([]), 'force')).toBe(false)
    expect(flagBoolean(parse(['--force=false']), 'force')).toBe(false)
    expect(flagBoolean(parse(['--force=true']), 'force')).toBe(true)
  })

  test('last occurrence wins', () => {
    expect(flagString(parse(['--name', 'a', '--name', 'b']), 'name')).toBe('b')
  })

  test('repeatable flags collect every occurrence', () => {
    expect(parse(['--tag', 'a', '--tag=b']).flags.tag).toEqual(['a', 'b'])
    expect(parse([]).flags.tag).toBeUndefined()
  })

  test('unknown long flags name the command and the valid flags', () => {
    const only: Record<string, FlagSpec> = { plugin: { type: 'string', description: 'p' } }
    expect(() => parseArgs(['--bogus'], only, 'setting list')).toThrow(
      'unknown flag --bogus for setting list\nvalid flags: --plugin, --json, --help, --yes, --retry-request'
    )
    expect(() => parseArgs(['--bogus'], only, 'setting list')).toThrow(UsageError)
  })

  test('unknown short flags keep their short message', () => {
    expect(() => parse(['-x'])).toThrow('unknown flag -x')
  })

  test('rejects a missing value', () => {
    expect(() => parse(['--name'])).toThrow('--name requires a value')
  })

  test('integer flags take digits only', () => {
    expect(() => parse(['--lines', 'abc'])).toThrow('--lines must be an integer, got "abc"')
    expect(() => parse(['--lines', '1.5'])).toThrow(UsageError)
    expect(() => parse(['--lines='])).toThrow(UsageError)
  })

  test('number flags take finite numbers', () => {
    expect(parse(['--ratio', '1.5']).flags.ratio).toBe(1.5)
    expect(parse(['--ratio=-2e3']).flags.ratio).toBe(-2000)
    for (const bad of ['abc', '', ' ', 'Infinity', 'NaN']) {
      expect(() => parse([`--ratio=${bad}`])).toThrow(`--ratio must be a number, got "${bad}"`)
    }
  })

  test('json flags are parsed', () => {
    expect(parse(['--meta', '{"a":[1]}']).flags.meta).toEqual({ a: [1] })
    expect(parse(['--meta=null']).flags.meta).toBeNull()
    expect(() => parse(['--meta', '{'])).toThrow(/^--meta must be JSON: .+/)
  })

  test('rejects a value on a boolean flag', () => {
    expect(() => parse(['--force=maybe'])).toThrow('--force is a switch; got "maybe"')
  })

  test('enum values are checked after the type', () => {
    expect(flagString(parse(['--color', 'red']), 'color')).toBe('red')
    expect(() => parse(['--color', 'green'])).toThrow('--color must be one of red, blue, got "green"')
    expect(flagInt(parse(['--level', '2']), 'level')).toBe(2)
    expect(() => parse(['--level', '3'])).toThrow('--level must be one of 1, 2, got "3"')
    expect(() => parse(['--level', 'x'])).toThrow('--level must be an integer, got "x"')
  })

  test('required flags are checked at parse time unless help is asked for', () => {
    const strict = { ...defs, other: { type: 'string', description: 'o', required: true } } satisfies Record<string, FlagSpec>
    expect(() => parseArgs([], strict, 'demo')).toThrow('missing required flag --must, --other')
    expect(() => parseArgs(['--must', 'x'], strict, 'demo')).toThrow('missing required flag --other')
    expect(parseArgs(['--must=x', '--other=y'], strict, 'demo').flags.must).toBe('x')
    expect(parseArgs(['--help'], strict, 'demo').flags.help).toBe(true)
    expect(parseArgs(['-h'], strict, 'demo').flags.help).toBe(true)
  })
})

describe('wantsHelp', () => {
  test('sees --help and -h only where the parser would read the switch', () => {
    expect(wantsHelp(['--help'], defs)).toBe(true)
    expect(wantsHelp(['--name', 'x', '-h'], defs)).toBe(true)
    expect(wantsHelp(['--force', '--help'], defs)).toBe(true)
    expect(wantsHelp(['--bogus', '--help'], defs)).toBe(true)
    expect(wantsHelp(['--', '--help'], defs)).toBe(false)
    expect(wantsHelp(['x', '--', '-h'], defs)).toBe(false)
    expect(wantsHelp(['--name', '-h'], defs)).toBe(false)
    expect(wantsHelp(['--name=--help'], defs)).toBe(false)
    expect(wantsHelp(['--name', '--help'], defs)).toBe(false)
    expect(wantsHelp(['--name'], defs)).toBe(false)
  })
})

describe('extractGlobals', () => {
  test('takes --yes and --retry-request out wherever they stand before --', () => {
    expect(extractGlobals(['--yes', 'plugin', 'uninstall', 'x', '--retry-request', 'r-1', '--force'])).toEqual({
      argv: ['plugin', 'uninstall', 'x', '--force'],
      options: { yes: true, retryRequest: 'r-1' }
    })
    expect(extractGlobals(['status', '--retry-request=r-2', '--yes=false']).options).toEqual({ yes: false, retryRequest: 'r-2' })
  })

  test('leaves everything after -- alone', () => {
    expect(extractGlobals(['api', 'call', 'x', '--', '--yes']).argv).toEqual(['api', 'call', 'x', '--', '--yes'])
    expect(extractGlobals(['api', '--', '--yes']).options.yes).toBe(false)
  })

  test('a missing, empty or over-long request ID is a usage error', () => {
    expect(() => extractGlobals(['status', '--retry-request'])).toThrow('--retry-request requires a value')
    expect(() => extractGlobals(['--retry-request', '--json'])).toThrow('--retry-request requires a value')
    expect(() => extractGlobals(['--retry-request='])).toThrow(UsageError)
    expect(() => extractGlobals(['--retry-request', 'x'.repeat(64)])).not.toThrow()
    expect(() => extractGlobals(['--retry-request', 'x'.repeat(65)])).toThrow('at most 64 characters')
  })

  test('the global switches are known to routing', () => {
    for (const token of ['--yes', '--version', '-v', '--json', '-h']) expect(isGlobalToken(token)).toBe(true)
    expect(isGlobalToken('--retry-request')).toBe(false)
  })
})
