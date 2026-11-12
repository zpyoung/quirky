import { lstatSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_LIMITS,
  DEFAULT_WINDOWS,
  FAULT_KINDS,
  FAULT_MIN_MINUTES,
  MAX_WINDOWS,
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

export const USAGE = `Usage: bun scripts/soak.ts [--minutes <n>] [--out <dir>] [--windows <0-7>]
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

function parseWindows(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WINDOWS

  const text = value.trim()
  const windows = text === '' ? NaN : Number(text)
  if (!Number.isInteger(windows) || windows < 0 || windows > MAX_WINDOWS) {
    throw new UsageError('--windows must be a whole number from 0 to 7')
  }
  return windows
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
  const windowsError = '--windows must be a whole number from 0 to 7'
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--fault' && (argv[index + 1] === undefined || argv[index + 1].startsWith('-'))) {
      throw new UsageError(faultError)
    }
    if (argv[index] === '--windows' && (argv[index + 1] === undefined || argv[index + 1].startsWith('-'))) {
      throw new UsageError(windowsError)
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
        windows: { type: 'string' },
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
  const windows = parseWindows(values.windows)
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
    ? { minutes, out, limits, windows }
    : { minutes, out, limits, windows, fault }
}
