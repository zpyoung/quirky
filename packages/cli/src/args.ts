import type { FlagSpec } from './command-spec'

/** Raised for bad invocations; `main` maps it to exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Flag values by name: strings, numbers, booleans, arrays for repeatable flags, or parsed JSON. */
export type ParsedArgs = {
  positionals: string[]
  flags: Record<string, unknown>
}

export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: 'boolean', description: 'print machine-readable JSON' },
  help: { type: 'boolean', description: 'show help' }
}

function parseValue(name: string, spec: FlagSpec, raw: string): unknown {
  let value: unknown
  switch (spec.type) {
    case 'integer':
      if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${name} must be an integer, got "${raw}"`)
      value = Number(raw)
      break
    case 'number':
      value = raw.trim() === '' ? Number.NaN : Number(raw)
      if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got "${raw}"`)
      break
    case 'json':
      try {
        value = JSON.parse(raw)
      } catch (error) {
        throw new UsageError(`--${name} must be JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      break
    default:
      value = raw
  }
  if (spec.enum && !spec.enum.includes(value as string | number)) {
    throw new UsageError(`--${name} must be one of ${spec.enum.join(', ')}, got "${raw}"`)
  }
  return value
}

/**
 * Splits `argv` into positionals and the flags declared in `defs` (plus the global `--json` and
 * `--help`). Supports `--name value`, `--name=value`, `-h` for `--help`, and `--` to end flag
 * parsing. A value that starts with `--` must be written `--name=value`. Unknown flags, bad values
 * and missing required flags are usage errors naming `command`.
 */
export function parseArgs(argv: readonly string[], defs: Record<string, FlagSpec>, command: string): ParsedArgs {
  const all: Record<string, FlagSpec> = { ...GLOBAL_FLAGS, ...defs }
  const positionals: string[] = []
  const flags: Record<string, unknown> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (token === '-h') {
      flags.help = true
      continue
    }
    if (!token.startsWith('--')) {
      if (token.startsWith('-') && token.length > 1) throw new UsageError(`unknown flag ${token}`)
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    const spec = Object.hasOwn(all, name) ? all[name] : undefined
    if (!spec) {
      const valid = [...Object.keys(defs).filter((key) => !Object.hasOwn(GLOBAL_FLAGS, key)), ...Object.keys(GLOBAL_FLAGS)]
      throw new UsageError(
        `unknown flag --${name} for ${command}\nvalid flags: ${valid.map((key) => `--${key}`).join(', ')}`
      )
    }
    let raw: string | undefined = eq === -1 ? undefined : token.slice(eq + 1)
    let value: unknown
    if (spec.type === 'boolean') {
      if (raw === undefined || raw === 'true') value = true
      else if (raw === 'false') value = false
      else throw new UsageError(`--${name} is a switch; got "${raw}"`)
    } else {
      if (raw === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`--${name} requires a value`)
        if (argv[i + 1].startsWith('--')) {
          throw new UsageError(`--${name} requires a value; write --${name}=<value> for a value starting with --`)
        }
        raw = argv[++i]
      }
      value = parseValue(name, spec, raw)
    }
    if (spec.repeatable) {
      const existing = flags[name]
      if (Array.isArray(existing)) existing.push(value)
      else flags[name] = [value]
    } else {
      flags[name] = value
    }
  }
  if (flags.help !== true) {
    const missing = Object.entries(defs)
      .filter(([name, spec]) => spec.required && flags[name] === undefined)
      .map(([name]) => `--${name}`)
    if (missing.length) throw new UsageError(`missing required flag ${missing.join(', ')}`)
  }
  return { positionals, flags }
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags[name]
  return typeof value === 'number' ? value : undefined
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true
}
