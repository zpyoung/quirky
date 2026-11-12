import { lstatSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_LIMITS,
  FAULT_KINDS,
  FAULT_MIN_MINUTES,
  QUALIFYING_MINUTES,
  type SoakConfig,
  type SoakLimits,
} from './contracts.ts'

/** Identifies invalid CLI input before any daemon is started. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage: bun scripts/soak.ts [--minutes <n>] [--out <dir>]
                    [--max-children <n>] [--max-growth <n>] [--max-zombies <n>]
                    [--max-events-per-5s <n>] [--max-stall-ms <n>]
                    [--fault leak|zombies|storm|block] [--help]`

function parseNumber(value: string | undefined, flag: string, fallback: number, allowZero: boolean): number {
  if (value === undefined) return fallback

  const text = value.trim()
  const number = text === '' ? NaN : Number(text)
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    const requirement = allowZero ? 'a finite nonnegative number' : 'a finite positive number'
    throw new UsageError(`${flag} must be ${requirement}`)
  }
  return number
}

function validateOutDirectory(path: string): string {
  if (path === '') throw new UsageError('--out must be a non-empty path')

  const out = resolve(path)
  let entry
  try {
    entry = lstatSync(out)
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return out
    throw new UsageError(`--out cannot be accessed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let directory = entry
  if (entry.isSymbolicLink()) {
    try {
      directory = statSync(out)
    } catch (error) {
      throw new UsageError(`--out must be an empty directory or a nonexistent path: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!directory.isDirectory()) throw new UsageError('--out must be an empty directory or a nonexistent path')

  let entries: string[]
  try {
    entries = readdirSync(out)
  } catch (error) {
    throw new UsageError(`--out cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (entries.length > 0) throw new UsageError('--out directory must be empty')
  return out
}

/** Validates flags and reserves an empty output directory for the soak. */
export function parseArguments(argv: string[]): SoakConfig | { help: true } {
  const faultError = `--fault must be one of ${FAULT_KINDS.join(', ')}`
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--fault' && (argv[index + 1] === undefined || argv[index + 1].startsWith('-'))) {
      throw new UsageError(faultError)
    }
  }

  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean' },
        fault: { type: 'string' },
        minutes: { type: 'string' },
        out: { type: 'string' },
        'max-children': { type: 'string' },
        'max-growth': { type: 'string' },
        'max-zombies': { type: 'string' },
        'max-events-per-5s': { type: 'string' },
        'max-stall-ms': { type: 'string' }
      },
      allowPositionals: false,
      strict: true
    }))
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }

  if (values.help) return { help: true }
  const fault = values.fault === undefined
    ? undefined
    : FAULT_KINDS.find((kind) => kind === values.fault)
  if (values.fault !== undefined && fault === undefined) throw new UsageError(faultError)


  const minutes = parseNumber(values.minutes, '--minutes', QUALIFYING_MINUTES, false)
  if (fault !== undefined && minutes < FAULT_MIN_MINUTES) {
    throw new UsageError(`--fault needs --minutes ${FAULT_MIN_MINUTES} or more`)
  }

  const limits: SoakLimits = {
    maxChildren: parseNumber(values['max-children'], '--max-children', DEFAULT_LIMITS.maxChildren, true),
    maxGrowth: parseNumber(values['max-growth'], '--max-growth', DEFAULT_LIMITS.maxGrowth, true),
    maxZombies: parseNumber(values['max-zombies'], '--max-zombies', DEFAULT_LIMITS.maxZombies, true),
    maxEventsPer5s: parseNumber(values['max-events-per-5s'], '--max-events-per-5s', DEFAULT_LIMITS.maxEventsPer5s, true),
    maxStallMs: parseNumber(values['max-stall-ms'], '--max-stall-ms', DEFAULT_LIMITS.maxStallMs, true)
  }

  const out = values.out === undefined
    ? mkdtempSync(join(tmpdir(), 'quirky-soak-'))
    : validateOutDirectory(values.out)

  return fault === undefined
    ? { minutes, out, limits }
    : { minutes, out, limits, fault }
}
