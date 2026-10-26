import { CONNECTION_METHODS, type ApiCatalog } from '@quirky/protocol'
import { UsageError, parseArgs } from '../args'
import { buildCatalog, resolveCommands } from '../catalog'
import { commandHelp } from '../command-spec'
import { formatGeneric } from '../format'
import { commandForMethod, generatedCommands, paramsFromArgs } from '../generated'
import { declaredCommands } from '../plugin-commands'
import { takePositionals } from './support'
import type { Command, Context } from './types'

/**
 * Reads `api.describe` and builds the full command catalog. The kernel table is imported lazily
 * because `commands/index.ts` imports this file.
 */
export async function loadCatalog(ctx: Context): Promise<ApiCatalog> {
  const { COMMANDS } = await import('./index')
  const description = await ctx.rpc.call('api.describe', {})
  return buildCatalog(
    description,
    COMMANDS,
    resolveCommands(COMMANDS, declaredCommands(description), generatedCommands(description))
  )
}

function catalogText(catalog: ApiCatalog): string {
  const groups = new Map<string, ApiCatalog['commands']>()
  for (const entry of catalog.commands) {
    const group = entry.command.split(' ')[0]
    groups.set(group, [...(groups.get(group) ?? []), entry])
  }
  const lines: string[] = []
  for (const [group, entries] of groups) {
    const width = Math.max(...entries.map((entry) => entry.usage.length))
    lines.push(group)
    for (const entry of entries) {
      const note = entry.shadowedBy ? `(shadowed by ${entry.shadowedBy})` : ''
      const summary = [entry.summary, note].filter(Boolean).join(' ')
      lines.push(`  ${entry.usage.padEnd(width)}  ${summary}`.trimEnd())
    }
  }
  lines.push(`${catalog.methods.length} methods, ${catalog.events.length} events`)
  return lines.join('\n')
}

export const api: Command = {
  name: 'api',
  summary: 'list every method, event and command, including plugins',
  positionals: [],
  flags: {},
  methods: ['api.describe'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const catalog = await loadCatalog(ctx)
    ctx.out.result(catalog, () => catalogText(catalog))
  }
}

const GLOBAL_TOKENS = new Set(['--json', '--json=true', '--json=false'])

export const apiCall: Command = {
  name: 'api call',
  summary: 'call any method by name, with flags taken from its params schema',
  positionals: [{ name: 'method', description: 'the method to call, e.g. git.status or acme.notes/add', required: true }],
  flags: {},
  methods: ['api.describe'],
  plugin: null,
  rawArgs: true,
  async run(args, ctx) {
    const methodAt = args.positionals.findIndex((token) => !GLOBAL_TOKENS.has(token))
    const method = args.positionals[methodAt]
    if (method === undefined || method.startsWith('-')) throw new UsageError('missing <method>')
    const rest = args.positionals.slice(methodAt + 1)
    const description = await ctx.rpc.call('api.describe', {})
    const entry = description.methods.find((candidate) => candidate.name === method)
    if (!entry) throw new UsageError(`unknown method ${method}`)
    if ((CONNECTION_METHODS as readonly string[]).includes(method) || entry.connection) {
      throw new UsageError(`${method} needs a live connection and can't be called from the CLI`)
    }
    const command = commandForMethod(entry)
    const parsed = parseArgs(rest, command.flags, command.name, { checkRequired: false })
    if (parsed.flags.help === true) {
      ctx.out.line(commandHelp(command))
      return
    }
    const params = paramsFromArgs(command, parsed, entry.params)
    const result = await ctx.rpc.callAny(method, params)
    ctx.out.result(result, () => formatGeneric(result))
  }
}
