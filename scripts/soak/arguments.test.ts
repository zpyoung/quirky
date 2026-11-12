import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { parseArguments, UsageError } from './arguments.ts'

const scratch: string[] = []
const defaultLimits = {
  maxChildren: 60,
  maxGrowth: 5,
  maxZombies: 0,
  maxEventsPer5s: 30,
  maxStallMs: 1000
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-soak-arguments-'))
  scratch.push(dir)
  return dir
}

function trackNewDefaultOut(out: string, existing: Set<string>): void {
  const name = basename(out)
  if (isAbsolute(out) && dirname(out) === tmpdir() && name.startsWith('quirky-soak-') && !existing.has(name)) {
    scratch.push(out)
  }
}

function parseConfig(argv: string[]) {
  const result = parseArguments(argv)
  if ('help' in result) throw new Error('Expected a soak config, received help')
  return result
}

function expectUsageError(argv: string[], problem: string): void {
  let caught: unknown
  try {
    parseArguments(argv)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(UsageError)
  if (!(caught instanceof UsageError)) return
  expect(caught.message.toLowerCase()).toContain(problem.toLowerCase())
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('uses the documented defaults and gives each default output a fresh temp path', () => {
  const existing = new Set(readdirSync(tmpdir()))
  const first = parseConfig([])
  trackNewDefaultOut(first.out, existing)
  const second = parseConfig([])
  trackNewDefaultOut(second.out, existing)

  expect(first.minutes).toBe(30)
  expect(first.limits).toEqual(defaultLimits)
  expect(isAbsolute(first.out)).toBe(true)
  expect(dirname(first.out)).toBe(tmpdir())
  expect(basename(first.out).startsWith('quirky-soak-')).toBe(true)
  expect(second.out).not.toBe(first.out)
})

test('parses --minutes as a fractional number', () => {
  const out = makeTempDir()
  const config = parseConfig(['--minutes', '0.4', '--out', out])

  expect(config).toEqual({ minutes: 0.4, out, limits: defaultLimits })
})

test('parses --out', () => {
  const out = makeTempDir()
  const config = parseConfig(['--out', out])

  expect(config.out).toBe(out)
})

const validLimits = [
  ['--max-children', '12', 'maxChildren', 12],
  ['--max-growth', '8', 'maxGrowth', 8],
  ['--max-zombies', '2', 'maxZombies', 2],
  ['--max-events-per-5s', '45', 'maxEventsPer5s', 45],
  ['--max-stall-ms', '1500', 'maxStallMs', 1500]
] as const

for (const [flag, value, field, expected] of validLimits) {
  test(`parses ${flag}`, () => {
    const out = makeTempDir()
    const config = parseConfig(['--out', out, flag, value])

    expect(config.limits).toEqual({ ...defaultLimits, [field]: expected })
  })
}

test('returns the help result for --help', () => {
  expect(parseArguments(['--help'])).toEqual({ help: true })
})

test('rejects an unknown flag as a usage error', () => {
  const out = makeTempDir()
  expectUsageError(['--out', out, '--not-a-soak-option'], '--not-a-soak-option')
})

for (const flag of ['--minutes', '--out', ...validLimits.map(([name]) => name)]) {
  test(`rejects ${flag} when its value is missing`, () => {
    const argv = flag === '--out' ? [flag] : ['--out', makeTempDir(), flag]
    expectUsageError(argv, flag)
  })
}

test('rejects zero minutes as a usage error', () => {
  const out = makeTempDir()
  expectUsageError(['--out', out, '--minutes', '0'], '--minutes')
})

for (const [flag] of validLimits) {
  for (const value of ['abc', 'NaN', 'Infinity', '-1']) {
    test(`rejects ${value} for ${flag}`, () => {
      const out = makeTempDir()
      expectUsageError(['--out', out, flag, value], flag)
    })
  }
}

test('rejects a negative inline --max-children value with its nonnegative constraint', () => {
  const out = makeTempDir()
  expectUsageError(['--out', out, '--max-children=-1'], 'a finite nonnegative number')
})

test('rejects --out when the directory already contains a file', () => {
  const out = makeTempDir()
  writeFileSync(join(out, 'occupied.txt'), 'occupied')

  expectUsageError(['--out', out], '--out')
})
