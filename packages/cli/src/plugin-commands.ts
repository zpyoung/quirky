import {
  validateValue,
  type ApiCliCommandEntry,
  type ApiDescription,
  type CliContext,
  type CliModule,
  type Schema
} from '@quirky/protocol'
import { StderrFailure, UsageError, type ParsedArgs } from './args'
import type { FlagSpec, PositionalSpec } from './command-spec'
import type { Command, Context } from './commands/types'
import { formatGeneric } from './format'
import { formatRecord, formatTable } from './output'

const camelCase = (flag: string) => flag.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())

function checkPositionals(entry: ApiCliCommandEntry, args: ParsedArgs): void {
  const missing = entry.positionals.findIndex((positional, i) => positional.required && args.positionals[i] === undefined)
  if (missing !== -1) throw new UsageError(`missing <${entry.positionals[missing].name}>`)
  if (args.positionals.length > entry.positionals.length) {
    throw new UsageError(`unexpected argument "${args.positionals[entry.positionals.length]}"`)
  }
}

/** A positional arrives as text; one bound to a numeric or boolean param is converted before validation. */
function coerce(raw: string, property: Schema | undefined): unknown {
  if ((property?.type === 'integer' || property?.type === 'number') && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw)
  }
  if (property?.type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true'
  return raw
}

function genericParams(entry: ApiCliCommandEntry, args: ParsedArgs, schema: Schema | undefined): Record<string, unknown> {
  checkPositionals(entry, args)
  const params: Record<string, unknown> = Object.create(null)
  entry.positionals.forEach((positional, i) => {
    const raw = args.positionals[i]
    if (raw === undefined) return
    const param = positional.param || positional.name
    params[param] = coerce(raw, schema?.properties?.[param])
  })
  for (const flag of entry.flags) {
    if (Object.hasOwn(args.flags, flag.name)) params[flag.param || camelCase(flag.name)] = args.flags[flag.name]
  }
  const failure = schema ? validateValue(schema, params) : null
  if (failure) throw new UsageError(failure)
  return params
}

/** The CLI services a plugin's CLI module gets for one command run. */
export function cliContextFor(ctx: Context): CliContext {
  return {
    call: (method, params = {}) => ctx.rpc.callAny(method, params),
    out: {
      json: ctx.out.json,
      result: (value, text) => ctx.out.result(value, text),
      line: (text) => ctx.out.line(text),
      jsonLine: (value) => ctx.out.jsonLine(value)
    },
    format: { table: formatTable, record: (pairs) => formatRecord(pairs) },
    env: ctx.env,
    cwd: ctx.cwd,
    readFile: async (path) => ctx.readFile(path),
    sleep: (ms) => ctx.sleep(ms),
    now: () => ctx.now(),
    usage: (message) => new UsageError(message),
    fail: (message) => new StderrFailure(message),
    reconnect: () => ctx.rpc.reconnect()
  }
}

async function runModule(entry: ApiCliCommandEntry, module: string, args: ParsedArgs, ctx: Context): Promise<void> {
  checkPositionals(entry, args)
  let loaded: Partial<CliModule>
  try {
    loaded = (await import(module)) as Partial<CliModule>
  } catch (error) {
    throw new StderrFailure(`could not load the CLI module of ${entry.plugin}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const name = entry.id.slice(entry.id.lastIndexOf('/') + 1)
  const handler = loaded.commands && Object.hasOwn(loaded.commands, name) ? loaded.commands[name] : undefined
  if (typeof handler !== 'function') {
    throw new StderrFailure(`the CLI module of ${entry.plugin} has no command "${name}"`)
  }
  const flags: Record<string, unknown> = {}
  for (const flag of entry.flags) if (Object.hasOwn(args.flags, flag.name)) flags[flag.name] = args.flags[flag.name]
  await handler({ positionals: args.positionals, flags }, cliContextFor(ctx))
}

function commandFor(entry: ApiCliCommandEntry, name: string, schemaOf: (method: string) => Schema | undefined): Command {
  const flags: Record<string, FlagSpec> = Object.create(null)
  for (const flag of entry.flags) {
    flags[flag.name] = {
      type: flag.type,
      description: flag.description,
      ...(flag.required ? { required: true as const } : {}),
      ...(flag.repeatable ? { repeatable: true as const } : {}),
      ...(flag.enum ? { enum: flag.enum } : {})
    }
  }
  const positionals: PositionalSpec[] = entry.positionals.map(({ name: positional, description, required }) => ({
    name: positional,
    description,
    required
  }))
  return {
    name,
    summary: entry.summary,
    positionals,
    flags,
    methods: entry.methods,
    plugin: entry.plugin,
    async run(args, ctx) {
      if (entry.module !== null) return runModule(entry, entry.module, args, ctx)
      if (entry.method === null) {
        throw new StderrFailure(`${entry.plugin} declares "${entry.words}" with neither a method nor a CLI module`)
      }
      const params = genericParams(entry, args, schemaOf(entry.method))
      const result = await ctx.rpc.callAny(entry.method, params)
      ctx.out.result(result, () => formatGeneric(result))
    }
  }
}

/**
 * One CLI command per declared plugin command in the catalog, plus one per alias word (marked with
 * `aliasOf` so listings show only the primary words). A command without a CLI module runs generically
 * against its method; one with a module imports it only when the command runs.
 */
export function declaredCommands(description: ApiDescription): Command[] {
  const schemas = new Map(description.methods.map((entry) => [entry.name, entry.params]))
  const schemaOf = (method: string) => schemas.get(method)
  return description.cli.commands.flatMap((entry) => {
    const primary = commandFor(entry, entry.words, schemaOf)
    return [primary, ...entry.aliasWords.map((words) => ({ ...commandFor(entry, words, schemaOf), aliasOf: entry.words }))]
  })
}
