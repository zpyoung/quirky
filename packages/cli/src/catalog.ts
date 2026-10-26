import { BUILTIN_PLUGIN_PREFIX, type ApiCatalog, type ApiCommandEntry, type ApiDescription } from '@quirky/protocol'
import { usageOf } from './command-spec'
import type { Command } from './commands/types'

export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function rank(command: Command): number {
  return command.plugin?.startsWith(BUILTIN_PLUGIN_PREFIX) ? 0 : 1
}

/**
 * Decides which plugin commands the CLI can run. A kernel command wins over a plugin command with
 * the same name or whose name extends the kernel's words; a plugin's declared commands win over
 * generated ones with the same name; within each group an earlier command (built-ins first, then by
 * name, a primary before an alias word) wins over a later duplicate. Losers keep `shadowedBy`.
 */
export function resolveCommands(
  kernel: Command[],
  declared: Command[],
  generated: Command[]
): { active: Command[]; shadowed: Command[] } {
  const order = (a: Command, b: Command) =>
    rank(a) - rank(b) ||
    byText(a.name, b.name) ||
    Number(a.aliasOf !== undefined) - Number(b.aliasOf !== undefined) ||
    byText(a.plugin ?? '', b.plugin ?? '')
  const active: Command[] = []
  const shadowed: Command[] = []
  for (const command of [...declared].sort(order).concat([...generated].sort(order))) {
    const owner =
      kernel.find((candidate) => candidate.name === command.name) ??
      kernel.find((candidate) => command.name.startsWith(`${candidate.name} `))
    if (owner) {
      shadowed.push({ ...command, shadowedBy: `kernel ${owner.name}` })
      continue
    }
    const earlier = active.find((candidate) => candidate.name === command.name)
    if (earlier) shadowed.push({ ...command, shadowedBy: `${earlier.plugin} ${earlier.name}` })
    else active.push(command)
  }
  return { active, shadowed }
}

function entryOf(command: Command): ApiCommandEntry {
  return {
    command: command.name,
    plugin: command.plugin,
    methods: [...command.methods],
    summary: command.summary,
    usage: usageOf(command),
    positionals: command.positionals.map(({ name, description, required }) => ({ name, description, required })),
    flags: Object.entries(command.flags).map(([name, spec]) => ({
      name,
      type: spec.type,
      description: spec.description,
      required: spec.required === true,
      repeatable: spec.repeatable === true,
      ...(spec.enum ? { enum: [...spec.enum] } : {})
    })),
    ...(command.shadowedBy ? { shadowedBy: command.shadowedBy } : {})
  }
}

/** Orders catalog commands by words, then kernel before plugins, then by plugin ID. */
export function compareEntries(a: ApiCommandEntry, b: ApiCommandEntry): number {
  return byText(a.command, b.command) || Number(a.plugin !== null) - Number(b.plugin !== null) || byText(a.plugin ?? '', b.plugin ?? '')
}

/**
 * The document `quirky api --json` prints: the daemon's description plus every CLI command the
 * kernel, installed plugins and shadowed plugin commands give, so an agent sees what each does and why.
 * Alias words are not listed; they reach the command listed under its primary words.
 */
export function buildCatalog(
  description: ApiDescription,
  kernel: Command[],
  resolved: { active: Command[]; shadowed: Command[] }
): ApiCatalog {
  const commands = [...kernel, ...resolved.active, ...resolved.shadowed]
    .filter((command) => command.aliasOf === undefined)
    .map(entryOf)
    .sort(compareEntries)
  return { ...description, commands }
}
