import {
  BUILTIN_PLUGIN_PREFIX,
  RESERVED_FLAG_NAMES,
  flagNameOf,
  validateValue,
  type ApiDescription,
  type ApiMethodEntry,
  type Schema
} from '@quirky/protocol'
import { UsageError, type ParsedArgs } from './args'
import type { FlagSpec } from './command-spec'
import type { Command } from './commands/types'
import { formatGeneric } from './format'

/** The CLI word for a plugin: its ID, without the `quirky.` prefix built-ins carry. */
export function groupOf(pluginId: string): string {
  return pluginId.startsWith(BUILTIN_PLUGIN_PREFIX) ? pluginId.slice(BUILTIN_PLUGIN_PREFIX.length) : pluginId
}

const SCALAR_TYPES = ['string', 'integer', 'number', 'boolean'] as const
type ScalarType = (typeof SCALAR_TYPES)[number]

const isScalarType = (type: unknown): type is ScalarType => SCALAR_TYPES.includes(type as ScalarType)

const isReserved = (flag: string) => (RESERVED_FLAG_NAMES as readonly string[]).includes(flag)

function flagFor(property: Schema, required: boolean): FlagSpec {
  const description = property.description ?? ''
  const base = { description, ...(required ? { required: true as const } : {}) }
  if (isScalarType(property.type)) {
    return { type: property.type, ...base, ...(property.enum ? { enum: property.enum } : {}) }
  }
  if (property.type === 'array' && isScalarType(property.items?.type)) {
    return {
      type: property.items.type,
      ...base,
      repeatable: true,
      ...(property.items.enum ? { enum: property.items.enum } : {})
    }
  }
  return { type: 'json', ...base }
}

function flagsFor(schema: Schema): Record<string, FlagSpec> {
  const flags: Record<string, FlagSpec> = Object.create(null)
  const required = schema.required ?? []
  for (const [property, propertySchema] of Object.entries(schema.properties ?? {})) {
    const flag = flagNameOf(property)
    if (!isReserved(flag)) flags[flag] = flagFor(propertySchema, required.includes(property))
  }
  flags.params = { type: 'json', description: 'all params as one JSON object' }
  return flags
}

/**
 * Builds the params object for a generated command from `--params` and the per-property flags,
 * and checks it against `schema` before anything is sent. Flag-sourced failures are worded with
 * the flag (`--priority must be at most 5`), `--params` ones with the path (`params.title ...`).
 */
export function paramsFromArgs(command: Command, args: ParsedArgs, schema: Schema): Record<string, unknown> {
  const raw = Object.hasOwn(args.flags, 'params') ? args.flags.params : undefined
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new UsageError('--params must be a JSON object')
  }
  const params: Record<string, unknown> = Object.assign(Object.create(null), raw)
  if (args.positionals.length) throw new UsageError(`unexpected argument "${args.positionals[0]}"`)
  const fromFlag = new Map<string, string>()
  for (const property of Object.keys(schema.properties ?? {})) {
    const flag = flagNameOf(property)
    if (!Object.hasOwn(command.flags, flag) || isReserved(flag) || !Object.hasOwn(args.flags, flag)) continue
    if (Object.hasOwn(params, property)) throw new UsageError(`${property} is given by both --params and --${flag}`)
    params[property] = args.flags[flag]
    fromFlag.set(property, flag)
  }
  const missing = (schema.required ?? []).filter(
    (property) =>
      !Object.hasOwn(params, property) &&
      !isReserved(flagNameOf(property)) &&
      Object.hasOwn(command.flags, flagNameOf(property))
  )
  if (missing.length) throw new UsageError(`missing required flag ${missing.map((p) => `--${flagNameOf(p)}`).join(', ')}`)
  const failure = validateValue(schema, params)
  if (failure) {
    for (const [property, flag] of fromFlag) {
      const prefix = `params.${property}`
      if (failure.startsWith(prefix) && !/^[A-Za-z0-9_$-]/.test(failure.slice(prefix.length))) {
        throw new UsageError(`--${flag}${failure.slice(prefix.length)}`)
      }
    }
    throw new UsageError(failure)
  }
  return params
}

function generatedCommand(entry: ApiMethodEntry, plugin: string): Command {
  const command: Command = {
    name: `${groupOf(plugin)} ${entry.name.slice(entry.name.indexOf('/') + 1)}`,
    summary: entry.description?.split('\n')[0] ?? '',
    positionals: [],
    flags: flagsFor(entry.params),
    methods: [entry.name],
    plugin,
    deferRequired: true,
    async run(args, ctx) {
      const params = paramsFromArgs(command, args, entry.params)
      const result = await ctx.rpc.callAny(entry.name, params)
      ctx.out.result(result, () => formatGeneric(result))
    }
  }
  return command
}

/** One CLI command per plugin method in the daemon's catalog; kernel methods are not commands. */
export function generatedCommands(description: ApiDescription): Command[] {
  return description.methods.flatMap((entry) => (entry.plugin === null ? [] : [generatedCommand(entry, entry.plugin)]))
}
