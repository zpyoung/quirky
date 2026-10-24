/** Raised for bad invocations; `main` maps it to exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type FlagKind = 'boolean' | 'string' | 'int'
export type FlagDefs = Record<string, FlagKind>
export type ParsedArgs = {
  positionals: string[]
  flags: Record<string, string | number | boolean>
}

export const GLOBAL_FLAGS: FlagDefs = { json: 'boolean', help: 'boolean' }

/**
 * Splits `argv` into positionals and the flags declared in `defs`. Supports `--name value`,
 * `--name=value`, `-h` for `--help`, and `--` to end flag parsing. Unknown flags are usage errors.
 */
export function parseArgs(argv: readonly string[], defs: FlagDefs): ParsedArgs {
  const positionals: string[] = []
  const flags: ParsedArgs['flags'] = {}
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
    const kind = Object.hasOwn(defs, name) ? defs[name] : undefined
    if (!kind) throw new UsageError(`unknown flag --${name}`)
    let raw: string | undefined = eq === -1 ? undefined : token.slice(eq + 1)
    if (kind === 'boolean') {
      if (raw === undefined || raw === 'true') flags[name] = true
      else if (raw === 'false') flags[name] = false
      else throw new UsageError(`--${name} is a switch; got "${raw}"`)
      continue
    }
    if (raw === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} requires a value`)
      raw = argv[++i]
    }
    if (kind === 'int') {
      if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${name} must be an integer, got "${raw}"`)
      flags[name] = Number(raw)
    } else {
      flags[name] = raw
    }
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
